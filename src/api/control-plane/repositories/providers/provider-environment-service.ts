import { createHash } from 'node:crypto';
import {
	assignmentEnvironmentGrantSchema,
	providerEnvironmentProfileDescriptorSchema,
	type AssignmentEnvironmentGrant,
	type ProviderEnvironmentProfileDescriptor,
} from '@treeseed/sdk/capacity-provider/contracts';
import type { CapacityGovernanceDatabase } from '../../../capacity/database.ts';
import { CapacityGovernanceError } from '../../../capacity/database.ts';

type UserPrincipal = { id: string; roles?: string[]; permissions?: string[] };
type ProviderPrincipal = { membershipId: string; teamId: string; capacityProviderId: string; scopes: string[] };
type ProviderAuth = { principal?: ProviderPrincipal } | null | undefined;
type OwnerStore = CapacityGovernanceDatabase & {
	principalCanAccessTeam(principal: UserPrincipal, teamId: string): Promise<boolean>;
	principalCanManageTeam(principal: UserPrincipal, teamId: string): Promise<boolean>;
};

function parsed<T>(value: unknown): T {
	return JSON.parse(String(value)) as T;
}

function etag(value: unknown) {
	return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function limit(value: unknown) {
	const candidate = Number(value ?? 50);
	return Number.isInteger(candidate) ? Math.min(100, Math.max(1, candidate)) : 50;
}

function requireProvider(auth: unknown, requiredScopes: string[]): ProviderPrincipal {
	const principal = (auth as ProviderAuth)?.principal;
	if (!principal) throw new CapacityGovernanceError('provider_access_token_required', 'Provider membership access token is required.', 401);
	const missingScopes = requiredScopes.filter((scope) => !principal.scopes.includes(scope));
	if (missingScopes.length) throw new CapacityGovernanceError('provider_scope_required', 'Provider token does not include the required scope.', 403, { requiredScopes, missingScopes });
	return principal;
}

export function createProviderEnvironmentService(store: OwnerStore) {
	const requireUser = (principal: UserPrincipal | null | undefined) => {
		if (!principal) throw new CapacityGovernanceError('authentication_required', 'An authenticated team principal is required.', 401);
		return principal;
	};
	const requireRead = async (principal: UserPrincipal | null | undefined, teamId: string) => {
		const actor = requireUser(principal);
		if (!await store.principalCanAccessTeam(actor, teamId)) throw new CapacityGovernanceError('provider_team_access_denied', 'The principal cannot read this team provider.', 403);
		return actor;
	};
	const requireManage = async (principal: UserPrincipal | null | undefined, teamId: string) => {
		const actor = requireUser(principal);
		if (!await store.principalCanManageTeam(actor, teamId)) throw new CapacityGovernanceError('provider_team_management_denied', 'The principal cannot manage this team provider.', 403);
		return actor;
	};
	const profile = async (providerId: string, profileId: string) => {
		await store.ensureInitialized();
		const row = await store.first(`SELECT descriptor_json FROM capacity_provider_environment_profiles WHERE capacity_provider_id = ? AND profile_id = ?`, [providerId, profileId]);
		if (!row) throw new CapacityGovernanceError('provider_environment_profile_not_found', 'The provider environment profile was not found.', 404);
		return providerEnvironmentProfileDescriptorSchema.parse(parsed(row.descriptor_json));
	};
	const activeGrant = async (teamId: string, assignmentId: string) => {
		await store.ensureInitialized();
		const row = await store.first(`SELECT grant_json FROM capacity_assignment_environment_grants WHERE team_id = ? AND assignment_id = ? AND revoked_at IS NULL`, [teamId, assignmentId]);
		if (!row) throw new CapacityGovernanceError('assignment_environment_grant_not_found', 'The assignment environment grant was not found.', 404);
		return assignmentEnvironmentGrantSchema.parse(parsed(row.grant_json));
	};
	return {
		async publish(auth: unknown, profileId: string, body: Record<string, unknown>) {
			const principal = requireProvider(auth, ['provider:availability:write']);
			const descriptor = providerEnvironmentProfileDescriptorSchema.parse(body);
			if (descriptor.id !== profileId) throw new CapacityGovernanceError('provider_environment_profile_path_mismatch', 'The profile ID must match the request path.', 400);
			const membership = await store.first(`SELECT status FROM capacity_provider_team_memberships WHERE id = ? AND team_id = ? AND capacity_provider_id = ?`, [principal.membershipId, principal.teamId, principal.capacityProviderId]);
			if (membership?.status !== 'approved') throw new CapacityGovernanceError('provider_membership_not_approved', 'An approved provider membership is required.', 403);
			const current = await store.first(`SELECT generation, descriptor_json FROM capacity_provider_environment_profiles WHERE capacity_provider_id = ? AND profile_id = ?`, [principal.capacityProviderId, profileId]);
			if (current && Number(current.generation) > descriptor.generation) throw new CapacityGovernanceError('provider_environment_profile_stale', 'The profile generation is older than the published generation.', 409);
			if (current && Number(current.generation) === descriptor.generation) {
				const existing = providerEnvironmentProfileDescriptorSchema.parse(parsed(current.descriptor_json));
				if (JSON.stringify(existing) !== JSON.stringify(descriptor)) throw new CapacityGovernanceError('provider_environment_profile_generation_conflict', 'The profile generation is already bound to another descriptor.', 409);
				return existing;
			}
			await store.run(`INSERT INTO capacity_provider_environment_profiles (capacity_provider_id, profile_id, generation, descriptor_json, updated_at) VALUES (?, ?, ?, ?, ?)
				ON CONFLICT (capacity_provider_id, profile_id) DO UPDATE SET generation = EXCLUDED.generation, descriptor_json = EXCLUDED.descriptor_json, updated_at = EXCLUDED.updated_at`,
			[principal.capacityProviderId, profileId, descriptor.generation, JSON.stringify(descriptor), descriptor.updatedAt]);
			return descriptor;
		},
		async list(principal: UserPrincipal | null | undefined, teamId: string, providerId: string, query: Record<string, unknown>) {
			await requireRead(principal, teamId);
			const membership = await store.first(`SELECT id FROM capacity_provider_team_memberships WHERE team_id = ? AND capacity_provider_id = ?`, [teamId, providerId]);
			if (!membership) throw new CapacityGovernanceError('provider_not_found', 'The team capacity provider was not found.', 404);
			const cursor = typeof query.cursor === 'string' ? query.cursor : '';
			const pageLimit = limit(query.limit);
			const rows = await store.all(`SELECT profile_id, descriptor_json FROM capacity_provider_environment_profiles WHERE capacity_provider_id = ? AND profile_id > ? ORDER BY profile_id ASC LIMIT ?`, [providerId, cursor, pageLimit + 1]);
			const items = rows.slice(0, pageLimit).map((row) => providerEnvironmentProfileDescriptorSchema.parse(parsed(row.descriptor_json)));
			return { items, nextCursor: rows.length > pageLimit ? String(rows[pageLimit - 1]?.profile_id) : null };
		},
		async show(principal: UserPrincipal | null | undefined, teamId: string, providerId: string, profileId: string) {
			await requireRead(principal, teamId);
			const membership = await store.first(`SELECT id FROM capacity_provider_team_memberships WHERE team_id = ? AND capacity_provider_id = ?`, [teamId, providerId]);
			if (!membership) throw new CapacityGovernanceError('provider_not_found', 'The team capacity provider was not found.', 404);
			return profile(providerId, profileId);
		},
		async showGrant(principal: UserPrincipal | null | undefined, teamId: string, assignmentId: string) {
			await requireRead(principal, teamId);
			return activeGrant(teamId, assignmentId);
		},
		async putGrant(principal: UserPrincipal | null | undefined, teamId: string, assignmentId: string, body: Record<string, unknown>, ifMatch?: string) {
			await requireManage(principal, teamId);
			const grant = assignmentEnvironmentGrantSchema.parse(body);
			if (grant.teamId !== teamId || grant.assignmentId !== assignmentId) throw new CapacityGovernanceError('assignment_environment_grant_path_mismatch', 'Grant team and assignment IDs must match the request path.', 400);
			const assignment = await store.first(`SELECT team_id, project_id, capacity_provider_id FROM capacity_provider_assignments WHERE id = ?`, [assignmentId]);
			if (!assignment) throw new CapacityGovernanceError('capacity_assignment_not_found', 'The capacity assignment was not found.', 404);
			if (String(assignment.team_id) !== teamId || String(assignment.project_id) !== grant.projectId || String(assignment.capacity_provider_id) !== grant.providerId) throw new CapacityGovernanceError('assignment_environment_grant_authority_mismatch', 'The grant does not match the assignment authority.', 409);
			const descriptor = await profile(grant.providerId, grant.profileId);
			const available = new Set(descriptor.variables.filter((entry) => entry.available).map((entry) => entry.name));
			const unavailable = grant.variables.filter((name) => !available.has(name));
			if (unavailable.length) throw new CapacityGovernanceError('assignment_environment_variables_unavailable', 'The provider has not offered every granted environment variable.', 409, { unavailable });
			const currentRow = await store.first(`SELECT grant_json FROM capacity_assignment_environment_grants WHERE assignment_id = ? AND revoked_at IS NULL`, [assignmentId]);
			const current = currentRow ? assignmentEnvironmentGrantSchema.parse(parsed<AssignmentEnvironmentGrant>(currentRow.grant_json)) : null;
			if ((!current && ifMatch !== 'new') || (current && ifMatch !== etag(current))) throw new CapacityGovernanceError('assignment_environment_grant_precondition_failed', 'The environment grant changed after it was loaded.', 412);
			const now = new Date().toISOString();
			await store.run(`INSERT INTO capacity_assignment_environment_grants (assignment_id, grant_id, team_id, project_id, capacity_provider_id, profile_id, grant_json, issued_at, expires_at, revoked_at, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
				ON CONFLICT (assignment_id) DO UPDATE SET grant_id = EXCLUDED.grant_id, team_id = EXCLUDED.team_id, project_id = EXCLUDED.project_id, capacity_provider_id = EXCLUDED.capacity_provider_id, profile_id = EXCLUDED.profile_id, grant_json = EXCLUDED.grant_json, issued_at = EXCLUDED.issued_at, expires_at = EXCLUDED.expires_at, revoked_at = NULL, updated_at = EXCLUDED.updated_at`,
			[assignmentId, grant.grantId, teamId, grant.projectId, grant.providerId, grant.profileId, JSON.stringify(grant), grant.issuedAt, grant.expiresAt, now, now]);
			return grant;
		},
		async revokeGrant(principal: UserPrincipal | null | undefined, teamId: string, assignmentId: string, ifMatch?: string) {
			await requireManage(principal, teamId);
			const grant = await activeGrant(teamId, assignmentId);
			if (ifMatch !== etag(grant)) throw new CapacityGovernanceError('assignment_environment_grant_precondition_failed', 'The environment grant changed after it was loaded.', 412);
			const now = new Date().toISOString();
			await store.run(`UPDATE capacity_assignment_environment_grants SET revoked_at = ?, updated_at = ? WHERE team_id = ? AND assignment_id = ? AND revoked_at IS NULL`, [now, now, teamId, assignmentId]);
			return { ...grant, revokedAt: now };
		},
	};
}

export type ProviderEnvironmentService = ReturnType<typeof createProviderEnvironmentService>;

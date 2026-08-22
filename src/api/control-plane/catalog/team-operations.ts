import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { ControlPlaneOperationError, type BoundOperation } from './operation-registry.ts';

export interface TeamOperationDependencies {
	store: {
		listTeamsForPrincipal(principal: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
		loadTeamProfileByName(name: string, principal: Record<string, unknown>): Promise<Record<string, unknown> | null>;
		getTeam(teamId: string): Promise<Record<string, unknown> | null>;
		principalCanAccessTeam(principal: Record<string, unknown>, teamId: string): Promise<boolean>;
		getTeamAccessSummary(teamId: string, principal: Record<string, unknown>): Promise<Record<string, unknown>>;
		resolvePrincipalTeamContext(teamId: string, principal: Record<string, unknown>): Promise<{ roles?: string[] } | null>;
		listTeamMembers(teamId: string): Promise<Array<Record<string, any>>>;
		listTeamInvites(teamId: string): Promise<Array<Record<string, unknown>>>;
	};
}

function authenticatedPrincipal(context: { principal?: Record<string, any> }) {
	if (!context.principal) throw new ControlPlaneOperationError(401, 'authentication_required', 'Authentication is required.');
	return context.principal;
}

async function requireTeamRead(dependencies: TeamOperationDependencies, teamId: string, context: { principal?: Record<string, any> }) {
	const principal = authenticatedPrincipal(context);
	const team = await dependencies.store.getTeam(teamId);
	if (!team) throw new ControlPlaneOperationError(404, 'team_missing', 'The team was not found.');
	if (!await dependencies.store.principalCanAccessTeam(principal, teamId)) {
		throw new ControlPlaneOperationError(403, 'team_forbidden', 'The principal cannot access this team.');
	}
	return { principal, team };
}

async function requireTeamManagement(dependencies: TeamOperationDependencies, teamId: string, context: { principal?: Record<string, any> }) {
	const access = await requireTeamRead(dependencies, teamId, context);
	if (access.principal.roles?.some((role: string) => role === 'admin' || role === 'platform_admin')) return access;
	const membership = await dependencies.store.resolvePrincipalTeamContext(teamId, access.principal);
	if (!membership?.roles?.some((role) => role === 'team_owner' || role === 'project_lead')) {
		throw new ControlPlaneOperationError(403, 'team_role_forbidden', 'Team management authority is required.');
	}
	return access;
}

export function createTeamsListOperation(
	dependencies: TeamOperationDependencies,
): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.teams.list> {
	return {
		binding: CONTROL_PLANE_OPERATIONS.teams.list,
		async handler(_input, context) {
			if (!context.principal) throw new ControlPlaneOperationError(401, 'authentication_required', 'Authentication is required.');
			return { teams: await dependencies.store.listTeamsForPrincipal(context.principal) };
		},
	};
}

export function createTeamProfileOperation(
	dependencies: TeamOperationDependencies,
): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.teams.profile> {
	return {
		binding: CONTROL_PLANE_OPERATIONS.teams.profile,
		async handler(input, context) {
			if (!context.principal) throw new ControlPlaneOperationError(401, 'authentication_required', 'Authentication is required.');
			const profile = await dependencies.store.loadTeamProfileByName(input.path.name, context.principal);
			if (!profile) throw new ControlPlaneOperationError(404, 'team_profile_not_found', 'The team profile was not found.');
			return profile;
		},
	};
}

export function createTeamAccessOperation(dependencies: TeamOperationDependencies): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.teams.access> {
	return {
		binding: CONTROL_PLANE_OPERATIONS.teams.access,
		async handler(input, context) {
			const access = await requireTeamRead(dependencies, input.path.teamId, context);
			return { team: access.team, access: await dependencies.store.getTeamAccessSummary(input.path.teamId, access.principal) };
		},
	};
}

export function createTeamMembersOperation(dependencies: TeamOperationDependencies): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.teams.members> {
	return {
		binding: CONTROL_PLANE_OPERATIONS.teams.members,
		async handler(input, context) {
			await requireTeamRead(dependencies, input.path.teamId, context);
			const members = await dependencies.store.listTeamMembers(input.path.teamId);
			const query = String(input.query.q ?? '').trim().toLowerCase();
			const filtered = query ? members.filter((member) => `${member.displayName ?? ''} ${member.email ?? ''} ${member.roleKey ?? ''}`.toLowerCase().includes(query)) : members;
			const limit = Math.min(100, Math.max(1, Number(input.query.limit ?? 50) || 50));
			const offset = Math.max(0, Number(input.query.cursor ?? 0) || 0);
			const nextOffset = offset + limit;
			return { items: filtered.slice(offset, nextOffset), total: filtered.length,
				ownerCount: members.filter((member) => member.roles?.includes('team_owner')).length,
				cursor: nextOffset < filtered.length ? String(nextOffset) : null };
		},
	};
}

export function createTeamInvitesOperation(dependencies: TeamOperationDependencies): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.teams.invites> {
	return {
		binding: CONTROL_PLANE_OPERATIONS.teams.invites,
		async handler(input, context) {
			await requireTeamManagement(dependencies, input.path.teamId, context);
			const invites = await dependencies.store.listTeamInvites(input.path.teamId);
			const limit = Math.min(100, Math.max(1, Number(input.query.limit ?? 50) || 50));
			const offset = Math.max(0, Number(input.query.cursor ?? 0) || 0);
			const nextOffset = offset + limit;
			return { items: invites.slice(offset, nextOffset), total: invites.length, cursor: nextOffset < invites.length ? String(nextOffset) : null };
		},
	};
}

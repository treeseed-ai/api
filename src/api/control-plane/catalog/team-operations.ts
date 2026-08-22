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
		getTeamInviteByToken(token: string): Promise<Record<string, any>>;
		acceptTeamInvite(token: string, principalId: string): Promise<Record<string, any>>;
		first(query: string, parameters?: unknown[]): Promise<Record<string, any> | null>;
		createTeam(input: Record<string, unknown>): Promise<Record<string, any>>;
		getTeamDeletionReadiness(teamId: string): Promise<Record<string, any>>;
		recordAuditEvent(event: Record<string, unknown>): Promise<unknown>;
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

async function requireTeamOwner(dependencies: TeamOperationDependencies, teamId: string, context: { principal?: Record<string, any> }) {
	const access = await requireTeamRead(dependencies, teamId, context);
	if (access.principal.roles?.some((role: string) => role === 'admin' || role === 'platform_admin')) return access;
	const membership = await dependencies.store.resolvePrincipalTeamContext(teamId, access.principal);
	if (!membership?.roles?.includes('team_owner')) throw new ControlPlaneOperationError(403, 'team_owner_required', 'Team owner authority is required.');
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

export function createTeamInviteShowOperation(dependencies: TeamOperationDependencies): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.teams.inviteShow> {
	return {
		binding: CONTROL_PLANE_OPERATIONS.teams.inviteShow,
		async handler(input) {
			const result = await dependencies.store.getTeamInviteByToken(input.path.token);
			if (!result.ok) throw new ControlPlaneOperationError(404, 'team_invite_missing', 'The team invitation was not found.');
			return { invite: { id: result.invite.id, email: result.invite.email, roleKey: result.invite.roleKey,
				status: result.invite.status, expiresAt: result.invite.expiresAt },
				team: result.team ? { id: result.team.id, name: result.team.name, displayName: result.team.displayName } : null };
		},
	};
}

export function createTeamInviteAcceptOperation(dependencies: TeamOperationDependencies): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.teams.inviteAccept> {
	return {
		binding: CONTROL_PLANE_OPERATIONS.teams.inviteAccept,
		async handler(input, context) {
			const principal = authenticatedPrincipal(context);
			const result = await dependencies.store.acceptTeamInvite(input.path.token, principal.id);
			if (!result.ok) throw new ControlPlaneOperationError(
				['stale', 'stale_or_expired', 'already_accepted'].includes(String(result.code)) ? 409 : 400,
				String(result.code ?? 'team_invite_invalid'), 'The team invitation could not be accepted.');
			await dependencies.store.recordAuditEvent({ actorType: 'user', actorId: principal.id,
				eventType: 'team.invitation.accepted', targetType: 'team', targetId: result.team?.id ?? result.invite?.teamId ?? null,
				data: { invitationId: result.invite?.id ?? null } });
			return result;
		},
	};
}

export function createTeamCreateOperation(dependencies: TeamOperationDependencies): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.teams.create> {
	return {
		binding: CONTROL_PLANE_OPERATIONS.teams.create,
		async handler(input, context) {
			const principal = authenticatedPrincipal(context);
			if (principal.roles?.some((role: string) => role === 'team_api_key' || role === 'project_api')) {
				throw new ControlPlaneOperationError(403, 'team_creation_forbidden', 'This credential cannot create teams.');
			}
			const verified = await dependencies.store.first(
				"SELECT COUNT(*) AS count FROM user_email_addresses WHERE user_id = ? AND status = 'verified'", [principal.id]);
			if (Number(verified?.count ?? 0) < 1) throw new ControlPlaneOperationError(403, 'verified_email_required', 'Verify an email address before creating a team.');
			const body = input.body as Record<string, any>;
			const name = String(body.slug ?? body.name ?? '').trim();
			if (!name) throw new ControlPlaneOperationError(400, 'invalid_team', 'A team name is required.');
			try {
				const team = await dependencies.store.createTeam({ name,
					displayName: typeof body.displayName === 'string' ? body.displayName : typeof body.label === 'string' ? body.label : name,
					logoUrl: typeof body.logoUrl === 'string' ? body.logoUrl : null,
					profileSummary: typeof body.profileSummary === 'string' ? body.profileSummary : typeof body.description === 'string' ? body.description : null,
					metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {}, ownerUserId: principal.id });
				await dependencies.store.recordAuditEvent({ actorType: 'user', actorId: principal.id, eventType: 'team.created', targetType: 'team', targetId: team.id, data: { name: team.name } });
				return team;
			} catch (error) {
				const message = error instanceof Error ? error.message : 'The team could not be created.';
				const conflict = /already taken|already used/u.test(message);
				throw new ControlPlaneOperationError(conflict ? 409 : 400, conflict ? 'namespace_taken' : 'invalid_team', message);
			}
		},
	};
}

export function createTeamDeletionReadinessOperation(dependencies: TeamOperationDependencies): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.teams.deletionReadiness> {
	return {
		binding: CONTROL_PLANE_OPERATIONS.teams.deletionReadiness,
		async handler(input, context) {
			await requireTeamOwner(dependencies, input.path.teamId, context);
			return dependencies.store.getTeamDeletionReadiness(input.path.teamId);
		},
	};
}

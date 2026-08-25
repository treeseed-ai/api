import { CapacityOperationError } from './capacity-operation-error.ts';

export type CapacityPrincipal = { id: string; roles?: string[]; permissions?: string[] } | undefined;

export async function authorizeCapacityTeam(store: any, principal: CapacityPrincipal, teamId: string, permission: string) {
	if (!principal) throw new CapacityOperationError(401, 'authentication_required', 'Authentication is required.');
	const administrator = principal.roles?.some((role) => role === 'admin' || role === 'platform_admin')
		|| principal.permissions?.includes('*:*:*') || false;
	if (!administrator && !await store.principalCanAccessTeam(principal, teamId)) {
		throw new CapacityOperationError(403, 'team_access_denied', 'The principal cannot access this team.');
	}
	const access = administrator ? { permissions: ['*:*:*'] } : await store.getTeamAccessSummary(teamId, principal);
	if (!administrator && !access.permissions.includes(permission)) {
		throw new CapacityOperationError(403, 'capacity_permission_denied', `${permission} authority is required.`);
	}
	return principal;
}

export async function authorizeCapacityProject(store: any, principal: CapacityPrincipal, projectId: string, permission: string) {
	const details = await store.getProjectDetails(projectId);
	if (!details?.project?.teamId) throw new CapacityOperationError(404, 'project_not_found', 'Project not found.');
	await authorizeCapacityTeam(store, principal, details.project.teamId, permission);
	return details;
}

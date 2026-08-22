import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { ControlPlaneOperationError, type BoundOperation } from './operation-registry.ts';

export interface ProjectOperationDependencies {
	store: {
		listProjectsForPrincipal(principal: Record<string, unknown>): Promise<Array<Record<string, any>>>;
		listTeamProjects(teamId: string): Promise<Array<Record<string, any>>>;
		principalCanAccessTeam(principal: Record<string, unknown>, teamId: string): Promise<boolean>;
	};
}

function visibleProjects(projects: Array<Record<string, any>>) {
	return projects.filter((project) => project.metadata?.inventory?.status !== 'archived');
}

export function createProjectsListOperation(dependencies: ProjectOperationDependencies): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.projects.list> {
	return {
		binding: CONTROL_PLANE_OPERATIONS.projects.list,
		async handler(input, context) {
			const principal = context.principal;
			if (!principal) throw new ControlPlaneOperationError(401, 'authentication_required', 'Authentication is required.');
			if (!input.query.teamId) return { projects: visibleProjects(await dependencies.store.listProjectsForPrincipal(principal)) };
			const administrator = principal.roles?.some((role) => role === 'admin' || role === 'platform_admin')
				|| principal.permissions?.includes('*:*:*');
			if (!administrator && !await dependencies.store.principalCanAccessTeam(principal, input.query.teamId)) {
				throw new ControlPlaneOperationError(403, 'team_access_denied', 'The principal cannot access this team.');
			}
			if (principal.roles?.includes('team_api_key')
				&& !principal.permissions?.some((permission) => permission === '*:*:*' || permission === 'projects:read:team')) {
				throw new ControlPlaneOperationError(403, 'team_permission_denied', 'The credential cannot read team projects.');
			}
			return { projects: visibleProjects(await dependencies.store.listTeamProjects(input.query.teamId)) };
		},
	};
}

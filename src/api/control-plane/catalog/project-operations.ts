import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { ControlPlaneOperationError, type BoundOperation } from './operation-registry.ts';

export interface ProjectOperationDependencies {
	store: {
		listProjectsForPrincipal(principal: Record<string, unknown>): Promise<Array<Record<string, any>>>;
		listTeamProjects(teamId: string): Promise<Array<Record<string, any>>>;
		principalCanAccessTeam(principal: Record<string, unknown>, teamId: string): Promise<boolean>;
		getProjectDetails(projectId: string): Promise<Record<string, any> | null>;
		getProjectAccessSummary(projectId: string, principal: Record<string, unknown>): Promise<Record<string, unknown>>;
		getProjectSummary(projectId: string, principal: Record<string, unknown>): Promise<Record<string, unknown>>;
	};
}

function visibleProjects(projects: Array<Record<string, any>>) {
	return projects.filter((project) => project.metadata?.inventory?.status !== 'archived');
}

async function projectAccess(dependencies: ProjectOperationDependencies, projectId: string, context: { principal?: Record<string, any> }) {
	const principal = context.principal;
	if (!principal) throw new ControlPlaneOperationError(401, 'authentication_required', 'Authentication is required.');
	const details = await dependencies.store.getProjectDetails(projectId);
	if (!details?.project) throw new ControlPlaneOperationError(404, 'project_not_found', 'The project was not found.');
	const administrator = principal.roles?.some((role: string) => role === 'admin' || role === 'platform_admin')
		|| principal.permissions?.includes('*:*:*');
	if (!administrator && !await dependencies.store.principalCanAccessTeam(principal, details.project.teamId)) {
		throw new ControlPlaneOperationError(403, 'project_access_denied', 'The principal cannot access this project.');
	}
	if (principal.roles?.includes('team_api_key')
		&& !principal.permissions?.some((permission: string) => permission === '*:*:*' || permission === 'projects:read:team')) {
		throw new ControlPlaneOperationError(403, 'project_permission_denied', 'The credential cannot read this project.');
	}
	return { principal, details };
}

export function createProjectShowOperation(dependencies: ProjectOperationDependencies): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.projects.show> {
	return {
		binding: CONTROL_PLANE_OPERATIONS.projects.show,
		async handler(input, context) {
			return (await projectAccess(dependencies, input.path.projectId, context)).details;
		},
	};
}

export function createProjectAccessOperation(dependencies: ProjectOperationDependencies): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.projects.access> {
	return {
		binding: CONTROL_PLANE_OPERATIONS.projects.access,
		async handler(input, context) {
			const access = await projectAccess(dependencies, input.path.projectId, context);
			return dependencies.store.getProjectAccessSummary(input.path.projectId, access.principal);
		},
	};
}

export function createProjectSummaryOperation(dependencies: ProjectOperationDependencies): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.projects.summary> {
	return {
		binding: CONTROL_PLANE_OPERATIONS.projects.summary,
		async handler(input, context) {
			const access = await projectAccess(dependencies, input.path.projectId, context);
			return dependencies.store.getProjectSummary(input.path.projectId, access.principal);
		},
	};
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

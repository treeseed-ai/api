import { KnowledgeOperationError } from './knowledge-operation-error.ts';

export type KnowledgePrincipal = { id: string; roles?: string[]; permissions?: string[] } | undefined;

export function createKnowledgeAuthorization(store: any) {
	async function team(principal: KnowledgePrincipal, teamId: string, permission: string) {
		if (!principal) throw new KnowledgeOperationError(401, 'authentication_required', 'Authentication is required.');
		const administrator = principal.roles?.some((role) => ['admin', 'platform_admin'].includes(role))
			|| principal.permissions?.includes('*:*:*') || false;
		if (!administrator && !await store.principalCanAccessTeam(principal, teamId)) {
			throw new KnowledgeOperationError(403, 'knowledge_access_denied', 'The principal cannot access this team.');
		}
		const summary = administrator ? { permissions: ['*:*:*'] } : await store.getTeamAccessSummary(teamId, principal);
		if (!administrator && !summary.permissions.includes(permission)) {
			throw new KnowledgeOperationError(403, 'knowledge_permission_denied', `${permission} authority is required.`);
		}
		return { principal, teamId, administrator, permissions: new Set<string>(summary.permissions) };
	}

	async function project(principal: KnowledgePrincipal, projectId: string, permission: string) {
		const details = await store.getProjectDetails(projectId);
		if (!details?.project) throw new KnowledgeOperationError(404, 'project_not_found', 'The project was not found.');
		return { ...await team(principal, details.project.teamId, permission), project: details.project };
	}

	return { team, project };
}

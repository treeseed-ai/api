import { decodeCapacityPageCursor, normalizeCapacityPageLimit } from '@treeseed/sdk/capacity-pagination';
import { authorizeCapacityProject, type CapacityPrincipal } from './capacity-authorization.ts';
import { CapacityOperationError } from './capacity-operation-error.ts';

function page(query: Record<string, unknown>) {
	try { return { limit: normalizeCapacityPageLimit(query.limit), cursor: decodeCapacityPageCursor(query.cursor) }; }
	catch (error) { throw new CapacityOperationError(400, 'capacity_page_invalid', error instanceof Error ? error.message : String(error)); }
}
function artifactId(value: any) { return String(value?.id ?? value?.taskId ?? ''); }

export function createAgentQueryService(store: any) {
	return {
		async list(principal: CapacityPrincipal, projectId: string) {
			await authorizeCapacityProject(store, principal, projectId, 'projects:read:team');
			return await store.getProjectAgentsSummary(projectId, principal) ?? { projectId, agents: [] };
		},
		async show(principal: CapacityPrincipal, projectId: string, slug: string) {
			await authorizeCapacityProject(store, principal, projectId, 'projects:read:team');
			const summary = await store.getProjectAgentsSummary(projectId, principal);
			const agent = Array.isArray(summary?.agents)
				? summary.agents.find((item: any) => String(item?.agentSlug ?? item?.slug ?? '') === slug) : null;
			if (!agent) throw new CapacityOperationError(404, 'project_agent_not_found', 'Project agent not found.');
			return { projectId, agent };
		},
		async classes(principal: CapacityPrincipal, projectId: string, query: Record<string, unknown>) {
			await authorizeCapacityProject(store, principal, projectId, 'projects:read:team');
			return store.listProjectAgentClassesPage(projectId, page(query));
		},
		async classShow(principal: CapacityPrincipal, projectId: string, classId: string) {
			await authorizeCapacityProject(store, principal, projectId, 'projects:read:team');
			const result = await store.getProjectAgentClass(projectId, classId);
			if (!result) throw new CapacityOperationError(404, 'project_agent_class_not_found', 'Project agent class not found.');
			return result;
		},
		async artifacts(principal: CapacityPrincipal, projectId: string) {
			await authorizeCapacityProject(store, principal, projectId, 'projects:read:team');
			return { projectId, items: await store.collectControlPlaneGeneratedArtifacts(projectId), warnings: [] };
		},
		async artifact(principal: CapacityPrincipal, projectId: string, id: string) {
			await authorizeCapacityProject(store, principal, projectId, 'projects:read:team');
			const artifact = (await store.collectControlPlaneGeneratedArtifacts(projectId)).find((item: any) => artifactId(item) === id);
			if (!artifact) throw new CapacityOperationError(404, 'agent_artifact_not_found', 'Agent artifact not found.');
			return { projectId, artifact };
		},
	};
}

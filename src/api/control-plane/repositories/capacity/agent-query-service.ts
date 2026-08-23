import { decodeCapacityPageCursor, normalizeCapacityPageLimit } from '@treeseed/sdk/capacity-pagination';
import { authorizeCapacityProject, type CapacityPrincipal } from './capacity-authorization.ts';
import { CapacityOperationError } from './capacity-operation-error.ts';

function page(query: Record<string, unknown>) {
	try { return { limit: normalizeCapacityPageLimit(query.limit), cursor: decodeCapacityPageCursor(query.cursor) }; }
	catch (error) { throw new CapacityOperationError(400, 'capacity_page_invalid', error instanceof Error ? error.message : String(error)); }
}
function artifactId(value: any) { return String(value?.id ?? value?.taskId ?? ''); }
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

async function acceptedAgents(store: any, projectId: string) {
	const page = await store.listProjectAgentClassesPage(projectId, { limit: 200, cursor: null });
	return (Array.isArray(page?.items) ? page.items : []).flatMap((agentClass: any) => {
		const agents = record(agentClass.handlerRefs).agents;
		return Array.isArray(agents) ? agents.map(record).filter((agent) => agent.enabled !== false).map((agent) => ({
			agentSlug: String(agent.slug ?? agent.agentId ?? ''), name: String(agent.name ?? agent.title ?? agent.slug ?? agent.agentId ?? ''),
			projectAgentClassId: agentClass.id, allocationClass: agentClass.slug, definitionRevision: String(record(agentClass.metadata).immutableRef ?? agentClass.updatedAt ?? ''),
			activities: record(agent.activities), chatEnabled: record(record(agent.activities).chat).enabled !== false && Boolean(record(record(agent.activities).chat).handler),
			status: agentClass.status === 'active' ? 'ready' : agentClass.status,
		})) : [];
	}).filter((agent: any) => agent.agentSlug);
}

export function createAgentQueryService(store: any) {
	return {
		async list(principal: CapacityPrincipal, projectId: string) {
			await authorizeCapacityProject(store, principal, projectId, 'projects:read:team');
			const [definitions, runtime] = await Promise.all([acceptedAgents(store, projectId), store.getProjectAgentsSummary(projectId, principal)]);
			const runtimeBySlug = new Map((Array.isArray(runtime?.agents) ? runtime.agents : []).map((agent: any) => [String(agent.agentSlug ?? agent.slug ?? ''), agent]));
			return { projectId, agents: definitions.map((agent: any) => ({ ...agent, runtime: runtimeBySlug.get(agent.agentSlug) ?? null })) };
		},
		async show(principal: CapacityPrincipal, projectId: string, slug: string) {
			await authorizeCapacityProject(store, principal, projectId, 'projects:read:team');
			const agent = (await acceptedAgents(store, projectId)).find((item: any) => item.agentSlug === slug);
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

import { decodeCapacityPageCursor, normalizeCapacityPageLimit } from '@treeseed/sdk/capacity-pagination';
import { authorizeCapacityProject, type CapacityPrincipal } from './capacity-authorization.ts';
import { CapacityOperationError } from './capacity-operation-error.ts';
import { validateAgentDefinitionModel, type AgentDefinition } from '@treeseed/sdk/agent-capacity';
import { AgentTeamCloneService } from '../../../capacity/services/capacity/agents/team-clone/agent-team-clone-service.ts';

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
		return Array.isArray(agents) ? agents.flatMap((value) => {
			const parsed = validateAgentDefinitionModel(value);
			return parsed.ok && parsed.data ? [parsed.data] : [];
		}).map((agent) => ({
			agentSlug: agent.id.split('/').at(-1) ?? agent.id, name: agent.name,
			projectAgentClassId: agentClass.id, allocationClass: agentClass.slug, definitionRevision: String(record(agentClass.metadata).immutableRef ?? agentClass.updatedAt ?? ''),
			definition: agent, activities: agent.activityProfiles, chatEnabled: Boolean(agent.activityProfiles.chat),
			effectiveActivities: Object.fromEntries(Object.entries(agent.activityProfiles).map(([activity, profile]) => [activity, {
				handler: profile.handler, origin: profile.handler.includes('/') ? 'project-runtime' : 'agent-package',
				prompt: profile.prompt, context: [...agent.context.include, ...(profile.additionalContext ?? [])],
				permissions: profile.permissions, dependsOn: profile.dependsOn ?? null,
			}])),
			status: agentClass.status === 'active' ? 'ready' : agentClass.status,
		})) : [];
	}).filter((agent: any) => agent.agentSlug);
}

export function createAgentQueryService(store: any) {
	const teamClone = new AgentTeamCloneService(store);
	return {
		planTeamClone(principal: CapacityPrincipal, teamId: string, input: any) { return teamClone.plan(principal, teamId, input); },
		applyTeamClone(principal: CapacityPrincipal, teamId: string, input: any) { return teamClone.apply(principal, teamId, input); },
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
		async handlers(principal: CapacityPrincipal, projectId: string) {
			await authorizeCapacityProject(store, principal, projectId, 'projects:read:team');
			const agents = await acceptedAgents(store, projectId);
			const handlers = [...new Map(agents.flatMap((agent: any) => Object.values(agent.definition.activityProfiles as AgentDefinition['activityProfiles']))
				.map((profile: any) => [profile.handler, { id: profile.handler,
					origin: String(profile.handler).includes('/') ? 'project-runtime' : 'agent-package' }])).values()];
			return { projectId, handlers };
		},
		async handler(principal: CapacityPrincipal, projectId: string, handlerId: string) {
			const result = await this.handlers(principal, projectId);
			const handler = result.handlers.find((candidate: any) => candidate.id === handlerId);
			if (!handler) throw new CapacityOperationError(404, 'agent_handler_not_found', 'Agent handler not found in the selected project runtime.');
			return { projectId, handler };
		},
		async validateProfile(principal: CapacityPrincipal, projectId: string, slug: string) {
			const result = await this.show(principal, projectId, slug);
			return { projectId, agentSlug: slug, valid: true, definition: result.agent.definition };
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

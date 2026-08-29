import { CapacityGovernanceError } from '../../../database.ts';

type Row = Record<string, unknown>;

export interface CommunicationAddressInput {
	projectSlug: string | null;
	agentSlug: string;
	requirement: 'required' | 'optional';
	address: string;
}

export interface ResolvedCommunicationTarget {
	projectId: string;
	projectSlug: string;
	agentSlug: string;
	requirement: 'required' | 'optional';
}

function record(value: unknown): Row {
	if (value && typeof value === 'object' && !Array.isArray(value)) return value as Row;
	if (typeof value === 'string') try { return record(JSON.parse(value)); } catch { return {}; }
	return {};
}

function text(value: unknown, fallback = '') { return typeof value === 'string' && value.trim() ? value.trim() : fallback; }

function projectAgents(agentClasses: unknown[]) {
	return agentClasses.flatMap((candidate) => {
		const value = record(candidate);
		const handlers = record(value.handlerRefs ?? value.handler_refs_json);
		return Array.isArray(handlers.agents) ? handlers.agents.map(record) : [];
	}).filter((agent) => {
		const chat = record(record(agent.activities).chat);
		return agent.enabled !== false && chat.enabled !== false && Boolean(text(chat.handler));
	});
}

async function projectAgentClasses(store: any, projectId: string) {
	if (typeof store.listProjectAgentClassesPage === 'function') {
		const page = await store.listProjectAgentClassesPage(projectId, { limit: 200, cursor: null });
		return Array.isArray(page?.items) ? page.items : [];
	}
	if (typeof store.all === 'function') return store.all(
		"SELECT handler_refs_json FROM project_agent_classes WHERE project_id=? AND status='active' ORDER BY created_at,id", [projectId]);
	throw new CapacityGovernanceError('communication_agent_inventory_unavailable', 'Team agent inventory is unavailable.', 503);
}

export async function resolveTeamCommunicationTargets(store: any, teamId: string, addresses: CommunicationAddressInput[]) {
	const projects = (await store.listTeamProjects(teamId)).filter((project: Row) => !project.status || project.status === 'active');
	const inventory = await Promise.all(projects.map(async (project: Row) => {
		const classes = await projectAgentClasses(store, text(project.id));
		return { projectId: text(project.id), projectSlug: text(project.slug, text(project.id)), agents: projectAgents(classes) };
	}));
	const resolved = new Map<string, ResolvedCommunicationTarget>();
	for (const address of addresses) {
		const candidates = inventory.flatMap((project) => project.agents
			.filter((agent) => text(agent.slug ?? agent.agentId) === address.agentSlug)
			.filter(() => !address.projectSlug || [project.projectId, project.projectSlug].includes(address.projectSlug))
			.map(() => ({ projectId: project.projectId, projectSlug: project.projectSlug, agentSlug: address.agentSlug, requirement: address.requirement })));
		if (!candidates.length) throw new CapacityGovernanceError('communication_agent_not_found',
			`No chat-enabled team agent matches ${address.address}.`, 404, { address: address.address });
		for (const candidate of candidates) {
			const key = `${candidate.projectId}/${candidate.agentSlug}`; const existing = resolved.get(key);
			if (!existing || candidate.requirement === 'required') resolved.set(key, candidate);
		}
	}
	return [...resolved.values()].sort((left, right) => left.projectSlug.localeCompare(right.projectSlug) || left.agentSlug.localeCompare(right.agentSlug));
}

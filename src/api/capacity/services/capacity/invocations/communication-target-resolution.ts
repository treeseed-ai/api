import { CapacityGovernanceError } from '../../../database.ts';
import { validateAgentDefinitionModel } from '@treeseed/sdk/agent-capacity';
import { decodeCapacityPageCursor, type CapacityPageCursor } from '@treeseed/sdk/capacity-pagination';

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
	});
}

async function projectAgentClasses(store: any, projectId: string) {
	if (typeof store.listProjectAgentClassesPage === 'function') {
		const items: unknown[] = [], seen = new Set<string>();
		let cursor: CapacityPageCursor | null = null;
		do {
			const page = await store.listProjectAgentClassesPage(projectId, { limit: 200, cursor });
			if (!Array.isArray(page?.items)) throw new CapacityGovernanceError('communication_agent_inventory_unavailable', 'Team agent inventory is incomplete.', 503);
			items.push(...page.items);
			if (page.page?.hasMore !== true) return items;
			const next = text(page.page.nextCursor);
			if (!next || seen.has(next)) throw new CapacityGovernanceError('communication_agent_inventory_unavailable', 'Team agent inventory cursor did not advance.', 503);
			seen.add(next); cursor = decodeCapacityPageCursor(next);
		} while (cursor);
		throw new CapacityGovernanceError('communication_agent_inventory_unavailable', 'Team agent inventory is incomplete.', 503);
	}
	if (typeof store.all === 'function') return store.all(
		"SELECT handler_refs_json FROM project_agent_classes WHERE project_id=? ORDER BY created_at,id", [projectId]);
	throw new CapacityGovernanceError('communication_agent_inventory_unavailable', 'Team agent inventory is unavailable.', 503);
}

export async function resolveTeamCommunicationTargets(store: any, teamId: string, addresses: CommunicationAddressInput[]) {
	const projects: Row[] = await store.listTeamProjects(teamId);
	const inventory = await Promise.all(projects.map(async (project: Row) => {
		const classes = await projectAgentClasses(store, text(project.id));
		return { projectId: text(project.id), projectSlug: text(project.slug, text(project.id)), agents: projectAgents(classes) };
	}));
	const resolved = new Map<string, ResolvedCommunicationTarget>();
	for (const address of addresses) {
		const candidates = inventory.flatMap((project) => project.agents
			.filter((agent) => text(agent.id) === address.agentSlug || text(agent.id).endsWith(`/${address.agentSlug}`)
				|| Array.isArray(agent.groupIds) && agent.groupIds.includes(address.agentSlug))
			.filter(() => !address.projectSlug || [project.projectId, project.projectSlug].includes(address.projectSlug))
			.map((agent) => {
				const validation = validateAgentDefinitionModel(agent);
				if (!validation.ok || !validation.data) throw new CapacityGovernanceError('communication_agent_definition_invalid',
					`Addressed agent ${text(agent.id)} has an invalid governed definition.`, 409,
					{ projectId: project.projectId, address: address.address, diagnostics: validation.diagnostics });
				return { projectId: project.projectId, projectSlug: project.projectSlug,
					agentSlug: validation.data.id.split('/').at(-1)!, requirement: address.requirement };
			}));
		if (!candidates.length) throw new CapacityGovernanceError('communication_agent_not_found',
			`No team agent or group matches ${address.address}.`, 404, { address: address.address });
		for (const candidate of candidates) {
			const key = `${candidate.projectId}/${candidate.agentSlug}`; const existing = resolved.get(key);
			if (!existing || candidate.requirement === 'required') resolved.set(key, candidate);
		}
	}
	return [...resolved.values()].sort((left, right) => left.projectSlug.localeCompare(right.projectSlug) || left.agentSlug.localeCompare(right.agentSlug));
}

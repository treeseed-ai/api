import { MAX_CAPACITY_PAGE_LIMIT,type CapacityPage } from '@treeseed/sdk/capacity-pagination';
import { compileAgentPlanningGraph,normalizeWorkdayAgentSelection,validateAgentSignalContract,validateProposalTypeContract,validateGovernanceGroupGraph,validateGroupDefinition,validateGroupEdgeDefinition,type AgentPlanningGraph,type AgentSignalContract,type ProposalTypeContract,type GovernanceGroup,type GovernanceGroupEdge } from '@treeseed/sdk/agent-capacity';
import { createHash } from 'node:crypto';
import { CapacityGovernanceError } from '../../../../database.ts';
import { capacityWorkdayAgentsFromClasses,type CapacityWorkdayAgent } from './workday-agent-policy.ts';

type JsonRecord = Record<string, unknown>;

export interface WorkdayPlanningGraphStore {
	listProjectAgentClassesPage(projectId: string, filters: { limit: number }): Promise<CapacityPage<unknown>>;
}

export interface WorkdayPlanningGraphSnapshot {
	revision: string;
	agents: CapacityWorkdayAgent[];
	graph: AgentPlanningGraph;
	signalContracts: Record<string, AgentSignalContract>;
	proposalTypeContracts: Record<string, ProposalTypeContract>;
	groups: Record<string,GovernanceGroup>;
	groupEdges: Record<string,GovernanceGroupEdge>;
}

function record(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function profile(agent: CapacityWorkdayAgent) {
	const signals = record(agent.signalPolicy);
	return {
		id: agent.nodeId,
		agentId: agent.slug,
		activityType: agent.activityType,
		stage: typeof agent.planningIntent.stage === 'string' ? agent.planningIntent.stage : null,
		signals: {
			subscribesTo: Array.isArray(signals.subscribesTo) ? signals.subscribesTo as never[] : [],
			publishes: Array.isArray(signals.publishes) ? signals.publishes as string[] : [],
		},
	};
}

function signalContracts(agentClasses: unknown[]) {
	const selected: Record<string, AgentSignalContract> = {};
	for (const value of agentClasses) {
		const refs = record(record(value).handlerRefs ?? record(value).handler_refs);
		for (const [id, candidate] of Object.entries(record(refs.signalContracts))) {
			const validation = validateAgentSignalContract(candidate);
			if (!validation.ok || !validation.value || validation.value.id !== id) throw new CapacityGovernanceError(
				'capacity_workday_signal_contract_invalid', 'Project agent reconciliation contains an invalid signal contract.', 409,
				{ contractId: id, diagnostics: validation.diagnostics },
			);
			if (selected[id] && JSON.stringify(selected[id]) !== JSON.stringify(validation.value)) throw new CapacityGovernanceError(
				'capacity_workday_signal_contract_conflict', 'Selected agent classes disagree about a signal contract.', 409, { contractId: id },
			);
			selected[id] = validation.value;
		}
	}
	return Object.fromEntries(Object.entries(selected).sort(([left], [right]) => left.localeCompare(right)));
}

function proposalTypeContracts(agentClasses: unknown[]) {
	const selected: Record<string, ProposalTypeContract> = {};
	for (const value of agentClasses) for (const [id,candidate] of Object.entries(record(record(record(value).handlerRefs ?? record(value).handler_refs).proposalTypeContracts))) {
		const validation = validateProposalTypeContract(candidate);
		if (!validation.ok || !validation.value || validation.value.id !== id) throw new CapacityGovernanceError('capacity_workday_proposal_type_contract_invalid', 'Project agent reconciliation contains an invalid proposal type contract.', 409, { proposalTypeId: id, diagnostics: validation.diagnostics });
		if (selected[id] && JSON.stringify(selected[id]) !== JSON.stringify(validation.value)) throw new CapacityGovernanceError('capacity_workday_proposal_type_contract_conflict', 'Selected agent classes disagree about a proposal type contract.', 409, { proposalTypeId: id });
		selected[id] = validation.value;
	}
	return Object.fromEntries(Object.entries(selected).sort(([left],[right]) => left.localeCompare(right)));
}

function groups(agentClasses:unknown[],key:'groupContracts'|'groupEdgeContracts'){
	const selected:Record<string,GovernanceGroup|GovernanceGroupEdge>={};for(const value of agentClasses)for(const [id,candidate] of Object.entries(record(record(record(value).handlerRefs??record(value).handler_refs)[key]))){const validation=key==='groupContracts'?validateGroupDefinition(candidate):validateGroupEdgeDefinition(candidate);if(!validation.ok)throw new CapacityGovernanceError('capacity_workday_group_contract_invalid','Project agent reconciliation contains an invalid group contract.',409,{id,diagnostics:validation.diagnostics});selected[id]=candidate as GovernanceGroup|GovernanceGroupEdge}return selected;
}

function digest(agents: CapacityWorkdayAgent[], graph: AgentPlanningGraph, contracts: Record<string, AgentSignalContract>, proposalTypes: Record<string, ProposalTypeContract>,groupContracts?:Record<string,GovernanceGroup>,groupEdgeContracts?:Record<string,GovernanceGroupEdge>) {
	return createHash('sha256').update(JSON.stringify({ agents, nodes: graph.nodes, edges: graph.edges, signalContracts: contracts, proposalTypeContracts: proposalTypes,...(groupContracts?{groups:groupContracts}:{}),...(groupEdgeContracts?{groupEdges:groupEdgeContracts}:{}) })).digest('hex');
}

export function compileWorkdayPlanningGraphSnapshot(agentClasses: unknown[], selection: unknown): WorkdayPlanningGraphSnapshot {
	const agents = capacityWorkdayAgentsFromClasses(agentClasses, normalizeWorkdayAgentSelection(selection));
	if (!agents.length) throw new CapacityGovernanceError('capacity_workday_agent_selection_empty', 'Workday selection resolved no eligible planning profiles.', 409);
	const contracts = signalContracts(agentClasses);
	const proposalTypes = proposalTypeContracts(agentClasses);
	const groupContracts=groups(agentClasses,'groupContracts') as Record<string,GovernanceGroup>;const groupEdgeContracts=groups(agentClasses,'groupEdgeContracts') as Record<string,GovernanceGroupEdge>;
	try { validateGovernanceGroupGraph(Object.values(groupContracts), Object.values(groupEdgeContracts)); }
	catch (error) { throw new CapacityGovernanceError('capacity_workday_group_graph_invalid', error instanceof Error ? error.message : 'Project group graph is invalid.', 409); }
	const graph = compileAgentPlanningGraph(agents.map(profile), { externalRoots: ['workday-started', 'proposal-submitted'], contracts });
	if (!graph.ok) throw new CapacityGovernanceError(
		'capacity_workday_planning_graph_invalid',
		'Selected planning profiles do not form a valid signal DAG.',
		409,
		{ diagnostics: graph.diagnostics },
	);
	const referenced = new Set(graph.nodes.flatMap((node) => [...node.produces, ...node.requires.map((entry) => entry.contract)]));
	const missing = [...referenced].filter((id) => !contracts[id]);
	if (missing.length) throw new CapacityGovernanceError('capacity_workday_signal_contract_missing', 'The signal DAG references contracts that were not frozen from TreeDX.', 409, { contractIds: missing });
	return { agents, graph, signalContracts: contracts, proposalTypeContracts: proposalTypes, groups:groupContracts, groupEdges:groupEdgeContracts, revision: digest(agents, graph, contracts, proposalTypes,groupContracts,groupEdgeContracts) };
}

export async function resolveWorkdayPlanningGraphSnapshot(
	store: WorkdayPlanningGraphStore,
	projectId: string,
	selection: unknown,
): Promise<WorkdayPlanningGraphSnapshot> {
	const page = await store.listProjectAgentClassesPage(projectId, { limit: MAX_CAPACITY_PAGE_LIMIT });
	if (page.page.hasMore) throw new CapacityGovernanceError('capacity_internal_collection_bound_exceeded', 'Project agent classes exceed the planning graph snapshot bound.', 409, { projectId });
	return compileWorkdayPlanningGraphSnapshot(page.items, selection);
}

export function decodeWorkdayPlanningGraphSnapshot(value: unknown, projectId: string): WorkdayPlanningGraphSnapshot {
	const snapshot = record(value);
	if (!Array.isArray(snapshot.agents)) throw new CapacityGovernanceError('capacity_workday_planning_graph_snapshot_invalid', 'Workday planning graph snapshot has no agent profiles.', 500, { projectId });
	const agents = snapshot.agents as CapacityWorkdayAgent[];
	const contracts = record(snapshot.signalContracts) as Record<string, AgentSignalContract>;
	const proposalTypes = record(snapshot.proposalTypeContracts) as Record<string, ProposalTypeContract>;
	const groupContracts=record(snapshot.groups) as Record<string,GovernanceGroup>;const groupEdgeContracts=record(snapshot.groupEdges) as Record<string,GovernanceGroupEdge>;
	const graph = compileAgentPlanningGraph(agents.map(profile), { externalRoots: ['workday-started', 'proposal-submitted'], contracts });
	const revision = typeof snapshot.revision === 'string' ? snapshot.revision : '';
	if (!graph.ok || !revision || ![digest(agents, graph, contracts, proposalTypes,groupContracts,groupEdgeContracts),digest(agents,graph,contracts,proposalTypes)].includes(revision) || Object.entries(contracts).some(([id, contract]) => {
		const validation = validateAgentSignalContract(contract); return !validation.ok || validation.value?.id !== id;
	}) || Object.entries(proposalTypes).some(([id,contract]) => { const validation = validateProposalTypeContract(contract); return !validation.ok || validation.value?.id !== id; })) throw new CapacityGovernanceError(
		'capacity_workday_planning_graph_snapshot_invalid',
		'Workday planning graph snapshot is corrupt or changed after scheduling.',
		500,
		{ projectId, diagnostics: graph.diagnostics },
	);
	return { agents, graph, signalContracts: contracts, proposalTypeContracts: proposalTypes, groups:groupContracts, groupEdges:groupEdgeContracts, revision };
}

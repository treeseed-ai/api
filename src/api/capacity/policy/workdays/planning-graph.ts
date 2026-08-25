import type { EffectiveGroupMembership, SignalGroupScope } from '@treeseed/sdk/agent-capacity';
import { matchSignalGroupScope } from './signal-scope.ts';
import type { AgentSignalContract } from '@treeseed/sdk/agent-capacity';

export type SignalProducerPolicy = 'any' | 'all' | 'quorum';

export interface SignalSubscription {
	contract: string;
	groupScope?: SignalGroupScope;
	filters?: Record<string, unknown>;
	cardinality?: 'single' | 'each';
	producerPolicy?: SignalProducerPolicy;
	quorum?: number;
}

export interface PlanningGraphProfile {
	id?: string;
	agentId: string;
	activityType: string;
	stage?: string | null;
	signals?: { subscribesTo?: SignalSubscription[]; publishes?: string[] };
}

export interface PlanningGraphNode {
	id: string;
	agentId: string;
	activityType: string;
	stage: string | null;
	requires: SignalSubscription[];
	produces: string[];
}

export interface PlanningGraphEdge {
	fromNodeId: string;
	toNodeId: string;
	contracts: string[];
}

export interface PlanningGraphDiagnostic {
	code: 'duplicate_node' | 'missing_producer' | 'self_dependency' | 'cycle' | 'invalid_quorum' | 'missing_contract' | 'publisher_not_allowed' | 'subscriber_not_allowed' | 'filter_not_allowed';
	nodeId: string;
	contractId?: string;
	message: string;
}

export interface AgentPlanningGraph {
	nodes: PlanningGraphNode[];
	edges: PlanningGraphEdge[];
	externalRoots: string[];
	diagnostics: PlanningGraphDiagnostic[];
	ok: boolean;
}

export interface PlanningGraphEvidenceReference {
	contractId: string;
	recordId: string;
	subjectId?: string | null;
	payload?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	groupMembership?: EffectiveGroupMembership;
}

export interface PlanningGraphGroupContext {
	projectId: string;
	agentMembershipByNodeId: Record<string, EffectiveGroupMembership>;
	depthByGroupId?: Record<string, number>;
}

export interface PlanningGraphNodeEvidence {
	nodeId: string;
	references: PlanningGraphEvidenceReference[];
}

function normalize(value: string): string { return value.trim().replace(/_/gu, '-'); }
function unique(values: string[] = []): string[] { return [...new Set(values.map(normalize).filter(Boolean))].sort(); }

function node(profile: PlanningGraphProfile): PlanningGraphNode {
	return {
		id: profile.id?.trim() || `${profile.agentId}:${profile.activityType}`,
		agentId: profile.agentId,
		activityType: profile.activityType,
		stage: profile.stage?.trim() || null,
		requires: (profile.signals?.subscribesTo ?? []).map((entry) => ({
			...entry,
			contract: normalize(entry.contract),
			cardinality: entry.cardinality ?? 'single',
			producerPolicy: entry.producerPolicy ?? 'any',
		})).sort((left, right) => left.contract.localeCompare(right.contract)),
		produces: unique(profile.signals?.publishes),
	};
}

function cycles(nodes: PlanningGraphNode[], edges: PlanningGraphEdge[]): PlanningGraphDiagnostic[] {
	const outgoing = new Map(nodes.map((entry) => [entry.id, [] as string[]]));
	const incoming = new Map(nodes.map((entry) => [entry.id, 0]));
	for (const edge of edges) { outgoing.get(edge.fromNodeId)?.push(edge.toNodeId); incoming.set(edge.toNodeId, (incoming.get(edge.toNodeId) ?? 0) + 1); }
	const ready = nodes.filter((entry) => incoming.get(entry.id) === 0).map((entry) => entry.id).sort();
	let visited = 0;
	while (ready.length) {
		const id = ready.shift() as string; visited += 1;
		for (const target of outgoing.get(id) ?? []) { const count = (incoming.get(target) ?? 0) - 1; incoming.set(target, count); if (!count) ready.push(target); }
		ready.sort();
	}
	return visited === nodes.length ? [] : nodes.filter((entry) => (incoming.get(entry.id) ?? 0) > 0).map((entry) => ({
		code: 'cycle', nodeId: entry.id, message: `Signal graph node ${entry.id} participates in a cycle.`,
	}));
}

export function compileAgentPlanningGraph(
	profiles: PlanningGraphProfile[],
	options: { externalRoots?: string[]; contracts?: Record<string, AgentSignalContract> } = {},
): AgentPlanningGraph {
	const nodes = profiles.map(node).sort((left, right) => left.id.localeCompare(right.id));
	const externalRoots = unique(options.externalRoots);
	const diagnostics: PlanningGraphDiagnostic[] = [];
	const byId = new Map<string, PlanningGraphNode>();
	for (const entry of nodes) {
		if (byId.has(entry.id)) diagnostics.push({ code: 'duplicate_node', nodeId: entry.id, message: `Signal graph node ${entry.id} is declared more than once.` });
		else byId.set(entry.id, entry);
	}
	const producers = new Map<string, PlanningGraphNode[]>();
	for (const entry of byId.values()) for (const contract of entry.produces) {
		const definition = options.contracts?.[contract];
		if (options.contracts && !definition) diagnostics.push({ code: 'missing_contract', nodeId: entry.id, contractId: contract, message: `${entry.id} publishes unknown signal contract ${contract}.` });
		else if (definition?.allowedProducerProfiles?.length && !definition.allowedProducerProfiles.includes(entry.activityType)) diagnostics.push({ code: 'publisher_not_allowed', nodeId: entry.id, contractId: contract, message: `${entry.activityType} may not publish ${contract}.` });
		producers.set(contract, [...(producers.get(contract) ?? []), entry]);
	}
	const grouped = new Map<string, string[]>();
	for (const entry of byId.values()) for (const subscription of entry.requires) {
		const definition = options.contracts?.[subscription.contract];
		if (options.contracts && !definition) diagnostics.push({ code: 'missing_contract', nodeId: entry.id, contractId: subscription.contract, message: `${entry.id} subscribes to unknown signal contract ${subscription.contract}.` });
		if (definition?.subscriberActivityProfiles?.length && !definition.subscriberActivityProfiles.includes(entry.activityType)) diagnostics.push({ code: 'subscriber_not_allowed', nodeId: entry.id, contractId: subscription.contract, message: `${entry.activityType} may not subscribe to ${subscription.contract}.` });
		const invalidFilters = Object.keys(subscription.filters ?? {}).filter((key) => !definition?.filterableFields?.includes(key));
		if (definition && invalidFilters.length) diagnostics.push({ code: 'filter_not_allowed', nodeId: entry.id, contractId: subscription.contract, message: `${subscription.contract} does not expose filter fields: ${invalidFilters.join(', ')}.` });
		const candidates = (producers.get(subscription.contract) ?? []).filter((producer) => producer.id !== entry.id);
		const self = (producers.get(subscription.contract) ?? []).some((producer) => producer.id === entry.id);
		if (!candidates.length && !externalRoots.includes(subscription.contract)) diagnostics.push({
			code: self ? 'self_dependency' : 'missing_producer', nodeId: entry.id, contractId: subscription.contract,
			message: `${entry.id} subscribes to ${subscription.contract}, but ${self ? 'only publishes it itself' : 'no selected profile or external root publishes it'}.`,
		});
		if (subscription.producerPolicy === 'quorum' && (subscription.quorum ?? 0) > candidates.length) diagnostics.push({
			code: 'invalid_quorum', nodeId: entry.id, contractId: subscription.contract,
			message: `${entry.id} requires quorum ${subscription.quorum}, but only ${candidates.length} producers exist.`,
		});
		for (const producer of candidates) { const key = `${producer.id}\u0000${entry.id}`; grouped.set(key, [...(grouped.get(key) ?? []), subscription.contract]); }
	}
	const edges = [...grouped].map(([key, contracts]) => { const [fromNodeId, toNodeId] = key.split('\u0000'); return { fromNodeId, toNodeId, contracts: unique(contracts) }; })
		.sort((left, right) => `${left.fromNodeId}:${left.toNodeId}`.localeCompare(`${right.fromNodeId}:${right.toNodeId}`));
	diagnostics.push(...cycles([...byId.values()], edges));
	return { nodes: [...byId.values()], edges, externalRoots, diagnostics, ok: diagnostics.length === 0 };
}

function matchesFilters(reference: PlanningGraphEvidenceReference, filters: Record<string, unknown> = {}): boolean {
	const values = { ...(reference.payload ?? {}), ...(reference.metadata ?? {}) };
	return Object.entries(filters).every(([key, expected]) => {
		const actual = values[key];
		return Array.isArray(expected) ? expected.includes(actual) || (Array.isArray(actual) && actual.some((item) => expected.includes(item))) : actual === expected;
	});
}

function satisfying(graph: AgentPlanningGraph, node: PlanningGraphNode, subscription: SignalSubscription, evidence: PlanningGraphNodeEvidence[], groups?: PlanningGraphGroupContext) {
	const predecessorIds = new Set(graph.edges.filter((edge) => edge.toNodeId === node.id && edge.contracts.includes(subscription.contract)).map((edge) => edge.fromNodeId));
	return evidence.flatMap((entry) => entry.references.filter((reference) =>
		(entry.nodeId === '$external' || predecessorIds.has(entry.nodeId)) && normalize(reference.contractId) === subscription.contract
		&& matchesFilters(reference, subscription.filters) && matchesGroups(node, subscription, reference, groups),
	).map((reference) => ({ nodeId: entry.nodeId, reference })));
}

function matchesGroups(node: PlanningGraphNode, subscription: SignalSubscription, reference: PlanningGraphEvidenceReference, groups?: PlanningGraphGroupContext) {
	if (!subscription.groupScope) return true;
	if (!groups) return false;
	const agentMembership = groups.agentMembershipByNodeId[node.id];
	const subjectMembership = reference.groupMembership;
	if (!agentMembership || !subjectMembership) return false;
	return matchSignalGroupScope({ scope: subscription.groupScope, agentMembership, subjectMembership, depthByGroupId: groups.depthByGroupId }).matched;
}

export function evaluatePlanningGraphNode(graph: AgentPlanningGraph, nodeId: string, evidence: PlanningGraphNodeEvidence[], groups?: PlanningGraphGroupContext) {
	const selected = graph.nodes.find((entry) => entry.id === nodeId);
	if (!selected || !graph.ok) return { ready: false, missing: selected?.requires ?? [], matched: [] as PlanningGraphNodeEvidence[] };
	const matched = new Map<string, PlanningGraphEvidenceReference[]>();
	const missing = selected.requires.filter((subscription) => {
		const found = satisfying(graph, selected, subscription, evidence, groups);
		for (const item of found) matched.set(item.nodeId, [...(matched.get(item.nodeId) ?? []), item.reference]);
		const producerCount = new Set(found.map((item) => item.nodeId)).size;
		if (subscription.producerPolicy === 'all') {
			const expected = new Set(graph.edges.filter((edge) => edge.toNodeId === nodeId && edge.contracts.includes(subscription.contract)).map((edge) => edge.fromNodeId)).size;
			return producerCount < expected;
		}
		if (subscription.producerPolicy === 'quorum') return producerCount < (subscription.quorum ?? 1);
		return found.length === 0;
	});
	return { ready: missing.length === 0, missing, matched: [...matched].map(([entryNodeId, references]) => ({ nodeId: entryNodeId, references })) };
}

export function evaluatePlanningGraphNodeInstances(graph: AgentPlanningGraph, nodeId: string, evidence: PlanningGraphNodeEvidence[], groups?: PlanningGraphGroupContext) {
	const selected = graph.nodes.find((entry) => entry.id === nodeId);
	if (!selected) return [];
	const each = selected.requires.find((entry) => entry.cardinality === 'each');
	if (!each) { const result = evaluatePlanningGraphNode(graph, nodeId, evidence, groups); return result.ready ? [{ instanceKey: 'single', matched: result.matched }] : []; }
	const anchors = satisfying(graph, selected, each, evidence, groups);
	return anchors.flatMap(({ reference }) => {
		const subject = reference.subjectId ?? reference.recordId;
		const scoped = evidence.map((entry) => ({ ...entry, references: entry.references.filter((candidate) => (candidate.subjectId ?? candidate.recordId) === subject) }));
		const result = evaluatePlanningGraphNode(graph, nodeId, scoped, groups);
		return result.ready ? [{ instanceKey: subject, matched: result.matched }] : [];
	}).filter((entry, index, all) => all.findIndex((candidate) => candidate.instanceKey === entry.instanceKey) === index)
		.sort((left, right) => left.instanceKey.localeCompare(right.instanceKey));
}

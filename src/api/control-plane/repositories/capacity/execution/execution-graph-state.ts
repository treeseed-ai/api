import { createHash } from 'node:crypto';
import { validateExecutionGraph, type ExecutionNode, type ExecutionEdge } from '@treeseed/sdk/agent-capacity';
import { CapacityOperationError } from '../capacity-operation-error.ts';

type Row = Record<string, unknown>;
export type TeamGraph = { teamId: string; revision: number; digest: string; nodes: ExecutionNode[]; edges: ExecutionEdge[] };
export const record = (value: unknown): Row => {
	if (value && typeof value === 'object' && !Array.isArray(value)) return value as Row;
	if (typeof value === 'string') try { return record(JSON.parse(value)); } catch { return {}; }
	return {};
};
export const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
export const stable = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
	if (value && typeof value === 'object') return `{${Object.entries(value as Row).sort(([a], [b]) => a.localeCompare(b))
		.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
	return JSON.stringify(value);
};
export const digest = (value: unknown): string => `sha256:${createHash('sha256').update(stable(value)).digest('hex')}`;

export function applyOperationalState(current: TeamGraph, projected: TeamGraph, revision: number,
	activeAssignmentNodeIds: ReadonlySet<string> = new Set(),
	terminalAssignmentStatuses: ReadonlyMap<string, { status: ExecutionNode['status']; nodeRevision: number }> = new Map()): TeamGraph {
	const priorById = new Map(current.nodes.map((node) => [node.id, node]));
	const activeIds = new Set(projected.nodes.map((node) => node.id));
	const terminalProjectionNodeIds = new Set<string>();
	const nodes = projected.nodes.map((node) => {
		const prior = priorById.get(node.id);
		// A terminal simulation no longer owns this decision projection. Retire its
		// candidate and review state; a later selected workday gets a fresh attempt.
		if (prior?.workdayId && !node.workdayId && node.authorityRefs?.some((reference) => reference.model === 'decision'))
			return { ...prior, status: 'stale' as const,
				nodeRevision: prior.status === 'stale' ? prior.nodeRevision : prior.nodeRevision + 1,
				graphRevisionUpdated: revision };
		const freshSimulationAttempt = Boolean(prior && node.workdayId && prior.workdayId !== node.workdayId
			&& node.authorityRefs?.some((reference) => reference.model === 'decision'));
		const terminal = prior ? terminalAssignmentStatuses.get(node.id) : undefined;
		// A completed Reviewer result governs the paired Actor candidate, not the
		// projection revision. Projection-only bumps must not reopen an approval;
		// the caller rejects it when a newer Actor candidate has completed.
		const applicableTerminal = !freshSimulationAttempt && terminal && (prior?.pairRole !== 'reviewer'
			|| terminal.status === 'completed' || terminal.nodeRevision >= prior.nodeRevision) ? terminal : undefined;
		// The caller has already reconciled paired review chronology. Applying the
		// selected terminal state across a projection revision repairs transient
		// source churn without replaying superseded request-changes results.
		const recoveredTerminalStatus = prior && applicableTerminal ? applicableTerminal.status : undefined;
		if (prior && recoveredTerminalStatus) {
			// A request-changes Reviewer is blocked only until its paired Actor
			// commits a newer candidate. Re-evaluate that edge below; treating
			// the older review as terminal would strand the re-review forever.
			if (prior.pairRole !== 'reviewer' || recoveredTerminalStatus !== 'blocked') {
				terminalProjectionNodeIds.add(node.id);
			}
			return { ...prior, status: recoveredTerminalStatus,
			// A terminal assignment is evidence for an existing node revision, not a
			// new semantic revision. Repeated reconciliation must converge instead of
			// manufacturing fresh ready Actor revisions that can be leased again.
			nodeRevision: Math.max(prior.nodeRevision, applicableTerminal!.nodeRevision), graphRevisionUpdated: revision };
		}
		const operational = prior && !freshSimulationAttempt && node.kind !== 'condition'
			&& ((prior.pairRole !== 'reviewer' && ['completed', 'failed', 'cancelled'].includes(prior.status))
				|| (['assigned', 'running'].includes(prior.status) && activeAssignmentNodeIds.has(prior.id)));
		if (operational) return { ...prior, graphRevisionUpdated: revision };
		const semantic = (value: ExecutionNode) => {
			const { status: _status, nodeRevision: _nodeRevision, graphRevisionCreated: _created,
				graphRevisionUpdated: _updated, ...rest } = value;
			return rest;
		};
		const changed = prior && (stable(semantic(prior)) !== stable(semantic(node))
			|| (node.kind === 'condition' && prior.status !== node.status));
		const nodeRevision = prior
			? prior.status === 'stale' || changed ? prior.nodeRevision + 1 : Math.max(prior.nodeRevision, node.nodeRevision)
			: node.nodeRevision;
		return { ...node, nodeRevision,
			graphRevisionCreated: prior?.graphRevisionCreated ?? node.graphRevisionCreated, graphRevisionUpdated: revision };
	});
	for (const prior of current.nodes) {
		if (activeIds.has(prior.id)) continue;
		nodes.push(prior.status === 'stale'
			? prior
			: !prior.workdayId && prior.kind !== 'communication' && ['assigned', 'running'].includes(prior.status)
				&& activeAssignmentNodeIds.has(prior.id)
			? { ...prior, graphRevisionUpdated: revision }
			: { ...prior, status: 'stale', nodeRevision: prior.nodeRevision + 1, graphRevisionUpdated: revision });
	}
	const activeNodes = new Map(nodes.map((node) => [node.id, node]));
	for (const reviewer of nodes.filter((candidate) => candidate.pairRole === 'reviewer')) {
		const pair = projected.edges.find((edge) => edge.toNodeId === reviewer.id && edge.provenance === 'review-pair');
		const actor = pair ? activeNodes.get(pair.fromNodeId) : undefined;
		// A Reviewer result is meaningful only for its exact successful Actor
		// candidate. If the current Actor revision failed or was cancelled, retire
		// any older Reviewer completion and keep review blocked.
		if (actor && actor.status !== 'completed' && reviewer.status === 'completed') {
			reviewer.status = 'blocked';
			reviewer.nodeRevision = Math.max(reviewer.nodeRevision, actor.nodeRevision);
			reviewer.graphRevisionUpdated = revision;
		}
	}
	for (const node of nodes.filter((candidate) => candidate.kind === 'condition' && candidate.status === 'completed')) {
		const predecessors = projected.edges.filter((edge) => edge.toNodeId === node.id)
			.map((edge) => activeNodes.get(edge.fromNodeId));
		if (predecessors.some((candidate) => candidate?.status !== 'completed')) node.status = 'blocked';
	}
	for (const node of nodes) {
		if (node.status === 'proposed' || node.status === 'stale'
			|| terminalProjectionNodeIds.has(node.id)
			|| ['assigned', 'running', 'completed', 'failed', 'cancelled'].includes(node.status)) continue;
		if (node.kind === 'condition') continue;
		const predecessors = projected.edges.filter((edge) => edge.toNodeId === node.id).map((edge) => activeNodes.get(edge.fromNodeId));
		node.status = predecessors.every((candidate) => candidate?.status === 'completed') ? 'ready' : 'blocked';
	}
	const withoutGraphRevision = (node: ExecutionNode) => {
		const { graphRevisionCreated: _created, graphRevisionUpdated: _updated, ...value } = node;
		return value;
	};
	const normalizedNodes = nodes.map((node) => {
		const prior = priorById.get(node.id);
		return prior && activeIds.has(node.id) && stable(withoutGraphRevision(prior)) === stable(withoutGraphRevision(node))
			? { ...node, graphRevisionCreated: prior.graphRevisionCreated, graphRevisionUpdated: prior.graphRevisionUpdated }
			: node;
	}).sort((left, right) => left.id.localeCompare(right.id));
	const priorEdges = new Map(current.edges.map((candidate) => [candidate.id, candidate]));
	const edges = projected.edges.map((candidate) => ({ ...candidate,
		graphRevisionCreated: priorEdges.get(candidate.id)?.graphRevisionCreated ?? candidate.graphRevisionCreated }));
	const checked = validateExecutionGraph(normalizedNodes, edges);
	if (!checked.ok) throw Object.assign(new CapacityOperationError(422, 'execution_graph_invalid', 'The reconciled execution graph is invalid.'), { diagnostics: checked.diagnostics });
	return { teamId: projected.teamId, revision, nodes: normalizedNodes, edges,
		digest: digest({ teamId: projected.teamId, nodes: normalizedNodes, edges }) };
}

/** Reconcile a committed request-changes result whose paired node update was interrupted. */
export function recoverIncompleteReviewCycles(graph: TeamGraph, completedReviews: ReadonlyMap<string, number>,
	latestRequestChangesReviewers: ReadonlySet<string>, revision: number): TeamGraph {
	for (const reviewer of graph.nodes) {
		const completed = completedReviews.get(reviewer.id) ?? 0;
		if (reviewer.pairRole !== 'reviewer' || reviewer.status !== 'failed'
			|| !latestRequestChangesReviewers.has(reviewer.id) || completed < 1
			|| completed >= (reviewer.maximumReviewCycles ?? 1)) continue;
		const pair = graph.edges.find((edge) => edge.toNodeId === reviewer.id && edge.provenance === 'review-pair');
		const actor = pair ? graph.nodes.find((node) => node.id === pair.fromNodeId && node.pairRole === 'actor'
			&& (node.status === 'blocked' || node.status === 'completed')) : undefined;
		if (!actor) continue;
		reviewer.nodeRevision += 1; reviewer.status = 'blocked'; reviewer.graphRevisionUpdated = revision;
		actor.nodeRevision += 1; actor.status = 'ready'; actor.graphRevisionUpdated = revision;
	}
	graph.digest = digest({ teamId: graph.teamId, nodes: graph.nodes, edges: graph.edges });
	return graph;
}

export function reviewCycleLimitReached(completedReviews: number, maximumReviewCycles: number | undefined): boolean {
	return completedReviews >= (maximumReviewCycles ?? 1);
}

/** Retry an interrupted governance review only within a bounded three-attempt
 * history and only before a durable result. Other work remains fail-closed. */
export function recoverInterruptedGovernanceReviews(graph: TeamGraph, returnedOnlyNodeIds: ReadonlySet<string>, revision: number): TeamGraph {
	for (const node of graph.nodes) {
		if (node.kind !== 'reviewing' || node.status !== 'failed'
			|| !returnedOnlyNodeIds.has(node.id)) continue;
		node.nodeRevision += 1;
		node.status = 'ready';
		node.graphRevisionUpdated = revision;
	}
	graph.digest = digest({ teamId: graph.teamId, nodes: graph.nodes, edges: graph.edges });
	return graph;
}

export function recoverableGovernanceReviewAttemptHistory(history: readonly Row[]): boolean {
	return history.length > 0 && history.length < 3 && history.every((attempt) =>
		text(attempt.status) === 'returned' && !attempt.assignment_result_json
		&& (['provider_runtime_recovery', 'provider_restart_recovery'].includes(text(attempt.lifecycle_code))
			|| (text(attempt.lifecycle_code) === 'agent_executor_failed'
				&& text(attempt.lifecycle_reason).startsWith('assignment_context_read_failed:')
				&& /^assignment_context_read_failed:.*:TreeDX is temporarily unavailable(?: \(\d{3}:[a-zA-Z0-9_-]+\))?\.$/u.test(text(attempt.lifecycle_reason)))));
}

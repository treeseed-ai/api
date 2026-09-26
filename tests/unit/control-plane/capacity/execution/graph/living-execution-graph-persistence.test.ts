import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createControlPlanePostgresDatabase } from '../../../../../../src/api/support/control-plane-postgres.ts';
import type { ExecutionNode, GraphRevision } from '@treeseed/sdk/agent-capacity';
import {
	createExecutionGraphService,
	isRevisionRequiredReviewDisposition,
	persistExecutionGraph,
	selectTerminalAssignmentRows,
	simulationRunByDecision,
	simulationRunBySelection,
	terminalAssignmentWasRequeued,
} from '../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-service.ts';
import { applyOperationalState, recoverIncompleteReviewCycles, recoverInterruptedGovernanceReviews,
	recoverableGovernanceReviewAttemptHistory, reviewCycleLimitReached,
} from '../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-state.ts';

const sourceRef = {
	store: 'treedx' as const, model: 'proposal', id: 'proposal', revision: 1,
	digest: `sha256:${'a'.repeat(64)}`, repository: 'repository', commit: 'b'.repeat(40), path: 'proposals/one.mdx',
};
const permissions = { content: { read: ['proposal'] as const, write: [] }, tools: ['source.read'] as const };

function node(status: ExecutionNode['status']): ExecutionNode {
	return {
		schemaVersion: 'treeseed.execution-node/v1', id: 'node', teamId: 'team', projectId: 'project',
		workItemId: 'work', kind: 'acting', pairRole: 'actor', sourceRef, authorityRefs: [{
			store: 'postgresql', model: 'decision', id: 'decision', revision: 1, digest: `sha256:${'c'.repeat(64)}`,
		}],
		ruleRevision: 1, nodeRevision: 1, agentClass: 'engineer', status,
		estimate: { minimumSeconds: 1, expectedSeconds: 2, maximumSeconds: 3 },
		requiredCapabilities: [], requestedPermissions: permissions as never, workspace: 'git',
		acceptanceCriteria: ['Verified.'], maximumReviewCycles: 1,
		graphRevisionCreated: 1, graphRevisionUpdated: 1,
	};
}

const graph = (revision: number, nodes: ExecutionNode[] = []) => ({
	teamId: 'team', revision, digest: `sha256:${String(revision).padStart(64, '0')}`, nodes, edges: [],
});

it('uses only the canonical request-changes review disposition', () => {
	expect(isRevisionRequiredReviewDisposition('request-changes')).toBe(true);
	expect(isRevisionRequiredReviewDisposition('revision-required')).toBe(false);
	expect(isRevisionRequiredReviewDisposition('rejected')).toBe(false);
});

it('keeps an approved review authoritative over a duplicate result until the Actor publishes a new candidate', () => {
	const actor = { ...node('completed'), id: 'actor' };
	const reviewer = { ...node('completed'), id: 'reviewer', kind: 'reviewing' as const, pairRole: 'reviewer' as const };
	const pair = { schemaVersion: 'treeseed.execution-edge/v1' as const, id: 'pair', teamId: 'team',
		fromNodeId: 'actor', toNodeId: 'reviewer', provenance: 'review-pair' as const, graphRevisionCreated: 1 };
	const result = (id: string, at: string, disposition = '') => ({ execution_node_id: id, status: 'completed',
		execution_node_revision: 1, terminal_at: at, lifecycle_output_json: { activityCompletion: { reviewDisposition: disposition } } });
	const approved = result('reviewer', '2026-09-25T08:06:00.000Z', 'approved');
	const duplicate = result('reviewer', '2026-09-25T08:50:00.000Z', 'request-changes');
	const originalActor = result('actor', '2026-09-25T08:01:00.000Z');
	expect(selectTerminalAssignmentRows([duplicate, approved, originalActor], [actor, reviewer], [pair])
		.find((entry) => entry.execution_node_id === 'reviewer')).toBe(approved);
	const revisedActor = result('actor', '2026-09-25T08:55:00.000Z');
	expect(selectTerminalAssignmentRows([revisedActor, duplicate, approved, originalActor], [actor, reviewer], [pair])
		.find((entry) => entry.execution_node_id === 'reviewer')).toBe(duplicate);
});

it('binds each accepted decision to at most one active simulation workday', () => {
	expect(simulationRunByDecision([{ id: 'fresh', executionMode: 'simulation', parameters: { decisionIds: ['decision'] } }]).get('decision')).toBe('fresh');
	expect(simulationRunByDecision([{ id: 'production', executionMode: 'production', parameters: { decisionIds: ['decision'] } }]).size).toBe(0);
	expect(() => simulationRunByDecision([
		{ id: 'first', executionMode: 'simulation', parameters: { decisionIds: ['decision'] } },
		{ id: 'second', executionMode: 'simulation', parameters: { decisionIds: ['decision'] } },
	])).toThrow(/simultaneous simulations/u);
	expect(simulationRunBySelection([{ id: 'golden', executionMode: 'simulation', parameters: {
		proposalIds: ['proposal'], decisionIds: [],
	} }], 'proposalIds').get('proposal')).toBe('golden');
});

it('starts a new simulation from projected readiness without adopting a prior exhausted review', () => {
	const exhausted = { ...node('blocked'), nodeRevision: 4, workdayId: 'old' };
	const fresh = { ...node('blocked'), workdayId: 'fresh' };
	const result = applyOperationalState(graph(4, [exhausted]), graph(5, [fresh]), 5, new Set(),
		new Map([['node', { status: 'blocked' as const, nodeRevision: 4 }]]));
	expect(result.nodes[0]).toMatchObject({ status: 'ready', workdayId: 'fresh', nodeRevision: 5 });
	expect(applyOperationalState(result, graph(6, [fresh]), 6).nodes[0]).toMatchObject({
		status: 'ready', workdayId: 'fresh', nodeRevision: 5,
	});
});

it('retires every terminal simulation node before another workday selects its decision', () => {
	for (const status of ['completed', 'blocked', 'failed'] as const) {
		const old = { ...node(status), workdayId: 'stopped-workday', nodeRevision: 3 };
		const retired = applyOperationalState(graph(3, [old]), graph(4, [node('ready')]), 4,
			new Set(), new Map([['node', { status, nodeRevision: 3 }]]));
		expect(retired.nodes[0]).toMatchObject({ status: 'stale', workdayId: 'stopped-workday', nodeRevision: 4 });
		const fresh = applyOperationalState(retired, graph(5, [{ ...node('blocked'), workdayId: 'new-workday' }]), 5);
		expect(fresh.nodes[0]).toMatchObject({ status: 'ready', workdayId: 'new-workday' });
	}
});

it('recovers only the one exact governance review returned by an interrupted provider', () => {
	const reviewer = { ...node('failed'), workItemId: 'proposal-review', kind: 'reviewing' as const,
		pairRole: null, id: 'review' };
	const recovered = recoverInterruptedGovernanceReviews(graph(2, [reviewer]), new Set(['review']), 3);
	expect(recovered.nodes[0]).toMatchObject({ status: 'ready', nodeRevision: 2 });
	expect(recoverInterruptedGovernanceReviews(graph(2, [{ ...reviewer, status: 'failed', nodeRevision: 1 }]), new Set(), 3).nodes[0]?.status).toBe('failed');
});

it('bounds transient governance read recovery and never replays a durable result', () => {
	const restart = { status: 'returned', lifecycle_code: 'provider_runtime_recovery', assignment_result_json: null };
	const transient = { status: 'returned', lifecycle_code: 'agent_executor_failed',
		lifecycle_reason: 'assignment_context_read_failed:proposal:commit:path:TreeDX is temporarily unavailable.',
		assignment_result_json: null };
	expect(recoverableGovernanceReviewAttemptHistory([restart, transient])).toBe(true);
	expect(recoverableGovernanceReviewAttemptHistory([restart, transient, restart])).toBe(false);
	expect(recoverableGovernanceReviewAttemptHistory([{ ...transient, assignment_result_json: '{}' }])).toBe(false);
	expect(recoverableGovernanceReviewAttemptHistory([{ ...transient,
		lifecycle_reason: 'assignment_context_read_failed:proposal:forbidden' }])).toBe(false);
});

const revision = (value: number, graphDigest: string): GraphRevision => ({
	schemaVersion: 'treeseed.graph-revision/v1', teamId: 'team', revision: value, ruleRevision: 1,
	changedSourceRefs: [sourceRef], graphDigest,
	changes: { added: [], changed: [], completed: [], blocked: [], stale: [], removedEdges: [], addedEdges: [] },
	createdAt: '2026-09-13T12:00:00.000Z',
});

function row(status: ExecutionNode['status']) {
	const value = node(status);
	return {
		id: value.id, team_id: value.teamId, project_id: value.projectId, work_item_id: value.workItemId,
		kind: value.kind, pair_role: value.pairRole, source_ref_json: JSON.stringify(value.sourceRef),
		authority_refs_json: JSON.stringify(value.authorityRefs), rule_revision: value.ruleRevision,
		node_revision: value.nodeRevision, agent_class: value.agentClass, status: value.status,
		estimate_json: JSON.stringify(value.estimate), required_capabilities_json: '[]',
		requested_permissions_json: JSON.stringify(value.requestedPermissions), workspace: value.workspace,
		acceptance_criteria_json: JSON.stringify(value.acceptanceCriteria),
		maximum_review_cycles: value.maximumReviewCycles, graph_revision_created: 1, graph_revision_updated: 1,
	};
}

describe('normalized living execution graph persistence', () => {
	it('preserves an in-flight node even when its source is replaced', () => {
		const current = graph(1, [node('running')]);
		const desired = graph(2, []);
		expect(applyOperationalState(current, desired, 2, new Set(['node'])).nodes).toEqual([
			expect.objectContaining({ id: 'node', status: 'running', graphRevisionUpdated: 2 }),
		]);
	});

	it('retires an orphaned assigned proposal node when no active assignment owns it', () => {
		expect(applyOperationalState(graph(1, [node('assigned')]), graph(2), 2).nodes).toEqual([
			expect.objectContaining({ id: 'node', status: 'stale', nodeRevision: 2, graphRevisionUpdated: 2 }),
		]);
	});

	it('retires communication nodes after their invocation leaves the active source set', () => {
		const discussionRef = { ...sourceRef, model: 'discussion' as const, id: 'invocation', path: 'discussions/topic/request.mdx' };
		const communication = { ...node('assigned'), kind: 'communication' as const, pairRole: null,
			workItemId: undefined, sourceRef: discussionRef, authorityRefs: [discussionRef], workspace: 'treedx' as const,
			requestedPermissions: { content: { read: ['discussion' as const], write: ['discussion' as const] }, tools: ['discussion' as const] } };
		expect(applyOperationalState(graph(1, [communication]), graph(2), 2).nodes).toEqual([
			expect.objectContaining({ id: 'node', status: 'stale', nodeRevision: 2, graphRevisionUpdated: 2 }),
		]);
	});

	it('retires assigned workday nodes after the workday leaves the active source set', () => {
		const workdayNode = { ...node('assigned'), workdayId: 'terminal-workday' };
		expect(applyOperationalState(graph(1, [workdayNode]), graph(2), 2).nodes).toEqual([
			expect.objectContaining({ id: 'node', status: 'stale', nodeRevision: 2, graphRevisionUpdated: 2 }),
		]);
	});

	it('preserves a request-changes node revision across identical source reconciliation', () => {
		const advanced = { ...node('ready'), nodeRevision: 2 };
		const reconciled = applyOperationalState(graph(2, [advanced]), graph(3, [node('blocked')]), 3);
		expect(reconciled.nodes).toEqual([expect.objectContaining({ id: 'node', nodeRevision: 2, status: 'ready' })]);
	});

	it('recovers an interrupted first request-changes projection without counting failed retries as review cycles', () => {
		const actor = { ...node('completed'), id: 'actor', nodeRevision: 16, maximumReviewCycles: 2 };
		const reviewer = { ...node('failed'), id: 'reviewer', kind: 'reviewing' as const, pairRole: 'reviewer' as const,
			agentClass: 'reviewer', nodeRevision: 2, maximumReviewCycles: 2 };
		const paired = { ...graph(3, [actor, reviewer]), edges: [{ id: 'pair', teamId: 'team', fromNodeId: 'actor',
			toNodeId: 'reviewer', provenance: 'review-pair' as const, graphRevisionCreated: 1 }] };
		const recovered = recoverIncompleteReviewCycles(paired, new Map([['reviewer', 1]]), new Set(['reviewer']), 4);
		expect(recovered.nodes).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: 'actor', status: 'ready', nodeRevision: 17 }),
			expect.objectContaining({ id: 'reviewer', status: 'blocked', nodeRevision: 3 }),
		]));
		const exhausted = recoverIncompleteReviewCycles({ ...paired, nodes: [{ ...actor, status: 'blocked' }, { ...reviewer, status: 'failed' }] }, new Map([['reviewer', 2]]), new Set(['reviewer']), 4);
		expect(exhausted.nodes.find((candidate) => candidate.id === 'reviewer')?.status).toBe('failed');
	});

	it('does not reopen the Actor after a later Reviewer timeout', () => {
		const actor = { ...node('completed'), id: 'actor', nodeRevision: 14, maximumReviewCycles: 2 };
		const reviewer = { ...node('failed'), id: 'reviewer', kind: 'reviewing' as const, pairRole: 'reviewer' as const,
			agentClass: 'reviewer', nodeRevision: 15, maximumReviewCycles: 2 };
		const paired = { ...graph(3, [actor, reviewer]), edges: [{ id: 'pair', teamId: 'team', fromNodeId: 'actor',
			toNodeId: 'reviewer', provenance: 'review-pair' as const, graphRevisionCreated: 1 }] };
		const recovered = recoverIncompleteReviewCycles(paired, new Map([['reviewer', 1]]), new Set(), 4);
		expect(recovered.nodes).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: 'actor', status: 'completed', nodeRevision: 14 }),
			expect.objectContaining({ id: 'reviewer', status: 'failed', nodeRevision: 15 }),
		]));
	});

	it('treats maximumReviewCycles as the total bounded Reviewer decisions', () => {
		expect(reviewCycleLimitReached(1, 2)).toBe(false);
		expect(reviewCycleLimitReached(2, 2)).toBe(true);
		expect(reviewCycleLimitReached(3, 2)).toBe(true);
	});

	it('does not let a superseded terminal attempt close an operator-requeued node', () => {
		expect(terminalAssignmentWasRequeued({ terminal_at: '2026-09-23T12:00:00.000Z',
			metadata_json: { operatorRetry: { requestedAt: '2026-09-23T12:01:00.000Z' } } })).toBe(true);
		expect(terminalAssignmentWasRequeued({ terminal_at: '2026-09-23T12:02:00.000Z',
			metadata_json: { operatorRetry: { requestedAt: '2026-09-23T12:01:00.000Z' } } })).toBe(false);
	});

	it('preserves graph revision metadata when projected semantics are unchanged', () => {
		const current = graph(1, [node('ready')]);
		const projected = graph(2, [{ ...node('ready'), graphRevisionCreated: 2, graphRevisionUpdated: 2 }]);
		expect(applyOperationalState(current, projected, 2).nodes).toEqual([
			expect.objectContaining({ id: 'node', graphRevisionCreated: 1, graphRevisionUpdated: 1 }),
		]);
	});

	it('reopens a completed feedback condition and blocks dependent work', () => {
		const condition = { ...node('completed'), id: 'question', kind: 'condition' as const, pairRole: null,
			workItemId: undefined, agentClass: undefined, estimate: undefined, requiredCapabilities: undefined,
			requestedPermissions: undefined, workspace: undefined,
			condition: { conditionType: 'question' as const, subjectRef: sourceRef, expectedState: 'feedback:q:resolved' } };
		const actor = { ...node('ready'), id: 'actor' };
		const current = { ...graph(1, [condition, actor]), edges: [{
			schemaVersion: 'treeseed.execution-edge/v1' as const, id: 'condition-edge', teamId: 'team',
			fromNodeId: condition.id, toNodeId: actor.id, provenance: 'governance' as const,
			graphRevisionCreated: 1,
		}] };
		const projected = { ...graph(2, [{ ...condition, status: 'blocked' as const }, { ...actor, status: 'blocked' as const }]),
			edges: current.edges };
		const result = applyOperationalState(current, projected, 2);
		expect(result.nodes.find((entry) => entry.id === 'question')).toMatchObject({ status: 'blocked', nodeRevision: 2 });
		expect(result.nodes.find((entry) => entry.id === 'actor')?.status).toBe('blocked');
	});

	it('revises an unassigned node when projected assignment semantics change', () => {
		const current = graph(1, [node('ready')]);
		const projected = { ...node('blocked'), estimate: { minimumSeconds: 1, expectedSeconds: 5, maximumSeconds: 30 } };
		expect(applyOperationalState(current, graph(2, [projected]), 2, new Set(['node'])).nodes).toEqual([
			expect.objectContaining({ id: 'node', status: 'ready', nodeRevision: 2, estimate: projected.estimate }),
		]);
	});

	it('preserves all immutable semantics for an in-flight node', () => {
		const current = graph(1, [node('running')]);
		const projected = { ...node('blocked'), estimate: { minimumSeconds: 1, expectedSeconds: 5, maximumSeconds: 30 } };
		expect(applyOperationalState(current, graph(2, [projected]), 2, new Set(['node'])).nodes).toEqual([
			expect.objectContaining({ status: 'running', nodeRevision: 1, estimate: node('running').estimate }),
		]);
	});

	it('does not revise an already stale node on repeated reconciliation', () => {
		const stale = { ...node('stale'), nodeRevision: 2, graphRevisionUpdated: 2 };
		expect(applyOperationalState(graph(2, [stale]), graph(3), 3).nodes).toEqual([stale]);
	});

	it('reactivates a stale node when its exact source returns', () => {
		const stale = { ...node('stale'), nodeRevision: 2, graphRevisionUpdated: 2 };
		const projected = { ...node('ready'), graphRevisionCreated: 3, graphRevisionUpdated: 3 };
		expect(applyOperationalState(graph(2, [stale]), graph(3, [projected]), 3).nodes).toEqual([
			expect.objectContaining({ id: 'node', status: 'ready', nodeRevision: 3, graphRevisionCreated: 1, graphRevisionUpdated: 3 }),
		]);
	});

	it('restores terminal assignment state when an exact source returns after transient staleness', () => {
		const stale = { ...node('stale'), nodeRevision: 2, graphRevisionUpdated: 2 };
		const projected = { ...node('ready'), graphRevisionCreated: 3, graphRevisionUpdated: 3 };
		expect(applyOperationalState(graph(2, [stale]), graph(3, [projected]), 3, new Set(),
			new Map([['node', { status: 'completed' as const, nodeRevision: 1 }]])).nodes).toEqual([
			expect.objectContaining({ id: 'node', status: 'completed', nodeRevision: 2,
				graphRevisionCreated: 1, graphRevisionUpdated: 3 }),
		]);
	});

	it('converges a caller-selected terminal result across projection revisions', () => {
		const reactivated = { ...node('ready'), nodeRevision: 3, graphRevisionUpdated: 3 };
		expect(applyOperationalState(graph(3, [reactivated]), graph(4, [node('ready')]), 4, new Set(),
			new Map([['node', { status: 'completed' as const, nodeRevision: 1 }]])).nodes).toEqual([
			expect.objectContaining({ id: 'node', status: 'completed', nodeRevision: 3, graphRevisionUpdated: 4 }),
		]);
	});

	it('does not re-ready an Actor blocked by terminal review exhaustion', () => {
		const exhausted = { ...node('ready'), nodeRevision: 4, graphRevisionUpdated: 3 };
		expect(applyOperationalState(graph(3, [exhausted]), graph(4, [node('blocked')]), 4, new Set(),
			new Map([['node', { status: 'blocked' as const, nodeRevision: 3 }]])).nodes).toEqual([
			expect.objectContaining({ id: 'node', status: 'blocked', nodeRevision: 4, graphRevisionUpdated: 4 }),
		]);
	});

	it('does not reopen an approved Reviewer after projection-only revision bumps', () => {
		const reviewer = { ...node('completed'), id: 'reviewer', kind: 'reviewing' as const,
			pairRole: 'reviewer' as const, agentClass: 'reviewer', nodeRevision: 3 };
		const projected = { ...reviewer, status: 'blocked' as const, nodeRevision: 1,
			graphRevisionCreated: 4, graphRevisionUpdated: 4 };
		const terminal = new Map([['reviewer', { status: 'completed' as const, nodeRevision: 2 }]]);
		const reconciled = applyOperationalState(graph(3, [reviewer]), graph(4, [projected]), 4, new Set(), terminal);
		expect(reconciled.nodes).toEqual([
			expect.objectContaining({ id: 'reviewer', status: 'completed', nodeRevision: 3 }),
		]);
		expect(applyOperationalState(reconciled, graph(5, [projected]), 5, new Set(), terminal).nodes[0])
			.toMatchObject({ status: 'completed', nodeRevision: 3 });
	});

	it('readies a request-changes Reviewer after the revised Actor completes', () => {
		const actor = { ...node('completed'), id: 'actor', nodeRevision: 4 };
		const reviewer = { ...node('blocked'), id: 'reviewer', kind: 'reviewing' as const,
			pairRole: 'reviewer' as const, agentClass: 'reviewer', nodeRevision: 4 };
		const pair = { schemaVersion: 'treeseed.execution-edge/v1' as const,
			id: 'pair', teamId: 'team', fromNodeId: 'actor', toNodeId: 'reviewer',
			provenance: 'review-pair' as const, graphRevisionCreated: 1 };
		const result = applyOperationalState(
			{ ...graph(3, [actor, reviewer]), edges: [pair] },
			{ ...graph(4, [{ ...actor, status: 'blocked' }, reviewer]), edges: [pair] },
			4, new Set(), new Map([
				['actor', { status: 'completed' as const, nodeRevision: 4 }],
				['reviewer', { status: 'blocked' as const, nodeRevision: 3 }],
			]),
		);
		expect(result.nodes.find((candidate) => candidate.id === 'reviewer')).toMatchObject({ status: 'ready', nodeRevision: 4 });
	});

	it('keeps a Reviewer blocked when the current Actor revision failed', () => {
		const actor = { ...node('running'), id: 'actor', pairRole: 'actor' as const, nodeRevision: 3 };
		const reviewer = { ...node('completed'), id: 'reviewer', kind: 'reviewing' as const,
			pairRole: 'reviewer' as const, agentClass: 'reviewer', nodeRevision: 2 };
		const projectedActor = { ...actor, status: 'blocked' as const, nodeRevision: 1 };
		const projectedReviewer = { ...reviewer, status: 'blocked' as const, nodeRevision: 1 };
		const pair = { schemaVersion: 'treeseed.execution-edge/v1' as const,
			id: 'pair', teamId: 'team', fromNodeId: 'actor', toNodeId: 'reviewer',
			provenance: 'review-pair' as const, graphRevisionCreated: 1 };
		const result = applyOperationalState(
			{ ...graph(3, [actor, reviewer]), edges: [pair] },
			{ ...graph(4, [projectedActor, projectedReviewer]), edges: [pair] },
			4,
			new Set(),
			new Map([
				['actor', { status: 'failed' as const, nodeRevision: 3 }],
				['reviewer', { status: 'completed' as const, nodeRevision: 2 }],
			]),
		);
		expect(result.nodes.find((candidate) => candidate.id === 'actor')).toMatchObject({ status: 'failed', nodeRevision: 3 });
		expect(result.nodes.find((candidate) => candidate.id === 'reviewer')).toMatchObject({ status: 'blocked', nodeRevision: 3 });
	});

	it('closes the completion race when the assignment settles before its assigned node update', () => {
		const assigned = { ...node('assigned'), nodeRevision: 3, graphRevisionUpdated: 3 };
		expect(applyOperationalState(graph(3, [assigned]), graph(4, [node('ready')]), 4, new Set(),
			new Map([['node', { status: 'completed' as const, nodeRevision: 3 }]])).nodes).toEqual([
			expect.objectContaining({ id: 'node', status: 'completed', nodeRevision: 3 }),
		]);
	});

	it('uses the append-only graph revision as the optimistic lock and receipt', async () => {
		const operations: Array<{ query: string; params: unknown[] }> = [];
		const next = graph(2, [node('ready')]);
		const store = {
			batch: async (input: typeof operations) => { operations.push(...input); },
			first: async () => ({ revision: 2, graph_digest: next.digest }),
		};
		await persistExecutionGraph(store, next, graph(1), revision(2, next.digest));
		expect(operations.some((operation) => operation.query.includes('estimate_json=excluded.estimate_json'))).toBe(true);
		expect(operations[0]?.query).toContain('FOR UPDATE');
		expect(operations[1]?.query).toContain('COALESCE(MAX(revision),0)');
		expect(operations[1]?.query).toContain('ON CONFLICT (team_id,revision) DO NOTHING');
		expect(operations[1]?.params[8]).toBe(1);
		expect(operations.slice(2).every((operation) => operation.query.includes('created_at=?'))).toBe(true);
		expect(operations.some((operation) => /graph_events|reconciliation_receipts/u.test(operation.query))).toBe(false);
	});

	it('writes only the changed component when an unrelated project remains unchanged', async () => {
		const unchanged = { ...node('ready'), id: 'other-node', projectId: 'other-project' };
		const changed = { ...node('blocked'), id: 'changed-node' };
		const current = graph(1, [unchanged, changed]);
		const next = graph(2, [unchanged, { ...changed, status: 'ready', graphRevisionUpdated: 2 }]);
		const operations: Array<{ query: string; params: unknown[] }> = [];
		const store = {
			batch: async (input: typeof operations) => { operations.push(...input); },
			first: async () => ({ revision: 2, graph_digest: next.digest }),
		};
		await persistExecutionGraph(store, next, current, revision(2, next.digest));
		const nodeWrites = operations.filter((operation) => operation.query.includes('INSERT INTO execution_nodes'));
		expect(nodeWrites).toHaveLength(1);
		expect(nodeWrites[0]?.params[0]).toBe('changed-node');
		expect(operations[1]?.params[9]).toContain('other-node');
	});

	it('fails closed when another reconciliation wins the graph revision', async () => {
		const next = graph(2);
		const store = {
			batch: async () => undefined,
			first: async () => ({ revision: 3, graph_digest: `sha256:${'f'.repeat(64)}` }),
		};
		await expect(persistExecutionGraph(store, next, graph(1), revision(2, next.digest)))
			.rejects.toMatchObject({ code: 'execution_graph_revision_conflict' });
	});

	it('reads lifecycle state from normalized columns without node JSON', async () => {
		const service = createExecutionGraphService({ first: async () => row('running') });
		await expect(service.node({ id: 'admin', roles: ['platform_admin'] }, 'team', 'node')).resolves.toMatchObject({
			id: 'node', status: 'running', sourceRef,
		});
	});
});

describe.skipIf(!process.env.TREESEED_TEST_POSTGRES_URL)('graph operational-state admission fence in PostgreSQL', () => {
	it('rejects stale projections after admission and completion without creating a revision', async () => {
		const connection = new URL(process.env.TREESEED_TEST_POSTGRES_URL!);
		if (connection.hostname !== '127.0.0.1' || connection.pathname !== '/postgres') throw new Error('Disposable loopback PostgreSQL required.');
		const admin = new pg.Pool({ connectionString: connection.href });
		const name = `treeseed_graph_test_${randomUUID().replaceAll('-', '')}`;
		await admin.query(`CREATE DATABASE "${name}"`);
		connection.pathname = `/${name}`;
		const database = createControlPlanePostgresDatabase(connection.href, { migrationMode: 'apply' });
		try {
			await database.migrate();
			const now = revision(1, '').createdAt;
			await database.pool.query(`INSERT INTO teams (id,slug,name,created_at,updated_at) VALUES ('team','team','Team',$1,$1)`, [now]);
			await database.pool.query(`INSERT INTO projects (id,team_id,slug,name,created_at,updated_at) VALUES ('project','team','project','Project',$1,$1)`, [now]);
			const store = {
				batch: (operations: Array<{ query: string; params: unknown[] }>) => database.batch(operations),
				first: (sql: string, params: unknown[]) => database.prepare(sql).bind(...params).first(),
			};
			const current = graph(1, [node('ready')]);
			await persistExecutionGraph(store, current, graph(0), revision(1, current.digest));
			const stale = graph(2, [node('ready')]);
			for (const status of ['assigned', 'completed'] as const) {
				await database.pool.query('UPDATE execution_nodes SET status=$1 WHERE id=$2', [status, 'node']);
				await expect(persistExecutionGraph(store, stale, current, revision(2, stale.digest)))
					.rejects.toMatchObject({ code: 'execution_graph_revision_conflict' });
				expect((await database.pool.query('SELECT status FROM execution_nodes WHERE id=$1', ['node'])).rows[0].status).toBe(status);
				expect((await database.pool.query('SELECT max(revision)::int AS revision FROM execution_graph_revisions')).rows[0].revision).toBe(1);
			}
			const refreshed = graph(1, [node('completed')]);
			const next = applyOperationalState(refreshed, stale, 2);
			await persistExecutionGraph(store, next, refreshed, revision(2, next.digest));
			expect((await database.pool.query('SELECT status FROM execution_nodes WHERE id=$1', ['node'])).rows[0].status).toBe('completed');
		} finally {
			await database.pool.end();
			await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
			await admin.end();
		}
	}, 30_000);
});

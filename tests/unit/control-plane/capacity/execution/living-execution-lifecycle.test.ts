import { describe, expect, it, vi } from 'vitest';
import { livingExecutionLifecycleOperations } from '../../../../../src/api/capacity/services/capacity/assignments/lifecycle/execution/living-execution-lifecycle.ts';

const digest = `sha256:${'a'.repeat(64)}`, commit = 'b'.repeat(40);
const sourceRef = { store: 'treedx', model: 'proposal', id: 'proposal', revision: 1, digest,
	repository: 'library', commit, path: 'proposals/one.mdx' };
const row = (id: string, status: string, pairRole: 'actor' | 'reviewer' = 'actor', workItemId = id, revision = 1) => ({ id, team_id: 'team', project_id: 'project', work_item_id: workItemId,
	kind: pairRole === 'reviewer' ? 'reviewing' : 'acting', pair_role: pairRole, source_ref_json: sourceRef, authority_refs_json: [], rule_revision: 1,
	node_revision: revision, agent_class: pairRole === 'reviewer' ? 'reviewer' : 'engineer', status, estimate_json: { minimumSeconds: 1, expectedSeconds: 2, maximumSeconds: 3 },
	required_capabilities_json: [], requested_permissions_json: { content: { read: ['proposal'], write: [] }, tools: ['source.read'] },
	workspace: 'read-only', acceptance_criteria_json: ['done'], maximum_review_cycles: 2,
	graph_revision_created: 1, graph_revision_updated: 1 });

describe('living execution result projection', () => {
	it('records completion, readies satisfied successors, and appends one graph revision', async () => {
		const store = { first: vi.fn(async () => ({ revision: 1 })), all: vi.fn(async (query: string) => query.includes('execution_nodes')
			? [row('actor', 'running'), row('next', 'blocked')]
			: [{ id: 'edge', team_id: 'team', from_node_id: 'actor', to_node_id: 'next', provenance: 'work-item',
				graph_revision_created: 1, graph_revision_removed: null }]) };
		const operations = await livingExecutionLifecycleOperations({ store: store as never,
			assignment: { id: 'assignment', teamId: 'team', executionNodeId: 'actor', executionNodeRevision: 1,
				assignmentAttempt: { sourceRef } } as never, status: 'completed', now: '2026-09-13T12:00:00.000Z',
			result: { id: 'result' } as never });
		expect(operations.map((operation) => operation.query)).toEqual(expect.arrayContaining([
			expect.stringContaining('assignment_result_json'), expect.stringContaining("status='ready'"),
			expect.stringContaining('INSERT INTO execution_graph_revisions'),
		]));
		const successorUpdate = operations.find((operation) => operation.query.includes("target.pair_role='reviewer'"))!;
		expect(successorUpdate.query).toContain('GREATEST(target.node_revision,?)');
		expect(successorUpdate.params?.slice(0, 2)).toEqual(['actor', 1]);
		const revision = operations.find((operation) => operation.query.includes('INSERT INTO execution_graph_revisions'))!;
		expect(revision.params?.[1]).toBe(2);
		expect(JSON.parse(String(revision.params?.[5]))).toMatchObject({ changed: ['actor', 'next'], completed: ['actor'] });
	});

	it('readies a paired Reviewer failed by a stopped workday after its retried Actor completes', async () => {
		const store = { first: vi.fn(async () => ({ revision: 7 })), all: vi.fn(async (query: string) => query.includes('execution_nodes')
			? [row('actor', 'running', 'actor', 'work', 13), row('reviewer', 'failed', 'reviewer', 'work', 12)]
			: [{ id: 'pair', team_id: 'team', from_node_id: 'actor', to_node_id: 'reviewer', provenance: 'review-pair',
				graph_revision_created: 1, graph_revision_removed: null }]) };
		const operations = await livingExecutionLifecycleOperations({ store: store as never,
			assignment: { id: 'retried-actor', teamId: 'team', executionNodeId: 'actor', executionNodeRevision: 13,
				assignmentAttempt: { sourceRef } } as never, status: 'completed', now: '2026-09-23T06:00:00.000Z',
			result: { id: 'result' } as never });
		const successorUpdate = operations.find((operation) => operation.query.includes("target.pair_role='reviewer'"))!;
		expect(successorUpdate.query).toContain("target.status='failed'");
		expect(successorUpdate.params).toEqual(['actor', 13, 8, '2026-09-23T06:00:00.000Z', 'team',
			'actor', 'work', 13, 'actor']);
		const revision = operations.find((operation) => operation.query.includes('INSERT INTO execution_graph_revisions'))!;
		expect(JSON.parse(String(revision.params?.[5]))).toMatchObject({ changed: ['actor', 'reviewer'], completed: ['actor'] });
	});

	it('advances the same Actor and Reviewer pair when exact review requests changes', async () => {
		const store = { first: vi.fn(async (query: string) => query.includes('COUNT(*)') ? ({ count: 0 }) : ({ revision: 3 })), all: vi.fn(async (query: string) => query.includes('execution_nodes')
			? [row('actor', 'completed', 'actor', 'work', 7), row('reviewer', 'running', 'reviewer', 'work', 3)]
			: [{ id: 'pair', team_id: 'team', from_node_id: 'actor', to_node_id: 'reviewer', provenance: 'review-pair',
				graph_revision_created: 1, graph_revision_removed: null }]) };
		const operations = await livingExecutionLifecycleOperations({ store: store as never,
			assignment: { id: 'review-assignment', teamId: 'team', executionNodeId: 'reviewer', executionNodeRevision: 3,
			assignmentAttempt: { sourceRef } } as never, status: 'completed', reviewDisposition: 'request-changes',
			now: '2026-09-13T12:00:00.000Z', result: { id: 'review-result' } as never });
		expect(store.first.mock.calls.find(([query]) => String(query).includes('COUNT(*)'))?.[0])
			.toContain("reviewDisposition}'='request-changes'");
		expect(operations.filter((operation) => operation.query.includes('UPDATE execution_nodes'))).toHaveLength(2);
		expect(operations.map((operation) => operation.query).join('\n')).not.toContain("target SET status='ready'");
		const actorUpdate = operations.find((operation) => operation.query.includes("pair_role='actor'"))!;
		expect(actorUpdate.query).toContain("status='completed'");
		expect(actorUpdate.query).toContain("THEN 'blocked' ELSE 'ready'");
		expect(actorUpdate.params).toEqual(['team', 'reviewer', 'review-assignment', 2, 4, '2026-09-13T12:00:00.000Z', 'team', 'actor', 7]);
		const revision = operations.find((operation) => operation.query.includes('INSERT INTO execution_graph_revisions'))!;
		expect(JSON.parse(String(revision.params?.[5]))).toMatchObject({ changed: ['reviewer', 'actor'], completed: [] });
	});

	it('blocks the same work item when its bounded review cycles are exhausted', async () => {
		const store = { first: vi.fn(async (query: string) => query.includes('COUNT(*)') ? ({ count: 1 }) : ({ revision: 4 })), all: vi.fn(async (query: string) => query.includes('execution_nodes')
			? [row('actor', 'completed', 'actor', 'work', 8), row('reviewer', 'running', 'reviewer', 'work', 4)]
			: [{ id: 'pair', team_id: 'team', from_node_id: 'actor', to_node_id: 'reviewer', provenance: 'review-pair',
				graph_revision_created: 1, graph_revision_removed: null }]) };
		const operations = await livingExecutionLifecycleOperations({ store: store as never,
			assignment: { id: 'review-assignment-2', teamId: 'team', executionNodeId: 'reviewer', executionNodeRevision: 4,
				assignmentAttempt: { sourceRef } } as never, status: 'completed', reviewDisposition: 'request-changes',
			now: '2026-09-13T12:00:00.000Z', result: { id: 'review-result-2' } as never });
		const sql = operations.map((operation) => operation.query).join('\n');
		const updates = operations.filter((operation) => operation.query.includes('UPDATE execution_nodes'));
		expect(updates.every((operation) => operation.query.includes('SELECT COUNT(*) FROM capacity_provider_assignments history'))).toBe(true);
		expect(updates.map((operation) => operation.params?.slice(0, 4))).toEqual([
			['team', 'reviewer', 'review-assignment-2', 2], ['team', 'reviewer', 'review-assignment-2', 2],
		]);
		expect(updates.every((operation) => operation.query.includes('history.id<>?'))).toBe(true);
		expect(sql).not.toContain("target SET status='ready'");
		const revision = operations.find((operation) => operation.query.includes('INSERT INTO execution_graph_revisions'))!;
		expect(JSON.parse(String(revision.params?.[5]))).toMatchObject({ blocked: ['reviewer', 'actor'] });
	});
	it('counts only the current simulation workday when enforcing review cycles', async () => {
		const store = { first: vi.fn(async (query: string) => query.includes('COUNT(*)') ? ({ count: 0 }) : ({ revision: 4 })),
			all: vi.fn(async (query: string) => query.includes('execution_nodes')
				? [row('actor', 'completed', 'actor', 'work', 8), row('reviewer', 'running', 'reviewer', 'work', 4)]
				: [{ id: 'pair', team_id: 'team', from_node_id: 'actor', to_node_id: 'reviewer', provenance: 'review-pair',
					graph_revision_created: 1, graph_revision_removed: null }]) };
		const operations = await livingExecutionLifecycleOperations({ store: store as never,
			assignment: { id: 'new-review', teamId: 'team', workDayId: 'fresh', executionMode: 'simulation',
				executionNodeId: 'reviewer', executionNodeRevision: 4, assignmentAttempt: { sourceRef } } as never,
			status: 'completed', reviewDisposition: 'request-changes', now: '2026-09-23T12:00:00.000Z',
			result: { id: 'new-review-result' } as never });
		expect(store.first.mock.calls.find(([query]) => String(query).includes('COUNT(*)'))?.[0]).toContain('AND work_day_id=?');
		const updates = operations.filter((operation) => operation.query.includes('UPDATE execution_nodes'));
		expect(updates).toHaveLength(2);
		expect(updates.every((operation) => operation.query.includes('history.work_day_id=?'))).toBe(true);
		expect(updates[0]?.params?.slice(0, 5)).toEqual(['team', 'reviewer', 'new-review', 'fresh', 2]);
	});

	it('fails a returned node when its immutable attempt reaches the bounded retry limit', async () => {
		const store = { first: vi.fn(async () => ({ revision: 1 })), all: vi.fn(async (query: string) => query.includes('execution_nodes')
			? [row('actor', 'running')] : []) };
		const operations = await livingExecutionLifecycleOperations({ store: store as never,
			assignment: { id:'assignment', teamId:'team', executionNodeId:'actor', executionNodeRevision:1,
				capacityEnvelope:{ budget:{ maxAttempts:1 } }, assignmentAttempt:{ sourceRef, attempt:1 } } as never,
			status:'returned', now:'2026-09-13T12:00:00.000Z' });
		const nodeUpdate = operations.find((operation) => operation.query.includes('UPDATE execution_nodes SET status='))!;
		expect(nodeUpdate.params?.[0]).toBe('failed');
		const revision = operations.find((operation) => operation.query.includes('INSERT INTO execution_graph_revisions'))!;
		expect(JSON.parse(String(revision.params?.[5]))).toMatchObject({ blocked:['actor'] });
	});
	it('retries one governance Reviewer response lost to a provider restart, not source-mutating work', async () => {
		const store = { first: vi.fn(async () => ({ revision: 1 })), all: vi.fn(async (query: string) => query.includes('execution_nodes')
			? [{ ...row('review', 'running', 'reviewer', 'proposal-review'), pair_role: null }] : []) };
		const assignment = { id: 'review-assignment', teamId: 'team', executionNodeId: 'review', executionNodeRevision: 1,
			capacityEnvelope: { budget: { maxAttempts: 1 } }, assignmentAttempt: { sourceRef, attempt: 1 } } as never;
		const operations = await livingExecutionLifecycleOperations({ store: store as never, assignment,
			status: 'returned', returnCode: 'provider_runtime_recovery', now: '2026-09-13T12:00:00.000Z' });
		expect(operations.find((operation) => operation.query.includes('UPDATE execution_nodes SET status='))?.params?.[0]).toBe('ready');
	});
});

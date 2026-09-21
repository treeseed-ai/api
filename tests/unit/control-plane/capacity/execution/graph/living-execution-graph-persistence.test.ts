import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createControlPlanePostgresDatabase } from '../../../../../../src/api/support/control-plane-postgres.ts';
import type { ExecutionNode, GraphRevision } from '@treeseed/sdk/agent-capacity';
import {
	applyOperationalState,
	createExecutionGraphService,
	persistExecutionGraph,
	recoverIncompleteReviewCycles,
} from '../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-service.ts';

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
		expect(applyOperationalState(current, desired, 2).nodes).toEqual([
			expect.objectContaining({ id: 'node', status: 'running', graphRevisionUpdated: 2 }),
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
		const recovered = recoverIncompleteReviewCycles(graph(3, [actor, reviewer]), new Map([['reviewer', 1]]), 4);
		expect(recovered.nodes).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: 'actor', status: 'ready', nodeRevision: 17 }),
			expect.objectContaining({ id: 'reviewer', status: 'blocked', nodeRevision: 3 }),
		]));
		const exhausted = recoverIncompleteReviewCycles(graph(3, [{ ...actor, status: 'blocked' }, { ...reviewer, status: 'failed' }]), new Map([['reviewer', 2]]), 4);
		expect(exhausted.nodes.find((candidate) => candidate.id === 'reviewer')?.status).toBe('failed');
	});

	it('preserves graph revision metadata when projected semantics are unchanged', () => {
		const current = graph(1, [node('ready')]);
		const projected = graph(2, [{ ...node('ready'), graphRevisionCreated: 2, graphRevisionUpdated: 2 }]);
		expect(applyOperationalState(current, projected, 2).nodes).toEqual([
			expect.objectContaining({ id: 'node', graphRevisionCreated: 1, graphRevisionUpdated: 1 }),
		]);
	});

	it('revises an unassigned node when projected assignment semantics change', () => {
		const current = graph(1, [node('ready')]);
		const projected = { ...node('blocked'), estimate: { minimumSeconds: 1, expectedSeconds: 5, maximumSeconds: 30 } };
		expect(applyOperationalState(current, graph(2, [projected]), 2).nodes).toEqual([
			expect.objectContaining({ id: 'node', status: 'ready', nodeRevision: 2, estimate: projected.estimate }),
		]);
	});

	it('preserves all immutable semantics for an in-flight node', () => {
		const current = graph(1, [node('running')]);
		const projected = { ...node('blocked'), estimate: { minimumSeconds: 1, expectedSeconds: 5, maximumSeconds: 30 } };
		expect(applyOperationalState(current, graph(2, [projected]), 2).nodes).toEqual([
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

import { describe, expect, it, vi } from 'vitest';
import { commitLivingExecutionLifecycle } from '../../../../../src/api/capacity/services/capacity/assignments/lifecycle/execution/living-execution-lifecycle.ts';
import type { CapacityGovernanceDatabase } from '../../../../../src/api/capacity/database.ts';
import { assignment } from '../execution/fixtures/assignment.ts';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';

const revisionConflict = () => Object.assign(new Error('concurrent graph revision'), {
	code: '23505', constraint: 'execution_graph_revisions_pkey',
});

const sourceRef = { store: 'treedx', model: 'proposal', id: 'proposal', revision: 1,
	digest: `sha256:${'a'.repeat(64)}`, repository: 'library', commit: 'b'.repeat(40), path: 'proposals/one.mdx' };
const attempt = assignmentAttemptSchema.parse({ ...assignment, nodeId: 'actor', graphRevision: 1, sourceRef });
const input = (store: CapacityGovernanceDatabase) => ({ store,
	assignment: { id: 'assignment', teamId: 'team', executionNodeId: 'actor', executionNodeRevision: 1,
		graphRevision: 1, stateVersion: 1, assignmentAttempt: attempt } as never,
	status: 'completed', now: '2026-09-13T12:00:00.000Z' });
const operations = [{ query: 'same assignment transition' }, { query: 'same teardown' }];
const nodeRow = { id: 'actor', team_id: 'team', project_id: 'project',
	work_item_id: 'work', kind: 'acting', pair_role: 'actor', source_ref_json: sourceRef, authority_refs_json: [],
	rule_revision: 1, node_revision: 1, agent_class: 'engineer', status: 'running',
	estimate_json: { expectedSeconds: 2, maximumSeconds: 3 }, required_capabilities_json: [],
	requested_permissions_json: { content: { read: ['proposal'], write: [] }, tools: ['source.read'] },
	workspace: 'read-only', acceptance_criteria_json: ['done'], maximum_review_cycles: 2,
	graph_revision_created: 1, graph_revision_updated: 1 };

function fixture(fail: (attempt: number) => Error | null) {
	const attempts: Array<Array<{ query: string; params: unknown[] }>> = [];
	const transaction = vi.fn(async (apply: (client: never) => Promise<unknown>) => {
		const queries: Array<{ query: string; params: unknown[] }> = []; attempts.push(queries);
		const query = async (sql: string, params: unknown[] = []) => {
			queries.push({ query: sql, params });
			if (sql.includes('INSERT INTO execution_graph_revisions')) {
				const error = fail(attempts.length); if (error) throw error;
			}
			const rows = sql.includes('SELECT revision') ? [{ revision: attempts.length + 9 }]
				: sql.includes('SELECT * FROM execution_nodes') ? [structuredClone(nodeRow)]
					: sql.includes('SELECT id FROM capacity_provider_assignments') ? [{ id: attempt.id }]
						: sql.includes('SELECT id FROM execution_nodes') ? [{ id: attempt.nodeId }] : [];
			return { rows, rowCount: rows.length };
		};
		return apply({ query } as never);
	});
	return { store: { db: { transaction } } as unknown as CapacityGovernanceDatabase, attempts, transaction };
}

describe('concurrent assignment graph completion', () => {
	it('reprojects only the rolled-back graph operations against the committed revision', async () => {
		const { store, attempts, transaction } = fixture(attempt => attempt === 1 ? revisionConflict() : null);
		const before = structuredClone(operations);
		await commitLivingExecutionLifecycle(input(store), operations);
		expect(transaction).toHaveBeenCalledTimes(2);
		expect(attempts.map(queries => queries[0]?.query)).toEqual([
			'SELECT id FROM teams WHERE id=$1 FOR NO KEY UPDATE', 'SELECT id FROM teams WHERE id=$1 FOR NO KEY UPDATE',
		]);
		expect(attempts.map(queries => queries.find(row => row.query.includes('INSERT INTO execution_graph_revisions'))?.params[1]))
			.toEqual([11, 12]);
		expect(attempts.map(queries => queries.filter(row => row.query.startsWith('same ')).map(row => row.query)))
			.toEqual([['same assignment transition'], ['same assignment transition', 'same teardown']]);
		expect(operations).toEqual(before);
	});

	it('fails closed on unrelated uniqueness errors and bounded repeated contention', async () => {
		const unrelated = Object.assign(new Error('other unique key'), { code: '23505', constraint: 'other_pkey' });
		const first = fixture(() => unrelated);
		await expect(commitLivingExecutionLifecycle(input(first.store), operations)).rejects.toBe(unrelated);
		expect(first.transaction).toHaveBeenCalledOnce();
		const repeated = fixture(() => revisionConflict());
		await expect(commitLivingExecutionLifecycle(input(repeated.store), operations)).rejects.toMatchObject({
			constraint: 'execution_graph_revisions_pkey',
		});
		expect(repeated.transaction).toHaveBeenCalledTimes(4);
		expect(repeated.attempts.every(queries => !queries.some(row => row.query === 'same teardown'))).toBe(true);
	});
	it('propagates an inherited transaction failure without reusing its aborted connection', async () => {
		const error = revisionConflict();
		const store = fixture(() => null);
		const database = { run: vi.fn(async () => {}), first: vi.fn(async (sql: string) =>
			 sql.includes('SELECT revision') ? { revision: 10 } : { id: sql.includes('capacity_provider_assignments') ? attempt.id : attempt.nodeId }),
			all: vi.fn(async (sql: string) => sql.includes('execution_nodes') ? [structuredClone(nodeRow)] : []),
			batch: vi.fn(async () => { throw error; }) } as unknown as CapacityGovernanceDatabase;
		await expect(commitLivingExecutionLifecycle(input(store.store), operations, database)).rejects.toBe(error);
		expect(store.transaction).not.toHaveBeenCalled();
		expect(database.batch).toHaveBeenCalledOnce();
	});
});

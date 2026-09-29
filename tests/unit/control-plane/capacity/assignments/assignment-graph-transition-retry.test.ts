import { describe, expect, it, vi } from 'vitest';
import { batchAssignmentGraphTransition } from '../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-lifecycle-service.ts';

const statement = (query: string) => ({ query });
const revisionConflict = () => Object.assign(new Error('concurrent graph revision'), {
	code: '23505', constraint: 'execution_graph_revisions_pkey',
});

describe('concurrent assignment graph completion', () => {
	it('reprojects only the rolled-back graph operations against the committed revision', async () => {
		const batches: string[][] = [];
		const batch = vi.fn(async (operations: Array<{ query: string }>) => {
			batches.push(operations.map((operation) => operation.query));
			if (batches.length === 1) throw revisionConflict();
		});
		const rebuildGraphOperations = vi.fn(async () => [statement('graph revision 12')]);
		await batchAssignmentGraphTransition({
			operations: [statement('same assignment transition'), statement('graph revision 11'), statement('same teardown')],
			graphOperationCount: 1, batch, rebuildGraphOperations,
		});
		expect(batches).toEqual([
			['same assignment transition', 'graph revision 11', 'same teardown'],
			['same assignment transition', 'graph revision 12', 'same teardown'],
		]);
		expect(rebuildGraphOperations).toHaveBeenCalledOnce();
	});

	it('fails closed on unrelated uniqueness errors and bounded repeated contention', async () => {
		const unrelated = Object.assign(new Error('other unique key'), { code: '23505', constraint: 'other_pkey' });
		const rebuildGraphOperations = vi.fn(async () => [statement('new graph')]);
		await expect(batchAssignmentGraphTransition({ operations: [statement('assignment')], graphOperationCount: 0,
			batch: async () => { throw unrelated; }, rebuildGraphOperations })).rejects.toBe(unrelated);
		expect(rebuildGraphOperations).not.toHaveBeenCalled();
		let attempts = 0;
		await expect(batchAssignmentGraphTransition({ operations: [statement('assignment')], graphOperationCount: 0,
			batch: async () => { attempts++; throw revisionConflict(); }, rebuildGraphOperations })).rejects.toMatchObject({
			constraint: 'execution_graph_revisions_pkey',
		});
		expect(attempts).toBe(4);
	});
});

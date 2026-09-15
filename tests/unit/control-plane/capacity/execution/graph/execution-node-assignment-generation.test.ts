import { describe, expect, it, vi } from 'vitest';
import { executionNodeAssignmentGeneration } from '../../../../../../src/api/capacity/services/capacity/assignments/planning/execution/living-execution-assignment.ts';

describe('living execution-node assignment generations', () => {
	it('starts at zero for a node revision with no prior assignments', async () => {
		const store = { first: vi.fn().mockResolvedValue({ assignment_count: 0 }) };
		await expect(executionNodeAssignmentGeneration(store as never, 'team', 'node', 2)).resolves.toBe(0);
		expect(store.first).toHaveBeenCalledWith(expect.stringContaining('execution_node_revision=?'), ['team', 'node', 2]);
	});

	it('advances the deterministic generation after every prior attempt', async () => {
		const store = { first: vi.fn().mockResolvedValue({ assignment_count: 3 }) };
		await expect(executionNodeAssignmentGeneration(store as never, 'team', 'node', 2)).resolves.toBe(3);
	});
});

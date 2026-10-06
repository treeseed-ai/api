import { describe, expect, it, vi } from 'vitest';

const { getAssignment } = vi.hoisted(() => ({ getAssignment: vi.fn() }));

vi.mock('../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts', () => ({
	ProviderAssignmentRepository: class {
		get = getAssignment;
	},
}));

import { OperatorAssignmentService } from '../../../../../src/api/capacity/services/capacity/assignments/observability/operator-assignment-service.ts';

describe('operator assignment requeue', () => {
	it('reopens a returned graph node without requiring its reusable reservation to be settled', async () => {
		getAssignment.mockResolvedValue({
			id: 'assignment-1', teamId: 'team-1', status: 'returned', leaseState: 'released',
			reservationId: 'reservation-1', executionNodeId: 'node-1', executionNodeRevision: 1,
			stateVersion: 4, metadata: { retained: true },
		});
		const database = {
			ensureInitialized: vi.fn(),
			first: vi.fn().mockResolvedValue({ node_revision: 2, status: 'ready' }),
		} as never;

		const result = await new OperatorAssignmentService(database).requeue('team-1', 'assignment-1', {
			idempotencyKey: 'retry-1',
		});

		expect(result).toMatchObject({ demand: null, alreadyLeasable: false });
		expect(database.first).toHaveBeenCalledOnce();
		expect(database.first.mock.calls[0]?.[0]).toContain("target.status='ready'");
		expect(database.first.mock.calls[0]?.[0]).toContain('marked_assignment');
		expect(database.first.mock.calls[0]?.[0]).toContain("reopened.pair_role='actor'");
		expect(database.first.mock.calls[0]?.[0]).toContain("reviewer.pair_role='reviewer'");
		expect(JSON.parse(String(database.first.mock.calls[0]?.[1]?.[3]))).toMatchObject({
			retained: true, operatorRetry: { requestedAt: expect.any(String) },
		});
	});
});

import { describe, expect, it, vi } from 'vitest';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { createAssignmentOperations } from '../../../../src/api/control-plane/catalog/capacity/assignments.ts';
import { createAssignmentService } from '../../../../src/api/control-plane/repositories/capacity/assignment-service.ts';

const principal = { id: 'user-1' };
describe('assignment catalog operations', () => {
	it('binds only the five operator assignment operations', () => {
		const assignments = Object.fromEntries(['list', 'show', 'explain', 'cancel', 'retry'].map((name) => [name, vi.fn()])) as any;
		expect(createAssignmentOperations({ assignments }).map((operation) => operation.binding)).toEqual([
			CONTROL_PLANE_OPERATIONS.assignments.list, CONTROL_PLANE_OPERATIONS.assignments.show,
			CONTROL_PLANE_OPERATIONS.assignments.explain, CONTROL_PLANE_OPERATIONS.assignments.cancel,
			CONTROL_PLANE_OPERATIONS.assignments.retry,
		]);
	});

	it('passes API-derived actor and idempotency evidence to cancellation', async () => {
		const store = { principalCanAccessTeam: vi.fn(async () => true),
			getTeamAccessSummary: vi.fn(async () => ({ permissions: ['teams:manage:team'] })),
			cancelCapacityAssignment: vi.fn(async (_teamId, _assignmentId, input) => input) };
		await expect(createAssignmentService(store).cancel(principal, 'team-1', 'assignment-1', { reason: 'operator' }, 'cancel-1'))
			.resolves.toMatchObject({ reason: 'operator', actorId: 'user-1', idempotencyKey: 'cancel-1' });
	});
});

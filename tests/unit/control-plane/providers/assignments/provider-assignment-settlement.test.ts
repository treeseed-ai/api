import { beforeEach, describe, expect, it, vi } from 'vitest';

const { settleCapacityReservationExactlyOnce } = vi.hoisted(() => ({
	settleCapacityReservationExactlyOnce: vi.fn(),
}));

vi.mock('../../../../../src/api/capacity/services/capacity/accounting/settlement-service.ts', () => ({
	settleCapacityReservationExactlyOnce,
}));

import { createProviderAssignmentService } from '../../../../../src/api/control-plane/repositories/providers/provider-assignment-service.ts';

const auth = { principal: {
	membershipId: 'membership-1', teamId: 'team-1', capacityProviderId: 'provider-1',
	scopes: ['provider:usage:write', 'provider:assignments:write'],
} };

describe('provider assignment settlement', () => {
	beforeEach(() => {
		settleCapacityReservationExactlyOnce.mockReset().mockResolvedValue({ replayed: false, entry: { id: 'entry-1' } });
	});

	it('rejects retired mode-run identity before any settlement or assignment lookup', async () => {
		const store = { first: vi.fn() } as never;
		const service = createProviderAssignmentService(store);
		await expect(service.settle(auth, 'assignment-1', { modeRunId: 'retired-run', activeSeconds: 1, elapsedSeconds: 1 }, 'key'))
			.rejects.toMatchObject({ code: 'mode_run_contract_retired', status: 400 });
		expect(settleCapacityReservationExactlyOnce).not.toHaveBeenCalled();
	});

	it('closes the canonical suspended conversation checkpoint after durable settlement', async () => {
		const returnProviderAssignment = vi.fn().mockResolvedValue({ assignment: { id: 'assignment-1' } });
		const store = {
			first: vi.fn().mockResolvedValue({ id: 'assignment-1', team_id: 'team-1', membership_id: 'membership-1', reservation_id: 'reservation-1' }),
			getProviderAssignment: vi.fn().mockResolvedValue({
				id: 'assignment-1', teamId: 'team-1', membershipId: 'membership-1', capacityProviderId: 'provider-1',
				executionKind: 'conversation', status: 'returned', leaseState: 'released', lifecycleCode: 'discussion_response_required',
			}),
			returnProviderAssignment,
		} as never;
		const service = createProviderAssignmentService(store);

		await expect(service.settle(auth, 'assignment-1', { activeSeconds: 4, elapsedSeconds: 5, usageActual: {} }, 'settlement-1'))
			.resolves.toEqual({ replayed: false, entry: { id: 'entry-1' } });
		expect(returnProviderAssignment).toHaveBeenCalledWith(auth.principal, 'assignment-1', {});
	});

	it('does not invoke conversation closeout for ordinary workday settlement', async () => {
		const returnProviderAssignment = vi.fn();
		const store = {
			first: vi.fn().mockResolvedValue({ id: 'assignment-1', team_id: 'team-1', membership_id: 'membership-1', reservation_id: 'reservation-1' }),
			getProviderAssignment: vi.fn().mockResolvedValue({
				id: 'assignment-1', teamId: 'team-1', membershipId: 'membership-1', capacityProviderId: 'provider-1',
				executionKind: 'workday', status: 'completed', leaseState: 'released', lifecycleCode: 'completed',
			}),
			returnProviderAssignment,
		} as never;
		const service = createProviderAssignmentService(store);

		await service.settle(auth, 'assignment-1', { activeSeconds: 4, elapsedSeconds: 5, usageActual: {} }, 'settlement-1');
		expect(returnProviderAssignment).not.toHaveBeenCalled();
	});
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { settleCapacityReservationExactlyOnce } = vi.hoisted(() => ({
	settleCapacityReservationExactlyOnce: vi.fn(),
}));

vi.mock('../../../../../src/api/capacity/services/capacity/accounting/settlement-service.ts', () => ({
	settleCapacityReservationExactlyOnce,
}));

import { createProviderAssignmentService } from '../../../../../src/api/control-plane/repositories/providers/provider-assignment-service.ts';
import { frozenAttempt, terminalUsage } from '../../capacity/accounting/architecture/settlement-fixture.ts';

const auth = { principal: {
	membershipId: terminalUsage.membershipId, teamId: terminalUsage.teamId, capacityProviderId: 'provider',
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

	it('settles conversation usage without inventing a returned checkpoint or completing before its result', async () => {
		const returnProviderAssignment = vi.fn().mockResolvedValue({ assignment: { id: 'assignment-1' } });
		const store = {
			first: vi.fn().mockResolvedValue({ id: frozenAttempt.id, team_id: 'team', membership_id: 'membership', reservation_id: 'reservation',
				capacity_provider_id: 'provider', assignment_attempt_json: JSON.stringify(frozenAttempt), attempt_count: 1 }),
			getProviderAssignment: vi.fn().mockResolvedValue({
				id: 'assignment-1', teamId: 'team-1', membershipId: 'membership-1', capacityProviderId: 'provider-1',
				executionKind: 'conversation', status: 'leased', leaseState: 'leased', lifecycleCode: null,
			}),
			returnProviderAssignment,
		} as never;
		const service = createProviderAssignmentService(store);

		await expect(service.settle(auth, frozenAttempt.id, { ...structuredClone(terminalUsage) }, 'settlement-1'))
			.resolves.toEqual({ replayed: false, entry: { id: 'entry-1' } });
		expect(settleCapacityReservationExactlyOnce).toHaveBeenCalledWith(store, expect.objectContaining({
			assignmentId: frozenAttempt.id, assignmentAttempt: 1, activeSeconds: 2, elapsedSeconds: 3, usageActual: terminalUsage.usageActual,
		}));
		expect(returnProviderAssignment).not.toHaveBeenCalled();
	});

	it('does not invoke conversation closeout for ordinary workday settlement', async () => {
		const returnProviderAssignment = vi.fn();
		const store = {
			first: vi.fn().mockResolvedValue({ id: frozenAttempt.id, team_id: 'team', membership_id: 'membership', reservation_id: 'reservation',
				capacity_provider_id: 'provider', assignment_attempt_json: JSON.stringify(frozenAttempt), attempt_count: 1 }),
			getProviderAssignment: vi.fn().mockResolvedValue({
				id: 'assignment-1', teamId: 'team-1', membershipId: 'membership-1', capacityProviderId: 'provider-1',
				executionKind: 'workday', status: 'completed', leaseState: 'released', lifecycleCode: 'completed',
			}),
			returnProviderAssignment,
		} as never;
		const service = createProviderAssignmentService(store);

		await service.settle(auth, frozenAttempt.id, { ...structuredClone(terminalUsage) }, 'settlement-1');
		expect(returnProviderAssignment).not.toHaveBeenCalled();
	});
});

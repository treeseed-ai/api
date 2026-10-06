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
		const effects: string[] = [];
		const guarded: Parameters<typeof createProviderAssignmentService>[0] = {
			ensureInitialized: async () => { effects.push('initialize'); },
			run: async () => { effects.push('run'); }, first: async () => { effects.push('first'); return null; },
			all: async () => { effects.push('all'); return []; }, batch: async () => { effects.push('batch'); },
			getProviderAssignment: async () => { effects.push('assignment'); return null; },
			leaseNextProviderAssignment: async () => { effects.push('lease'); return {}; },
			renewProviderAssignmentLease: async () => { effects.push('renew'); return null; },
			returnProviderAssignment: async () => { effects.push('return'); return null; },
			completeProviderAssignment: async () => { effects.push('complete'); return null; },
			failProviderAssignment: async () => { effects.push('fail'); return null; },
		};
		const original = createProviderAssignmentService(guarded);
		const methods: Array<(body: Record<string, unknown>) => Promise<unknown>> = [
			body => original.renew(auth, 'assignment-1', body), body => original.returnAssignment(auth, 'assignment-1', body),
			body => original.complete(auth, 'assignment-1', body), body => original.fail(auth, 'assignment-1', body),
			body => original.reportUsage(auth, 'assignment-1', body, 'original-key'), body => original.settle(auth, 'assignment-1', body, 'original-key'),
		];
		for (const modeRunId of [undefined, null, '', 'retired-run', false, 0, {}, []]) for (const method of methods) {
			const body = { activeSeconds: 1, elapsedSeconds: 1, modeRunId }, before = structuredClone(body);
			await expect(method(body)).rejects.toMatchObject({ code: 'mode_run_contract_retired', status: 400 });
			expect(effects).toEqual([]); expect(settleCapacityReservationExactlyOnce).not.toHaveBeenCalled();
			expect(Object.hasOwn(body, 'modeRunId')).toBe(true); expect(body).toEqual(before);
		}
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

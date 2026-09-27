import { describe, expect, it, vi } from 'vitest';
import { CapacityWorkdayMaintenanceScheduler, runCapacityWorkdayMaintenance } from '../../../../src/api/capacity/services/capacity/workdays/lifecycle/workday-maintenance-service.ts';

function fixture() {
	return {
		maintainCapacityWorkdayRuns: vi.fn(async () => ({ expired: 0 })),
		recoverExpiredProviderAssignments: vi.fn(async () => ({ recovered: 0, safeRetries: 0, terminalFailures: 0, completed: 0, operatorActions: 0 })),
		maintainCapacityRuntimeRetention: vi.fn(async () => ({ expiredAccessTokens: 0, expiredAvailabilitySessions: 0, expiredRegistrationRequests: 0, deletedProofNonces: 0, deletedRateLimitBuckets: 0 })),
		tickDueCapacityWorkdaySchedules: vi.fn(async () => ({ considered: 0, created: 0, failures: [] })),
		all: vi.fn(async () => [{ id: 'workday', team_id: 'team' }]),
		tickCapacityWorkdayRun: vi.fn(async () => undefined),
	};
}

describe('complete workday maintenance pass', () => {
	it('reconciles running graphs after each housekeeping failure and preserves diagnostics', async () => {
		for (const method of ['maintainCapacityWorkdayRuns', 'recoverExpiredProviderAssignments', 'maintainCapacityRuntimeRetention', 'tickDueCapacityWorkdaySchedules'] as const) {
			const store = fixture();
			store[method].mockRejectedValueOnce(new Error('sweep failed'));
			await expect(runCapacityWorkdayMaintenance(store as never, '2026-09-26T21:30:00Z')).rejects.toThrow('sweep failed');
			expect(store.tickCapacityWorkdayRun).toHaveBeenCalledWith('team', 'workday', '2026-09-26T21:30:00Z', 'maintenance-recovery:workday:2026-09-26T21:30:00Z');
		}
	});
	it('retries after a failed sweep without overlapping maintenance passes', async () => {
		const store = fixture();
		store.maintainCapacityRuntimeRetention.mockRejectedValueOnce(new Error('sweep failed'));
		const scheduler = new CapacityWorkdayMaintenanceScheduler(store as never, 1_000);
		const first = scheduler.runIfDue(new Date('2026-09-26T21:30:00Z'));
		expect(scheduler.runIfDue(new Date('2026-09-26T21:30:01Z'))).toBe(first);
		await expect(first).rejects.toThrow('retention: sweep failed');
		await expect(scheduler.runIfDue(new Date('2026-09-26T21:30:01Z'))).resolves.toMatchObject({ runningWorkdaysReticked: 1 });
		expect(store.tickCapacityWorkdayRun).toHaveBeenCalledTimes(2);
	});
});

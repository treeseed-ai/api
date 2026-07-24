import { describe, expect, it, vi } from 'vitest';
import {
	CapacityWorkdayMaintenanceScheduler,
	runCapacityWorkdayMaintenance,
} from '../../../../../src/api/capacity/services/capacity/workdays/lifecycle/workday-maintenance-service.ts';

describe('capacity workday maintenance', () => {
	it('terminalizes stale workdays without mutating governance grants', async () => {
		const calls: string[] = [];
		const store = {
			async maintainCapacityWorkdayRuns(_teamId: string | null, now: string) {
				calls.push(`workdays:${now}`);
				return { expired: 2 };
			},
			async recoverExpiredProviderAssignments({ now }: { now?: string }) {
				calls.push(`assignments:${now}`);
				return { recovered: 3, safeRetries: 1, terminalFailures: 1, completed: 0, operatorActions: 1 };
			},
			async maintainCapacityRuntimeRetention(now: string) {
				calls.push(`retention:${now}`);
				return { expiredAccessTokens: 5, expiredAvailabilitySessions: 4, expiredRegistrationRequests: 3, deletedProofNonces: 2, deletedRateLimitBuckets: 1 };
			},
		};
		const result = await runCapacityWorkdayMaintenance(store, '2026-07-17T04:00:00.000Z');
		expect(calls).toEqual([
			'workdays:2026-07-17T04:00:00.000Z',
			'assignments:2026-07-17T04:00:00.000Z',
			'retention:2026-07-17T04:00:00.000Z',
		]);
		expect(result).toEqual({
			ranAt: '2026-07-17T04:00:00.000Z',
			terminalizedWorkdays: 2,
			recoveredTerminalWorkdays: 0,
			recoveredExpiredAssignments: 3,
			expiredAssignmentSafeRetries: 1,
			expiredAssignmentTerminalFailures: 1,
			expiredAssignmentCompletions: 0,
			expiredAssignmentOperatorActions: 1,
			expiredAccessTokens: 5,
			expiredAvailabilitySessions: 4,
			expiredRegistrationRequests: 3,
			deletedProofNonces: 2,
			deletedRateLimitBuckets: 1,
		});
	});

	it('runs at most once per interval and coalesces concurrent ticks', async () => {
		let release: (() => void) | undefined;
		const pending = new Promise<void>((resolve) => { release = resolve; });
		const store = {
			maintainCapacityWorkdayRuns: vi.fn(async () => {
				await pending;
				return { expired: 1 };
			}),
			recoverExpiredProviderAssignments: vi.fn(async () => ({ recovered: 0, safeRetries: 0, terminalFailures: 0, completed: 0, operatorActions: 0 })),
			maintainCapacityRuntimeRetention: vi.fn(async () => ({ expiredAccessTokens: 0, expiredAvailabilitySessions: 0, expiredRegistrationRequests: 0, deletedProofNonces: 0, deletedRateLimitBuckets: 0 })),
		};
		const scheduler = new CapacityWorkdayMaintenanceScheduler(store, 30_000);
		const now = new Date('2026-07-17T04:00:00.000Z');
		const first = scheduler.runIfDue(now);
		const concurrent = scheduler.runIfDue(now);
		release?.();
		expect(await first).toMatchObject({ terminalizedWorkdays: 1 });
		expect(await concurrent).toMatchObject({ terminalizedWorkdays: 1 });
		expect(await scheduler.runIfDue(new Date(now.getTime() + 10_000))).toBeNull();
		expect(store.maintainCapacityWorkdayRuns).toHaveBeenCalledTimes(1);
	});

	it('propagates maintenance storage failures instead of reporting a false no-op', async () => {
		const failure = Object.assign(new Error('database unavailable'), { code: 'capacity_storage_unavailable' });
		const store = {
			maintainCapacityWorkdayRuns: vi.fn(async () => { throw failure; }),
			recoverExpiredProviderAssignments: vi.fn(async () => ({ recovered: 0, safeRetries: 0, terminalFailures: 0, completed: 0, operatorActions: 0 })),
			maintainCapacityRuntimeRetention: vi.fn(async () => ({ expiredAccessTokens: 0, expiredAvailabilitySessions: 0, expiredRegistrationRequests: 0, deletedProofNonces: 0, deletedRateLimitBuckets: 0 })),
		};
		await expect(runCapacityWorkdayMaintenance(store, '2026-07-17T04:00:00.000Z')).rejects.toBe(failure);
	});
});

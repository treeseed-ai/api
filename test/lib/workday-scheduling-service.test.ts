import { describe, expect, it, vi } from 'vitest';
import { terminalizeCapacityWorkdayEnvelopes } from '../../src/api/capacity/services/workday-envelope-terminalization-service.ts';
import { recordCapacityWorkdayScheduleFailure } from '../../src/api/capacity/services/workday-scheduling-service.ts';

describe('workday scheduling recovery', () => {
	it('terminalizes envelopes by exact durable run ownership instead of id prefix', async () => {
		const all = vi.fn()
			.mockResolvedValueOnce([{ id: 'arbitrary-envelope-a' }, { id: 'arbitrary-envelope-b' }])
			.mockResolvedValueOnce([]);
		const updateWorkdayCapacityEnvelopeState = vi.fn(async (id: string, status: string) => ({ id, status }));
		await expect(terminalizeCapacityWorkdayEnvelopes({
			all, updateWorkdayCapacityEnvelopeState,
		} as never, 'team-a', 'run-a', 'failed')).resolves.toEqual({ terminalized: 2 });
		expect(all.mock.calls[0]?.[0]).toContain('workday_run_id = ?');
		expect(all.mock.calls[0]?.[1]?.slice(0, 2)).toEqual(['team-a', 'run-a']);
		expect(updateWorkdayCapacityEnvelopeState.mock.calls).toEqual([
			['arbitrary-envelope-a', 'failed'], ['arbitrary-envelope-b', 'failed'],
		]);
	});

	it('propagates envelope storage failure and rejects an unconfirmed transition', async () => {
		const storageFailure = new Error('envelope storage unavailable');
		await expect(terminalizeCapacityWorkdayEnvelopes({
			all: vi.fn(async () => { throw storageFailure; }),
		} as never, 'team-a', 'run-a', 'failed')).rejects.toBe(storageFailure);
		await expect(terminalizeCapacityWorkdayEnvelopes({
			all: vi.fn().mockResolvedValueOnce([{ id: 'envelope-a' }]),
			updateWorkdayCapacityEnvelopeState: vi.fn(async () => null),
		} as never, 'team-a', 'run-a', 'failed'))
			.rejects.toMatchObject({ code: 'capacity_workday_envelope_terminalization_failed' });
	});

	it('attempts every required recovery record and reports incomplete evidence', async () => {
		const createCapacityWorkdayEvent = vi.fn(async () => ({ id: 'event-a' }));
		const updateCapacityWorkdayRun = vi.fn(async () => ({ id: 'run-a', status: 'failed' }));
		await expect(recordCapacityWorkdayScheduleFailure({
			terminalizeCapacityWorkdayEnvelopes: vi.fn(async () => { throw new Error('envelope update failed'); }),
			createCapacityWorkdayEvent,
			updateCapacityWorkdayRun,
		} as never, { teamId: 'team-a', id: 'run-a' }, Object.assign(new Error('policy missing'), { code: 'policy_missing' })))
			.rejects.toMatchObject({
				code: 'capacity_workday_schedule_recovery_incomplete',
				details: { schedulingFailure: { code: 'policy_missing' }, recoveryFailures: [{ owner: 'envelopes' }] },
			});
		expect(createCapacityWorkdayEvent).toHaveBeenCalledOnce();
		expect(updateCapacityWorkdayRun).toHaveBeenCalledOnce();
	});
});

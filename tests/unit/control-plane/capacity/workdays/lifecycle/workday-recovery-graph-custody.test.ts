import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapacityWorkdayRecoveryRepository } from '../../../../../../src/api/capacity/repositories/capacity/workdays/workday-recovery.ts';
import { maintainCapacityWorkdayRuns } from '../../../../../../src/api/capacity/services/capacity/workdays/lifecycle/workday-recovery-service.ts';
import { compileCapacityWorkdayRunRecord } from '../../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-run-service.ts';

afterEach(() => vi.restoreAllMocks());

describe('workday recovery graph custody', () => {
	it('recovers later terminal workdays before reporting a corrupt historical assignment', async () => {
		const runs = ['old', 'current'].map(id => compileCapacityWorkdayRunRecord('team', { id, status: 'cancelled',
			executionMode: 'simulation', startedAt: '2026-09-30T04:59:00Z', completedAt: '2026-09-30T05:00:00Z',
			parameters: { durationSeconds: 60 } }, { now: '2026-09-30T04:59:00Z' }));
		const original = structuredClone(runs);
		vi.spyOn(CapacityWorkdayRecoveryRepository.prototype, 'listRunning').mockResolvedValue([]);
		vi.spyOn(CapacityWorkdayRecoveryRepository.prototype, 'listTerminal').mockResolvedValue(runs);
		vi.spyOn(CapacityWorkdayRecoveryRepository.prototype, 'recoveryState').mockImplementation(async run => ({
			run, hasUnfinishedAssignments: true, hasReadyNodes: false, missingDeadlineEvent: false }));
		const defect = new Error('Invalid historical assignment_attempt_json at agentClass');
		const store = { terminalizeCapacityWorkdayAssignments: vi.fn(async (_team: string, id: string) => {
			if (id === 'old') throw defect;
			return { unfinishedAssignmentCount: 0 };
		}), createCapacityWorkdayEvent: vi.fn() };
		await expect(maintainCapacityWorkdayRuns(store as never, 'team', '2026-09-30T05:10:00Z'))
			.rejects.toMatchObject({ name: 'AggregateError', errors: [expect.objectContaining({ cause: defect })] });
		expect(store.terminalizeCapacityWorkdayAssignments.mock.calls.map(([, id]) => id)).toEqual(['old', 'current']);
		expect(store.createCapacityWorkdayEvent).not.toHaveBeenCalled();
		expect(runs).toEqual(original); // Neither authority nor a success result is manufactured.
	});
	it('finds ready graph work and assignment evidence by the canonical workday IDs', async () => {
		const queries: string[] = [];
		const database = {
			ensureInitialized: vi.fn(async () => undefined),
			first: vi.fn(async (query: string) => {
				queries.push(query);
				return query.includes('FROM execution_nodes') ? { id: 'ready-node' } : null;
			}),
		};
		const run = compileCapacityWorkdayRunRecord('team', { id: 'run', status: 'cancelled', executionMode: 'simulation',
			startedAt: '2026-09-30T04:59:00Z', completedAt: '2026-09-30T05:00:00Z', parameters: { durationSeconds: 60 } },
			{ now: '2026-09-30T04:59:00Z' });
		const state = await new CapacityWorkdayRecoveryRepository(database as never).recoveryState(run);
		expect(state).toMatchObject({ hasReadyNodes: true, hasUnfinishedAssignments: false });
		expect(queries.join('\n')).not.toContain('capacity_workday_demands');
		expect(queries.join('\n')).toContain('assignment.work_day_id = ?');
		expect(queries.join('\n')).toContain("workday_id = ? AND status = 'ready'");
	});
});

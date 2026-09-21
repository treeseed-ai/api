import { describe, expect, it, vi } from 'vitest';
import { fenceCapacityWorkdayAdmission } from '../../../../../../src/api/capacity/services/capacity/workdays/lifecycle/workday-admission-fence-service.ts';

const runGet = vi.hoisted(() => vi.fn());
const advance = vi.hoisted(() => vi.fn());
const reconcile = vi.hoisted(() => vi.fn());
vi.mock('../../../../../../src/api/capacity/repositories/capacity/workdays/workday-run.ts', () => ({
	CapacityWorkdayRunRepository: class { get = runGet; },
}));
vi.mock('../../../../../../src/api/capacity/services/capacity/workdays/lifecycle/living-workday-lifecycle.ts', () => ({ advanceLivingWorkday: advance }));
vi.mock('../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-service.ts', () => ({ reconcileExecutionGraph: reconcile }));

describe('living workday admission fence', () => {
	it('counts direct living-graph assignments without demand rows', async () => {
		runGet.mockResolvedValue({ id: 'run', status: 'completed', parameters: {} });
		const queries: string[] = [];
		const store = {
			first: vi.fn(async (query: string) => {
				queries.push(query);
				return { total: 1, completed: 0, failed: 0, non_terminal: 1, unsettled: 0 };
			}),
			all: vi.fn(async (query: string) => { queries.push(query); return [{ id: 'assignment', status: 'running' }]; }),
		};
		const fence = await fenceCapacityWorkdayAdmission(store as never, 'team', 'run');
		expect(fence).toMatchObject({ ready: false, assignments: { total: 1, nonTerminal: 1 },
			problemAssignmentIds: ['assignment'] });
		expect(queries.join('\n')).not.toContain('capacity_workday_demands');
		expect(queries.filter((query) => query.includes('FROM capacity_provider_assignments'))
			.every((query) => query.includes('assignment.work_day_id = ?'))).toBe(true);
	});
	it('fails closed for a running workday without an applied plan', async () => {
		runGet.mockResolvedValue({ id: 'run', status: 'running', parameters: {} });
		await expect(fenceCapacityWorkdayAdmission({} as never, 'team', 'run'))
			.rejects.toMatchObject({ code: 'capacity_workday_plan_missing' });
	});
	it('closes and reconciles the authoritative living plan before reporting admission closed', async () => {
		const run = { id: 'run', status: 'running', parameters: { appliedPlan: { id: 'run' } } };
		runGet.mockResolvedValue(run);
		advance.mockResolvedValue({ changed: true, plan: { state: 'closing' }, status: 'running' });
		reconcile.mockResolvedValue(undefined);
		const store = { first: vi.fn(async () => ({ total: 0, completed: 0, failed: 0, non_terminal: 0, unsettled: 0 })),
			all: vi.fn(async () => []) };
		const fence = await fenceCapacityWorkdayAdmission(store as never, 'team', 'run');
		expect(advance).toHaveBeenCalledWith(store, run, expect.any(String), true);
		expect(reconcile).toHaveBeenCalledWith(store, 'team');
		expect(fence).toMatchObject({ admissionClosed: true, ready: true, successful: true });
	});
});

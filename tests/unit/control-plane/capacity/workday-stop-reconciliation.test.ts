import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	advance: vi.fn(),
	reconcile: vi.fn(),
}));

vi.mock('../../../../src/api/capacity/services/capacity/workdays/lifecycle/living-workday-lifecycle.ts', () => ({
	advanceLivingWorkday: mocks.advance,
}));
vi.mock('../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-service.ts', () => ({
	reconcileExecutionGraph: mocks.reconcile,
}));

import { createWorkdayService } from '../../../../src/api/control-plane/repositories/capacity/workday-service.ts';

const principal = { id: 'admin-1', roles: ['platform_admin'] };

describe('workday stop when graph reconciliation fails', () => {
	beforeEach(() => {
		mocks.advance.mockReset();
		mocks.reconcile.mockReset();
	});

	it('terminalizes through the existing workday writer so assignments and reservations are released', async () => {
		let run = { id: 'run-1', status: 'running', parameters: {
			appliedPlan: { state: 'active' },
		} };
		const store = {
			getCapacityWorkdayRun: vi.fn(async () => run),
			updateCapacityWorkdayRun: vi.fn(async (_teamId: string, _runId: string, input: Record<string, unknown>) => {
				run = { ...run, ...input } as typeof run;
				return run;
			}),
		};
		mocks.advance.mockImplementation(async () => {
			run = { ...run, parameters: { appliedPlan: { state: 'closing' } } };
			return { changed: true, status: 'running' };
		});
		mocks.reconcile.mockRejectedValue(Object.assign(new Error('Invalid proposal'), { code: 'execution_permission_ceiling_exceeded' }));

		const result = await createWorkdayService(store).stop(principal, 'team-1', 'run-1', { reason: 'operator stop' });
		expect(result).toMatchObject({ run: { status: 'failed', parameters: { appliedPlan: { state: 'ended' } } },
			reconciliation: { status: 'deferred', code: 'execution_permission_ceiling_exceeded' } });
		expect(store.updateCapacityWorkdayRun).toHaveBeenCalledWith('team-1', 'run-1', expect.objectContaining({ status: 'failed' }));
	});
});

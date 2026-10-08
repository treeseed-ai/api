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
import { appliedWorkdaySchema, compileWorkday, DEFAULT_WORKDAY_POLICY } from '@treeseed/sdk/agent-capacity';

const principal = { id: 'admin-1', roles: ['platform_admin'] };

describe('workday stop when graph reconciliation fails', () => {
	beforeEach(() => {
		mocks.advance.mockReset();
		mocks.reconcile.mockReset();
	});
	it('operator stop retains canonical closing authority without inventing an ended report and permits an unchanged closeout retry', async () => {
		const plan = compileWorkday({ id: 'run-1', teamId: 'team-1', policyId: 'default', policyRevision: 1,
			executionMode: 'simulation', startsAt: '2026-10-08T09:00:00.000Z', agentIds: [], policy: DEFAULT_WORKDAY_POLICY });
		let run = { id: 'run-1', status: 'running', parameters: { appliedPlan: { ...plan, state: 'active' } } };
		const store = { getCapacityWorkdayRun: vi.fn(async () => { appliedWorkdaySchema.parse(run.parameters.appliedPlan); return run; }),
			updateCapacityWorkdayRun: vi.fn(async (_team: string, _id: string, input: Record<string, unknown>) => {
				run = { ...run, ...input } as typeof run; return run;
			}), terminalizeCapacityWorkdayAssignments: vi.fn(async () => ({ unfinishedAssignmentCount: 1, deferredActiveAssignmentCount: 0 })) };
		mocks.advance.mockImplementation(async () => {
			run.parameters.appliedPlan = { ...run.parameters.appliedPlan, state: 'closing' }; return { changed: true, status: 'running' };
		});
		mocks.reconcile.mockRejectedValue(Object.assign(new Error('Invalid unrelated proposal'), { code: 'execution_permission_ceiling_exceeded' }));
		for (let retry = 0; retry < 2; retry++) {
			const response = await createWorkdayService(store).stop(principal, 'team-1', 'run-1', { reason: 'operator stop' });
			expect(response.run).toMatchObject({ status: 'running', parameters: { appliedPlan: { state: 'closing' } } });
			expect(response.run.parameters.appliedPlan).not.toHaveProperty('endedAt');
			expect(response.run.parameters.appliedPlan).not.toHaveProperty('reportRef');
			expect(response.reconciliation).toEqual({ status: 'deferred', code: 'execution_permission_ceiling_exceeded' });
		}
	});

	it('terminalizes through the existing workday writer so assignments and reservations are released', async () => {
		let run: { id: string; status: string; parameters: { appliedPlan: Record<string, unknown> } } = { id: 'run-1', status: 'running', parameters: {
			appliedPlan: { state: 'active' },
		} };
		const store = {
			getCapacityWorkdayRun: vi.fn(async () => run),
			updateCapacityWorkdayRun: vi.fn(async (_teamId: string, _runId: string, input: Record<string, unknown>) => {
				run = { ...run, ...input } as typeof run;
				return run;
			}),
			terminalizeCapacityWorkdayAssignments: vi.fn(async (_teamId: string, _runId: string, _input: Record<string, unknown>) => ({ assignmentCount: 2, completedAssignments: 1,
				failedAssignments: 1, unfinishedAssignmentCount: 0, deferredActiveAssignmentCount: 0,
				settlementErrors: [], settlementErrorCount: 0, settlementErrorsTruncated: false })),
		};
		mocks.advance.mockImplementation(async () => {
			// Completed closeout is a supplied lifecycle observation, not fabricated by stop.
			run = { ...run, status: 'cancelled', parameters: { appliedPlan: { state: 'ended',
				reportRef: { kind: 'treedx', projectId: 'project', repository: 'library', commit: 'a'.repeat(40), path: 'notes/report.mdx' } } } };
			return { changed: true, status: 'cancelled' };
		});
		mocks.reconcile.mockRejectedValue(Object.assign(new Error('Invalid proposal'), { code: 'execution_permission_ceiling_exceeded' }));

		const result = await createWorkdayService(store).stop(principal, 'team-1', 'run-1', { reason: 'operator stop' });
		expect(result).toMatchObject({ run: { status: 'cancelled', parameters: { appliedPlan: { state: 'ended' } } },
			terminalization: { unfinishedAssignmentCount: 0, deferredActiveAssignmentCount: 0 },
			reconciliation: { status: 'deferred', code: 'execution_permission_ceiling_exceeded' } });
		expect(store.terminalizeCapacityWorkdayAssignments).toHaveBeenCalledWith('team-1', 'run-1', expect.objectContaining({
			code: 'workday_operator_stopped', source: 'capacity_workday_operator_stop',
		}));
		const terminalizationInput = store.terminalizeCapacityWorkdayAssignments.mock.calls[0]?.[2] as unknown as {
			now: string; preserveActiveLeasesUntil: string;
		};
		expect(Date.parse(terminalizationInput.preserveActiveLeasesUntil) - Date.parse(terminalizationInput.now)).toBe(300_000);
		expect(store.updateCapacityWorkdayRun).toHaveBeenCalledWith('team-1', 'run-1', expect.objectContaining({ summary: expect.objectContaining({ outcome: 'operator_stopped' }) }));
	});
});

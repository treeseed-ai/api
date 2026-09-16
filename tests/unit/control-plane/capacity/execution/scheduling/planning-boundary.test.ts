import { describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ run: {} as Record<string, unknown>, cancel: vi.fn(), advance: vi.fn() }));
vi.mock('../../../../../../src/api/capacity/repositories/capacity/workdays/workday-run.ts', () => ({
	CapacityWorkdayRunRepository: class { async get() { return fixture.run; } },
}));
vi.mock('../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-service.ts', () => ({ reconcileExecutionGraph: vi.fn(async () => ({})) }));
vi.mock('../../../../../../src/api/capacity/services/capacity/workdays/lifecycle/living-workday-lifecycle.ts', () => ({ advanceLivingWorkday: fixture.advance }));
vi.mock('../../../../../../src/api/capacity/services/capacity/assignments/observability/operator-assignment-service.ts', () => ({
	OperatorAssignmentService: class { cancel = fixture.cancel; },
}));
import { tickCapacityWorkdayRun } from '../../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-tick-service.ts';

describe('planning phase boundary', () => {
	it.each(['2026-09-16T12:10:00.000Z', '2026-09-16T12:30:00.000Z'])('uses ordinary cancellation only after planning at %s', async now => {
		fixture.cancel.mockClear(); fixture.advance.mockResolvedValue({});
		fixture.run = { id: 'workday', teamId: 'team', status: 'running', capacityProviderId: 'provider', parameters: { appliedPlan: {
			schemaVersion: 'treeseed.workday/v1', id: 'workday', teamId: 'team', policyId: 'default', policyRevision: 1,
			executionMode: 'simulation', state: 'active', startsAt: '2026-09-16T12:00:00.000Z', endsAt: '2026-09-16T14:00:00.000Z',
			policySnapshot: { durationSeconds: 7200, maximumConcurrency: 1, communicationConcurrency: 1, planningPercent: 20,
				allocationWeight: 1, planningTurnMaximumSeconds: 180, projectPercentages: { project: 100 }, agentClassPercentages: { project: { engineer: 100 } } },
			planningRounds: [], admittedSecondsByProject: {}, admittedSecondsByAgentClass: {},
		} } };
		const store = { all: vi.fn(async (sql: string) => sql.includes('capacity_provider_team_memberships') ? [{ id: 'membership' }] : [{ id: 'turn' }]), run: vi.fn() };
		await tickCapacityWorkdayRun(store as never, 'team', 'workday', now);
		if (now.includes('12:10')) { expect(fixture.cancel).not.toHaveBeenCalled(); expect(store.run).not.toHaveBeenCalled(); }
		else {
			expect(fixture.cancel).toHaveBeenCalledWith('team', 'turn', expect.objectContaining({ idempotencyKey: 'planning-boundary:workday:turn' }));
			expect(store.all.mock.calls[1]?.[0]).toContain("node.kind IN ('planning','estimating')");
			expect(store.run).toHaveBeenCalledWith(expect.stringContaining("status IN ('ready','blocked')"), [now, 'team', 'workday']);
		}
	});
});

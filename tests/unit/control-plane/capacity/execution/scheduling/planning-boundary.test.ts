vi.mock('../../../../../../src/api/capacity/transaction.ts',()=>({capacityTransaction:async(store:unknown,apply:(store:unknown)=>Promise<unknown>)=>apply(store)}));
import { describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ run: {} as Record<string, unknown>, cancel: vi.fn(), advance: vi.fn(), communication: vi.fn() }));
vi.mock('../../../../../../src/api/capacity/repositories/capacity/workdays/workday-run.ts', () => ({
	CapacityWorkdayRunRepository: class { async get() { return fixture.run; } },
}));
vi.mock('../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-service.ts', () => ({
	reconcileExecutionGraph: vi.fn(async () => ({})), reconcileCommunicationExecutionGraph: fixture.communication,
}));
vi.mock('../../../../../../src/api/capacity/services/capacity/workdays/lifecycle/living-workday-lifecycle.ts', () => ({ advanceLivingWorkday: fixture.advance }));
vi.mock('../../../../../../src/api/capacity/services/capacity/assignments/observability/operator-assignment-service.ts', () => ({
	OperatorAssignmentService: class { cancel = fixture.cancel; },
}));
import { tickCapacityWorkdayRun } from '../../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-tick-service.ts';

describe('planning phase boundary', () => {
	it('ticks a standalone addressed conversation without requiring a workday plan or cancelling planning turns', async () => {
		fixture.cancel.mockClear(); fixture.advance.mockClear(); fixture.communication.mockResolvedValue({ teamId: 'team', revision: 2 });
		fixture.run = { id: 'conversation', teamId: 'team', status: 'running', capacityProviderId: 'provider',
			executionKind: 'conversation', parameters: { durationSeconds: 180, deadlineAt: '2026-10-24T01:04:00.000Z' } };
		const held = structuredClone(fixture.run), store = { all: vi.fn(async () => [{ id: 'membership' }]), first: vi.fn(async () => null), run: vi.fn() };
		const result = await tickCapacityWorkdayRun(store as never, 'team', 'conversation', '2026-10-24T01:01:00.000Z');
		expect(result).toMatchObject({ runId: 'conversation', lifecycle: { changed: false, plan: null, status: 'running' }, executionGraph: { teamId: 'team', revision: 2 } });
		expect(fixture.communication).toHaveBeenCalledWith(store, 'team');
		expect(fixture.advance).not.toHaveBeenCalled(); expect(fixture.cancel).not.toHaveBeenCalled(); expect(store.run).not.toHaveBeenCalled();
		expect(fixture.run).toEqual(held);
	});
	it.each([
		['workday', {}], ['conversation', { appliedPlan: null }],
	] as const)('still refuses missing ordinary or malformed declared plans: %s', async (executionKind, parameters) => {
		fixture.communication.mockClear(); fixture.advance.mockClear();
		fixture.run = { id: 'execution', teamId: 'team', status: 'running', capacityProviderId: 'provider', executionKind, parameters };
		const store = { all: vi.fn(async () => [{ id: 'membership' }]), first: vi.fn(async () => null), run: vi.fn() };
		await expect(tickCapacityWorkdayRun(store as never, 'team', 'execution')).rejects.toThrow();
		expect(fixture.communication).not.toHaveBeenCalled(); expect(fixture.advance).not.toHaveBeenCalled(); expect(store.run).not.toHaveBeenCalled();
	});
	it.each([
		['2026-09-16T12:10:00.000Z', 'active'],
		['2026-09-16T12:30:00.000Z', 'active'],
		['2026-09-16T12:10:00.000Z', 'closing'],
	] as const)('uses ordinary cancellation at the boundary or explicit closeout: %s %s', async (now, state) => {
		fixture.cancel.mockClear(); fixture.advance.mockResolvedValue({});
		fixture.run = { id: 'workday', teamId: 'team', status: 'running', capacityProviderId: 'provider', parameters: { appliedPlan: {
			schemaVersion: 'treeseed.workday/v1', id: 'workday', teamId: 'team', policyId: 'default', policyRevision: 1,
			executionMode: 'simulation', state, startsAt: '2026-09-16T12:00:00.000Z', endsAt: '2026-09-16T14:00:00.000Z',
			policySnapshot: { durationSeconds: 7200, maximumConcurrency: 1, communicationConcurrency: 1, planningPercent: 20,
				allocationWeight: 1, planningTurnMaximumSeconds: 180, projectPercentages: { project: 100 }, agentClassPercentages: { project: { engineer: 100 } } },
			planningRounds: [], admittedSecondsByProject: {}, admittedSecondsByAgentClass: {},
		} } };
		const store = { all: vi.fn(async (sql: string) => sql.includes('capacity_provider_team_memberships') ? [{ id: 'membership' }] : sql.startsWith('SELECT id FROM execution_nodes')?[]:[{ id: 'turn' }]),
			first: vi.fn(async () => null), run: vi.fn() };
		await tickCapacityWorkdayRun(store as never, 'team', 'workday', now);
		if (state === 'active') { expect(fixture.cancel).not.toHaveBeenCalled(); expect(store.run).not.toHaveBeenCalled(); }
		else {
			expect(fixture.cancel).toHaveBeenCalledWith('team', 'turn', expect.objectContaining({ idempotencyKey: 'planning-boundary:workday:turn' }));
			expect(store.all.mock.calls[1]?.[0]).toContain("node.kind IN ('planning','estimating')");
			expect(store.run).toHaveBeenCalledWith(expect.stringContaining("status IN ('ready','blocked')"), [now, 'team', 'workday']);
		}
	});
});

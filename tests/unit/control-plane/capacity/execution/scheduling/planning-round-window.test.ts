import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_WORKDAY_POLICY, appliedWorkdaySchema, compileWorkday } from '@treeseed/sdk/agent-capacity';
import type { CapacityGovernanceDatabase } from '../../../../../../src/api/capacity/database.ts';
import type { DurableCapacityWorkdayRun } from '../../../../../../src/api/capacity/repositories/capacity/workdays/workday-run.ts';
vi.mock('../../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-content-readback.ts', () => ({
	reconcileAssignmentContent: vi.fn(async () => undefined),
}));
import { advanceLivingWorkday } from '../../../../../../src/api/capacity/services/capacity/workdays/lifecycle/living-workday-lifecycle.ts';

const plan = { ...compileWorkday({ id: 'workday', teamId: 'team', policyId: 'default', policyRevision: 4,
	executionMode: 'simulation', policy: { ...DEFAULT_WORKDAY_POLICY, durationSeconds: 3600, planningPercent: 100 / 3,
		planningTurnMaximumSeconds: 180, maximumConcurrency: 5, communicationConcurrency: 5 },
	agentIds: ['project/researcher:planning'], startsAt: '2026-10-01T20:05:41.362Z' }), state: 'active' as const };

describe('planning round admission before an authoritative boundary', () => {
	it('repeats beyond two planning rounds without duplicating an active turn or refreshing the original policy and deadline', async () => {
		let run: DurableCapacityWorkdayRun = { id: plan.id, teamId: plan.teamId, capacityProviderId: 'provider',
			scenarioId: 'repeated-planning', status: 'running', environment: 'test', executionMode: 'simulation',
			executionKind: 'workday', requestedById: 'operator', parameters: { appliedPlan: structuredClone(plan), planningOnly: true },
			summary: {}, metrics: {}, expected: {}, actual: {}, reportRefs: {}, error: {}, startedAt: plan.startsAt,
			completedAt: null, createdAt: plan.startsAt, updatedAt: plan.startsAt };
		const store = { ensureInitialized: vi.fn<CapacityGovernanceDatabase['ensureInitialized']>(),
			all: vi.fn<CapacityGovernanceDatabase['all']>(), first: vi.fn<CapacityGovernanceDatabase['first']>(),
			run: vi.fn<CapacityGovernanceDatabase['run']>(), batch: vi.fn<CapacityGovernanceDatabase['batch']>(),
			updateCapacityWorkdayRun: vi.fn<Parameters<typeof advanceLivingWorkday>[0]['updateCapacityWorkdayRun']>() };
		for (const ordinal of [2, 3, 4, 5]) {
			const before = structuredClone(run), current = structuredClone(run.parameters.appliedPlan);
			// These are supplied UNIT node outcomes, not managed executions.
			const rounds = appliedWorkdaySchema.parse(current).planningRounds;
			const now = new Date(Date.parse(plan.startsAt) + ordinal * 1_000).toISOString();
			store.all.mockResolvedValue(rounds.flatMap(round => round.assignmentIds.map(id => ({ id, kind: 'planning', status: 'completed' }))));
			store.updateCapacityWorkdayRun.mockResolvedValue(run);
			const result = await advanceLivingWorkday(store, run, now);
			expect(run).toEqual(before);
			expect(result.plan.planningRounds.map(round => round.round)).toEqual(Array.from({ length: ordinal }, (_, index) => index + 1));
			expect(result.plan.planningRounds.slice(0, -1).every(round => round.state === 'complete')).toBe(true);
			expect(result.plan.planningRounds.at(-1)).toEqual({ round: ordinal, state: 'active', startedAt: now,
				assignmentIds: [`planning:workday:${ordinal}:project/researcher:planning`] });
			expect(result.plan.startsAt).toBe(plan.startsAt); expect(result.plan.endsAt).toBe(plan.endsAt);
			expect(result.plan.policySnapshot).toEqual(plan.policySnapshot);
			run = { ...run, parameters: { ...run.parameters, appliedPlan: result.plan } };
			const held = structuredClone(run);
			store.all.mockResolvedValue(result.plan.planningRounds.flatMap(round => round.assignmentIds.map(id =>
				({ id, kind: 'planning', status: round.round === ordinal ? 'ready' : 'completed' }))));
			expect(await advanceLivingWorkday(store, run, now)).toEqual({ changed: false, plan: result.plan, status: 'running' });
			expect(run).toEqual(held);
		}
		expect(store.first).not.toHaveBeenCalled(); expect(store.run).not.toHaveBeenCalled(); expect(store.batch).not.toHaveBeenCalled();
	});
	it.each([
		['captured EI third round', '2026-10-01T20:24:21.967Z', false],
		['one millisecond short of a turn', '2026-10-01T20:22:41.363Z', false],
		['exactly one whole turn', '2026-10-01T20:22:41.362Z', true],
		['fluid planning after initial phase', '2026-10-01T20:25:41.362Z', true],
		['last seconds of workday', '2026-10-01T21:05:00.000Z', false],
	] as const)('%s preserves deadlines and creates only usable new rounds', async (_label, now, admitted) => {
		const run = { id: 'workday', teamId: 'team', status: 'running', completedAt: null, reportRefs: {},
			parameters: { appliedPlan: plan } };
		const store = { all: vi.fn(async () => plan.planningRounds.flatMap(round => round.assignmentIds
			.map(id => ({ id, kind: 'planning', status: 'completed' })))), updateCapacityWorkdayRun: vi.fn(async () => run) };
		const result = await advanceLivingWorkday(store as never, run as never, now);
		expect(result.plan.planningRounds).toHaveLength(admitted ? 2 : 1);
		expect(result.plan.startsAt).toBe(plan.startsAt);
		expect(result.plan.endsAt).toBe(plan.endsAt);
		expect(result.plan.policySnapshot).toEqual(plan.policySnapshot);
	});
});

import { describe, expect, it, vi } from 'vitest';
import { compileWorkday } from '@treeseed/sdk/agent-capacity';
vi.mock('../../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-content-readback.ts', () => ({
	reconcileAssignmentContent: vi.fn(async () => undefined),
}));
import { advanceLivingWorkday } from '../../../../../../src/api/capacity/services/capacity/workdays/lifecycle/living-workday-lifecycle.ts';

const plan = { ...compileWorkday({ id: 'workday', teamId: 'team', policyId: 'default', policyRevision: 4,
	executionMode: 'simulation', policy: { durationSeconds: 3600, planningPercent: 100 / 3,
		planningTurnMaximumSeconds: 180, maximumConcurrency: 5, communicationConcurrency: 5 },
	agentIds: ['project/researcher:planning'], startsAt: '2026-10-01T20:05:41.362Z' }), state: 'active' as const };

describe('planning round admission before an authoritative boundary', () => {
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

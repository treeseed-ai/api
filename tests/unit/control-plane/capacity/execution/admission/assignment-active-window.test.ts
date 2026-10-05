import { describe, expect, it } from 'vitest';
import { buildAssignmentAttempt } from '../../../../../../src/api/capacity/services/capacity/assignments/planning/execution/assignment-attempt-builder.ts';
import { beginAssignmentPreparationTimeBudget, compileAssignmentTimeBudget } from '../../../../../../src/api/capacity/services/capacity/assignments/planning/assignment-time-budget.ts';
import { compileAssignmentExecutionWindow } from '../../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-execution-window-service.ts';
import { candidate, provider, run, executionCapability } from '../fixtures/assignment-attempt-fixtures.ts';

function allocate(now: string, mode: 'production' | 'simulation', startsAt: string, endsAt: string) {
	const planning = structuredClone(candidate);
	planning.node.kind = 'planning' as never;
	planning.node.pairRole = null;
	planning.node.workspace = 'read-only';
	planning.node.estimate = { expectedSeconds: 180, maximumSeconds: 180 };
	planning.node.requestedPermissions = { content: { read: ['proposal'], write: [] }, tools: ['source.read'] } as never;
	planning.effectiveProfile = { ...planning.effectiveProfile, activity: 'planning', handler: 'planner',
		permissionCeiling: planning.node.requestedPermissions } as never;
	const applied = { ...structuredClone(run as Record<string, unknown>), executionMode: mode, parameters: { appliedPlan: {
		...(run as { parameters: { appliedPlan: Record<string, unknown> } }).parameters.appliedPlan,
		executionMode: mode, startsAt, endsAt, policySnapshot: { durationSeconds: 3600, planningPercent: 100 / 3,
			maximumConcurrency: 5, communicationConcurrency: 5, planningTurnMaximumSeconds: 180,
			projectPercentages: { project: 100 }, agentClassPercentages: { project: { engineer: 100 } } },
	} } };
	const observation = { ...provider.accountingObservation.modelUsage, day: now.slice(0, 10), observedAt: now };
	return buildAssignmentAttempt({ candidate: planning as never, run: applied as never,
		principal: { teamId: 'team', capacityProviderId: 'provider' } as never,
		allocationInputs: { codex: { measurements: [], constraints: [] } }, providerSessionId: 'session',
		providers: [{ ...provider, accountingObservation: { modelUsage: observation, capabilityUsage: { [executionCapability]: observation } } }] as never,
		attempt: 1, now });
}

describe('active allocation and separately bounded infrastructure', () => {
	it.each(['production', 'simulation'] as const)('does not precharge unused infrastructure watchdog time in %s', mode => {
		const now = '2026-09-30T16:13:50.792Z';
		const allocated = allocate(now, mode, '2026-09-30T15:55:12.674Z', '2026-09-30T16:55:12.674Z');
		expect(allocated.assignment.limits.maximumSeconds).toBe(81); // Captured window was wrongly reduced to21.
		expect(allocated.assignment.deadline).toBe('2026-09-30T16:15:12.674Z');
		expect(allocated.allocation).toMatchObject({ admitted: true, limitingConstraint: 'execution-window' });
		const timing = compileAssignmentTimeBudget({ now, requestedSeconds: allocated.assignment.limits.maximumSeconds,
			configuredBudget: { deadline: allocated.assignment.deadline } });
		expect(timing.preparationSeconds).toBe(60);
		const prepared = beginAssignmentPreparationTimeBudget({ budget: timing.capacityBudget }, now);
		const execution = compileAssignmentExecutionWindow({ capacityEnvelope: prepared, metadata: {} } as never,
			'2026-09-30T16:13:54.321Z', {});
		expect(execution.capacityEnvelope).toMatchObject({ budget: { time: { reservedSeconds: 81,
			executionDeadlineAt: allocated.assignment.deadline, authorityDeadlineAt: allocated.assignment.deadline } } });
		expect(() => compileAssignmentExecutionWindow({ capacityEnvelope: prepared, metadata: {} } as never,
			'2026-09-30T16:14:51.000Z', {})).toThrow(/bounded preparation window/u);
	});
	it('clamps after real preparation without crossing the UTC accounting day', () => {
		const now = '2026-09-30T23:59:40.000Z';
		const allocated = allocate(now, 'simulation', '2026-09-30T23:50:00.000Z', '2026-10-01T00:50:00.000Z');
		expect(allocated.assignment.limits.maximumSeconds).toBe(20);
		expect(allocated.assignment.deadline).toBe('2026-10-01T00:00:00.000Z');
		const timing = compileAssignmentTimeBudget({ now, requestedSeconds: 20, configuredBudget: { deadline: allocated.assignment.deadline } });
		const prepared = beginAssignmentPreparationTimeBudget({ budget: timing.capacityBudget }, now);
		const execution = compileAssignmentExecutionWindow({ capacityEnvelope: prepared, metadata: {} } as never,
			'2026-09-30T23:59:44.000Z', {});
		expect(execution.capacityEnvelope).toMatchObject({ budget: { time: {
			executionDeadlineAt: '2026-10-01T00:00:00.000Z', remainingSeconds: 16 } } });
	});
	it('defers after authority is exhausted without changing provider supply', () => {
		expect(() => allocate('2026-09-30T16:55:12.674Z', 'simulation',
			'2026-09-30T15:55:12.674Z', '2026-09-30T16:55:12.674Z')).toThrow('No positive active-time allocation remains');
	});
});

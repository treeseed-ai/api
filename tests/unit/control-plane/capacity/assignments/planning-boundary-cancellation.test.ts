import { describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ run: null as Record<string, unknown> | null }));
vi.mock('../../../../../src/api/capacity/repositories/capacity/workdays/workday-run.ts', () => ({
	CapacityWorkdayRunRepository: class { async get() { return fixture.run; } },
}));
import { planningBoundaryCancellation } from '../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-failure-policy.ts';

const boundary = '2026-09-30T17:12:14.903Z';
function setup(ready = true) {
	fixture.run = { teamId: 'team', status: 'running', capacityProviderId: 'provider', parameters: {
		scheduledProjectIds: ['project'], appliedPlan: {
			schemaVersion: 'treeseed.workday/v1', id: 'workday', teamId: 'team', executionMode: 'simulation',
			policyId: 'default', policyRevision: 4, state: 'active', startsAt: '2026-09-30T16:52:14.903Z',
			endsAt: '2026-09-30T17:52:14.903Z', planningRounds: [], admittedSecondsByProject: {}, admittedSecondsByAgentClass: {},
			policySnapshot: { durationSeconds: 3600, planningPercent: 100 / 3, allocationWeight: 1,
				planningTurnMaximumSeconds: 180, maximumConcurrency: 5, communicationConcurrency: 5,
				projectPercentages: { project: 100 }, agentClassPercentages: { project: { engineer: 100 } } },
		} } };
	const assignment = { teamId: 'team', workDayId: 'workday', capacityProviderId: 'provider',
		assignmentAttempt: { effectiveProfile: { activity: 'planning' } }, metadata: {},
		capacityEnvelope: { budget: { time: { authorityDeadlineAt: boundary, executionDeadlineAt: boundary } } } };
	const store = { first: vi.fn(async () => ready ? { id: 'approved-actor' } : null) };
	return { assignment, store };
}

describe('planning cancellation at authoritative phase transition', () => {
	it('cancels the captured timeout when its phase ends before periodic cancellation', async () => {
		const { assignment, store } = setup();
		await expect(planningBoundaryCancellation(store as never, assignment as never,
			{ code: 'assignment_timeout' }, '2026-09-30T17:12:16.739Z')).resolves.toBe(true);
		expect(store.first).toHaveBeenCalledWith(expect.stringContaining("node.kind IN ('acting','reviewing')"), expect.any(Array));
	});
	it('recognizes phase cancellation after the periodic request without trusting a provider request', async () => {
		const { assignment, store } = setup();
		await expect(planningBoundaryCancellation(store as never, assignment as never,
			{ code: 'assignment_cancelled' }, boundary)).resolves.toBe(false);
		assignment.metadata = { cancellationRequested: true };
		await expect(planningBoundaryCancellation(store as never, assignment as never,
			{ code: 'assignment_cancelled' }, boundary)).resolves.toBe(true);
	});
	it('preserves earlier task expiration and acting failures', async () => {
		const { assignment, store } = setup();
		assignment.capacityEnvelope.budget.time.executionDeadlineAt = '2026-09-30T17:11:14.903Z';
		await expect(planningBoundaryCancellation(store as never, assignment as never,
			{ code: 'assignment_timeout' }, boundary)).resolves.toBe(false);
		assignment.capacityEnvelope.budget.time.executionDeadlineAt = boundary;
		assignment.assignmentAttempt.effectiveProfile.activity = 'acting';
		await expect(planningBoundaryCancellation(store as never, assignment as never,
			{ code: 'assignment_timeout' }, boundary)).resolves.toBe(false);
		expect(store.first).not.toHaveBeenCalled();
	});
	it('keeps fluid planning and non-timeout failures unchanged', async () => {
		const { assignment, store } = setup(false);
		await expect(planningBoundaryCancellation(store as never, assignment as never,
			{ code: 'assignment_timeout' }, boundary)).resolves.toBe(false);
		await expect(planningBoundaryCancellation(store as never, assignment as never,
			{ code: 'invalid_result' }, boundary)).resolves.toBe(false);
	});
	it('does not infer phase cancellation from missing or malformed authority', async () => {
		const { assignment, store } = setup();
		for (const value of ['', 'invalid', '2026-09-30T17:12:13.903Z']) {
			assignment.capacityEnvelope.budget.time.authorityDeadlineAt = value;
			await expect(planningBoundaryCancellation(store as never, assignment as never,
				{ code: 'assignment_timeout' }, boundary)).resolves.toBe(false);
		}
		assignment.capacityEnvelope.budget.time.authorityDeadlineAt = boundary;
		await expect(planningBoundaryCancellation(store as never, assignment as never,
			{ code: 'assignment_timeout' }, 'invalid')).resolves.toBe(false);
		fixture.run = null;
		await expect(planningBoundaryCancellation(store as never, assignment as never,
			{ code: 'assignment_timeout' }, boundary)).resolves.toBe(false);
	});
});

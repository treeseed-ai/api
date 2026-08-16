import { describe, expect, it } from 'vitest';
import { assignmentCloseoutWarningSeconds,beginAssignmentPreparationTimeBudget } from '../../../../../src/api/capacity/services/capacity/assignments/planning/assignment-time-budget.ts';
import { evaluateAssignmentLeaseDeadline } from '../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-lease-service.ts';

describe('assignment closeout time budget', () => {
	it('uses the validated configured warning for a sufficiently long assignment', () => {
		expect(assignmentCloseoutWarningSeconds(1_800, 180)).toBe(180);
	});

	it('preserves fixed closeout time for short tool-driven assignments', () => {
		expect(assignmentCloseoutWarningSeconds(300, 180)).toBe(120);
		expect(assignmentCloseoutWarningSeconds(180, 180)).toBe(120);
		expect(assignmentCloseoutWarningSeconds(60, 180)).toBe(30);
		expect(assignmentCloseoutWarningSeconds(3, 180)).toBe(1);
	});

	it('uses the three-minute default when configuration is absent', () => {
		expect(assignmentCloseoutWarningSeconds(1_800, undefined)).toBe(180);
	});
});

describe('assignment lease deadline gate', () => {
	const assignment = (deadline: string, closeoutWarningSeconds = 12, status: 'pending' | 'returned' = 'pending') => ({
		status,
		capacityEnvelope: { budget: { deadline, time: { hardDeadlineAt: deadline, closeoutWarningSeconds, executionStartedAt: '2026-08-13T14:00:00.000Z' } } },
	});

	it('does not spend a pending assignment preparation window while it waits for a lane', () => {
		const now = Date.parse('2026-08-13T14:35:14.000Z');
		expect(evaluateAssignmentLeaseDeadline({
			status: 'pending',
			capacityEnvelope: { budget: { deadline: '2026-08-13T14:01:00.000Z', time: { executionStartedAt: null } } },
		}, now)).toEqual({ eligible: true, hardDeadlineAt: null, remainingMs: null, minimumRemainingMs: 0 });
	});

	it('admits a fresh short assignment while enough execution time remains', () => {
		const now = Date.parse('2026-08-13T14:34:21.000Z');
		expect(evaluateAssignmentLeaseDeadline(assignment('2026-08-13T14:35:17.000Z'), now)).toEqual({
			eligible: true,
			hardDeadlineAt: '2026-08-13T14:35:17.000Z',
			remainingMs: 56_000,
			minimumRemainingMs: 30_000,
		});
	});

	it('rejects fresh work that has entered its closeout window', () => {
		const now = Date.parse('2026-08-13T14:35:14.000Z');
		expect(evaluateAssignmentLeaseDeadline(assignment('2026-08-13T14:35:17.000Z'), now)).toMatchObject({
			eligible: false,
			remainingMs: 3_000,
			minimumRemainingMs: 30_000,
		});
	});

	it('re-admits interrupted returned work during closeout when bounded cleanup time remains', () => {
		const now = Date.parse('2026-08-13T14:34:00.000Z');
		expect(evaluateAssignmentLeaseDeadline(assignment('2026-08-13T14:35:17.000Z', 120, 'returned'), now)).toEqual({
			eligible: true,
			hardDeadlineAt: '2026-08-13T14:35:17.000Z',
			remainingMs: 77_000,
			minimumRemainingMs: 30_000,
		});
	});

	it('rejects interrupted returned work when too little cleanup time remains', () => {
		const now = Date.parse('2026-08-13T14:35:00.000Z');
		expect(evaluateAssignmentLeaseDeadline(assignment('2026-08-13T14:35:17.000Z', 120, 'returned'), now)).toMatchObject({
			eligible: false,
			remainingMs: 17_000,
			minimumRemainingMs: 30_000,
		});
	});

	it('honors the configured closeout window', () => {
		const now = Date.parse('2026-08-13T14:00:00.000Z');
		expect(evaluateAssignmentLeaseDeadline(assignment('2026-08-13T14:02:00.000Z', 180), now)).toMatchObject({
			eligible: false,
			minimumRemainingMs: 180_000,
		});
	});

	it('keeps legacy admission records without a closeout policy leasable until their deadline', () => {
		const now = Date.parse('2026-08-13T14:00:00.000Z');
		expect(evaluateAssignmentLeaseDeadline(assignment('2026-08-13T14:00:06.000Z', 0), now)).toMatchObject({
			eligible: true,
			remainingMs: 6_000,
			minimumRemainingMs: 0,
		});
	});
});

describe('assignment preparation timing', () => {
	it('starts preparation when the provider leases queued work', () => {
		const result = beginAssignmentPreparationTimeBudget({
			requestedSeconds: 900,
			budget: { deadline: '2026-08-13T14:06:00.000Z', time: {
				requestedSeconds: 900, executionSeconds: 900, preparationSeconds: 180, closeoutSeconds: 180,
				preparationStartedAt: '2026-08-13T14:00:00.000Z', preparationDeadlineAt: '2026-08-13T14:03:00.000Z',
				executionStartedAt: null, closeoutDeadlineAt: '2026-08-13T14:06:00.000Z', hardDeadlineAt: '2026-08-13T14:06:00.000Z',
			} },
		}, '2026-08-13T14:10:00.000Z');
		expect(result.budget).toMatchObject({ deadline: '2026-08-13T14:16:00.000Z', time: {
			preparationStartedAt: '2026-08-13T14:10:00.000Z', preparationDeadlineAt: '2026-08-13T14:13:00.000Z',
			closeoutDeadlineAt: '2026-08-13T14:16:00.000Z', authorityDeadlineAt: '2026-08-13T14:31:00.000Z',
		} });
	});
});

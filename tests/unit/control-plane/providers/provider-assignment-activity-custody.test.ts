import { describe, expect, it } from 'vitest';
import { assignmentActivityType, assignmentWorkdayRunId, assertProviderOwnsAssignment } from '../../../../src/api/control-plane/repositories/providers/provider-assignment-support.ts';

describe('provider assignment activity custody', () => {
	it('requires the exact provider team and membership for assignment ownership without rewriting absent malformed or foreign authority', () => {
		const principal = { capacityProviderId: 'provider', teamId: 'team', membershipId: 'membership', scopes: ['provider:assignments:read'] };
		const assignment = { id: 'assignment', ...principal }, held = structuredClone(assignment), actor = structuredClone(principal);
		expect(assertProviderOwnsAssignment(assignment, principal, 'access')).toBe(assignment);
		expect(() => assertProviderOwnsAssignment(null, principal, 'access')).toThrow(expect.objectContaining({ status: 404, code: 'provider_assignment_not_found' }));
		const outcomes: unknown[] = [];
		for (const field of ['capacityProviderId', 'teamId', 'membershipId'] as const) {
			for (const value of [undefined, null, '', 'foreign', 0, {}, []]) {
				const supplied = Object.assign({}, assignment, { [field]: value }), before = structuredClone(supplied);
				try { assertProviderOwnsAssignment(supplied, principal, 'access'); outcomes.push(null); }
				catch (cause) { outcomes.push(cause); }
				expect(supplied).toEqual(before);
			}
			const supplied = { ...assignment }; delete supplied[field]; const before = structuredClone(supplied);
			try { assertProviderOwnsAssignment(supplied, principal, 'access'); outcomes.push(null); }
			catch (cause) { outcomes.push(cause); }
			expect(supplied).toEqual(before);
		}
		expect(assignment).toEqual(held); expect(principal).toEqual(actor);
		expect(outcomes).toHaveLength(24);
		for (const cause of outcomes) expect(cause).toMatchObject({ status: 403, code: 'provider_assignment_forbidden' });
	});
	it('reads only the pinned attempt profile in serialized and durable forms', () => {
		const attempt = { effectiveProfile: { activity: 'estimating' } };
		expect(assignmentActivityType({ assignmentAttempt: attempt, decisionInput: { activityType: 'acting' } })).toBe('estimating');
		expect(assignmentActivityType({ assignment_attempt_json: JSON.stringify(attempt) })).toBe('estimating');
		expect(assignmentActivityType({ decisionInput: { activityType: 'acting' } })).toBeNull();
		expect(assignmentWorkdayRunId({ workDayId: 'run-1', metadata: { workdayRunId: 'wrong' } })).toBe('run-1');
		expect(assignmentWorkdayRunId({ work_day_id: 'run-2' })).toBe('run-2');
		expect(assignmentWorkdayRunId({ metadata: { workdayRunId: 'wrong' } })).toBeNull();
	});
});

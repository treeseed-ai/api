import { describe, expect, it } from 'vitest';
import { isNodeEligibleInWorkdayPhase } from '../../../../../../src/api/capacity/services/capacity/assignments/planning/execution/living-execution-assignment.ts';
import { assignmentAccountingMode } from '../../../../../../src/api/capacity/services/capacity/assignments/admission/living-execution-admission.ts';

const proposal = { store: 'treedx', model: 'proposal', id: 'proposal' } as const;
const decision = { store: 'treedx', model: 'decision', id: 'decision' } as const;

describe('workday phase admission', () => {
	it('does not admit a separate proposal Reviewer in either phase', () => {
		const governanceReview = { kind: 'reviewing', pairRole: null, sourceRef: proposal } as never;
		const workReview = { kind: 'reviewing', pairRole: 'reviewer', sourceRef: decision } as never;
		expect(isNodeEligibleInWorkdayPhase(governanceReview, 'planning', false)).toBe(false);
		expect(isNodeEligibleInWorkdayPhase(governanceReview, 'acting', false)).toBe(false);
		expect(isNodeEligibleInWorkdayPhase(workReview, 'planning', false)).toBe(false);
		expect(isNodeEligibleInWorkdayPhase(workReview, 'acting', false)).toBe(true);
		expect(isNodeEligibleInWorkdayPhase(governanceReview, 'acting', true)).toBe(false);
	});
	it('charges paired work review to acting', () => {
		expect(assignmentAccountingMode({ effectiveProfile: { activity: 'reviewing' }, sourceRef: decision,
			workItemId: 'implement-change' } as never, 'planning')).toBe('acting');
		expect(assignmentAccountingMode({ effectiveProfile: { activity: 'reviewing' }, sourceRef: decision,
			workItemId: 'implement-change' } as never, 'acting')).toBe('acting');
	});
});

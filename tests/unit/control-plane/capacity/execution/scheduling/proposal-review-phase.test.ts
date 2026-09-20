import { describe, expect, it } from 'vitest';
import { isNodeEligibleInWorkdayPhase } from '../../../../../../src/api/capacity/services/capacity/assignments/planning/execution/living-execution-assignment.ts';
import { assignmentAccountingMode } from '../../../../../../src/api/capacity/services/capacity/assignments/admission/living-execution-admission.ts';

const proposal = { store: 'treedx', model: 'proposal', id: 'proposal' } as const;
const decision = { store: 'treedx', model: 'decision', id: 'decision' } as const;

describe('workday phase admission', () => {
	it('admits the independent proposal Reviewer during planning, but paired work review only during acting', () => {
		const governanceReview = { kind: 'reviewing', pairRole: null, sourceRef: proposal } as never;
		const workReview = { kind: 'reviewing', pairRole: 'reviewer', sourceRef: decision } as never;
		expect(isNodeEligibleInWorkdayPhase(governanceReview, 'planning', false)).toBe(true);
		expect(isNodeEligibleInWorkdayPhase(governanceReview, 'acting', false)).toBe(false);
		expect(isNodeEligibleInWorkdayPhase(workReview, 'planning', false)).toBe(false);
		expect(isNodeEligibleInWorkdayPhase(workReview, 'acting', false)).toBe(true);
		expect(isNodeEligibleInWorkdayPhase(governanceReview, 'acting', true)).toBe(false);
	});
	it('charges governance review to planning and paired work review to acting', () => {
		expect(assignmentAccountingMode({ effectiveProfile: { activity: 'reviewing' }, sourceRef: proposal,
			workItemId: 'proposal-review' } as never)).toBe('planning');
		expect(assignmentAccountingMode({ effectiveProfile: { activity: 'reviewing' }, sourceRef: decision,
			workItemId: 'implement-change' } as never)).toBe('acting');
	});
});

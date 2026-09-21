import { describe, expect, it } from 'vitest';
import { requiresGovernedPlanningProposal } from '../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-scheduling-service.ts';

describe('governed workday proposal selection', () => {
	it('identifies estimating selection while permitting a zero-proposal autonomous start', () => {
		expect(requiresGovernedPlanningProposal({ executionKind: 'workday', parameters: { planningOnly: true } } as never)).toBe(false);
		expect(requiresGovernedPlanningProposal({ executionKind: 'workday', parameters: { agentSelection: { activityTypes: ['estimating'] } } } as never)).toBe(true);
		expect(requiresGovernedPlanningProposal({ executionKind: 'workday', parameters: { planningOnly: false } } as never)).toBe(false);
	});

	it('does not apply project-planning proposal cardinality to communication runs', () => {
		expect(requiresGovernedPlanningProposal({ executionKind: 'conversation', parameters: { planningOnly: true } } as never)).toBe(false);
	});
});

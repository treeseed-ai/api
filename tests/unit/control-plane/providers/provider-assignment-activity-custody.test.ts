import { describe, expect, it } from 'vitest';
import { assignmentActivityType, assignmentWorkdayRunId } from '../../../../src/api/control-plane/repositories/providers/provider-assignment-support.ts';

describe('provider assignment activity custody', () => {
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

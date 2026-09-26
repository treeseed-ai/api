import { describe, expect, it } from 'vitest';
import { composeAssignmentLifecycleOutput } from '../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-lifecycle-output.ts';

describe('assignment lifecycle output', () => {
	it('persists the validated work-review disposition as the accounting authority', () => {
		const output = composeAssignmentLifecycleOutput({
			output: { activityCompletion: { resultId: 'result-1', reviewDisposition: 'untrusted-provider-value' } },
			completion: { disposition: 'completed' },
		}, { activeSeconds: 12 }, 'request-changes');

		expect(output).toMatchObject({
			activityCompletion: { resultId: 'result-1', reviewDisposition: 'request-changes' },
			completion: { disposition: 'completed' },
			performance: { activeSeconds: 12 },
		});
	});

	it('does not invent a review disposition for non-review assignments', () => {
		const output = composeAssignmentLifecycleOutput({ output: { value: true } }, null);
		expect(output).toEqual({ value: true, completion: null, performance: null });
	});
});

import { describe, expect, it } from 'vitest';
import { authoringExecutionPolicy } from '../../../../../src/api/capacity/routes/support/agent-lab/deployment-support/authoring-execution-policy.ts';

describe('agent definition authoring execution policy', () => {
	it('defaults to an upstream-isolated simulation checkpoint', () => {
		expect(authoringExecutionPolicy(undefined)).toEqual({
			executionMode: 'simulation', upstreamMutationPolicy: 'denied',
		});
	});

	it('requires explicit production mode for upstream publication', () => {
		expect(authoringExecutionPolicy('production')).toEqual({
			executionMode: 'production', upstreamMutationPolicy: 'exact-approved-ref',
		});
		expect(() => authoringExecutionPolicy('live')).toThrow('executionMode must be simulation or production.');
	});
});

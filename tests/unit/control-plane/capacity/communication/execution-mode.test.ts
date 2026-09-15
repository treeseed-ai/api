import { describe, expect, it } from 'vitest';
import { compileCapacityWorkdayRunRecord } from '../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-run-service.ts';

describe('chat execution mode', () => {
	it('runs admitted conversations on a real execution provider by default', () => {
		const run = compileCapacityWorkdayRunRecord('team', { executionKind: 'conversation' });
		expect(run.executionMode).toBe('production');
		expect(run.parameters).not.toHaveProperty('executionMode');
		expect(run.environment).toBe('local');
	});
	it.each([undefined, 'workday', 'simulation'])('preserves simulation default for %s', executionKind => {
		expect(compileCapacityWorkdayRunRecord('team', { executionKind }).executionMode).toBe('simulation');
	});
	it('preserves explicit simulation', () => {
		const input = { executionMode: 'simulation' };
		expect(compileCapacityWorkdayRunRecord('team', { executionKind: 'conversation', ...input }).executionMode).toBe('simulation');
	});
	it('rejects a duplicate parameters mode', () => {
		expect(() => compileCapacityWorkdayRunRecord('team', { parameters: { executionMode: 'simulation' } }))
			.toThrow(/top-level immutable property/u);
	});
});

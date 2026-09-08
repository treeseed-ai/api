import { describe, expect, it } from 'vitest';
import { compileCapacityWorkdayRunRecord } from '../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-run-service.ts';

describe('chat execution mode', () => {
	it('runs admitted conversations on a real execution provider by default', () => {
		const run = compileCapacityWorkdayRunRecord('team', { executionKind: 'conversation' });
		expect(run.executionMode).toBe('production');
		expect(run.parameters.executionMode).toBe('production');
		expect(run.environment).toBe('local');
	});
	it.each([undefined, 'workday', 'simulation'])('preserves simulation default for %s', executionKind => {
		expect(compileCapacityWorkdayRunRecord('team', { executionKind }).executionMode).toBe('simulation');
	});
	it.each([{ executionMode: 'simulation' }, { parameters: { executionMode: 'simulation' } }])('preserves explicit simulation %j', input => {
		expect(compileCapacityWorkdayRunRecord('team', { executionKind: 'conversation', ...input }).executionMode).toBe('simulation');
	});
});

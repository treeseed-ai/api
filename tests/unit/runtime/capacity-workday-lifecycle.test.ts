import { describe, expect, it } from 'vitest';
import {
	assertCapacityWorkdayParametersSafe,
	assertRunningCapacityWorkdayBounded,
	assertCapacityWorkdayTransition,
	capacityWorkdayStatus,
	capacityWorkdayTimestampField,
} from '../../../src/api/capacity/services/workday-lifecycle-service.ts';

describe('capacity workday lifecycle contract', () => {
	it('accepts the complete live lifecycle and rejects terminal resurrection', () => {
		expect(() => assertCapacityWorkdayTransition('draft', 'active')).not.toThrow();
		expect(() => assertCapacityWorkdayTransition('active', 'paused')).not.toThrow();
		expect(() => assertCapacityWorkdayTransition('paused', 'active')).not.toThrow();
		expect(() => assertCapacityWorkdayTransition('paused', 'degraded')).not.toThrow();
		expect(() => assertCapacityWorkdayTransition('active', 'completed')).not.toThrow();
		expect(() => assertCapacityWorkdayTransition('completed', 'active')).toThrow(/Cannot transition/u);
		expect(capacityWorkdayTimestampField('cancelled')).toBe('completed_at');
		expect(() => capacityWorkdayStatus('invented', 'draft')).toThrow(/Unknown capacity workday status/u);
	});

	it('permits protected references and rejects persisted secret material at any depth', () => {
		expect(() => assertCapacityWorkdayParametersSafe({ providerCredentialRef: 'secret://capacity/team-a' })).not.toThrow();
		expect(() => assertCapacityWorkdayParametersSafe({ nested: [{ providerToken: 'plaintext' }] })).toThrow(/never secret values/u);
		expect(() => assertCapacityWorkdayParametersSafe({ privateKey: 'plaintext' })).toThrow(/never secret values/u);
	});

	it('requires every running verification workday to have an explicit duration or deadline', () => {
		expect(() => assertRunningCapacityWorkdayBounded({ status: 'running', durationSeconds: 0, deadlineAt: null })).toThrow(/requires a positive durationSeconds/u);
		expect(() => assertRunningCapacityWorkdayBounded({ status: 'running', durationSeconds: 60, deadlineAt: null })).not.toThrow();
		expect(() => assertRunningCapacityWorkdayBounded({ status: 'running', durationSeconds: 0, deadlineAt: '2026-07-17T04:00:00.000Z' })).not.toThrow();
		expect(() => assertRunningCapacityWorkdayBounded({ status: 'queued', durationSeconds: 0, deadlineAt: null })).not.toThrow();
	});
});

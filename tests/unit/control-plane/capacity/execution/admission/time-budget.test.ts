import { describe, expect, it } from 'vitest';
import { compileAssignmentTimeBudget } from '../../../../../../src/api/capacity/services/capacity/assignments/planning/assignment-time-budget.ts';

describe('allocator deadline custody', () => {
	it('does not let infrastructure preparation move execution into another accounting day', () => {
		const timing = compileAssignmentTimeBudget({ now: '2026-09-16T23:59:00.000Z', requestedSeconds: 180, configuredBudget: {} });
		expect(timing.authorityExpiresAt).toBe('2026-09-17T00:00:00.000Z');
		expect(timing.capacityBudget.time.preparationDeadlineAt).toBe(timing.authorityExpiresAt);
		expect(timing.capacityBudget.time.preparationStartedAt).toBeNull();
	});
	it('preserves an earlier graph/phase deadline when projecting admission', () => {
		const deadline = '2026-09-16T21:00:30.000Z';
		const timing = compileAssignmentTimeBudget({ now: '2026-09-16T21:00:00.000Z', requestedSeconds: 180, configuredBudget: { deadline } });
		expect(timing.capacityBudget.deadline).toBe(deadline);
		expect(timing.capacityBudget.time.authorityDeadlineAt).toBe(deadline);
	});
});

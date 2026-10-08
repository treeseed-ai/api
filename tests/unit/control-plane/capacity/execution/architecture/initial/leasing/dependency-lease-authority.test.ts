import { describe, expect, it } from 'vitest';
import { dependencyLeaseBudget } from './dependency-lease-fixture.ts';
import { evaluateAssignmentLeaseDeadline } from '../../../../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-lease-service.ts';
import { beginAssignmentPreparationTimeBudget } from '../../../../../../../../src/api/capacity/services/capacity/assignments/planning/assignment-time-budget.ts';

function eligible(envelope: Record<string, unknown>, now: number) {
	const capacityEnvelope = { teamId: 'team', projectId: 'project', mode: 'acting' };
	const assignment: Parameters<typeof evaluateAssignmentLeaseDeadline>[0] = { status: 'pending', capacityEnvelope };
	// Intentionally malformed INPUT DTOs reach the real gate, not a fixture validator.
	Object.assign(capacityEnvelope, structuredClone(envelope));
	try { return evaluateAssignmentLeaseDeadline(assignment, now).eligible; }
	catch { return false; }
}

function preparationClocks(envelope: ReturnType<typeof beginAssignmentPreparationTimeBudget>) {
	const budget = envelope.budget;
	if (!budget || typeof budget !== 'object' || !('time' in budget)) throw new Error('Preparation budget required');
	const time = budget.time;
	if (!time || typeof time !== 'object' || !('authorityDeadlineAt' in time) || !('preparationDeadlineAt' in time)
		|| typeof time.authorityDeadlineAt !== 'string' || typeof time.preparationDeadlineAt !== 'string') throw new Error('Exact preparation clocks required');
	return { authorityDeadlineAt: time.authorityDeadlineAt, preparationDeadlineAt: time.preparationDeadlineAt };
}

describe('exact admitted authority during lease preparation', () => {
	it('pending preparation retains a valid original authority window and cannot bypass its exact expired deadline', () => {
		const f = dependencyLeaseBudget(), before = structuredClone(f);
		expect(eligible(f.envelope, Date.parse(f.now))).toBe(true);
		expect(eligible(f.envelope, Date.parse(f.deadline))).toBe(false);
		expect(eligible(f.envelope, Date.parse(f.deadline) + 1)).toBe(false); expect(f).toEqual(before);
	});
	it('missing malformed and nonfinite lease clocks deny rather than treating unknown timing as unlimited authority', () => {
		const f = dependencyLeaseBudget(); expect(eligible(f.envelope, Date.parse(f.now))).toBe(true);
		for (const value of [undefined, '', 'not-a-clock', null] as const) {
			const envelope = { ...f.envelope, budget: { ...f.envelope.budget, deadline: value, time: { ...f.envelope.budget.time,
				hardDeadlineAt: value, authorityDeadlineAt: value, preparationDeadlineAt: value } } }, original = structuredClone(envelope);
			expect(eligible(envelope, Date.parse(f.now))).toBe(false); expect(envelope).toEqual(original);
		}
		for (const now of [Number.NaN, Infinity, -Infinity]) { const original = structuredClone(f.envelope); expect(eligible(f.envelope, now)).toBe(false); expect(f.envelope).toEqual(original); }
	});
	it('actual preparation retries preserve the original authority expiry and reject malformed signed preparation clocks without rewriting the envelope', () => {
		const f = dependencyLeaseBudget(), original = structuredClone(f.envelope);
		const first = beginAssignmentPreparationTimeBudget(f.envelope, f.now);
		const retried = beginAssignmentPreparationTimeBudget(first, new Date(Date.parse(f.now) + 1_000).toISOString());
		expect(preparationClocks(first).authorityDeadlineAt).toBe(f.deadline); expect(preparationClocks(retried).authorityDeadlineAt).toBe(f.deadline);
		expect(Date.parse(preparationClocks(retried).preparationDeadlineAt)).toBeLessThanOrEqual(Date.parse(f.deadline)); expect(f.envelope).toEqual(original);
		for (const field of ['authorityDeadlineAt', 'preparationDeadlineAt'] as const) {
			const invalid = { ...f.envelope, budget: { ...f.envelope.budget, time: { ...f.envelope.budget.time, [field]: 'malformed' } } }, before = structuredClone(invalid);
			expect(() => beginAssignmentPreparationTimeBudget(invalid, f.now)).toThrow(); expect(invalid).toEqual(before);
		}
	});
});

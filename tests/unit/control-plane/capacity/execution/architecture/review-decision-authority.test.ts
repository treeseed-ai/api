import { describe, expect, it } from 'vitest';
import type { CapacityGovernanceDatabase } from '../../../../../../src/api/capacity/database.ts';
import { resolveReviewDisposition } from '../../../../../../src/api/capacity/services/capacity/assignments/context/review-result.ts';
import { actorResult, reviewAssignment, reviewDecision, reviewResult } from './review-decision-fixture.ts';

describe('architecture work-review Decision authority units', () => {
	const store = { first: async () => ({ pair_role: 'reviewer' }), all: async () => [{ assignment_result_json: actorResult() }] };
	const database = store as unknown as CapacityGovernanceDatabase; // Unit collaborator only, not integration proof.
	const result = () => reviewResult('d'.repeat(40));
	it('accepts complete classed authority for arbitrary configured reviewing identity without input mutation', async () => {
		const assignment = reviewAssignment(), decision = reviewDecision(), output = result();
		const original = structuredClone({ assignment, decision, output });
		await expect(resolveReviewDisposition(database, assignment, output, async () => decision)).resolves.toBe('approved');
		expect({ assignment, decision, output }).toEqual(original);
	});
	it('denies absent or malformed class, method, decision-maker and authority evidence', async () => {
		for (const field of Object.keys(reviewDecision())) {
			const decision: Record<string, unknown> = reviewDecision(); delete decision[field];
			await expect(resolveReviewDisposition(database, reviewAssignment(), result(), async () => decision), field)
				.rejects.toMatchObject({ code: 'review_decision_required' });
		}
		for (const [field, value] of [['decisionClass', 'review'], ['decisionMethod', 'guess'], ['decidedByRefs', []],
			['authorityRefs', []], ['rationale', ''], ['decidedAt', 'not-time'], ['executionPlan', {}]] as const) {
			await expect(resolveReviewDisposition(database, reviewAssignment(), result(), async () => ({ ...reviewDecision(), [field]: value })), field)
				.rejects.toMatchObject({ code: 'review_decision_required' });
		}
	});
	it('requires signed positions for approval and vote methods, not a method label alone', async () => {
		for (const decisionMethod of ['approval', 'vote']) {
			await expect(resolveReviewDisposition(database, reviewAssignment(), result(), async () => ({ ...reviewDecision(), decisionMethod })), decisionMethod)
				.rejects.toMatchObject({ code: 'review_decision_required' });
		}
	});
	it('does not turn a rejected work-review Decision into request-changes', async () => {
		await expect(resolveReviewDisposition(database, reviewAssignment(), result(), async () => ({ ...reviewDecision(), disposition: 'rejected' })))
			.rejects.toMatchObject({ code: 'review_decision_required' });
	});
	it('requires exact decision-maker evidence from the assigned governed reviewing profile', async () => {
		await expect(resolveReviewDisposition(database, reviewAssignment(), result(), async () => ({ ...reviewDecision(),
			decidedByRefs: [{ ...reviewDecision().decidedByRefs[0]!, id: 'unassigned-reviewer' }] })))
			.rejects.toMatchObject({ code: 'review_decision_required' });
	});
	it('denies conflicting exact review Decisions rather than selecting the first returned disposition', async () => {
		const output = result(); output.references.push({ kind: 'treedx', projectId: 'project', repository: 'repository',
			commit: 'd'.repeat(40), path: 'decisions/review-two.mdx', workspaceId: 'workspace' });
		await expect(resolveReviewDisposition(database, reviewAssignment(), output, async reference => ({ ...reviewDecision(),
			id: reference.path.endsWith('two.mdx') ? 'review-two' : 'review-one',
			disposition: reference.path.endsWith('two.mdx') ? 'request-changes' : 'approved' })))
			.rejects.toMatchObject({ code: 'review_decision_required' });
	});
	it('denies review evidence produced before admission or after the returned result', async () => {
		for (const decidedAt of ['2026-10-02T11:59:00.000Z', '2026-10-02T12:00:11.000Z']) {
			await expect(resolveReviewDisposition(database, reviewAssignment(), result(), async () => ({ ...reviewDecision(), decidedAt })), decidedAt)
				.rejects.toMatchObject({ code: 'review_decision_required' });
		}
	});
});

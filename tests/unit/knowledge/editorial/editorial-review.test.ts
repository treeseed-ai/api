import { describe, expect, it, vi } from 'vitest';
import { editorialReviewGate, editorialSubmissionRequirements, requiredRevisionReviewerIds,
	verifiedEditorialContextTrace } from '../../../../src/api/knowledge/editorial-review.ts';
import { recordKnowledgeEditorialReviewMethod } from '../../../../src/api/store/knowledge/collaboration.ts';

const digest = 'a'.repeat(64);
const result = (kind: 'technical' | 'audience' | 'graph', reviewerId: string) => ({
	kind, disposition: 'approved', reviewerId, authorId: 'author-a', contentRevision: 'commit-a',
	contextDigest: digest, criteria: [{ id: `${kind}-criterion`, status: 'pass' }],
});

describe('Guide editorial review gate', () => {
	it('requires a valid context digest for Guide changes and graph review for structural paths', () => {
		expect(editorialSubmissionRequirements(['src/content/knowledge/treeseed-guide/deployment/page.md'], '')).toMatchObject({
			requiresEditorialReview: true, requiresGraphReview: false, error: expect.any(String),
		});
		expect(editorialSubmissionRequirements(['src/content/knowledge/treeseed-guide/foundation.md'], digest)).toMatchObject({
			requiresEditorialReview: true, requiresGraphReview: true, contextDigest: digest, error: null,
		});
	});

	it('requires technical, audience, optional graph, and durable satisfied state', () => {
		expect(editorialReviewGate({ requiresEditorialReview: true, contextDigest: digest })).toEqual({ ok: false, code: 'technical_review_required' });
		expect(editorialReviewGate({ requiresEditorialReview: true, contextDigest: digest,
			technicalReview: result('technical', 'technical-a'), audienceReview: result('audience', 'audience-a'),
			requiresGraphReview: true, editorialGateSatisfied: false })).toEqual({ ok: false, code: 'graph_review_required' });
		expect(editorialReviewGate({ requiresEditorialReview: true, contextDigest: digest,
			technicalReview: result('technical', 'technical-a'), audienceReview: result('audience', 'audience-a'),
			graphReview: result('graph', 'graph-a'), requiresGraphReview: true, editorialGateSatisfied: true })).toEqual({ ok: true });
	});

	it('accepts context only from a successful project-scoped Guide authoring trace', async () => {
		const first = vi.fn().mockResolvedValue({ id: 'mode-run-a', trace_refs_json: '{}' });
		expect(await verifiedEditorialContextTrace({ first }, 'project-a', digest)).toMatchObject({ id: 'mode-run-a' });
		expect(first.mock.calls[0][0]).toContain("status = 'succeeded'");
		expect(first.mock.calls[0][0]).toContain("'guide-writer'");
		expect(first.mock.calls[0][1]).toEqual(['project-a', digest]);
		expect(await verifiedEditorialContextTrace({ first }, 'project-a', 'not-a-digest')).toBeNull();
	});

	it('records independent exact-revision results and closes the durable gate', async () => {
		let current: any = { id: 'review-a', status: 'open', commitSha: 'commit-a', contextDigest: digest,
			requiresEditorialReview: true, requiresGraphReview: false };
		const run = vi.fn().mockImplementation(async (_sql, values) => {
			const stored = JSON.parse(values[0]);
			current = { ...current, [`${stored.kind}Review`]: stored, editorialGateSatisfied: values[1] === 1 };
			return { meta: { changes: 1 } };
		});
		const store = { ensureInitialized: vi.fn(), run, getKnowledgeReview: vi.fn(async () => current) };
		await recordKnowledgeEditorialReviewMethod.call(store as never, 'review-a', { result: result('technical', 'technical-a') });
		const recorded = await recordKnowledgeEditorialReviewMethod.call(store as never, 'review-a', { result: result('audience', 'audience-a') });
		expect(recorded).toMatchObject({ ok: true, review: { editorialGateSatisfied: true } });
		const duplicate = await recordKnowledgeEditorialReviewMethod.call(store as never, 'review-a', { result: result('graph', 'audience-a') });
		expect(duplicate).toMatchObject({ ok: false, code: 'reviewer_independence_required' });
	});

	it('returns a requested revision to the reviewer who rejected it', async () => {
		expect(requiredRevisionReviewerIds({ status: 'changes-requested', technicalReview: {
			disposition: 'changes-requested', reviewerId: 'technical-a' } })).toEqual({ technical: 'technical-a' });
		const current: any = { id: 'review-b', status: 'open', commitSha: 'commit-a', contextDigest: digest,
			requiresEditorialReview: true, requiresGraphReview: false,
			requiredReviewerIds: { technical: 'technical-a' } };
		const store = { ensureInitialized: vi.fn(), run: vi.fn(), getKnowledgeReview: vi.fn(async () => current) };
		const recorded = await recordKnowledgeEditorialReviewMethod.call(store as never, 'review-b', {
			result: result('technical', 'technical-b'),
		});
		expect(recorded).toMatchObject({ ok: false, code: 'rejecting_reviewer_required' });
		expect(store.run).not.toHaveBeenCalled();
	});
});

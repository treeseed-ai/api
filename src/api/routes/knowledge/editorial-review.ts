import { validateEditorialReview } from '../../knowledge/runtime/editorial-review.ts';
import { simulationEvidence } from '../../store/governance/policy/support/simulation-evidence.ts';

export function installEditorialReviewRoutes(context: any) {
	const { app, jsonError, store } = context;
	app.post('/v1/knowledge/reviews/:reviewId/editorial-results', async (c: any) => {
		const review = await store.getKnowledgeReview(c.req.param('reviewId'));
		if (!review) return jsonError(c, 404, 'Knowledge review not found.');
		const workspace = await store.getKnowledgeWorkspace(review.workspaceId);
		if (!workspace) return jsonError(c, 409, 'The review workspace is no longer available.');
		const access = await context.requireProjectAccess(c, store, workspace.projectId, 'knowledge:review');
		if (access.response) return access.response;
		if (workspace.actorUserId === access.principal.id) return jsonError(c, 403,
			'Authors cannot review their own knowledge submission.', { code: 'knowledge_self_review_denied' });
		const body = await c.req.json().catch(() => ({}));
		let result;
		try {
			result = validateEditorialReview({ ...body.result, reviewerId: access.principal.id,
				authorId: workspace.actorUserId, contentRevision: review.commitSha, contextDigest: review.contextDigest });
		}
		catch (error) { return jsonError(c, 422, error instanceof Error ? error.message : 'Invalid editorial review result.'); }
		const requiredReviewerId = review.requiredReviewerIds?.[result.kind];
		if (requiredReviewerId && requiredReviewerId !== result.reviewerId) return jsonError(c, 409,
			'The reviewer who requested this revision must review the revised result.', { code: 'rejecting_reviewer_required' });
		const recorded = await store.recordKnowledgeEditorialReview(review.id, { result });
		if (!recorded.ok) return jsonError(c, 409, recorded.code === 'reviewer_independence_required'
			? 'Technical, audience, and graph reviews require independent reviewers.'
			: 'The review changed before the editorial result was recorded.', { code: recorded.code ?? 'stale_knowledge_review' });
		await store.recordAuditEvent({ eventType: `knowledge.review.${result.kind}_recorded`, actorType: 'user',
			actorId: access.principal.id, targetType: 'knowledge_review', targetId: review.id,
			data: { workspaceId: workspace.id, projectId: workspace.projectId, contentRevision: result.contentRevision,
				contextDigest: result.contextDigest, disposition: result.disposition, simulation: simulationEvidence(body, access.principal.id) } });
		return c.json({ ok: true, payload: recorded.review });
	});
}

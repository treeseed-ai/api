export function editorialSubmissionRequirements(changedPaths: string[], contextDigest: unknown) {
	const requiresEditorialReview = changedPaths.some((path) => path.includes('/knowledge/treeseed-guide/')
		|| /\/books\/treeseed-guide\.(md|mdx)$/u.test(path));
	const digest = typeof contextDigest === 'string' && /^[a-f0-9]{64}$/u.test(contextDigest.trim()) ? contextDigest.trim() : '';
	return { requiresEditorialReview, contextDigest: digest,
		error: requiresEditorialReview && !digest ? 'TreeSeed Guide submissions require an editorial context digest.' : null };
}

export function editorialReviewGate(review: any) {
	if (!review?.requiresEditorialReview) return { ok: true };
	if (!review.contextDigest) return { ok: false, code: 'editorial_context_required' };
	if (review.technicalReview?.disposition !== 'approved') return { ok: false, code: 'technical_review_required' };
	if (review.audienceReview?.disposition !== 'approved') return { ok: false, code: 'audience_review_required' };
	if (!review.editorialGateSatisfied) return { ok: false, code: 'editorial_review_gate_incomplete' };
	return { ok: true };
}

export async function verifiedEditorialContextTrace(store: any, projectId: string, contextDigest: string) {
	if (!/^[a-f0-9]{64}$/u.test(contextDigest)) return null;
	return store.first(`SELECT id, trace_refs_json FROM agent_mode_runs
		WHERE project_id = ? AND status = 'succeeded'
			AND trace_refs_json::jsonb ->> 'editorialContextDigest' = ?
			AND trace_refs_json::jsonb ->> 'editorialContextSchemaVersion' = 'treeseed.editorial-context/v1'
			AND trace_refs_json::jsonb ->> 'agentSlug' IN ('guide-writer', 'guide-steward', 'knowledge-cartographer')
		ORDER BY completed_at DESC NULLS LAST LIMIT 1`, [projectId, contextDigest]);
}

export function requiredRevisionReviewerIds(review: any) {
	if (review?.status !== 'changes-requested') return {};
	return Object.fromEntries(['technical', 'audience'].flatMap((kind) => {
		const prior = review[`${kind}Review`];
		return prior?.disposition === 'changes-requested' ? [[kind, prior.reviewerId]] : [];
	}));
}

import { randomUUID } from 'node:crypto';
import { isoNow, type ControlPlaneStore, parseJson } from '../../persistence/store.ts';

function workspace(row: any) {
	return row ? {
		id: row.id, teamId: row.team_id, projectId: row.project_id, repositoryId: row.repository_id,
		treeDxWorkspaceId: row.treedx_workspace_id, actorUserId: row.actor_user_id,
		baseRef: row.base_ref, baseCommitSha: row.base_commit_sha, branchName: row.branch_name,
		allowedPaths: parseJson(row.allowed_paths_json, []), status: row.status, version: Number(row.version),
		createdAt: row.created_at, updatedAt: row.updated_at,
	} : null;
}

function review(row: any) {
	return row ? {
		id: row.id, workspaceId: row.workspace_id, status: row.status,
		submittedByUserId: row.submitted_by_user_id, decidedByUserId: row.decided_by_user_id,
		notes: row.notes, commitSha: row.commit_sha, createdAt: row.created_at, updatedAt: row.updated_at,
		changedPaths: parseJson(row.changed_paths_json, []),
		contextDigest: row.context_digest ?? undefined,
		requiresEditorialReview: Number(row.requires_editorial_review ?? 0) === 1,
		editorialGateSatisfied: Number(row.editorial_gate_satisfied ?? 0) === 1,
		technicalReview: parseJson(row.technical_review_json, undefined),
		audienceReview: parseJson(row.audience_review_json, undefined),
		requiredReviewerIds: parseJson(row.required_reviewer_ids_json, {}),
	} : null;
}

export async function createKnowledgeWorkspaceRecordMethod(this: ControlPlaneStore, input: any) {
	await this.ensureInitialized();
	const id = input.id ?? randomUUID();
	const timestamp = isoNow();
	await this.run(`INSERT INTO knowledge_authoring_workspaces
		(id, team_id, project_id, repository_id, treedx_workspace_id, actor_user_id, base_ref, base_commit_sha, branch_name, allowed_paths_json, status, version, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?)`, [id, input.teamId, input.projectId, input.repositoryId,
		input.treeDxWorkspaceId, input.actorUserId, input.baseRef, input.baseCommitSha, input.branchName,
		JSON.stringify(input.allowedPaths ?? []), timestamp, timestamp]);
	return this.getKnowledgeWorkspace(id);
}

export async function getKnowledgeWorkspaceMethod(this: ControlPlaneStore, id: string) {
	await this.ensureInitialized();
	return workspace(await this.first(`SELECT * FROM knowledge_authoring_workspaces WHERE id = ? LIMIT 1`, [id]));
}

export async function updateKnowledgeWorkspaceMethod(this: ControlPlaneStore, id: string, input: any) {
	await this.ensureInitialized();
	const current = await this.getKnowledgeWorkspace(id);
	if (!current) return { ok: false, code: 'missing' };
	if (Number(input.version) !== current.version) return { ok: false, code: 'stale', workspace: current };
	const result = await this.run(`UPDATE knowledge_authoring_workspaces SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?`,
		[input.status ?? current.status, isoNow(), id, current.version]);
	if (!result.success || Number(result.meta?.changes ?? 0) !== 1) return { ok: false, code: 'stale', workspace: await this.getKnowledgeWorkspace(id) };
	return { ok: true, workspace: await this.getKnowledgeWorkspace(id) };
}

export async function createKnowledgeReviewMethod(this: ControlPlaneStore, input: any) {
	await this.ensureInitialized();
	const id = input.id ?? randomUUID();
	const timestamp = isoNow();
	await this.run(`INSERT INTO knowledge_reviews
		(id, workspace_id, status, submitted_by_user_id, notes, commit_sha, changed_paths_json, context_digest,
			requires_editorial_review, editorial_gate_satisfied, required_reviewer_ids_json, created_at, updated_at)
		VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, input.workspaceId, input.submittedByUserId,
		input.notes ?? null, input.commitSha ?? null, JSON.stringify(input.changedPaths ?? []), input.contextDigest ?? null,
		input.requiresEditorialReview ? 1 : 0, input.requiresEditorialReview ? 0 : 1,
		JSON.stringify(input.requiredReviewerIds ?? {}), timestamp, timestamp]);
	return review(await this.first(`SELECT * FROM knowledge_reviews WHERE id = ?`, [id]));
}

export async function getKnowledgeReviewMethod(this: ControlPlaneStore, id: string) {
	await this.ensureInitialized();
	return review(await this.first(`SELECT * FROM knowledge_reviews WHERE id = ? LIMIT 1`, [id]));
}

export async function getKnowledgeReviewByWorkspaceMethod(this: ControlPlaneStore, workspaceId: string) {
	await this.ensureInitialized();
	return review(await this.first(`SELECT * FROM knowledge_reviews WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1`, [workspaceId]));
}

export async function submitKnowledgeWorkspaceMethod(this: ControlPlaneStore, input: any) {
	await this.ensureInitialized();
	const id = input.id ?? randomUUID();
	const timestamp = isoNow();
	const inserted = await this.first(`WITH candidate AS (
		SELECT id FROM knowledge_authoring_workspaces
		WHERE id = ? AND status IN ('draft', 'changes-requested') AND version = ?
		FOR UPDATE
	), updated_workspace AS (
		UPDATE knowledge_authoring_workspaces SET status = 'submitted', version = version + 1, updated_at = ?
		WHERE id = (SELECT id FROM candidate) RETURNING id
	), inserted_review AS (
		INSERT INTO knowledge_reviews
			(id, workspace_id, status, submitted_by_user_id, notes, commit_sha, changed_paths_json, context_digest,
				requires_editorial_review, editorial_gate_satisfied, required_reviewer_ids_json, created_at, updated_at)
		SELECT ?, id, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM updated_workspace RETURNING id
	)
	SELECT id FROM inserted_review`, [input.workspaceId, input.workspaceVersion, timestamp, id,
		input.submittedByUserId, input.notes ?? null, input.commitSha, JSON.stringify(input.changedPaths ?? []),
		input.contextDigest ?? null, input.requiresEditorialReview ? 1 : 0,
		input.requiresEditorialReview ? 0 : 1, JSON.stringify(input.requiredReviewerIds ?? {}), timestamp, timestamp]);
	return inserted?.id ? { ok: true, review: await this.getKnowledgeReview(inserted.id),
		workspace: await this.getKnowledgeWorkspace(input.workspaceId) }
		: { ok: false, code: 'stale_or_missing', review: await this.getKnowledgeReviewByWorkspace(input.workspaceId),
			workspace: await this.getKnowledgeWorkspace(input.workspaceId) };
}

export async function listKnowledgeReviewsMethod(this: ControlPlaneStore, teamId: string) {
	await this.ensureInitialized();
	const rows = await this.all(`SELECT r.*, w.team_id, w.project_id, w.branch_name, w.actor_user_id, w.version AS workspace_version
		FROM knowledge_reviews r JOIN knowledge_authoring_workspaces w ON w.id = r.workspace_id
		WHERE w.team_id = ? ORDER BY r.created_at DESC`, [teamId]);
	return rows.map((row: any) => ({ ...review(row), teamId: row.team_id, projectId: row.project_id,
		branchName: row.branch_name, authorUserId: row.actor_user_id, workspaceVersion: Number(row.workspace_version) }));
}

export async function decideKnowledgeReviewMethod(this: ControlPlaneStore, id: string, input: any) {
	await this.ensureInitialized();
	const status = input.decision === 'approve' ? 'approved' : 'changes-requested';
	const timestamp = isoNow();
	const updated = await this.first(`WITH candidate AS (
		SELECT reviews.id AS review_id, workspaces.id AS workspace_id
		FROM knowledge_reviews reviews
		INNER JOIN knowledge_authoring_workspaces workspaces ON workspaces.id = reviews.workspace_id
		WHERE reviews.id = ? AND reviews.status = 'open' AND workspaces.id = ?
			AND workspaces.status = 'submitted' AND workspaces.version = ?
			AND (? <> 'approve' OR reviews.editorial_gate_satisfied = 1)
		FOR UPDATE OF reviews, workspaces
	), updated_review AS (
		UPDATE knowledge_reviews SET status = ?, decided_by_user_id = ?, notes = ?, updated_at = ?
		WHERE id = (SELECT review_id FROM candidate) RETURNING id
	), updated_workspace AS (
		UPDATE knowledge_authoring_workspaces SET status = ?, version = version + 1, updated_at = ?,
			treedx_workspace_id = COALESCE(?, treedx_workspace_id)
		WHERE id = (SELECT workspace_id FROM candidate)
			AND EXISTS (SELECT 1 FROM updated_review) RETURNING id
	)
	SELECT id FROM updated_review WHERE EXISTS (SELECT 1 FROM updated_workspace)`,
		[id, input.workspaceId, input.workspaceVersion, input.decision, status, input.decidedByUserId, input.notes,
			timestamp, status, timestamp, input.revisionWorkspace?.workspaceId ?? null]);
	return updated?.id ? { ok: true, review: await this.getKnowledgeReview(id), workspace: await this.getKnowledgeWorkspace(input.workspaceId) }
		: { ok: false, code: 'stale_or_missing' };
}

export async function recordKnowledgeEditorialReviewMethod(this: ControlPlaneStore, id: string, input: any) {
	await this.ensureInitialized();
	const current = await this.getKnowledgeReview(id);
	if (!current || current.status !== 'open') return { ok: false, code: 'stale_or_missing', review: current };
	const existingReviewers = [current.technicalReview, current.audienceReview]
		.filter((entry: any) => entry && entry.kind !== input.result.kind).map((entry: any) => entry.reviewerId);
	if (existingReviewers.includes(input.result.reviewerId)) return { ok: false, code: 'reviewer_independence_required', review: current };
	const requiredReviewerId = current.requiredReviewerIds?.[input.result.kind];
	if (requiredReviewerId && requiredReviewerId !== input.result.reviewerId) {
		return { ok: false, code: 'rejecting_reviewer_required', review: current };
	}
	const field = input.result.kind === 'technical' ? 'technical_review_json' : 'audience_review_json';
	const reviews = { technical: current.technicalReview, audience: current.audienceReview,
		[input.result.kind]: input.result } as Record<string, any>;
	const satisfied = reviews.technical?.disposition === 'approved' && reviews.audience?.disposition === 'approved';
	const otherField = field === 'technical_review_json' ? 'audience_review_json' : 'technical_review_json';
	const result = await this.run(`UPDATE knowledge_reviews SET ${field} = ?, editorial_gate_satisfied = ?, updated_at = ?
		WHERE id = ? AND status = 'open' AND commit_sha = ? AND context_digest = ?
			AND (${otherField} IS NULL OR ${otherField}::jsonb ->> 'reviewerId' <> ?)`, [JSON.stringify(input.result),
		satisfied ? 1 : 0, isoNow(), id, input.result.contentRevision, input.result.contextDigest,
		input.result.reviewerId]);
	return Number(result.meta?.changes ?? 0) === 1 ? { ok: true, review: await this.getKnowledgeReview(id) }
		: { ok: false, code: 'stale_or_mismatched', review: await this.getKnowledgeReview(id) };
}

export async function createKnowledgePublicationMethod(this: ControlPlaneStore, input: any) {
	await this.ensureInitialized();
	const existing = await this.getKnowledgePublicationByReview(input.reviewId);
	if (existing) return existing;
	const id = input.id ?? randomUUID();
	const timestamp = isoNow();
	await this.run(`INSERT INTO knowledge_publications
		(id, workspace_id, review_id, project_id, commit_sha, published_ref, status, created_at)
		VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`, [id, input.workspaceId, input.reviewId, input.projectId, input.commitSha, input.publishedRef, timestamp]);
	return this.first(`SELECT * FROM knowledge_publications WHERE id = ?`, [id]);
}

export async function getKnowledgePublicationByReviewMethod(this: ControlPlaneStore, reviewId: string) {
	await this.ensureInitialized();
	return this.first(`SELECT * FROM knowledge_publications WHERE review_id = ? LIMIT 1`, [reviewId]);
}

export async function updateKnowledgePublicationMethod(this: ControlPlaneStore, id: string, input: any) {
	await this.ensureInitialized();
	const result = await this.run(`UPDATE knowledge_publications SET status = ?, published_revision = ?, completed_at = ? WHERE id = ? AND status = ?`,
		[input.status, input.publishedRevision ?? null, input.completedAt ?? null, id, input.expectedStatus]);
	return Number(result.meta?.changes ?? 0) === 1
		? { ok: true, publication: await this.first(`SELECT * FROM knowledge_publications WHERE id = ?`, [id]) }
		: { ok: false, publication: await this.first(`SELECT * FROM knowledge_publications WHERE id = ?`, [id]) };
}

export async function completeKnowledgePublicationMethod(this: ControlPlaneStore, id: string, input: any) {
	await this.ensureInitialized();
	const timestamp = input.completedAt ?? isoNow();
	const updated = await this.first(`WITH candidate AS (
		SELECT publications.id AS publication_id, workspaces.id AS workspace_id
		FROM knowledge_publications publications
		INNER JOIN knowledge_authoring_workspaces workspaces ON workspaces.id = publications.workspace_id
		WHERE publications.id = ? AND publications.status = 'queued'
			AND workspaces.id = ? AND workspaces.status = 'approved' AND workspaces.version = ?
		FOR UPDATE OF publications, workspaces
	), updated_publication AS (
		UPDATE knowledge_publications SET status = 'completed', published_revision = ?, completed_at = ?
		WHERE id = (SELECT publication_id FROM candidate) RETURNING id
	), updated_workspace AS (
		UPDATE knowledge_authoring_workspaces SET status = 'published', version = version + 1, updated_at = ?
		WHERE id = (SELECT workspace_id FROM candidate)
			AND EXISTS (SELECT 1 FROM updated_publication) RETURNING id
	)
	SELECT id FROM updated_publication WHERE EXISTS (SELECT 1 FROM updated_workspace)`,
		[id, input.workspaceId, input.workspaceVersion, input.publishedRevision, timestamp, timestamp]);
	return updated?.id ? { ok: true,
		publication: await this.first(`SELECT * FROM knowledge_publications WHERE id = ?`, [id]),
		workspace: await this.getKnowledgeWorkspace(input.workspaceId) }
		: { ok: false, code: 'stale_or_missing',
			publication: await this.first(`SELECT * FROM knowledge_publications WHERE id = ?`, [id]),
			workspace: await this.getKnowledgeWorkspace(input.workspaceId) };
}

import { randomUUID } from 'node:crypto';
import { isoNow, type ControlPlaneStore } from '../../persistence/store.ts';

const comment = (row: any) => row ? { id: row.id, reviewId: row.review_id, authorUserId: row.author_user_id,
	path: row.path, lineStart: row.line_start == null ? undefined : Number(row.line_start),
	lineEnd: row.line_end == null ? undefined : Number(row.line_end), body: row.body, status: row.status,
	resolvedByUserId: row.resolved_by_user_id ?? undefined, version: Number(row.version),
	createdAt: row.created_at, updatedAt: row.updated_at } : null;

export async function heartbeatKnowledgeWorkspaceMethod(this: ControlPlaneStore, workspaceId: string, userId: string) {
	await this.ensureInitialized();
	const timestamp = isoNow();
	await this.run(`INSERT INTO knowledge_workspace_presence (id, workspace_id, user_id, last_seen_at) VALUES (?, ?, ?, ?)
		ON CONFLICT (workspace_id, user_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at`,
		[`knowledge-presence:${workspaceId}:${userId}`, workspaceId, userId, timestamp]);
	return { workspaceId, userId, lastSeenAt: timestamp };
}

export async function listKnowledgeWorkspacePresenceMethod(this: ControlPlaneStore, workspaceId: string) {
	await this.ensureInitialized();
	const rows = await this.all(`SELECT user_id, last_seen_at FROM knowledge_workspace_presence
		WHERE workspace_id = ? AND last_seen_at >= ? ORDER BY last_seen_at DESC`,
		[workspaceId, new Date(Date.now() - 5 * 60_000).toISOString()]);
	return rows.map((row: any) => ({ userId: row.user_id, lastSeenAt: row.last_seen_at }));
}

export async function createKnowledgeReviewCommentMethod(this: ControlPlaneStore, input: any) {
	await this.ensureInitialized();
	const id = input.id ?? randomUUID(); const timestamp = isoNow();
	await this.run(`INSERT INTO knowledge_review_comments
		(id, review_id, author_user_id, path, line_start, line_end, body, status, version, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, 'open', 1, ?, ?)`, [id, input.reviewId, input.authorUserId, input.path,
		input.lineStart ?? null, input.lineEnd ?? null, input.body, timestamp, timestamp]);
	return comment(await this.first(`SELECT * FROM knowledge_review_comments WHERE id = ?`, [id]));
}

export async function listKnowledgeReviewCommentsMethod(this: ControlPlaneStore, reviewId: string) {
	await this.ensureInitialized();
	return (await this.all(`SELECT * FROM knowledge_review_comments WHERE review_id = ? ORDER BY created_at ASC`, [reviewId])).map(comment);
}

export async function resolveKnowledgeReviewCommentMethod(this: ControlPlaneStore, id: string, input: any) {
	await this.ensureInitialized();
	const result = await this.run(`UPDATE knowledge_review_comments SET status = 'resolved', resolved_by_user_id = ?,
		version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status = 'open'`,
		[input.userId, isoNow(), id, input.version]);
	return Number(result.meta?.changes ?? 0) === 1
		? { ok: true, comment: comment(await this.first(`SELECT * FROM knowledge_review_comments WHERE id = ?`, [id])) }
		: { ok: false, code: 'stale_or_missing' };
}

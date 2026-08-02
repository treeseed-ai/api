import { randomUUID } from 'node:crypto';
import type { FeedbackCollectionFilters, FeedbackStatus } from '@treeseed/sdk/feedback';

export function jsonValue<T>(value: unknown, fallback: T): T {
	try { return typeof value === 'string' ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}

export async function primaryVerifiedEmail(store: any, userId: string) {
	const row = await store.first(`SELECT email FROM user_email_addresses WHERE user_id = ? AND status = 'verified' ORDER BY is_primary DESC, verified_at ASC LIMIT 1`, [userId]);
	return typeof row?.email === 'string' ? row.email : null;
}

export async function feedbackRateAllowed(store: any, userId: string) {
	const since = new Date(Date.now() - 60 * 60_000).toISOString();
	const row = await store.first('SELECT COUNT(*) AS count FROM feedback_submissions WHERE submitter_user_id = ? AND created_at >= ?', [userId, since]);
	return Number(row?.count ?? 0) < 10;
}

export async function existingIdempotentFeedback(store: any, userId: string, key: string) {
	return store.first('SELECT id, type, status, created_at FROM feedback_submissions WHERE submitter_user_id = ? AND idempotency_key = ?', [userId, key]);
}

export function feedbackWhere(filters: FeedbackCollectionFilters) {
	const conditions: string[] = [];
	const values: unknown[] = [];
	if (filters.status) { conditions.push('f.status = ?'); values.push(filters.status); }
	if (filters.type) { conditions.push('f.type = ?'); values.push(filters.type); }
	if (filters.teamId) { conditions.push('f.team_id = ?'); values.push(filters.teamId); }
	if (filters.hasScreenshot !== undefined) conditions.push(filters.hasScreenshot ? 'EXISTS (SELECT 1 FROM feedback_attachments a WHERE a.feedback_id = f.id AND a.expired_at IS NULL)' : 'NOT EXISTS (SELECT 1 FROM feedback_attachments a WHERE a.feedback_id = f.id AND a.expired_at IS NULL)');
	if (filters.exported !== undefined) conditions.push(filters.exported ? 'EXISTS (SELECT 1 FROM feedback_export_items ei WHERE ei.feedback_id = f.id)' : 'NOT EXISTS (SELECT 1 FROM feedback_export_items ei WHERE ei.feedback_id = f.id)');
	if (filters.from) { conditions.push('f.created_at >= ?'); values.push(filters.from); }
	if (filters.to) { conditions.push('f.created_at <= ?'); values.push(filters.to); }
	if (filters.cursor) { conditions.push('f.created_at < ?'); values.push(filters.cursor); }
	if (filters.query) {
		conditions.push(`(f.id ILIKE ? OR f.message ILIKE ? OR f.canonical_path ILIKE ? OR f.type ILIKE ?
			OR t.id ILIKE ? OR t.slug ILIKE ? OR t.name ILIKE ? OR t.display_name ILIKE ?
			OR u.id ILIKE ? OR u.username ILIKE ? OR u.display_name ILIKE ? OR u.email ILIKE ?)`);
		for (let index = 0; index < 12; index += 1) values.push(`%${filters.query.slice(0, 200)}%`);
	}
	return { clause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', values };
}

export async function listFeedback(store: any, filters: FeedbackCollectionFilters) {
	const { clause, values } = feedbackWhere(filters);
	const limit = Math.max(1, Math.min(100, filters.limit ?? 25));
	const rows = await store.all(`SELECT f.*,
		COALESCE(t.display_name, t.name, t.slug) AS team_label,
		COALESCE(u.display_name, u.username, u.id) AS submitter_label
		FROM feedback_submissions f
		LEFT JOIN teams t ON t.id = f.team_id
		LEFT JOIN users u ON u.id = f.submitter_user_id
		${clause} ORDER BY f.created_at DESC LIMIT ?`, [...values, limit + 1]);
	const enriched = await Promise.all(rows.map(async (row: any) => {
		const [attachment, exportItem] = await Promise.all([
			store.first('SELECT id FROM feedback_attachments WHERE feedback_id = ? AND expired_at IS NULL LIMIT 1', [row.id]),
			store.first('SELECT feedback_id FROM feedback_export_items WHERE feedback_id = ? LIMIT 1', [row.id]),
		]);
		return { ...row, has_screenshot: Boolean(attachment), exported: Boolean(exportItem) };
	}));
	const counts = await store.all('SELECT status, COUNT(*) AS count FROM feedback_submissions GROUP BY status');
	const teams = await store.all(`SELECT DISTINCT t.id, t.slug, COALESCE(t.display_name, t.name, t.slug) AS label FROM teams t JOIN feedback_submissions f ON f.team_id = t.id ORDER BY label ASC LIMIT 500`);
	return { rows: enriched.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1]?.created_at : undefined, counts: Object.fromEntries(counts.map((row: any) => [row.status, Number(row.count)])), teams };
}

export async function feedbackDetail(store: any, id: string) {
	const feedback = await store.first('SELECT * FROM feedback_submissions WHERE id = ?', [id]);
	if (!feedback) return null;
	const [attachments, history, exportItem] = await Promise.all([
		store.all('SELECT * FROM feedback_attachments WHERE feedback_id = ? ORDER BY created_at ASC', [id]),
		store.all(`SELECT e.*, COALESCE(u.display_name, u.username, e.actor_user_id) AS actor_label FROM feedback_status_events e LEFT JOIN users u ON u.id = e.actor_user_id WHERE e.feedback_id = ? ORDER BY e.created_at ASC`, [id]),
		store.first('SELECT feedback_id FROM feedback_export_items WHERE feedback_id = ? LIMIT 1', [id]),
	]);
	return { feedback: { ...feedback, has_screenshot: attachments.some((item: any) => !item.expired_at), exported: Boolean(exportItem) }, attachments, history };
}

export async function changeFeedbackStatus(store: any, input: { id: string; actorId: string; status: FeedbackStatus; note?: string; version: number }) {
	const current = await store.first('SELECT status, version FROM feedback_submissions WHERE id = ?', [input.id]);
	if (!current) return { code: 'not_found' } as const;
	if (Number(current.version) !== input.version) return { code: 'conflict' } as const;
	const allowed: Record<FeedbackStatus, FeedbackStatus[]> = {
		new: ['triaged'],
		triaged: ['in_progress', 'resolved'],
		in_progress: ['triaged', 'resolved'],
		resolved: ['in_progress'],
	};
	if (!allowed[current.status as FeedbackStatus]?.includes(input.status)) return { code: 'invalid_transition' } as const;
	const noteRequired = input.status === 'resolved' || (current.status === 'resolved' && input.status !== 'resolved');
	if (noteRequired && !input.note?.trim()) return { code: 'note_required' } as const;
	const now = new Date().toISOString();
	const updated = await store.first('UPDATE feedback_submissions SET status = ?, resolved_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? RETURNING version', [input.status, input.status === 'resolved' ? now : null, now, input.id, input.version]);
	if (!updated) return { code: 'conflict' } as const;
	await store.run('INSERT INTO feedback_status_events (id, feedback_id, from_status, to_status, note, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [randomUUID(), input.id, current.status, input.status, input.note?.trim() || null, input.actorId, now]);
	if (input.status === 'resolved') await store.run(`UPDATE feedback_attachments SET expires_at = ? WHERE feedback_id = ? AND expires_at IS NULL`, [new Date(Date.now() + 90 * 86400_000).toISOString(), input.id]);
	if (current.status === 'resolved' && input.status !== 'resolved') await store.run('UPDATE feedback_attachments SET expires_at = NULL WHERE feedback_id = ? AND expired_at IS NULL', [input.id]);
	return { code: 'updated', version: input.version + 1, previousStatus: current.status } as const;
}

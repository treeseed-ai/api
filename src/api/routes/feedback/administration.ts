import { randomUUID } from 'node:crypto';
import { isFeedbackStatus, isFeedbackType, type FeedbackCollectionFilters } from '@treeseed/sdk/feedback';
import { principalHasPlatformPermission } from '@treeseed/sdk/api';
import { createPrivateObjectStorage } from '../../storage/private-object-storage.ts';
import { changeFeedbackStatus, feedbackDetail, feedbackWhere, jsonValue, listFeedback } from '../../feedback/repository.ts';

function isPlatformAdministrator(c: any) {
	const principal = c.get('principal');
	return c.get('actorType') !== 'service' && principalHasPlatformPermission(principal, 'feedback:read:global');
}

function deny(c: any) {
	c.header('cache-control', 'private, no-store');
	return c.json({ ok: false, code: 'feedback_admin_forbidden', message: 'Platform administrator access is required.' }, { status: c.get('principal') ? 403 : 401 });
}

function filtersFrom(value: any): FeedbackCollectionFilters {
	return {
		query: typeof value?.query === 'string' ? value.query.slice(0, 200) : undefined,
		status: isFeedbackStatus(value?.status) ? value.status : undefined,
		type: isFeedbackType(value?.type) ? value.type : undefined,
		teamId: typeof value?.teamId === 'string' ? value.teamId.slice(0, 160) : undefined,
		hasScreenshot: value?.hasScreenshot === true || value?.hasScreenshot === 'true' ? true : value?.hasScreenshot === false || value?.hasScreenshot === 'false' ? false : undefined,
		exported: value?.exported === true || value?.exported === 'true' ? true : value?.exported === false || value?.exported === 'false' ? false : undefined,
		from: typeof value?.from === 'string' ? value.from : undefined,
		to: typeof value?.to === 'string' ? value.to : undefined,
		cursor: typeof value?.cursor === 'string' ? value.cursor : undefined,
		limit: Number(value?.limit) || undefined,
	};
}

function summary(row: any) {
	return { id: row.id, type: row.type, status: row.status, message: row.message, submitterId: row.submitter_user_id, submitterLabel: row.submitter_label ?? undefined, teamId: row.team_id ?? undefined, teamLabel: row.team_label ?? undefined, projectId: row.project_id ?? undefined, canonicalPath: row.canonical_path, hasScreenshot: Boolean(row.has_screenshot), exported: Boolean(row.exported), createdAt: row.created_at, updatedAt: row.updated_at, resolvedAt: row.resolved_at ?? undefined, version: Number(row.version) };
}

export function installFeedbackAdministrationRoutes({ app, store, options }: any) {
	const feedbackStorage = createPrivateObjectStorage({ adapter: options?.feedbackStorage });
	app.use('/v1/admin/feedback/*', async (c: any, next: any) => isPlatformAdministrator(c) ? next() : deny(c));
	app.get('/v1/admin/feedback', async (c: any) => {
		if (!isPlatformAdministrator(c)) return deny(c);
		c.header('cache-control', 'private, no-store');
		const result = await listFeedback(store, filtersFrom(Object.fromEntries(new URL(c.req.url).searchParams)));
		return c.json({ ok: true, payload: { items: result.rows.map(summary), nextCursor: result.nextCursor, teams: result.teams.map((team: any) => ({ id: team.id, slug: team.slug, label: team.label })), counts: { new: result.counts.new ?? 0, triaged: result.counts.triaged ?? 0, in_progress: result.counts.in_progress ?? 0, resolved: result.counts.resolved ?? 0 } } });
	});
	app.get('/v1/admin/feedback/:feedbackId', async (c: any) => {
		if (!isPlatformAdministrator(c)) return deny(c);
		c.header('cache-control', 'private, no-store');
		const result = await feedbackDetail(store, c.req.param('feedbackId'));
		if (!result) return c.json({ ok: false, code: 'feedback_not_found', message: 'Feedback was not found.' }, { status: 404 });
		const row = result.feedback;
		const [submitter, team] = await Promise.all([
			store.first('SELECT id, username, display_name, metadata_json FROM users WHERE id = ?', [row.submitter_user_id]),
			row.team_id ? store.first('SELECT id, slug, name, display_name FROM teams WHERE id = ?', [row.team_id]) : null,
		]);
		const submitterMetadata = jsonValue<Record<string, unknown>>(submitter?.metadata_json, {});
		return c.json({ ok: true, payload: { ...summary(row), submitter: submitter ? { id: submitter.id, username: submitter.username ?? undefined, displayName: submitter.display_name ?? submitter.username ?? 'User', image: typeof submitterMetadata.image === 'string' ? submitterMetadata.image : undefined } : undefined, team: team ? { id: team.id, slug: team.slug, displayName: team.display_name ?? team.name } : undefined, allowContact: Boolean(row.allow_contact), contactEmail: row.contact_email ?? undefined, context: jsonValue(row.context_json, {}), client: jsonValue(row.client_json, {}), attachments: result.attachments.map((item: any) => ({ id: item.id, feedbackId: item.feedback_id, mimeType: item.mime_type, byteSize: Number(item.byte_size), width: item.width, height: item.height, digest: item.digest, redactionVersion: item.redaction_version, maskedRegionCount: item.masked_region_count, createdAt: item.created_at, expiresAt: item.expires_at, expiredAt: item.expired_at })), history: result.history.map((event: any) => ({ id: event.id, fromStatus: event.from_status, toStatus: event.to_status, note: event.note, actorId: event.actor_user_id, actorLabel: event.actor_label, createdAt: event.created_at })) } });
	});
	app.patch('/v1/admin/feedback/:feedbackId/status', async (c: any) => {
		if (!isPlatformAdministrator(c)) return deny(c);
		const principal = c.get('principal');
		const body = await c.req.json().catch(() => ({}));
		if (!isFeedbackStatus(body.status)) return c.json({ ok: false, code: 'status_invalid', message: 'Choose a valid feedback status.', fieldErrors: { status: 'Choose a valid status.' } }, { status: 400 });
		const result = await changeFeedbackStatus(store, { id: c.req.param('feedbackId'), actorId: principal.id, status: body.status, note: typeof body.note === 'string' ? body.note.slice(0, 4000) : undefined, version: Number(body.version) });
		if (result.code === 'not_found') return c.json({ ok: false, code: result.code, message: 'Feedback was not found.' }, { status: 404 });
		if (result.code === 'conflict') return c.json({ ok: false, code: result.code, message: 'This feedback changed in another session. Refresh and try again.' }, { status: 409 });
		if (result.code === 'invalid_transition') return c.json({ ok: false, code: result.code, message: 'Move feedback through the supported triage workflow.', fieldErrors: { status: 'Choose the next available status.' } }, { status: 400 });
		if (result.code === 'note_required') return c.json({ ok: false, code: result.code, message: 'Add a note explaining the resolution or reopening.', fieldErrors: { note: 'A note is required.' } }, { status: 400 });
		const eventType = body.status === 'resolved' ? 'feedback.resolved' : result.previousStatus === 'resolved' ? 'feedback.reopened' : 'feedback.status_changed';
		await store.recordAuditEvent({ eventType, actorType: 'user', actorId: principal.id, targetType: 'feedback', targetId: c.req.param('feedbackId'), data: { feedbackId: c.req.param('feedbackId'), fromStatus: result.previousStatus, toStatus: body.status, version: result.version } });
		return c.json({ ok: true, code: 'feedback_status_updated', message: body.status === 'resolved' ? 'Feedback resolved.' : 'Feedback status updated.', payload: { status: body.status, version: result.version } });
	});
	app.get('/v1/admin/feedback/:feedbackId/attachments/:attachmentId', async (c: any) => {
		if (!isPlatformAdministrator(c)) return deny(c);
		const row = await store.first('SELECT storage_key, mime_type, expired_at FROM feedback_attachments WHERE id = ? AND feedback_id = ?', [c.req.param('attachmentId'), c.req.param('feedbackId')]);
		if (!row || row.expired_at) return c.json({ ok: false, code: 'attachment_not_found', message: 'Attachment is unavailable.' }, { status: 404 });
		const object = await feedbackStorage.get(row.storage_key);
		if (!object) return c.json({ ok: false, code: 'attachment_unavailable', message: 'Attachment storage is unavailable.' }, { status: 503 });
		return new Response(object.bytes, { headers: { 'content-type': row.mime_type, 'cache-control': 'private, no-store', 'content-disposition': 'inline' } });
	});
	installFeedbackExportRoutes({ app, store, feedbackStorage });
}

function installFeedbackExportRoutes({ app, store, feedbackStorage }: any) {
	app.post('/v1/admin/feedback/exports', async (c: any) => {
		if (!isPlatformAdministrator(c)) return deny(c);
		const principal = c.get('principal');
		const body = await c.req.json().catch(() => ({}));
		const filters = filtersFrom(body.filters ?? body);
		const { clause, values } = feedbackWhere(filters);
		const selected = Array.isArray(body.feedbackIds) ? body.feedbackIds.filter((id: unknown) => typeof id === 'string').slice(0, 500) : [];
		const selectClause = selected.length ? `WHERE f.id IN (${selected.map(() => '?').join(', ')})` : clause;
		const rows = await store.all(`SELECT f.* FROM feedback_submissions f LEFT JOIN teams t ON t.id = f.team_id LEFT JOIN users u ON u.id = f.submitter_user_id ${selectClause} ORDER BY f.created_at DESC LIMIT 501`, selected.length ? selected : values);
		if (rows.length > 500) return c.json({ ok: false, code: 'export_too_large', message: 'Narrow the export to 500 feedback records or fewer.' }, { status: 400 });
		const id = randomUUID(); const now = new Date().toISOString(); const expiresAt = new Date(Date.now() + 7 * 86400_000).toISOString();
		const includeScreenshots = body.includeScreenshots === true;
		await store.run(`INSERT INTO feedback_exports (id, requested_by_user_id, status, filters_json, include_screenshots, item_count, storage_key, digest, byte_size, source_closure, error, expires_at, completed_at, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?, ?, NULL, NULL, NULL, ?, NULL, ?, NULL, ?, ?)`, [id, principal.id, JSON.stringify(filters), includeScreenshots ? 1 : 0, rows.length, process.env.TREESEED_SOURCE_CLOSURE ?? null, expiresAt, now, now]);
		for (const row of rows) await store.run('INSERT INTO feedback_export_items (export_id, feedback_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [id, row.id, now]);
		const operation = await store.createPlatformOperation({ namespace: 'feedback', operation: 'generate_export', target: 'control_plane_operations_runner', idempotencyKey: `feedback-export:${id}`, input: { exportId: id }, requestedByType: 'user', requestedById: principal.id });
		return c.json({ ok: true, code: 'feedback_export_queued', message: 'Privacy-safe feedback export is being prepared.', operation, payload: { id, status: 'queued', itemCount: rows.length, includeScreenshots, createdAt: now, expiresAt, operationId: operation.id } }, { status: 202 });
	});
	app.get('/v1/admin/feedback/exports/:exportId', async (c: any) => {
		if (!isPlatformAdministrator(c)) return deny(c);
		const row = await store.first('SELECT * FROM feedback_exports WHERE id = ?', [c.req.param('exportId')]);
		return row ? c.json({ ok: true, payload: { id: row.id, status: row.status, itemCount: Number(row.item_count), includeScreenshots: Boolean(row.include_screenshots), createdAt: row.created_at, expiresAt: row.expires_at, completedAt: row.completed_at, error: row.error } }) : c.json({ ok: false, code: 'export_not_found', message: 'Export was not found.' }, { status: 404 });
	});
	app.get('/v1/admin/feedback/exports/:exportId/download', async (c: any) => {
		if (!isPlatformAdministrator(c)) return deny(c);
		const row = await store.first(`SELECT storage_key, expires_at FROM feedback_exports WHERE id = ? AND status = 'ready'`, [c.req.param('exportId')]);
		if (!row || Date.parse(row.expires_at) <= Date.now()) return c.json({ ok: false, code: 'export_expired', message: 'Export is unavailable or expired.' }, { status: 404 });
		const object = await feedbackStorage.get(row.storage_key);
		if (!object) return c.json({ ok: false, code: 'export_unavailable', message: 'Export storage is unavailable.' }, { status: 503 });
		return new Response(object.bytes, { headers: { 'content-type': 'application/zip', 'cache-control': 'private, no-store', 'content-disposition': `attachment; filename="feedback-${c.req.param('exportId')}.zip"` } });
	});
}

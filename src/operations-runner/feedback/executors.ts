import { createFeedbackExportFiles, createStoredZip } from '../../api/feedback/export-bundle.ts';
import { createPrivateObjectStorage } from '../../api/storage/private-object-storage.ts';
import { feedbackWhere, jsonValue } from '../../api/feedback/repository.ts';

async function generateExport(input: any, context: any, store: any, storage: any) {
	const exportId = String(input?.exportId ?? '');
	const row = await store.first('SELECT * FROM feedback_exports WHERE id = ?', [exportId]);
	if (!row || row.status !== 'queued') throw new Error('Queued feedback export was not found.');
	await store.run(`UPDATE feedback_exports SET status = 'running', updated_at = ? WHERE id = ?`, [new Date().toISOString(), exportId]);
	await context.checkpoint({ phase: 'feedback.export.collecting', exportId }, { kind: 'feedback.export.collecting', data: { exportId } });
	const filters = jsonValue(row.filters_json, {});
	const selected = await store.all('SELECT feedback_id FROM feedback_export_items WHERE export_id = ?', [exportId]);
	const selectedIds = selected.map((item: any) => item.feedback_id);
	const { clause, values } = feedbackWhere(filters);
	const selectClause = selectedIds.length ? `WHERE f.id IN (${selectedIds.map(() => '?').join(', ')})` : clause;
	const records = await store.all(`SELECT f.* FROM feedback_submissions f LEFT JOIN teams t ON t.id = f.team_id LEFT JOIN users u ON u.id = f.submitter_user_id ${selectClause} ORDER BY f.created_at DESC LIMIT 501`, selectedIds.length ? selectedIds : values);
	if (records.length > 500) throw new Error('Feedback export exceeds the 500-record limit.');
	for (const record of records) record.feedback_history = await store.all('SELECT from_status, to_status, note, created_at FROM feedback_status_events WHERE feedback_id = ? ORDER BY created_at ASC', [record.id]);
	const includeScreenshots = Boolean(row.include_screenshots);
	const files = createFeedbackExportFiles(records, { createdAt: row.created_at, sourceClosure: row.source_closure ?? undefined, filters, includeScreenshots });
	let screenshotBytes = 0;
	if (includeScreenshots) {
		for (const record of records) {
			const attachments = await store.all(`SELECT id, storage_key FROM feedback_attachments WHERE feedback_id = ? AND mime_type = 'image/png' AND expired_at IS NULL`, [record.id]);
			for (const attachment of attachments) {
				const object = await storage.get(attachment.storage_key);
				if (!object) continue;
				screenshotBytes += object.bytes.length;
				if (screenshotBytes > 50 * 1024 * 1024) throw new Error('Feedback screenshot export exceeds the 50 MB privacy limit.');
				files.push({ name: `screenshots/${record.id}-${attachment.id}.png`, bytes: object.bytes });
			}
		}
	}
	const zip = createStoredZip(files);
	const saved = await storage.put('feedback-exports', zip, 'application/zip');
	const now = new Date().toISOString();
	await store.run(`UPDATE feedback_exports SET status = 'ready', item_count = ?, storage_key = ?, digest = ?, byte_size = ?, completed_at = ?, updated_at = ? WHERE id = ?`, [records.length, saved.key, saved.digest, zip.length, now, now, exportId]);
	for (const record of records) await store.run('INSERT INTO feedback_export_items (export_id, feedback_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [exportId, record.id, now]);
	await store.recordAuditEvent({ eventType: 'feedback.exported', actorType: 'user', actorId: row.requested_by_user_id, targetType: 'feedback_export', targetId: exportId, data: { exportId, itemCount: records.length, includeScreenshots, expiresAt: row.expires_at } });
	await context.checkpoint({ phase: 'feedback.export.ready', exportId }, { kind: 'feedback.export.ready', data: { exportId, itemCount: records.length } });
	return { ok: true, exportId, itemCount: records.length };
}

async function cleanRetention(_input: any, context: any, store: any, storage: any) {
	const now = new Date().toISOString();
	const attachments = await store.all('SELECT id, feedback_id, storage_key FROM feedback_attachments WHERE expires_at IS NOT NULL AND expires_at <= ? AND expired_at IS NULL', [now]);
	const exports = await store.all(`SELECT id, storage_key FROM feedback_exports WHERE expires_at <= ? AND status <> 'expired'`, [now]);
	for (const item of attachments) {
		await storage.delete(item.storage_key);
		await store.run('UPDATE feedback_attachments SET expired_at = ? WHERE id = ?', [now, item.id]);
		await store.recordAuditEvent({ eventType: 'feedback.attachment.expired', actorType: 'service', actorId: context.operation.id, targetType: 'feedback', targetId: item.feedback_id, data: { feedbackId: item.feedback_id, attachmentId: item.id } });
	}
	for (const item of exports) {
		if (item.storage_key) await storage.delete(item.storage_key);
		await store.run(`UPDATE feedback_exports SET status = 'expired', storage_key = NULL, updated_at = ? WHERE id = ?`, [now, item.id]);
	}
	await context.checkpoint({ phase: 'feedback.retention.complete' }, { kind: 'feedback.retention.complete', data: { attachmentCount: attachments.length, exportCount: exports.length } });
	return { ok: true, attachmentCount: attachments.length, exportCount: exports.length };
}

export function createFeedbackExecutors(options: any) {
	const store = options.controlPlaneStore;
	const storage = createPrivateObjectStorage({ adapter: options.feedbackStorage });
	return [
		{ namespace: 'feedback', operation: 'generate_export', async run(input: any, context: any) {
			if (!store) throw new Error('Feedback export requires a control-plane store.');
			try { return await generateExport(input, context, store, storage); }
			catch (error) {
				const exportId = String(input?.exportId ?? '');
				await store.run(`UPDATE feedback_exports SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`, [error instanceof Error ? error.message : 'Export failed.', new Date().toISOString(), exportId]);
				throw error;
			}
		} },
		{ namespace: 'feedback', operation: 'retention_cleanup', async run(input: any, context: any) { if (!store) throw new Error('Feedback retention requires a control-plane store.'); return cleanRetention(input, context, store, storage); } },
	];
}

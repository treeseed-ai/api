import assert from 'node:assert/strict';
import { createLocalPrivateObjectStorage } from '../../src/api/storage/private-object-storage.ts';
import { createControlPlanePostgresDatabase } from '../../src/api/support/control-plane-postgres.ts';

type RunValue = { value?: Record<string, unknown>; device?: string };

const phase = process.argv[2] ?? 'verify';
const environment = process.env.TREESEED_ACCEPTANCE_ENVIRONMENT ?? '';
assert.equal(environment, 'local', 'Feedback guarantee verification is restricted to the local acceptance environment.');
const runState = JSON.parse(process.env.TREESEED_GUARANTEE_RUN_STATE ?? '{}') as Record<string, RunValue>;
const messages = [...new Set(Object.entries(runState)
	.filter(([key, entry]) => key.startsWith('feedback.submitted@') && entry.value?.message)
	.map(([, entry]) => String(entry.value!.message)))];
assert.ok(messages.length > 0, 'Run state contains no UI-created feedback identifiers.');
const allMessages = [...messages, ...messages.map((message) => message.replace(/^Feedback run/u, 'Feedback text run'))];
const databaseUrl = process.env.TREESEED_DATABASE_URL ?? 'postgresql://treeseed:treeseed-local-dev@127.0.0.1:54329/treeseed_api';
const database = createControlPlanePostgresDatabase(databaseUrl);
const storage = createLocalPrivateObjectStorage();
const verified: Array<Record<string, unknown>> = [];

try {
	for (const message of allMessages) {
		const row = await database.prepare('SELECT * FROM feedback_submissions WHERE message = ? LIMIT 1').bind(message).first();
		assert.ok(row?.id, `UI-created feedback was not persisted: ${message}`);
		const feedbackId = String(row.id);
		const attachmentRows = await database.prepare('SELECT id, storage_key, digest, redaction_version, expired_at FROM feedback_attachments WHERE feedback_id = ?').bind(feedbackId).all();
		if (message.startsWith('Feedback text run')) assert.equal(attachmentRows.results.length, 0, 'Text-only feedback unexpectedly retained an attachment.');
		else {
			assert.equal(attachmentRows.results.length, 1, 'Screenshot feedback must retain one private capture.');
			assert.equal(attachmentRows.results[0]?.redaction_version, 'treeseed.feedback-capture/v3');
			assert.ok(await storage.get(String(attachmentRows.results[0]?.storage_key)), 'Private screenshot bytes are unavailable.');
		}
		const submittedAudit = await database.prepare(`SELECT data_json FROM audit_events WHERE event_type = 'feedback.submitted' AND target_id = ? LIMIT 1`).bind(feedbackId).first();
		assert.ok(submittedAudit, 'Correlated metadata-only submission audit is missing.');
		assert.equal(String(submittedAudit.data_json ?? '').includes(message), false, 'Feedback message leaked into audit storage.');
		if (!message.startsWith('Feedback text run')) {
			assert.equal(row.status, 'resolved', 'Managed feedback did not finish resolved.');
			const history = await database.prepare('SELECT to_status, note FROM feedback_status_events WHERE feedback_id = ? ORDER BY created_at ASC').bind(feedbackId).all();
			assert.deepEqual(history.results.map((event) => event.to_status), ['triaged', 'in_progress', 'resolved', 'in_progress', 'resolved']);
			assert.ok(history.results.filter((event) => event.to_status === 'resolved' || event.to_status === 'in_progress').some((event) => String(event.note ?? '').includes('guarantee')));
			const exported = await database.prepare(`SELECT e.id, e.status, e.storage_key FROM feedback_exports e JOIN feedback_export_items i ON i.export_id = e.id WHERE i.feedback_id = ? ORDER BY e.created_at DESC LIMIT 1`).bind(feedbackId).first();
			assert.equal(exported?.status, 'ready', 'Run feedback export did not complete through the operations runner.');
			assert.ok(await storage.get(String(exported?.storage_key)), 'Privacy-safe export bytes are unavailable.');
		}
		verified.push({ feedbackId, message, attachmentCount: attachmentRows.results.length });
	}

	if (phase === 'cleanup') {
		const ids = verified.map((item) => String(item.feedbackId));
		const attachmentKeys = await database.prepare(`SELECT storage_key FROM feedback_attachments WHERE feedback_id = ANY(?::text[])`).bind(ids).all();
		const exports = await database.prepare(`SELECT DISTINCT e.id, e.storage_key FROM feedback_exports e JOIN feedback_export_items i ON i.export_id = e.id WHERE i.feedback_id = ANY(?::text[])`).bind(ids).all();
		for (const object of [...attachmentKeys.results, ...exports.results]) if (object.storage_key) await storage.delete(String(object.storage_key));
		const exportIds = exports.results.map((item) => String(item.id));
		if (exportIds.length) {
			const operations = await database.prepare(`SELECT id FROM platform_operations WHERE namespace = 'feedback' AND operation = 'generate_export' AND input_json::jsonb->>'exportId' = ANY(?::text[])`).bind(exportIds).all();
			const operationIds = operations.results.map((item) => String(item.id));
			if (operationIds.length) await database.prepare('DELETE FROM platform_operation_events WHERE operation_id = ANY(?::text[])').bind(operationIds).run();
			await database.prepare(`DELETE FROM platform_operations WHERE namespace = 'feedback' AND operation = 'generate_export' AND input_json::jsonb->>'exportId' = ANY(?::text[])`).bind(exportIds).run();
			await database.prepare('DELETE FROM audit_events WHERE target_type = ? AND target_id = ANY(?::text[])').bind('feedback_export', exportIds).run();
			await database.prepare('DELETE FROM feedback_export_items WHERE export_id = ANY(?::text[])').bind(exportIds).run();
			await database.prepare('DELETE FROM feedback_exports WHERE id = ANY(?::text[])').bind(exportIds).run();
		}
		await database.prepare('DELETE FROM feedback_status_events WHERE feedback_id = ANY(?::text[])').bind(ids).run();
		await database.prepare('DELETE FROM feedback_attachments WHERE feedback_id = ANY(?::text[])').bind(ids).run();
		await database.prepare('DELETE FROM audit_events WHERE target_type = ? AND target_id = ANY(?::text[])').bind('feedback', ids).run();
		await database.prepare('DELETE FROM feedback_submissions WHERE id = ANY(?::text[])').bind(ids).run();
		const remaining = await database.prepare('SELECT COUNT(*)::integer AS count FROM feedback_submissions WHERE id = ANY(?::text[])').bind(ids).first();
		assert.equal(remaining?.count, 0, 'Run-owned feedback remains after cleanup.');
	}
} finally {
	await database.close();
}

process.stdout.write(`${JSON.stringify({ ok: true, phase, verified }, null, 2)}\n`);

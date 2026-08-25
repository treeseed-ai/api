import { createPrivateObjectStorage } from '../../api/storage/private-object-storage.ts';

export function createFeedbackRetentionExecutor(options: any) {
	const store = options.controlPlaneStore;
	const storage = createPrivateObjectStorage({ adapter: options.feedbackStorage });
	return {
		namespace: 'feedback', operation: 'retention_cleanup',
		async run(_input: unknown, context: any) {
			if (!store) throw new Error('Feedback retention requires a control-plane store.');
			const now = new Date().toISOString();
			const attachments = await store.all('SELECT id, feedback_id, storage_key FROM feedback_attachments WHERE expires_at IS NOT NULL AND expires_at <= ? AND expired_at IS NULL', [now]);
			for (const item of attachments) {
				await storage.delete(item.storage_key);
				await store.run('UPDATE feedback_attachments SET expired_at = ? WHERE id = ?', [now, item.id]);
				await store.recordAuditEvent({ eventType: 'feedback.attachment.expired', actorType: 'service', actorId: context.operation.id, targetType: 'feedback', targetId: item.feedback_id, data: { feedbackId: item.feedback_id, attachmentId: item.id } });
			}
			await context.checkpoint({ phase: 'feedback.retention.complete' }, { kind: 'feedback.retention.complete', data: { attachmentCount: attachments.length } });
			return { attachmentCount: attachments.length };
		},
	};
}

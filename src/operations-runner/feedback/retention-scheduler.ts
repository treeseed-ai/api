export class FeedbackRetentionScheduler {
	private lastAttemptAt = 0;

	constructor(private readonly store: any, private readonly intervalMs = 60 * 60_000) {}

	async runIfDue(now = Date.now()) {
		if (now - this.lastAttemptAt < this.intervalMs) return { scheduled: false };
		this.lastAttemptAt = now;
		const day = new Date(now).toISOString().slice(0, 10);
		const operation = await this.store.createPlatformOperation({
			namespace: 'feedback',
			operation: 'retention_cleanup',
			target: 'control_plane_operations_runner',
			idempotencyKey: `feedback-retention:${day}`,
			input: { scheduledAt: new Date(now).toISOString() },
			requestedByType: 'service',
			requestedById: 'feedback-retention-scheduler',
		});
		return { scheduled: true, operationId: operation.id };
	}
}

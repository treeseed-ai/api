import { COMMERCE_WEBHOOK_EVENT_STATUS_SET,enumValue,isoNow,MarketControlPlaneStore,serializeCommerceWebhookEvent } from "../../../../persistence/store.ts";
export async function updateCommerceWebhookEventStatusMethod(this: MarketControlPlaneStore, eventId, input: any = {}) {
    await this.ensureInitialized();
    const existing = serializeCommerceWebhookEvent(await this.first(`SELECT * FROM commerce_webhook_events WHERE id = ? LIMIT 1`, [eventId]));
    if (!existing)
        return null;
    const status = enumValue(input.status, COMMERCE_WEBHOOK_EVENT_STATUS_SET, existing.status);
    const processedAt = ['processed', 'ignored', 'failed'].includes(status) ? isoNow() : existing.processedAt;
    await this.run(`UPDATE commerce_webhook_events
			 SET status = ?, related_order_id = ?, related_subscription_id = ?, processing_error = ?, processed_at = ?, updated_at = ?
			 WHERE id = ?`, [
        status,
        input.relatedOrderId === undefined ? existing.relatedOrderId : input.relatedOrderId,
        input.relatedSubscriptionId === undefined ? existing.relatedSubscriptionId : input.relatedSubscriptionId,
        input.processingError === undefined ? existing.processingError : input.processingError,
        processedAt,
        isoNow(),
        eventId,
    ]);
    return serializeCommerceWebhookEvent(await this.first(`SELECT * FROM commerce_webhook_events WHERE id = ?`, [eventId]));
}

import { randomUUID } from 'node:crypto';
import { COMMERCE_STRIPE_ENVIRONMENT_SET,COMMERCE_WEBHOOK_EVENT_STATUS_SET,enumValue,isoNow,MarketControlPlaneStore,serializeCommerceWebhookEvent } from "../../../../persistence/store.ts";
export async function recordCommerceWebhookEventMethod(this: MarketControlPlaneStore, input: any = {}) {
    await this.ensureInitialized();
    const existing = serializeCommerceWebhookEvent(await this.first(`SELECT * FROM commerce_webhook_events WHERE provider = ? AND environment = ? AND event_id = ? LIMIT 1`, [input.provider ?? 'stripe', input.environment ?? 'test', input.eventId]));
    if (existing)
        return existing;
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    await this.run(`INSERT INTO commerce_webhook_events (
				id, provider, environment, event_id, event_type, connected_account_id, status, object_type, object_id,
				related_order_id, related_subscription_id, payload_hash, processing_error, received_at, processed_at,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        input.provider ?? 'stripe',
        enumValue(input.environment, COMMERCE_STRIPE_ENVIRONMENT_SET, 'test'),
        input.eventId,
        input.eventType,
        input.connectedAccountId ?? null,
        enumValue(input.status, COMMERCE_WEBHOOK_EVENT_STATUS_SET, 'received'),
        input.objectType ?? null,
        input.objectId ?? null,
        input.relatedOrderId ?? null,
        input.relatedSubscriptionId ?? null,
        input.payloadHash,
        input.processingError ?? null,
        input.receivedAt ?? timestamp,
        input.processedAt ?? null,
        timestamp,
        timestamp,
    ]);
    await this.recordCommerceGovernanceEvent({
        actorType: 'system',
        action: 'commerce_webhook.received',
        objectType: 'commerce_webhook_event',
        objectId: id,
        nextState: 'received',
        evidence: {
            provider: input.provider ?? 'stripe',
            eventId: input.eventId,
            eventType: input.eventType,
            connectedAccountId: input.connectedAccountId ?? null,
        },
    });
    return serializeCommerceWebhookEvent(await this.first(`SELECT * FROM commerce_webhook_events WHERE id = ?`, [id]));
}

import { randomUUID } from 'node:crypto';
import { COMMERCE_FULFILLMENT_EVENT_TYPE_SET,COMMERCE_FULFILLMENT_STATUS_SET,enumValue,isoNow,MarketControlPlaneStore,serializeCommerceFulfillmentEvent } from "../../../../persistence/store.ts";
export async function createCommerceFulfillmentEventMethod(this: MarketControlPlaneStore, input: any = {}) {
    await this.ensureInitialized();
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    await this.run(`INSERT INTO commerce_fulfillment_events (
				id, order_id, order_item_id, entitlement_id, vendor_id, seller_team_id, product_id, product_version_id,
				catalog_item_id, catalog_artifact_version_id, event_type, status, artifact_refs_json, delivery_refs_json,
				message, actor_type, actor_id, metadata_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        input.orderId,
        input.orderItemId ?? null,
        input.entitlementId ?? null,
        input.vendorId,
        input.sellerTeamId,
        input.productId,
        input.productVersionId ?? null,
        input.catalogItemId ?? null,
        input.catalogArtifactVersionId ?? null,
        enumValue(input.eventType, COMMERCE_FULFILLMENT_EVENT_TYPE_SET, 'manual_status'),
        enumValue(input.status, COMMERCE_FULFILLMENT_STATUS_SET, 'pending'),
        JSON.stringify(input.artifactRefs ?? []),
        JSON.stringify(input.deliveryRefs ?? []),
        input.message ?? null,
        input.actorType ?? 'user',
        input.actorId ?? 'system',
        JSON.stringify(input.metadata ?? {}),
        timestamp,
    ]);
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? 'user',
        actorId: input.actorId ?? null,
        action: input.eventType === 'artifact_delivered' ? 'commerce_fulfillment.artifact_delivered' : 'commerce_fulfillment.artifact_released',
        objectType: 'commerce_fulfillment_event',
        objectId: id,
        nextState: input.status ?? 'pending',
        relatedOrderId: input.orderId,
        relatedProductId: input.productId,
        relatedTeamId: input.sellerTeamId,
    });
    return serializeCommerceFulfillmentEvent(await this.first(`SELECT * FROM commerce_fulfillment_events WHERE id = ?`, [id]));
}

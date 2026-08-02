import { randomUUID } from 'node:crypto';
import { COMMERCE_ENTITLEMENT_STATUS_SET,enumValue,isoNow,MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function createCommerceEntitlementMethod(this: MarketControlPlaneStore, input: any = {}) {
    await this.ensureInitialized();
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    await this.run(`INSERT INTO commerce_entitlements (
				id, buyer_team_id, buyer_user_id, seller_team_id, product_id, product_version_id, offer_id, order_id,
				order_item_id, subscription_id, status, access_scope_json, starts_at, ends_at, renewal_state,
				fulfillment_artifact_refs_json, project_id, catalog_item_id, ownership_snapshot_json, metadata_json,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        input.buyerTeamId ?? null,
        input.buyerUserId ?? null,
        input.sellerTeamId,
        input.productId,
        input.productVersionId ?? null,
        input.offerId,
        input.orderId ?? null,
        input.orderItemId ?? null,
        input.subscriptionId ?? null,
        enumValue(input.status, COMMERCE_ENTITLEMENT_STATUS_SET, 'pending'),
        JSON.stringify(input.accessScope ?? {}),
        input.startsAt ?? timestamp,
        input.endsAt ?? null,
        input.renewalState ?? 'none',
        JSON.stringify(input.fulfillmentArtifactRefs ?? []),
        input.projectId ?? null,
        input.catalogItemId ?? null,
        JSON.stringify(input.ownershipSnapshot ?? {}),
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        timestamp,
    ]);
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? 'system',
        actorId: input.actorId ?? null,
        action: 'commerce_entitlement.created',
        objectType: 'commerce_entitlement',
        objectId: id,
        nextState: input.status ?? 'pending',
        relatedOrderId: input.orderId ?? null,
        relatedOfferId: input.offerId,
        relatedProductId: input.productId,
        relatedTeamId: input.buyerTeamId ?? input.sellerTeamId,
    });
    return this.getCommerceEntitlement(id);
}

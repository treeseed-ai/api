import { COMMERCE_STRIPE_SYNC_STATUS_SET,enumValue,isoNow,MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function updateCommerceOfferStripeProductSyncMethod(this: MarketControlPlaneStore, offerId, input: any = {}) {
    await this.ensureInitialized();
    const existing = await this.getCommerceOffer(offerId);
    if (!existing)
        return null;
    const timestamp = isoNow();
    const nextStatus = enumValue(input.stripeProductStatus ?? input.status, COMMERCE_STRIPE_SYNC_STATUS_SET, existing.stripeProductStatus ?? 'not_synced');
    await this.run(`UPDATE commerce_offers
			 SET stripe_product_id = ?, stripe_product_status = ?, stripe_product_synced_at = ?, stripe_product_sync_error = ?,
			     stripe_product_metadata_json = ?, updated_at = ?
			 WHERE id = ?`, [
        input.stripeProductId === undefined ? existing.stripeProductId : input.stripeProductId,
        nextStatus,
        input.stripeProductSyncedAt === undefined ? (nextStatus === 'synced' ? timestamp : existing.stripeProductSyncedAt) : input.stripeProductSyncedAt,
        input.stripeProductSyncError === undefined ? null : input.stripeProductSyncError,
        JSON.stringify(input.stripeProductMetadata ?? existing.stripeProductMetadata ?? {}),
        timestamp,
        offerId,
    ]);
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? 'system',
        actorId: input.actorId ?? null,
        action: input.action ?? (nextStatus === 'blocked'
            ? 'commerce_offer.stripe_product.sync_blocked'
            : nextStatus === 'drifted'
                ? 'commerce_offer.stripe_product.drifted'
                : nextStatus === 'failed'
                    ? 'commerce_offer.stripe_product.failed'
                    : 'commerce_offer.stripe_product.synced'),
        objectType: 'commerce_offer',
        objectId: offerId,
        priorState: existing.stripeProductStatus ?? 'not_synced',
        nextState: nextStatus,
        reason: input.reason ?? null,
        evidence: input.evidence ?? {},
        relatedOfferId: offerId,
        relatedProductId: existing.productId,
        relatedTeamId: existing.sellerTeamId,
    });
    return this.getCommerceOffer(offerId);
}

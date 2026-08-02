import { COMMERCE_STRIPE_SYNC_STATUS_SET,enumValue,isoNow,MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function updateCommercePriceStripeSyncMethod(this: MarketControlPlaneStore, priceId, input: any = {}) {
    await this.ensureInitialized();
    const existing = await this.getCommercePrice(priceId);
    if (!existing)
        return null;
    const offer = await this.getCommerceOffer(existing.offerId);
    const timestamp = isoNow();
    const nextStatus = enumValue(input.stripeSyncStatus ?? input.status, COMMERCE_STRIPE_SYNC_STATUS_SET, existing.stripeSyncStatus ?? 'not_synced');
    await this.run(`UPDATE commerce_prices
			 SET stripe_product_id = ?, stripe_price_id = ?, stripe_lookup_key = ?, stripe_sync_status = ?, stripe_synced_at = ?,
			     stripe_sync_error = ?, stripe_metadata_json = ?, updated_at = ?
			 WHERE id = ?`, [
        input.stripeProductId === undefined ? existing.stripeProductId : input.stripeProductId,
        input.stripePriceId === undefined ? existing.stripePriceId : input.stripePriceId,
        input.stripeLookupKey === undefined ? existing.stripeLookupKey : input.stripeLookupKey,
        nextStatus,
        input.stripeSyncedAt === undefined ? (nextStatus === 'synced' ? timestamp : existing.stripeSyncedAt) : input.stripeSyncedAt,
        input.stripeSyncError === undefined ? null : input.stripeSyncError,
        JSON.stringify(input.stripeMetadata ?? existing.stripeMetadata ?? {}),
        timestamp,
        priceId,
    ]);
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? 'system',
        actorId: input.actorId ?? null,
        action: input.action ?? (nextStatus === 'blocked'
            ? 'commerce_price.stripe_price.sync_blocked'
            : nextStatus === 'drifted'
                ? 'commerce_price.stripe_price.drifted'
                : nextStatus === 'failed'
                    ? 'commerce_price.stripe_price.failed'
                    : 'commerce_price.stripe_price.synced'),
        objectType: 'commerce_price',
        objectId: priceId,
        priorState: existing.stripeSyncStatus ?? 'not_synced',
        nextState: nextStatus,
        reason: input.reason ?? null,
        evidence: input.evidence ?? {},
        relatedOfferId: existing.offerId,
        relatedProductId: offer?.productId ?? null,
        relatedTeamId: offer?.sellerTeamId ?? null,
    });
    return this.getCommercePrice(priceId);
}

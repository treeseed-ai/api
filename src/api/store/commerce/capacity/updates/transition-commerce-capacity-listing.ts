import { COMMERCE_CAPACITY_LISTING_STATUS_SET,enumValue,isoNow,MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function transitionCommerceCapacityListingMethod(this: MarketControlPlaneStore, listingId, nextState, input: any = {}, capacity) {
    await this.ensureInitialized();
    const existing = await this.getCommerceCapacityListing(listingId);
    if (!existing)
        return null;
    const product = await this.getCommerceProduct(existing.productId);
    await this.ensureCommerceCapacityListingEligibility(product, input, capacity);
    const state = enumValue(nextState, COMMERCE_CAPACITY_LISTING_STATUS_SET, existing.status);
    await this.run(`UPDATE commerce_capacity_listings SET status = ?, updated_at = ? WHERE id = ?`, [state, isoNow(), listingId]);
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? 'user',
        actorId: input.actorId ?? null,
        action: input.action ?? `commerce_capacity_listing.${state}`,
        objectType: 'commerce_capacity_listing',
        objectId: listingId,
        priorState: existing.status,
        nextState: state,
        reason: input.reason ?? null,
        evidence: input.evidence ?? {},
        relatedProductId: existing.productId,
        relatedTeamId: existing.sellerTeamId,
    });
    return this.getCommerceCapacityListing(listingId);
}

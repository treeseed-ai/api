import { isoNow,MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function approveCommerceOfferMethod(this: MarketControlPlaneStore, offerId, input: any = {}) {
    await this.ensureInitialized();
    const existing = await this.getCommerceOffer(offerId);
    if (!existing)
        return null;
    const product = await this.getCommerceProduct(existing.productId);
    const vendor = await this.getCommerceVendor(existing.vendorId);
    if (product?.status !== 'approved' || vendor?.status !== 'approved') {
        const error: Error & Record<string, any> = new Error('Product and vendor must be approved before offer approval.');
        error.status = 409;
        throw error;
    }
    await this.run(`UPDATE commerce_offers SET status = ?, updated_at = ? WHERE id = ?`, ['approved', isoNow(), offerId]);
    if (product.catalogItemId) {
        const catalogItem = await this.getCatalogItem(product.catalogItemId);
        if (catalogItem) {
            await this.upsertCatalogItem(product.sellerTeamId, {
                ...catalogItem,
                offerMode: existing.mode,
                metadata: {
                    ...(catalogItem.metadata ?? {}),
                    primaryCommerceOfferId: offerId,
                },
            });
        }
    }
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? 'operator',
        actorId: input.actorId ?? null,
        action: 'offer.approve',
        objectType: 'commerce_offer',
        objectId: offerId,
        priorState: existing.status,
        nextState: 'approved',
        reason: input.reason ?? null,
        evidence: input.evidence ?? {},
        relatedOfferId: offerId,
        relatedProductId: existing.productId,
        relatedTeamId: existing.sellerTeamId,
    });
    return this.getCommerceOffer(offerId);
}

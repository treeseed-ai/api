import { isoNow,MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function approveCommerceProductMethod(this: MarketControlPlaneStore, productId, input: any = {}) {
    const existing = await this.getCommerceProduct(productId);
    if (!existing)
        return null;
    const vendor = await this.getCommerceVendor(existing.vendorId);
    if (vendor?.status !== 'approved') {
        const error: Error & Record<string, any> = new Error('Vendor must be approved before product approval.');
        error.status = 409;
        throw error;
    }
    const approvedOffer = (await this.listCommerceOffers({ productId, status: 'approved' }))[0] ?? null;
    const catalogItem = await this.upsertCatalogItem(existing.sellerTeamId, {
        id: existing.catalogItemId ?? undefined,
        kind: existing.kind,
        slug: existing.slug,
        title: existing.title,
        summary: existing.summary,
        visibility: existing.visibility,
        listingEnabled: existing.visibility === 'public',
        offerMode: approvedOffer?.mode ?? 'private',
        metadata: {
            ...(existing.metadata ?? {}),
            commerceProductId: existing.id,
            commerceVendorId: existing.vendorId,
            ownershipModel: existing.ownershipModel,
        },
    });
    await this.run(`UPDATE commerce_products SET status = ?, catalog_item_id = ?, updated_at = ? WHERE id = ?`, ['approved', catalogItem.id, isoNow(), productId]);
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? 'operator',
        actorId: input.actorId ?? null,
        action: 'product.approve',
        objectType: 'commerce_product',
        objectId: productId,
        priorState: existing.status,
        nextState: 'approved',
        reason: input.reason ?? null,
        evidence: input.evidence ?? {},
        relatedProductId: productId,
        relatedTeamId: existing.sellerTeamId,
    });
    return this.getCommerceProduct(productId);
}

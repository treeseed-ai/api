import { COMMERCE_CAPACITY_LISTING_OFFER_MODES,COMMERCE_FULFILLMENT_MODE_SET,COMMERCE_OFFER_MODE_SET,enumValue,isoNow,MarketControlPlaneStore,stringValue } from "../../../../persistence/store.ts";
export async function updateCommerceOfferMethod(this: MarketControlPlaneStore, offerId, input: any = {}) {
    await this.ensureInitialized();
    const existing = await this.getCommerceOffer(offerId);
    if (!existing)
        return null;
    const product = await this.getCommerceProduct(existing.productId);
    if (!['draft', 'rejected'].includes(existing.status)) {
        const error: Error & Record<string, any> = new Error('Only draft or rejected offers can be edited.');
        error.status = 409;
        throw error;
    }
    const nextMode = enumValue(input.mode, COMMERCE_OFFER_MODE_SET, existing.mode);
    if (product?.kind === 'capacity_listing' && !COMMERCE_CAPACITY_LISTING_OFFER_MODES.has(nextMode)) {
        const error: Error & Record<string, any> = new Error('Capacity listing products only support contact, private, or external discovery offers in Phase 9.');
        error.status = 409;
        throw error;
    }
    await this.run(`UPDATE commerce_offers
			 SET mode = ?, product_version_id = ?, title = ?, terms_summary = ?, access_scope_json = ?, support_scope_json = ?,
			     fulfillment_mode = ?, starts_at = ?, ends_at = ?, metadata_json = ?, updated_at = ?
			WHERE id = ?`, [
        nextMode,
        input.productVersionId === undefined ? existing.productVersionId : input.productVersionId,
        stringValue(input.title, existing.title),
        input.termsSummary === undefined ? existing.termsSummary : input.termsSummary,
        JSON.stringify(input.accessScope ?? existing.accessScope ?? {}),
        JSON.stringify(input.supportScope ?? existing.supportScope ?? {}),
        enumValue(input.fulfillmentMode, COMMERCE_FULFILLMENT_MODE_SET, existing.fulfillmentMode),
        input.startsAt === undefined ? existing.startsAt : input.startsAt,
        input.endsAt === undefined ? existing.endsAt : input.endsAt,
        JSON.stringify(input.metadata ?? existing.metadata ?? {}),
        isoNow(),
        offerId,
    ]);
    return this.getCommerceOffer(offerId);
}

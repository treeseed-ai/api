import { randomUUID } from 'node:crypto';
import { COMMERCE_CAPACITY_LISTING_OFFER_MODES,COMMERCE_FULFILLMENT_MODE_SET,COMMERCE_OFFER_MODE_SET,enumValue,isoNow,MarketControlPlaneStore,requireEnumValue,stringValue } from "../../../../persistence/store.ts";
export async function createCommerceOfferMethod(this: MarketControlPlaneStore, input: any = {}) {
    await this.ensureInitialized();
    const product = await this.getCommerceProduct(input.productId);
    if (!product)
        return null;
    const mode = requireEnumValue(input.mode, COMMERCE_OFFER_MODE_SET, 'commerce offer mode');
    if (product.kind === 'capacity_listing' && !COMMERCE_CAPACITY_LISTING_OFFER_MODES.has(mode)) {
        const error: Error & Record<string, any> = new Error('Capacity listing products only support contact, private, or external discovery offers in Phase 9.');
        error.status = 409;
        throw error;
    }
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    await this.run(`INSERT INTO commerce_offers (
				id, product_id, product_version_id, vendor_id, seller_team_id, mode, status, title, terms_summary,
				access_scope_json, support_scope_json, fulfillment_mode, active_price_id, stripe_product_id, stripe_product_status,
				stripe_product_synced_at, stripe_product_sync_error, stripe_product_metadata_json, starts_at, ends_at, metadata_json,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        product.id,
        input.productVersionId ?? null,
        product.vendorId,
        product.sellerTeamId,
        mode,
        'draft',
        stringValue(input.title, product.title),
        input.termsSummary ?? null,
        JSON.stringify(input.accessScope ?? {}),
        JSON.stringify(input.supportScope ?? {}),
        enumValue(input.fulfillmentMode, COMMERCE_FULFILLMENT_MODE_SET, 'automatic'),
        null,
        null,
        'not_synced',
        null,
        null,
        '{}',
        input.startsAt ?? null,
        input.endsAt ?? null,
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        timestamp,
    ]);
    return this.getCommerceOffer(id);
}

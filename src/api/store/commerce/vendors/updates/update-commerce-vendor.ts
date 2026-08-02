import { COMMERCE_GOVERNANCE_STATE_SET,COMMERCE_VENDOR_TRUST_LEVEL_SET,enumValue,isoNow,MarketControlPlaneStore,safeIdPart,stringValue } from "../../../../persistence/store.ts";
export async function updateCommerceVendorMethod(this: MarketControlPlaneStore, vendorId, input: any = {}) {
    await this.ensureInitialized();
    const existing = await this.getCommerceVendor(vendorId);
    if (!existing)
        return null;
    const timestamp = isoNow();
    await this.run(`UPDATE commerce_vendors
			 SET display_name = ?, slug = ?, status = ?, trust_level = ?, professional_entitlement_id = ?, stripe_account_id = ?,
			     sales_enabled = ?, service_sales_enabled = ?, capacity_listings_enabled = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`, [
        stringValue(input.displayName, existing.displayName),
        safeIdPart(input.slug ?? existing.slug, existing.slug),
        enumValue(input.status, COMMERCE_GOVERNANCE_STATE_SET, existing.status),
        enumValue(input.trustLevel, COMMERCE_VENDOR_TRUST_LEVEL_SET, existing.trustLevel),
        input.professionalEntitlementId === undefined ? existing.professionalEntitlementId : input.professionalEntitlementId,
        input.stripeAccountId === undefined ? existing.stripeAccountId : input.stripeAccountId,
        input.salesEnabled === undefined ? (existing.salesEnabled ? 1 : 0) : (input.salesEnabled === true ? 1 : 0),
        input.serviceSalesEnabled === undefined ? (existing.serviceSalesEnabled ? 1 : 0) : (input.serviceSalesEnabled === true ? 1 : 0),
        input.capacityListingsEnabled === undefined ? (existing.capacityListingsEnabled ? 1 : 0) : (input.capacityListingsEnabled === true ? 1 : 0),
        JSON.stringify(input.metadata ?? existing.metadata ?? {}),
        timestamp,
        vendorId,
    ]);
    return this.getCommerceVendor(vendorId);
}

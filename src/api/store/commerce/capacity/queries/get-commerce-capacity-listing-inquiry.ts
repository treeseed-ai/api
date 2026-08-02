import { MarketControlPlaneStore,serializeCommerceCapacityListingInquiry } from "../../../../persistence/store.ts";
export async function getCommerceCapacityListingInquiryMethod(this: MarketControlPlaneStore, inquiryId, options: any = {}) {
    await this.ensureInitialized();
    return serializeCommerceCapacityListingInquiry(await this.first(`SELECT * FROM commerce_capacity_listing_inquiries WHERE id = ? LIMIT 1`, [inquiryId]), options);
}

import { MarketControlPlaneStore,serializeCommerceCapacityListing } from "../../../../persistence/store.ts";
export async function getCommerceCapacityListingMethod(this: MarketControlPlaneStore, listingId, options: any = {}) {
    await this.ensureInitialized();
    return serializeCommerceCapacityListing(await this.first(`SELECT * FROM commerce_capacity_listings WHERE id = ? LIMIT 1`, [listingId]), options);
}

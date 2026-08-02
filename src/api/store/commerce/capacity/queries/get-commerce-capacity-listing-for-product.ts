import { MarketControlPlaneStore,serializeCommerceCapacityListing } from "../../../../persistence/store.ts";
export async function getCommerceCapacityListingForProductMethod(this: MarketControlPlaneStore, productId, options: any = {}) {
    await this.ensureInitialized();
    return serializeCommerceCapacityListing(await this.first(`SELECT * FROM commerce_capacity_listings WHERE product_id = ? LIMIT 1`, [productId]), options);
}

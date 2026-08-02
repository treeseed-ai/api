import { MarketControlPlaneStore,serializeCommerceVendor } from "../../../../persistence/store.ts";
export async function getCommerceVendorMethod(this: MarketControlPlaneStore, vendorId) {
    await this.ensureInitialized();
    return serializeCommerceVendor(await this.first(`SELECT * FROM commerce_vendors WHERE id = ? LIMIT 1`, [vendorId]));
}

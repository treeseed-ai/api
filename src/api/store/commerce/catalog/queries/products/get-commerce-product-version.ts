import { MarketControlPlaneStore,serializeCommerceProductVersion } from "../../../../../persistence/store.ts";
export async function getCommerceProductVersionMethod(this: MarketControlPlaneStore, productId, version) {
    await this.ensureInitialized();
    return serializeCommerceProductVersion(await this.first(`SELECT * FROM commerce_product_versions WHERE product_id = ? AND (id = ? OR version = ?) LIMIT 1`, [productId, version, version]));
}

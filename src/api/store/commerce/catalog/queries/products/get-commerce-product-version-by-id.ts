import { MarketControlPlaneStore,serializeCommerceProductVersion } from "../../../../../persistence/store.ts";
export async function getCommerceProductVersionByIdMethod(this: MarketControlPlaneStore, versionId) {
    await this.ensureInitialized();
    return serializeCommerceProductVersion(await this.first(`SELECT * FROM commerce_product_versions WHERE id = ? LIMIT 1`, [versionId]));
}

import { MarketControlPlaneStore,serializeCommerceProductVersion } from "../../../../../persistence/store.ts";
export async function listCommerceProductVersionsMethod(this: MarketControlPlaneStore, productId) {
    await this.ensureInitialized();
    const rows = await this.all(`SELECT * FROM commerce_product_versions WHERE product_id = ? ORDER BY created_at DESC`, [productId]);
    return rows.map(serializeCommerceProductVersion);
}

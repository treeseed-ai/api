import { MarketControlPlaneStore,serializeCommerceProduct } from "../../../../../persistence/store.ts";
export async function getCommerceProductMethod(this: MarketControlPlaneStore, productId) {
    await this.ensureInitialized();
    return serializeCommerceProduct(await this.first(`SELECT * FROM commerce_products WHERE id = ? LIMIT 1`, [productId]));
}

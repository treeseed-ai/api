import { MarketControlPlaneStore,serializeCommerceCart } from "../../../../persistence/store.ts";
export async function getCommerceCartMethod(this: MarketControlPlaneStore, cartId) {
    await this.ensureInitialized();
    return serializeCommerceCart(await this.first(`SELECT * FROM commerce_carts WHERE id = ? LIMIT 1`, [cartId]));
}

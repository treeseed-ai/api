import { MarketControlPlaneStore,serializeCommerceCartItem } from "../../../../persistence/store.ts";
export async function listCommerceCartItemsMethod(this: MarketControlPlaneStore, cartId) {
    await this.ensureInitialized();
    const rows = await this.all(`SELECT * FROM commerce_cart_items WHERE cart_id = ? ORDER BY created_at ASC`, [cartId]);
    return rows.map(serializeCommerceCartItem);
}

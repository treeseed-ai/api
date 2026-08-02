import { isoNow,MarketControlPlaneStore,serializeCommerceCartItem } from "../../../../persistence/store.ts";
export async function removeCommerceCartItemMethod(this: MarketControlPlaneStore, cartItemId) {
    await this.ensureInitialized();
    await this.run(`UPDATE commerce_cart_items SET status = 'removed', updated_at = ? WHERE id = ?`, [isoNow(), cartItemId]);
    return serializeCommerceCartItem(await this.first(`SELECT * FROM commerce_cart_items WHERE id = ?`, [cartItemId]));
}

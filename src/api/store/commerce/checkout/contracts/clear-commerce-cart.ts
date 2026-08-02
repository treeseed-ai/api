import { isoNow,MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function clearCommerceCartMethod(this: MarketControlPlaneStore, cartId) {
    await this.ensureInitialized();
    await this.run(`UPDATE commerce_cart_items SET status = 'removed', updated_at = ? WHERE cart_id = ? AND status = 'active'`, [isoNow(), cartId]);
    return this.listCommerceCartItems(cartId);
}

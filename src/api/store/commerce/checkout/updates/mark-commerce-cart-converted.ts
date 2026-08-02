import { isoNow,MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function markCommerceCartConvertedMethod(this: MarketControlPlaneStore, cartId, checkoutId) {
    await this.ensureInitialized();
    const timestamp = isoNow();
    await this.run(`UPDATE commerce_carts SET status = 'converted', updated_at = ? WHERE id = ?`, [timestamp, cartId]);
    await this.run(`UPDATE commerce_cart_items SET status = 'converted', updated_at = ? WHERE cart_id = ? AND status = 'active'`, [timestamp, cartId]);
    return this.getCommerceCart(cartId);
}

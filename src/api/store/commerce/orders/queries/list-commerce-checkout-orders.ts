import { MarketControlPlaneStore,serializeCommerceOrder } from "../../../../persistence/store.ts";
export async function listCommerceCheckoutOrdersMethod(this: MarketControlPlaneStore, checkoutId) {
    await this.ensureInitialized();
    const rows = await this.all(`SELECT * FROM commerce_orders WHERE checkout_id = ? ORDER BY created_at ASC`, [checkoutId]);
    return rows.map(serializeCommerceOrder);
}

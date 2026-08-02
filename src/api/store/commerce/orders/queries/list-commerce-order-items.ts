import { MarketControlPlaneStore,serializeCommerceOrderItem } from "../../../../persistence/store.ts";
export async function listCommerceOrderItemsMethod(this: MarketControlPlaneStore, orderId) {
    await this.ensureInitialized();
    const rows = await this.all(`SELECT * FROM commerce_order_items WHERE order_id = ? ORDER BY created_at ASC`, [orderId]);
    return rows.map(serializeCommerceOrderItem);
}

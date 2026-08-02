import { MarketControlPlaneStore,serializeCommerceOrder } from "../../../../persistence/store.ts";
export async function getCommerceOrderMethod(this: MarketControlPlaneStore, orderId) {
    await this.ensureInitialized();
    return serializeCommerceOrder(await this.first(`SELECT * FROM commerce_orders WHERE id = ? LIMIT 1`, [orderId]));
}

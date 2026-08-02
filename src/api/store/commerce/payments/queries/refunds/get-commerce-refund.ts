import { MarketControlPlaneStore,serializeCommerceRefund } from "../../../../../persistence/store.ts";
export async function getCommerceRefundMethod(this: MarketControlPlaneStore, refundId) {
    await this.ensureInitialized();
    return serializeCommerceRefund(await this.first(`SELECT * FROM commerce_refunds WHERE id = ? LIMIT 1`, [refundId]));
}

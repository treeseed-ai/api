import { MarketControlPlaneStore,serializeCommerceRefund } from "../../../../../persistence/store.ts";
export async function getCommerceRefundByIdempotencyKeyMethod(this: MarketControlPlaneStore, idempotencyKey) {
    await this.ensureInitialized();
    if (!idempotencyKey)
        return null;
    return serializeCommerceRefund(await this.first(`SELECT * FROM commerce_refunds WHERE idempotency_key = ? LIMIT 1`, [idempotencyKey]));
}

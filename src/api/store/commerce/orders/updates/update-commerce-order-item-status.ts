import { COMMERCE_ORDER_ITEM_STATUS_SET,enumValue,isoNow,MarketControlPlaneStore,serializeCommerceOrderItem } from "../../../../persistence/store.ts";
export async function updateCommerceOrderItemStatusMethod(this: MarketControlPlaneStore, orderItemId, input: any = {}) {
    await this.ensureInitialized();
    const existing = serializeCommerceOrderItem(await this.first(`SELECT * FROM commerce_order_items WHERE id = ? LIMIT 1`, [orderItemId]));
    if (!existing)
        return null;
    await this.run(`UPDATE commerce_order_items SET status = ?, refunded_amount = ?, refund_status = ?, entitlement_id = ?, metadata_json = ?, updated_at = ? WHERE id = ?`, [
        enumValue(input.status, COMMERCE_ORDER_ITEM_STATUS_SET, existing.status),
        input.refundedAmount === undefined ? existing.refundedAmount : Number(input.refundedAmount),
        input.refundStatus === undefined ? existing.refundStatus : input.refundStatus,
        input.entitlementId === undefined ? existing.entitlementId : input.entitlementId,
        JSON.stringify(input.metadata ?? existing.metadata ?? {}),
        isoNow(),
        orderItemId,
    ]);
    return serializeCommerceOrderItem(await this.first(`SELECT * FROM commerce_order_items WHERE id = ?`, [orderItemId]));
}

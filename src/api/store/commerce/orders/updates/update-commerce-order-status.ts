import { COMMERCE_ORDER_STATUS_SET,enumValue,isoNow,MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function updateCommerceOrderStatusMethod(this: MarketControlPlaneStore, orderId, input: any = {}) {
    await this.ensureInitialized();
    const existing = await this.getCommerceOrder(orderId);
    if (!existing)
        return null;
    const status = enumValue(input.status, COMMERCE_ORDER_STATUS_SET, existing.status);
    await this.run(`UPDATE commerce_orders
			 SET status = ?, refunded_amount = ?, refund_status = ?, stripe_payment_intent_id = ?, stripe_subscription_id = ?, stripe_customer_id = ?,
			     stripe_connected_account_id = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`, [
        status,
        input.refundedAmount === undefined ? existing.refundedAmount : Number(input.refundedAmount),
        input.refundStatus === undefined ? existing.refundStatus : input.refundStatus,
        input.stripePaymentIntentId === undefined ? existing.stripePaymentIntentId : input.stripePaymentIntentId,
        input.stripeSubscriptionId === undefined ? existing.stripeSubscriptionId : input.stripeSubscriptionId,
        input.stripeCustomerId === undefined ? existing.stripeCustomerId : input.stripeCustomerId,
        input.stripeConnectedAccountId === undefined ? existing.stripeConnectedAccountId : input.stripeConnectedAccountId,
        JSON.stringify(input.metadata ?? existing.metadata ?? {}),
        isoNow(),
        orderId,
    ]);
    return this.getCommerceOrder(orderId);
}

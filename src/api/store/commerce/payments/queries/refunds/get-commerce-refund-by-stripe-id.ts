import { MarketControlPlaneStore,serializeCommerceRefund } from "../../../../../persistence/store.ts";
export async function getCommerceRefundByStripeIdMethod(this: MarketControlPlaneStore, stripeRefundId, connectedAccountId = null) {
    await this.ensureInitialized();
    const clauses = ['stripe_refund_id = ?'];
    const params = [stripeRefundId];
    if (connectedAccountId) {
        clauses.push('stripe_connected_account_id = ?');
        params.push(connectedAccountId);
    }
    return serializeCommerceRefund(await this.first(`SELECT * FROM commerce_refunds WHERE ${clauses.join(' AND ')} LIMIT 1`, params));
}

import { MarketControlPlaneStore,serializeCommercePaymentGroup } from "../../../../../persistence/store.ts";
export async function getCommercePaymentGroupByStripeSubscriptionMethod(this: MarketControlPlaneStore, subscriptionId, connectedAccountId = null) {
    await this.ensureInitialized();
    const clauses = ['stripe_subscription_id = ?'];
    const params = [subscriptionId];
    if (connectedAccountId) {
        clauses.push('connected_account_id = ?');
        params.push(connectedAccountId);
    }
    return serializeCommercePaymentGroup(await this.first(`SELECT * FROM commerce_payment_groups WHERE ${clauses.join(' AND ')} LIMIT 1`, params));
}

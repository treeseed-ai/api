import { MarketControlPlaneStore,serializeCommerceSubscription } from "../../../../../persistence/store.ts";
export async function getCommerceSubscriptionByStripeIdMethod(this: MarketControlPlaneStore, stripeSubscriptionId, connectedAccountId = null) {
    await this.ensureInitialized();
    const clauses = ['stripe_subscription_id = ?'];
    const params = [stripeSubscriptionId];
    if (connectedAccountId) {
        clauses.push('stripe_connected_account_id = ?');
        params.push(connectedAccountId);
    }
    return serializeCommerceSubscription(await this.first(`SELECT * FROM commerce_subscriptions WHERE ${clauses.join(' AND ')} LIMIT 1`, params));
}

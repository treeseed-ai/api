import { MarketControlPlaneStore,serializeCommerceSubscription } from "../../../../../persistence/store.ts";
export async function getCommerceSubscriptionMethod(this: MarketControlPlaneStore, subscriptionId) {
    await this.ensureInitialized();
    return serializeCommerceSubscription(await this.first(`SELECT * FROM commerce_subscriptions WHERE id = ? LIMIT 1`, [subscriptionId]));
}

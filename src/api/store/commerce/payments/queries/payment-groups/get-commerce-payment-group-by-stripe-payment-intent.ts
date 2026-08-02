import { MarketControlPlaneStore,serializeCommercePaymentGroup } from "../../../../../persistence/store.ts";
export async function getCommercePaymentGroupByStripePaymentIntentMethod(this: MarketControlPlaneStore, paymentIntentId, connectedAccountId = null) {
    await this.ensureInitialized();
    const clauses = ['stripe_payment_intent_id = ?'];
    const params = [paymentIntentId];
    if (connectedAccountId) {
        clauses.push('connected_account_id = ?');
        params.push(connectedAccountId);
    }
    return serializeCommercePaymentGroup(await this.first(`SELECT * FROM commerce_payment_groups WHERE ${clauses.join(' AND ')} LIMIT 1`, params));
}

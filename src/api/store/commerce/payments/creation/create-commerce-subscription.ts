import { randomUUID } from 'node:crypto';
import { COMMERCE_SUBSCRIPTION_STATUS_SET,enumValue,isoNow,MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function createCommerceSubscriptionMethod(this: MarketControlPlaneStore, input: any = {}) {
    await this.ensureInitialized();
    const existing = await this.getCommerceSubscriptionByStripeId(input.stripeSubscriptionId, input.stripeConnectedAccountId);
    if (existing)
        return existing;
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    await this.run(`INSERT INTO commerce_subscriptions (
				id, order_id, vendor_id, seller_team_id, buyer_team_id, buyer_user_id, offer_id, price_id, status, renewal_state,
				stripe_subscription_id, stripe_customer_id, stripe_connected_account_id, current_period_start, current_period_end,
				cancel_at_period_end, canceled_at, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        input.orderId,
        input.vendorId,
        input.sellerTeamId,
        input.buyerTeamId ?? null,
        input.buyerUserId ?? null,
        input.offerId,
        input.priceId,
        enumValue(input.status, COMMERCE_SUBSCRIPTION_STATUS_SET, 'incomplete'),
        input.renewalState ?? 'active',
        input.stripeSubscriptionId,
        input.stripeCustomerId ?? null,
        input.stripeConnectedAccountId,
        input.currentPeriodStart ?? null,
        input.currentPeriodEnd ?? null,
        input.cancelAtPeriodEnd === true ? 1 : 0,
        input.canceledAt ?? null,
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        timestamp,
    ]);
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? 'system',
        actorId: input.actorId ?? null,
        action: 'commerce_subscription.created',
        objectType: 'commerce_subscription',
        objectId: id,
        nextState: input.status ?? 'incomplete',
        relatedOrderId: input.orderId,
        relatedOfferId: input.offerId,
        relatedTeamId: input.sellerTeamId,
    });
    return this.getCommerceSubscription(id);
}

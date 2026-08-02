import { COMMERCE_SUBSCRIPTION_STATUS_SET,enumValue,isoNow,MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function updateCommerceSubscriptionFromStripeMethod(this: MarketControlPlaneStore, subscriptionId, input: any = {}) {
    await this.ensureInitialized();
    const existing = await this.getCommerceSubscription(subscriptionId);
    if (!existing)
        return null;
    await this.run(`UPDATE commerce_subscriptions
			 SET status = ?, renewal_state = ?, current_period_start = ?, current_period_end = ?,
			     cancel_at_period_end = ?, canceled_at = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`, [
        enumValue(input.status, COMMERCE_SUBSCRIPTION_STATUS_SET, existing.status),
        input.renewalState ?? existing.renewalState,
        input.currentPeriodStart === undefined ? existing.currentPeriodStart : input.currentPeriodStart,
        input.currentPeriodEnd === undefined ? existing.currentPeriodEnd : input.currentPeriodEnd,
        input.cancelAtPeriodEnd === undefined ? (existing.cancelAtPeriodEnd ? 1 : 0) : (input.cancelAtPeriodEnd === true ? 1 : 0),
        input.canceledAt === undefined ? existing.canceledAt : input.canceledAt,
        JSON.stringify(input.metadata ?? existing.metadata ?? {}),
        isoNow(),
        subscriptionId,
    ]);
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? 'system',
        actorId: input.actorId ?? null,
        action: 'commerce_subscription.updated',
        objectType: 'commerce_subscription',
        objectId: subscriptionId,
        priorState: existing.status,
        nextState: input.status ?? existing.status,
        relatedOrderId: existing.orderId,
        relatedOfferId: existing.offerId,
        relatedTeamId: existing.sellerTeamId,
    });
    return this.getCommerceSubscription(subscriptionId);
}

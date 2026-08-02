import { stripeClientSecret,syncCommerceSubscriptionFromStripe,updateCheckoutCompletionFromGroup } from '../../index.ts';
export function entitlementRenewalStateFromSubscription(status) {
    if (status === 'active' || status === 'trialing')
        return 'active';
    if (status === 'past_due')
        return 'past_due';
    if (status === 'canceled')
        return 'canceled';
    if (status === 'unpaid')
        return 'unpaid';
    return 'pending';
}
export function subscriptionClientSecret(subscription) {
    return stripeClientSecret(subscription?.latest_invoice?.payment_intent?.client_secret)
        ?? stripeClientSecret(subscription?.latest_invoice?.payment_intent?.clientSecret);
}
export async function grantCommerceEntitlementsForOrder({ store, order, subscription = null, status = 'active', renewalState = 'none' }) {
    const orderItems = await store.listCommerceOrderItems(order.id);
    const entitlements = [];
    for (const item of orderItems) {
        const entitlement = await store.upsertCommerceEntitlementForOrderItem(item.id, {
            buyerTeamId: order.buyerTeamId,
            buyerUserId: order.buyerUserId,
            sellerTeamId: item.sellerTeamId,
            productId: item.productId,
            productVersionId: item.productVersionId,
            offerId: item.offerId,
            orderId: order.id,
            subscriptionId: subscription?.id ?? null,
            status,
            accessScope: item.accessScope,
            renewalState,
            fulfillmentArtifactRefs: item.metadata?.artifactRefs ?? [],
            catalogItemId: item.metadata?.catalogItemId ?? null,
            ownershipSnapshot: item.ownershipSnapshot,
            metadata: {
                mode: item.mode,
                priceId: item.priceId,
                preservePurchasedArtifacts: item.mode === 'subscription_updates',
            },
        });
        await store.updateCommerceOrderItemStatus(item.id, {
            status: status === 'active' ? 'paid' : 'pending',
            entitlementId: entitlement.id,
        });
        entitlements.push(entitlement);
    }
    return entitlements;
}
export async function handleCommerceSubscriptionWebhook({ store, event, object, connectedAccountId }) {
    const group = await store.getCommercePaymentGroupByStripeSubscription(object.id, connectedAccountId);
    const existingSubscription = await store.getCommerceSubscriptionByStripeId(object.id, connectedAccountId);
    const order = group ? await store.getCommerceOrder(group.orderId) : (existingSubscription ? await store.getCommerceOrder(existingSubscription.orderId) : null);
    if (!order)
        return { ignored: true, reason: 'No order found for Stripe subscription.' };
    const subscription = await syncCommerceSubscriptionFromStripe({ store, order, group, subscription: object, connectedAccountId });
    const status = subscription.status;
    const renewalState = subscription.renewalState;
    if (['active', 'trialing'].includes(status)) {
        await store.updateCommerceOrderStatus(order.id, { status: 'paid', stripeSubscriptionId: object.id });
        await grantCommerceEntitlementsForOrder({ store, order, subscription, status: 'active', renewalState });
        if (group)
            await store.updateCommercePaymentGroup(group.id, { status: 'succeeded' });
    }
    else if (['past_due', 'unpaid'].includes(status)) {
        await store.updateCommerceOrderStatus(order.id, { status: 'requires_action', stripeSubscriptionId: object.id });
        await store.updateEntitlementsForSubscription(subscription.id, { status: 'past_due', renewalState });
        if (group)
            await store.updateCommercePaymentGroup(group.id, { status: 'requires_action' });
    }
    else if (event.type === 'customer.subscription.deleted' || status === 'canceled') {
        await store.updateEntitlementsForSubscription(subscription.id, {
            status: 'canceled',
            renewalState: 'canceled',
            metadata: { preservePurchasedArtifacts: true },
        });
        if (group)
            await store.updateCommercePaymentGroup(group.id, { status: 'canceled' });
    }
    if (group)
        await updateCheckoutCompletionFromGroup(store, group);
    return { relatedOrderId: order.id, relatedSubscriptionId: subscription.id };
}

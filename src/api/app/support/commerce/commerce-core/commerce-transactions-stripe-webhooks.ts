import { entitlementRenewalStateFromSubscription,handleCommerceInvoiceWebhook,handleCommercePaymentIntentWebhook,handleCommerceSubscriptionWebhook,optionalTrimmedString,stripeTimestampToIso } from '../../index.ts';
export function resolveStripeWebhookSecret(config: any = {}) {
    return optionalTrimmedString(config.stripeWebhookSecret)
        ?? optionalTrimmedString(process.env.TREESEED_STRIPE_WEBHOOK_SECRET)
        ?? optionalTrimmedString(process.env.STRIPE_WEBHOOK_SECRET);
}
export function subscriptionStatusFromStripe(subscription) {
    const value = optionalTrimmedString(subscription?.status);
    return ['incomplete', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused'].includes(value)
        ? value
        : 'incomplete';
}
export async function ensureCommerceStripeCustomer({ store, stripeConnectService, group, buyerTeamId, buyerUserId }) {
    const environment = stripeConnectService.environment ?? 'test';
    const existing = await store.getCommerceBuyerStripeCustomer({
        vendorId: group.vendor.id,
        environment,
        buyerTeamId,
        buyerUserId,
    });
    if (existing)
        return existing;
    const customer = await stripeConnectService.createCustomer({
        connectedAccountId: group.account.stripeAccountId,
        params: {
            metadata: {
                treeseed_vendor_id: group.vendor.id,
                treeseed_buyer_team_id: buyerTeamId ?? '',
                treeseed_buyer_user_id: buyerUserId ?? '',
                treeseed_environment: environment,
            },
        },
    });
    return store.upsertCommerceBuyerStripeCustomer({
        buyerTeamId,
        buyerUserId,
        vendorId: group.vendor.id,
        connectedAccountId: group.account.stripeAccountId,
        environment,
        stripeCustomerId: customer.id,
        metadata: { provider: 'stripe' },
    });
}
export async function syncCommerceSubscriptionFromStripe({ store, order, group, subscription, connectedAccountId }) {
    const status = subscriptionStatusFromStripe(subscription);
    const existing = await store.getCommerceSubscriptionByStripeId(subscription.id, connectedAccountId);
    const firstItem = (await store.listCommerceOrderItems(order.id))[0] ?? null;
    const input = {
        orderId: order.id,
        vendorId: order.vendorId,
        sellerTeamId: order.sellerTeamId,
        buyerTeamId: order.buyerTeamId,
        buyerUserId: order.buyerUserId,
        offerId: firstItem?.offerId ?? null,
        priceId: firstItem?.priceId ?? null,
        status,
        renewalState: entitlementRenewalStateFromSubscription(status),
        stripeSubscriptionId: subscription.id,
        stripeCustomerId: subscription.customer ?? group?.stripeCustomerId ?? order.stripeCustomerId ?? null,
        stripeConnectedAccountId: connectedAccountId,
        currentPeriodStart: stripeTimestampToIso(subscription.current_period_start),
        currentPeriodEnd: stripeTimestampToIso(subscription.current_period_end),
        cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
        canceledAt: stripeTimestampToIso(subscription.canceled_at),
        metadata: { stripeStatus: status },
    };
    if (existing)
        return store.updateCommerceSubscriptionFromStripe(existing.id, input);
    return store.createCommerceSubscription(input);
}
export async function processCommerceStripeWebhook({ store, stripeConnectService, event }) {
    const object = event?.data?.object ?? {};
    const connectedAccountId = optionalTrimmedString(event?.account) ?? optionalTrimmedString(event?.context) ?? null;
    if (['payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled'].includes(event.type)) {
        return handleCommercePaymentIntentWebhook({ store, event, object, connectedAccountId });
    }
    if (['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'].includes(event.type)) {
        return handleCommerceSubscriptionWebhook({ store, event, object, connectedAccountId });
    }
    if (['invoice.payment_succeeded', 'invoice.payment_failed'].includes(event.type)) {
        return handleCommerceInvoiceWebhook({ store, stripeConnectService, event, object, connectedAccountId });
    }
    return { ignored: true, reason: `Unhandled Stripe event type "${event.type}".` };
}

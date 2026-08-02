import { CHECKOUT_SUBSCRIPTION_OFFER_MODES,checkoutGroupKey,checkoutGroupKind,checkoutGroupStatus,commerceCheckoutError,ensureCommerceStripeCustomer,entitlementRenewalStateFromSubscription,grantCommerceEntitlementsForOrder,optionalTrimmedString,orderStatusFromPaymentGroup,paymentGroupStatusFromPaymentIntent,publicPaymentGroups,resolveCommerceCheckoutItem,stripeClientSecret,stripeConfiguredError,stripeTimestampToIso,subscriptionClientSecret,subscriptionStatusFromStripe } from '../../index.ts';
export async function createCommerceCheckoutRun({ store, stripeConnectService, principal, input = {} as Record<string, unknown> }) {
    const buyerTeamId = optionalTrimmedString(input.buyerTeamId) ?? null;
    const buyerUserId = principal?.id ?? null;
    let cart = null;
    let rawItems = Array.isArray(input.items) ? input.items : [];
    if (input.cartId) {
        cart = await store.getCommerceCart(optionalTrimmedString(input.cartId));
        if (!cart)
            throw commerceCheckoutError(`Unknown commerce cart "${input.cartId}".`, 404);
        rawItems = (await store.listCommerceCartItems(cart.id)).filter((item) => item.status === 'active');
    }
    if (!rawItems.length)
        throw commerceCheckoutError('Checkout requires at least one item.', 400);
    if (!cart) {
        cart = await store.createCommerceCart(principal, { buyerTeamId, buyerUserId });
        for (const item of rawItems) {
            await store.addCommerceCartItem(cart.id, {
                offerId: item.offerId,
                priceId: item.priceId,
                quantity: item.quantity,
                actorId: buyerUserId,
            });
        }
        rawItems = (await store.listCommerceCartItems(cart.id)).filter((item) => item.status === 'active');
    }
    const resolvedItems = [];
    for (const item of rawItems) {
        resolvedItems.push(await resolveCommerceCheckoutItem({ store, stripeConnectService, item }));
    }
    const groupMap = new Map();
    for (const item of resolvedItems) {
        const key = checkoutGroupKey(item);
        if (!groupMap.has(key)) {
            groupMap.set(key, {
                key,
                kind: checkoutGroupKind(item.offer.mode),
                vendor: item.vendor,
                account: item.account,
                currency: item.currency,
                billingInterval: CHECKOUT_SUBSCRIPTION_OFFER_MODES.has(item.offer.mode) ? item.price?.billingInterval ?? 'month' : null,
                items: [],
            });
        }
        groupMap.get(key).items.push(item);
    }
    const checkout = await store.createCommerceCheckout({
        cartId: cart.id,
        buyerTeamId: cart.buyerTeamId ?? buyerTeamId,
        buyerUserId: cart.buyerUserId ?? buyerUserId,
        status: 'requires_confirmation',
        groupCount: groupMap.size,
        actorId: buyerUserId,
        metadata: { checkoutMode: 'stripe_elements_grouped_vendor' },
    });
    const orders = [];
    const paymentGroups = [];
    const entitlements = [];
    for (const group of groupMap.values()) {
        const subtotal = group.items.reduce((sum, item) => sum + item.totalAmount, 0);
        const order = await store.createCommerceOrder({
            checkoutId: checkout.id,
            cartId: cart.id,
            buyerTeamId: cart.buyerTeamId ?? buyerTeamId,
            buyerUserId: cart.buyerUserId ?? buyerUserId,
            vendorId: group.vendor.id,
            sellerTeamId: group.vendor.teamId,
            status: group.kind === 'free' ? 'paid' : 'pending_payment',
            currency: group.currency,
            subtotalAmount: subtotal,
            totalAmount: subtotal,
            stripeConnectedAccountId: group.account?.stripeAccountId ?? null,
            ownershipSnapshot: {
                capturedAt: new Date().toISOString(),
                items: group.items.map((item) => item.ownershipSnapshot),
            },
            actorId: buyerUserId,
            metadata: { checkoutId: checkout.id, groupKind: group.kind },
        });
        for (const item of group.items) {
            await store.createCommerceOrderItem(order.id, {
                vendorId: item.vendor.id,
                sellerTeamId: item.product.sellerTeamId,
                productId: item.product.id,
                productVersionId: item.productVersionId,
                offerId: item.offer.id,
                priceId: item.price?.id ?? null,
                mode: item.offer.mode,
                quantity: item.quantity,
                unitAmount: item.unitAmount,
                totalAmount: item.totalAmount,
                currency: item.currency,
                status: group.kind === 'free' ? 'paid' : 'pending',
                ownershipSnapshot: item.ownershipSnapshot,
                accessScope: item.offer.accessScope ?? {},
                supportScope: item.offer.supportScope ?? {},
                metadata: {
                    catalogItemId: item.product.catalogItemId,
                    artifactRefs: item.productVersionId ? [{ productVersionId: item.productVersionId }] : [],
                    priceVersion: item.price?.priceVersion ?? null,
                },
            });
        }
        let paymentGroup = null;
        if (group.kind === 'free') {
            paymentGroup = await store.createCommercePaymentGroup({
                checkoutId: checkout.id,
                orderId: order.id,
                vendorId: group.vendor.id,
                sellerTeamId: group.vendor.teamId,
                groupKind: 'free',
                status: 'succeeded',
                currency: group.currency,
                subtotalAmount: 0,
                totalAmount: 0,
                actorId: buyerUserId,
            });
            entitlements.push(...await grantCommerceEntitlementsForOrder({ store, order, status: 'active', renewalState: 'none' }));
        }
        else if (group.kind === 'one_time') {
            if (!await stripeConnectService.isConfigured())
                throw stripeConfiguredError();
            const paymentIntent = await stripeConnectService.createPaymentIntent({
                connectedAccountId: group.account.stripeAccountId,
                params: {
                    amount: subtotal,
                    currency: group.currency,
                    automatic_payment_methods: { enabled: true },
                    metadata: {
                        treeseed_checkout_id: checkout.id,
                        treeseed_order_id: order.id,
                        treeseed_vendor_id: group.vendor.id,
                        treeseed_seller_team_id: group.vendor.teamId,
                        treeseed_object_authority: 'treeseed',
                        treeseed_checkout_phase: 'phase_5',
                    },
                },
            });
            await store.updateCommerceOrderStatus(order.id, {
                status: orderStatusFromPaymentGroup(paymentGroupStatusFromPaymentIntent(paymentIntent)),
                stripePaymentIntentId: paymentIntent?.id ?? null,
                stripeConnectedAccountId: group.account.stripeAccountId,
            });
            paymentGroup = await store.createCommercePaymentGroup({
                checkoutId: checkout.id,
                orderId: order.id,
                vendorId: group.vendor.id,
                sellerTeamId: group.vendor.teamId,
                connectedAccountId: group.account.stripeAccountId,
                groupKind: 'one_time',
                status: paymentGroupStatusFromPaymentIntent(paymentIntent),
                currency: group.currency,
                subtotalAmount: subtotal,
                totalAmount: subtotal,
                stripePaymentIntentId: paymentIntent?.id ?? null,
                clientSecret: stripeClientSecret(paymentIntent?.client_secret),
                actorId: buyerUserId,
            });
        }
        else {
            if (!await stripeConnectService.isConfigured())
                throw stripeConfiguredError();
            const customer = await ensureCommerceStripeCustomer({
                store,
                stripeConnectService,
                group,
                buyerTeamId: cart.buyerTeamId ?? buyerTeamId,
                buyerUserId: cart.buyerUserId ?? buyerUserId,
            });
            const subscription = await stripeConnectService.createSubscription({
                connectedAccountId: group.account.stripeAccountId,
                params: {
                    customer: customer.stripeCustomerId,
                    items: group.items.map((item) => ({ price: item.price.stripePriceId, quantity: item.quantity })),
                    payment_behavior: 'default_incomplete',
                    payment_settings: { save_default_payment_method: 'on_subscription' },
                    expand: ['latest_invoice.payment_intent'],
                    metadata: {
                        treeseed_checkout_id: checkout.id,
                        treeseed_order_id: order.id,
                        treeseed_vendor_id: group.vendor.id,
                        treeseed_seller_team_id: group.vendor.teamId,
                        treeseed_object_authority: 'treeseed',
                        treeseed_checkout_phase: 'phase_5',
                    },
                },
            });
            const firstItem = group.items[0];
            const localSubscription = await store.createCommerceSubscription({
                orderId: order.id,
                vendorId: group.vendor.id,
                sellerTeamId: group.vendor.teamId,
                buyerTeamId: cart.buyerTeamId ?? buyerTeamId,
                buyerUserId: cart.buyerUserId ?? buyerUserId,
                offerId: firstItem.offer.id,
                priceId: firstItem.price.id,
                status: subscriptionStatusFromStripe(subscription),
                renewalState: entitlementRenewalStateFromSubscription(subscriptionStatusFromStripe(subscription)),
                stripeSubscriptionId: subscription.id,
                stripeCustomerId: customer.stripeCustomerId,
                stripeConnectedAccountId: group.account.stripeAccountId,
                currentPeriodStart: stripeTimestampToIso(subscription.current_period_start),
                currentPeriodEnd: stripeTimestampToIso(subscription.current_period_end),
                cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
                canceledAt: stripeTimestampToIso(subscription.canceled_at),
                actorId: buyerUserId,
            });
            await store.updateCommerceOrderStatus(order.id, {
                status: ['active', 'trialing'].includes(localSubscription.status) ? 'paid' : 'pending_payment',
                stripeSubscriptionId: subscription.id,
                stripeCustomerId: customer.stripeCustomerId,
                stripeConnectedAccountId: group.account.stripeAccountId,
            });
            paymentGroup = await store.createCommercePaymentGroup({
                checkoutId: checkout.id,
                orderId: order.id,
                vendorId: group.vendor.id,
                sellerTeamId: group.vendor.teamId,
                connectedAccountId: group.account.stripeAccountId,
                groupKind: 'subscription',
                billingInterval: group.billingInterval,
                status: ['active', 'trialing'].includes(localSubscription.status) ? 'succeeded' : 'requires_confirmation',
                currency: group.currency,
                subtotalAmount: subtotal,
                totalAmount: subtotal,
                stripeSubscriptionId: subscription.id,
                stripeCustomerId: customer.stripeCustomerId,
                clientSecret: subscriptionClientSecret(subscription),
                actorId: buyerUserId,
            });
            if (['active', 'trialing'].includes(localSubscription.status)) {
                entitlements.push(...await grantCommerceEntitlementsForOrder({
                    store,
                    order: await store.getCommerceOrder(order.id),
                    subscription: localSubscription,
                    status: 'active',
                    renewalState: localSubscription.renewalState,
                }));
            }
        }
        orders.push(await store.getCommerceOrder(order.id));
        paymentGroups.push(paymentGroup);
    }
    await store.markCommerceCartConverted(cart.id, checkout.id);
    const status = checkoutGroupStatus(paymentGroups);
    const finalCheckout = await store.updateCommerceCheckoutStatus(checkout.id, {
        status: status.status,
        completedGroupCount: status.completed,
    });
    return {
        checkout: finalCheckout,
        orders,
        paymentGroups: publicPaymentGroups(paymentGroups),
        entitlements,
    };
}

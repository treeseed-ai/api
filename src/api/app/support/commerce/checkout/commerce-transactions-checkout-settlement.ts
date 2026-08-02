import { checkoutGroupStatus,commerceCheckoutError,grantCommerceEntitlementsForOrder,orderStatusFromPaymentGroup,paymentGroupStatusFromPaymentIntent,stripeClientSecret,subscriptionClientSecret,syncCommerceSubscriptionFromStripe } from '../../index.ts';
export async function refreshCommercePaymentGroupState({ store, stripeConnectService, group }) {
    if (!group)
        throw commerceCheckoutError('Unknown commerce payment group.', 404);
    const order = await store.getCommerceOrder(group.orderId);
    if (!order)
        throw commerceCheckoutError('Unknown commerce order for payment group.', 404);
    if (group.groupKind === 'free') {
        return {
            group,
            order,
            entitlements: await grantCommerceEntitlementsForOrder({ store, order, status: 'active', renewalState: 'none' }),
        };
    }
    if (!group.connectedAccountId)
        throw commerceCheckoutError('Payment group is missing a Stripe connected account.', 409);
    if (group.stripePaymentIntentId) {
        const paymentIntent = await stripeConnectService.retrievePaymentIntent({
            connectedAccountId: group.connectedAccountId,
            paymentIntentId: group.stripePaymentIntentId,
        });
        const status = paymentGroupStatusFromPaymentIntent(paymentIntent);
        const updatedGroup = await store.updateCommercePaymentGroup(group.id, { status });
        const updatedOrder = await store.updateCommerceOrderStatus(order.id, { status: orderStatusFromPaymentGroup(status) });
        let entitlements = [];
        if (status === 'succeeded') {
            entitlements = await grantCommerceEntitlementsForOrder({ store, order: updatedOrder, status: 'active', renewalState: 'none' });
        }
        return {
            group: updatedGroup,
            order: updatedOrder,
            entitlements,
            clientSecret: ['requires_confirmation', 'requires_action', 'processing', 'pending'].includes(status)
                ? stripeClientSecret(paymentIntent?.client_secret ?? paymentIntent?.clientSecret)
                : null,
        };
    }
    if (group.stripeSubscriptionId) {
        const subscription = await stripeConnectService.retrieveSubscription({
            connectedAccountId: group.connectedAccountId,
            subscriptionId: group.stripeSubscriptionId,
        });
        const localSubscription = await syncCommerceSubscriptionFromStripe({
            store,
            order,
            group,
            subscription,
            connectedAccountId: group.connectedAccountId,
        });
        const status = ['active', 'trialing'].includes(localSubscription.status) ? 'succeeded' : 'requires_confirmation';
        const updatedGroup = await store.updateCommercePaymentGroup(group.id, { status });
        const updatedOrder = await store.updateCommerceOrderStatus(order.id, {
            status: status === 'succeeded' ? 'paid' : 'pending_payment',
            stripeSubscriptionId: group.stripeSubscriptionId,
        });
        let entitlements = [];
        if (status === 'succeeded') {
            entitlements = await grantCommerceEntitlementsForOrder({
                store,
                order: updatedOrder,
                subscription: localSubscription,
                status: 'active',
                renewalState: localSubscription.renewalState,
            });
        }
        return {
            group: updatedGroup,
            order: updatedOrder,
            subscription: localSubscription,
            entitlements,
            clientSecret: status === 'requires_confirmation' ? subscriptionClientSecret(subscription) : null,
        };
    }
    return { group, order, entitlements: [], clientSecret: null };
}
export async function updateCheckoutCompletionFromGroup(store, group) {
    if (!group?.checkoutId)
        return null;
    const checkout = await store.getCommerceCheckout(group.checkoutId);
    if (!checkout)
        return null;
    const groups = await Promise.all((await store.listCommerceCheckoutOrders(checkout.id)).map(async (order) => {
        const orderGroups = await store.all?.(`SELECT * FROM commerce_payment_groups WHERE order_id = ?`, [order.id]).catch(() => []);
        return orderGroups.map((row) => ({
            status: row.status,
        }));
    }));
    const flattened = groups.flat();
    if (!flattened.length)
        return checkout;
    const status = checkoutGroupStatus(flattened);
    return store.updateCommerceCheckoutStatus(checkout.id, {
        status: status.status,
        completedGroupCount: status.completed,
    });
}
export async function handleCommercePaymentIntentWebhook({ store, event, object, connectedAccountId }) {
    const group = await store.getCommercePaymentGroupByStripePaymentIntent(object.id, connectedAccountId);
    if (!group)
        return { ignored: true, reason: 'No payment group found for PaymentIntent.' };
    const order = await store.getCommerceOrder(group.orderId);
    if (!order)
        return { ignored: true, reason: 'No order found for PaymentIntent payment group.' };
    let groupStatus = paymentGroupStatusFromPaymentIntent(object);
    if (event.type === 'payment_intent.payment_failed')
        groupStatus = 'failed';
    if (event.type === 'payment_intent.canceled')
        groupStatus = 'canceled';
    const updatedGroup = await store.updateCommercePaymentGroup(group.id, { status: groupStatus });
    const orderStatus = orderStatusFromPaymentGroup(groupStatus);
    const updatedOrder = await store.updateCommerceOrderStatus(order.id, { status: orderStatus });
    if (groupStatus === 'succeeded') {
        const entitlements = await grantCommerceEntitlementsForOrder({ store, order: updatedOrder, status: 'active', renewalState: 'none' });
        const serviceContractId = object?.metadata?.treeseed_service_contract_id ?? group.metadata?.serviceContractId ?? order.metadata?.serviceContractId ?? null;
        if (serviceContractId) {
            const entitlement = entitlements[0] ?? null;
            await store.activateCommerceServiceContract(serviceContractId, {
                orderId: order.id,
                entitlementId: entitlement?.id ?? null,
                actorType: 'system',
                evidence: {
                    stripePaymentIntentId: object.id,
                    connectedAccountId,
                },
            });
        }
    }
    else if (['failed', 'canceled'].includes(groupStatus)) {
        const serviceContractId = object?.metadata?.treeseed_service_contract_id ?? group.metadata?.serviceContractId ?? order.metadata?.serviceContractId ?? null;
        if (serviceContractId) {
            const contract = await store.getCommerceServiceContract(serviceContractId);
            if (contract) {
                await store.recordCommerceServiceGovernance({
                    requestId: contract.requestId,
                    quoteId: contract.quoteId,
                    contractId: contract.id,
                    eventType: groupStatus === 'failed' ? 'manual_update' : 'canceled',
                    action: groupStatus === 'failed' ? 'commerce_service.checkout_failed' : 'commerce_service.checkout_canceled',
                    objectType: 'commerce_service_contract',
                    objectId: contract.id,
                    actorType: 'system',
                    priorState: contract.status,
                    nextState: contract.status,
                    evidence: {
                        stripePaymentIntentId: object.id,
                        connectedAccountId,
                        groupStatus,
                    },
                    relatedOrderId: order.id,
                    relatedOfferId: contract.offerId,
                    relatedProductId: contract.productId,
                    relatedTeamId: contract.sellerTeamId,
                });
            }
        }
    }
    await updateCheckoutCompletionFromGroup(store, updatedGroup);
    return { relatedOrderId: order.id };
}

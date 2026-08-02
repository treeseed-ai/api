import { ensurePrincipal,jsonError,optionalTrimmedString,principalIsSeedAdmin,requireTeamAccess,syncCommerceSubscriptionFromStripe } from '../../index.ts';
export function commerceErrorResponse(c, error) {
    const status = Number(error?.status ?? 500);
    if (![400, 401, 403, 404, 409, 502].includes(status))
        throw error;
    return jsonError(c, status, error instanceof Error ? error.message : String(error), error?.details ?? {});
}
export function redactCommerceServiceRequestForBuyer(request) {
    if (!request)
        return null;
    const { vendorPrivateNotes: _vendorPrivateNotes, ...publicRequest } = request;
    return publicRequest;
}
export async function requireCommerceCapacityListingAccess(c, store, listingId, permission = 'projects:read:team') {
    const listing = await store.getCommerceCapacityListing(listingId);
    if (!listing)
        return { response: jsonError(c, 404, `Unknown commerce capacity listing "${listingId}".`) };
    const auth = await ensurePrincipal(c);
    if (auth.response) {
        if (!permission && listing.status === 'approved' && listing.accessLevel === 'public_summary') {
            return { principal: null, listing: await store.getCommerceCapacityListing(listingId, { publicSafe: true }) };
        }
        if (!permission) {
            return { response: jsonError(c, 404, `Unknown commerce capacity listing "${listingId}".`) };
        }
        return auth;
    }
    if (principalIsSeedAdmin(auth.principal))
        return { principal: auth.principal, listing };
    const access = await requireTeamAccess(c, store, listing.sellerTeamId, permission);
    if (!access.response)
        return { principal: auth.principal, listing };
    if (!permission && listing.status === 'approved' && listing.accessLevel === 'public_summary') {
        return { principal: auth.principal, listing: await store.getCommerceCapacityListing(listingId, { publicSafe: true }) };
    }
    return access;
}
export async function requireCommerceCapacityInquiryAccess(c, store, inquiryId, permission = 'projects:read:team') {
    const inquiry = await store.getCommerceCapacityListingInquiry(inquiryId);
    if (!inquiry)
        return { response: jsonError(c, 404, `Unknown commerce capacity inquiry "${inquiryId}".`) };
    const auth = await ensurePrincipal(c);
    if (auth.response)
        return auth;
    if (principalIsSeedAdmin(auth.principal))
        return { principal: auth.principal, inquiry };
    const sellerAccess = await requireTeamAccess(c, store, inquiry.sellerTeamId, permission);
    if (!sellerAccess.response)
        return { principal: auth.principal, inquiry };
    if (inquiry.buyerTeamId) {
        const buyerAccess = await requireTeamAccess(c, store, inquiry.buyerTeamId, 'projects:read:team');
        if (!buyerAccess.response)
            return { principal: auth.principal, inquiry: { ...inquiry, governanceEvidence: {}, metadata: {} } };
    }
    if (inquiry.buyerUserId && inquiry.buyerUserId === auth.principal.id) {
        return { principal: auth.principal, inquiry: { ...inquiry, governanceEvidence: {}, metadata: {} } };
    }
    return sellerAccess;
}
export async function applyCommerceRefundState({ store, order, orderItem = null, amount, fullRefund }) {
    const nextOrderRefunded = Number(order.refundedAmount ?? 0) + Number(amount ?? 0);
    const orderFullyRefunded = nextOrderRefunded >= Number(order.totalAmount ?? 0);
    const updatedOrder = await store.markCommerceOrderRefundState(order.id, {
        status: orderFullyRefunded ? 'refunded' : 'partially_refunded',
        refundedAmount: nextOrderRefunded,
        refundStatus: orderFullyRefunded ? 'full' : 'partial',
        metadata: order.metadata,
    });
    const updatedItems = [];
    if (orderItem) {
        const nextItemRefunded = Number(orderItem.refundedAmount ?? 0) + Number(amount ?? 0);
        const itemFullyRefunded = nextItemRefunded >= Number(orderItem.totalAmount ?? 0);
        updatedItems.push(await store.markCommerceOrderItemRefundState(orderItem.id, {
            status: itemFullyRefunded ? 'refunded' : orderItem.status,
            refundedAmount: nextItemRefunded,
            refundStatus: itemFullyRefunded ? 'full' : 'partial',
            metadata: orderItem.metadata,
        }));
        if (itemFullyRefunded && orderItem.entitlementId) {
            await store.revokeCommerceEntitlement(orderItem.entitlementId, {
                action: 'commerce_entitlement.revoked',
                renewalState: 'canceled',
            });
        }
    }
    else if (fullRefund) {
        for (const item of await store.listCommerceOrderItems(order.id)) {
            updatedItems.push(await store.markCommerceOrderItemRefundState(item.id, {
                status: 'refunded',
                refundedAmount: item.totalAmount,
                refundStatus: 'full',
                metadata: item.metadata,
            }));
            if (item.entitlementId) {
                await store.revokeCommerceEntitlement(item.entitlementId, {
                    action: 'commerce_entitlement.revoked',
                    renewalState: 'canceled',
                });
            }
        }
    }
    return { order: updatedOrder, items: updatedItems };
}
export async function handleCommerceInvoiceWebhook({ store, stripeConnectService, event, object, connectedAccountId }) {
    const stripeSubscriptionId = optionalTrimmedString(object.subscription);
    if (!stripeSubscriptionId)
        return { ignored: true, reason: 'Invoice is not linked to a subscription.' };
    let subscriptionObject = null;
    if (await stripeConnectService.isConfigured()) {
        subscriptionObject = await stripeConnectService.retrieveSubscription({ connectedAccountId, subscriptionId: stripeSubscriptionId });
    }
    const subscription = await store.getCommerceSubscriptionByStripeId(stripeSubscriptionId, connectedAccountId);
    if (!subscription)
        return { ignored: true, reason: 'No local subscription found for invoice.' };
    if (subscriptionObject) {
        const order = await store.getCommerceOrder(subscription.orderId);
        const synced = await syncCommerceSubscriptionFromStripe({ store, order, group: null, subscription: subscriptionObject, connectedAccountId });
        if (event.type === 'invoice.payment_succeeded') {
            await store.updateEntitlementsForSubscription(synced.id, { status: 'active', renewalState: 'active' });
        }
        if (event.type === 'invoice.payment_failed') {
            await store.updateEntitlementsForSubscription(synced.id, { status: 'past_due', renewalState: 'past_due' });
        }
        return { relatedOrderId: synced.orderId, relatedSubscriptionId: synced.id };
    }
    await store.updateEntitlementsForSubscription(subscription.id, {
        status: event.type === 'invoice.payment_succeeded' ? 'active' : 'past_due',
        renewalState: event.type === 'invoice.payment_succeeded' ? 'active' : 'past_due',
    });
    return { relatedOrderId: subscription.orderId, relatedSubscriptionId: subscription.id };
}
export async function requireCommerceProductAccess(c, store, productId, permission = null) {
    const product = await store.getCommerceProduct(productId);
    if (!product) {
        return {
            response: jsonError(c, 404, `Unknown commerce product "${productId}".`),
        };
    }
    if (!permission && product.visibility === 'public' && product.status === 'approved') {
        return {
            principal: c.get('principal') ?? null,
            product,
        };
    }
    const auth = await ensurePrincipal(c);
    if (auth.response)
        return auth;
    if (permission) {
        const access = await requireTeamAccess(c, store, product.sellerTeamId, permission);
        if (access.response)
            return access;
        return {
            principal: access.principal,
            product,
        };
    }
    const teamIds = await store.teamIdsForPrincipal(auth.principal).catch(() => []);
    if (product.visibility === 'public' && product.status === 'approved') {
        return {
            principal: auth.principal,
            product,
        };
    }
    if (principalIsSeedAdmin(auth.principal) || teamIds.includes(product.sellerTeamId)) {
        return {
            principal: auth.principal,
            product,
        };
    }
    return {
        response: jsonError(c, 404, `Unknown commerce product "${productId}".`),
    };
}
export async function principalCanManageCommerceProduct(store, principal, product) {
    if (!principal)
        return false;
    if (principalIsSeedAdmin(principal))
        return true;
    const teamIds = await store.teamIdsForPrincipal(principal).catch(() => []);
    return teamIds.includes(product.sellerTeamId);
}
export function redactCommerceOwnershipWorkflow(workflow) {
    if (!workflow)
        return null;
    return {
        productId: workflow.productId,
        currentOwnershipRecord: workflow.currentOwnershipRecord?.buyerVisible ? workflow.currentOwnershipRecord : null,
        buyerVisibleOwnershipRecords: workflow.buyerVisibleOwnershipRecords ?? [],
        stewardshipAssignments: (workflow.stewardshipAssignments ?? []).filter((assignment) => assignment.visibleToBuyers),
        contributions: (workflow.contributions ?? []).filter((contribution) => ['public', 'buyer'].includes(contribution.attributionVisibility)),
        governancePolicies: (workflow.governancePolicies ?? []).map((policy) => ({
            id: policy.id,
            productId: policy.productId,
            teamId: policy.teamId,
            policyKind: policy.policyKind,
            title: policy.title,
            buyerVisibleSummary: policy.buyerVisibleSummary,
            status: policy.status,
            createdAt: policy.createdAt,
            updatedAt: policy.updatedAt,
        })),
        pendingTransfers: [],
        successionEvents: [],
    };
}
export async function requireCommerceOfferAccess(c, store, offerId, permission = null) {
    const auth = await ensurePrincipal(c);
    if (auth.response)
        return auth;
    const offer = await store.getCommerceOffer(offerId);
    if (!offer) {
        return {
            response: jsonError(c, 404, `Unknown commerce offer "${offerId}".`),
        };
    }
    if (permission) {
        const access = await requireTeamAccess(c, store, offer.sellerTeamId, permission);
        if (access.response)
            return access;
        return {
            principal: access.principal,
            offer,
        };
    }
    return {
        principal: auth.principal,
        offer,
    };
}

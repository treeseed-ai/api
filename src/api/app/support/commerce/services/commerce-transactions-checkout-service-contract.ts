import { commerceCheckoutError,orderStatusFromPaymentGroup,paymentGroupStatusFromPaymentIntent,publicPaymentGroups,stripeClientSecret,stripeConfiguredError } from '../../index.ts';
export async function createCommerceCheckoutRunForServiceContract({ store, stripeConnectService, principal, contractId, input = {} as Record<string, unknown> }) {
    const contract = await store.getCommerceServiceContract(contractId);
    if (!contract)
        throw commerceCheckoutError(`Unknown commerce service contract "${contractId}".`, 404);
    if (contract.status !== 'pending_checkout') {
        throw commerceCheckoutError('Scoped service contract checkout requires a pending checkout contract.', 409, { contractId, status: contract.status });
    }
    const request = await store.getCommerceServiceRequest(contract.requestId);
    const quote = await store.getCommerceServiceQuote(contract.quoteId);
    if (!request || !quote || quote.status !== 'accepted') {
        throw commerceCheckoutError('Scoped service checkout requires an accepted quote.', 409, { contractId, quoteId: contract.quoteId });
    }
    const offer = await store.getCommerceOffer(contract.offerId);
    const product = await store.getCommerceProduct(contract.productId);
    const vendor = await store.getCommerceVendor(contract.vendorId);
    if (!offer || offer.status !== 'approved' || offer.mode !== 'scoped_contract') {
        throw commerceCheckoutError('Scoped service checkout requires an approved scoped contract offer.', 409, { offerId: contract.offerId });
    }
    if (!product || product.status !== 'approved' || product.kind !== 'scoped_service') {
        throw commerceCheckoutError('Scoped service checkout requires an approved scoped service product.', 409, { productId: contract.productId });
    }
    if (!vendor || vendor.status !== 'approved' || vendor.serviceSalesEnabled !== true) {
        throw commerceCheckoutError('Scoped service checkout requires an approved service-enabled vendor.', 409, { vendorId: contract.vendorId });
    }
    const environment = stripeConnectService.environment ?? 'test';
    const account = await store.getCommerceVendorStripeAccount(vendor.id, environment);
    if (!account || account.accountStatus !== 'enabled') {
        throw commerceCheckoutError('Scoped service checkout requires an enabled Stripe connected account.', 409, { vendorId: vendor.id });
    }
    if (!await stripeConnectService.isConfigured())
        throw stripeConfiguredError();
    const buyerTeamId = request.buyerTeamId ?? input.buyerTeamId ?? null;
    const buyerUserId = request.buyerUserId ?? principal?.id ?? null;
    const cart = await store.createCommerceCart(principal, {
        buyerTeamId,
        buyerUserId,
        currency: quote.currency,
        metadata: { serviceRequestId: request.id, serviceContractId: contract.id },
    });
    const checkout = await store.createCommerceCheckout({
        cartId: cart.id,
        buyerTeamId,
        buyerUserId,
        status: 'requires_confirmation',
        groupCount: 1,
        actorId: principal?.id ?? null,
        metadata: { checkoutMode: 'stripe_elements_grouped_vendor', serviceRequestId: request.id, serviceContractId: contract.id },
    });
    const order = await store.createCommerceOrder({
        checkoutId: checkout.id,
        cartId: cart.id,
        buyerTeamId,
        buyerUserId,
        vendorId: vendor.id,
        sellerTeamId: vendor.teamId,
        status: 'pending_payment',
        currency: quote.currency,
        subtotalAmount: quote.amount,
        totalAmount: quote.amount,
        stripeConnectedAccountId: account.stripeAccountId,
        ownershipSnapshot: contract.ownershipSnapshot ?? request.ownershipSnapshot ?? {},
        actorId: principal?.id ?? null,
        metadata: {
            checkoutId: checkout.id,
            groupKind: 'one_time',
            serviceRequestId: request.id,
            serviceQuoteId: quote.id,
            serviceContractId: contract.id,
        },
    });
    const orderItem = await store.createCommerceOrderItem(order.id, {
        vendorId: vendor.id,
        sellerTeamId: vendor.teamId,
        productId: product.id,
        productVersionId: offer.productVersionId ?? product.currentVersionId ?? null,
        offerId: offer.id,
        priceId: null,
        mode: 'scoped_contract',
        quantity: 1,
        unitAmount: quote.amount,
        totalAmount: quote.amount,
        currency: quote.currency,
        status: 'pending',
        ownershipSnapshot: contract.ownershipSnapshot ?? request.ownershipSnapshot ?? {},
        accessScope: {
            ...(offer.accessScope ?? {}),
            serviceRequestId: request.id,
            serviceQuoteId: quote.id,
            serviceContractId: contract.id,
            scopeSummary: quote.scopeSummary,
            accessRequirements: quote.accessRequirements,
        },
        supportScope: offer.supportScope ?? {},
        metadata: {
            catalogItemId: product.catalogItemId,
            serviceRequestId: request.id,
            serviceQuoteId: quote.id,
            serviceContractId: contract.id,
            quoteVersion: quote.quoteVersion,
        },
    });
    const paymentIntent = await stripeConnectService.createPaymentIntent({
        connectedAccountId: account.stripeAccountId,
        params: {
            amount: quote.amount,
            currency: quote.currency,
            automatic_payment_methods: { enabled: true },
            metadata: {
                treeseed_checkout_id: checkout.id,
                treeseed_order_id: order.id,
                treeseed_order_item_id: orderItem.id,
                treeseed_vendor_id: vendor.id,
                treeseed_seller_team_id: vendor.teamId,
                treeseed_product_id: product.id,
                treeseed_offer_id: offer.id,
                treeseed_service_request_id: request.id,
                treeseed_service_quote_id: quote.id,
                treeseed_service_contract_id: contract.id,
                treeseed_object_authority: 'treeseed',
                treeseed_checkout_phase: 'phase_8_scoped_service',
            },
        },
    });
    const paymentGroup = await store.createCommercePaymentGroup({
        checkoutId: checkout.id,
        orderId: order.id,
        vendorId: vendor.id,
        sellerTeamId: vendor.teamId,
        connectedAccountId: account.stripeAccountId,
        groupKind: 'one_time',
        status: paymentGroupStatusFromPaymentIntent(paymentIntent),
        currency: quote.currency,
        subtotalAmount: quote.amount,
        totalAmount: quote.amount,
        stripePaymentIntentId: paymentIntent?.id ?? null,
        clientSecret: stripeClientSecret(paymentIntent?.client_secret),
        metadata: { serviceRequestId: request.id, serviceQuoteId: quote.id, serviceContractId: contract.id },
        actorId: principal?.id ?? null,
    });
    await store.updateCommerceOrderStatus(order.id, {
        status: orderStatusFromPaymentGroup(paymentGroup.status),
        stripePaymentIntentId: paymentIntent?.id ?? null,
        stripeConnectedAccountId: account.stripeAccountId,
    });
    await store.attachCommerceServiceOrder(contract.id, {
        orderId: order.id,
        orderItemId: orderItem.id,
        paymentGroupId: paymentGroup.id,
        actorType: 'user',
        actorId: principal?.id ?? null,
    });
    await store.markCommerceCartConverted(cart.id, checkout.id);
    return {
        checkout: await store.getCommerceCheckout(checkout.id),
        orders: [await store.getCommerceOrder(order.id)],
        paymentGroups: publicPaymentGroups([paymentGroup]),
        entitlements: [],
    };
}

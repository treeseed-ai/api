import { parseJson,redactBuyerUserId } from '../../foundation.ts';

export function serializeCommerceVendorStripeAccount(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        vendorId: row.vendor_id,
        teamId: row.team_id,
        environment: row.environment,
        stripeAccountId: row.stripe_account_id,
        accountStatus: row.account_status,
        onboardingStatus: row.onboarding_status,
        chargesEnabled: Boolean(row.charges_enabled),
        payoutsEnabled: Boolean(row.payouts_enabled),
        detailsSubmitted: Boolean(row.details_submitted),
        requirementsCurrentlyDue: parseJson(row.requirements_currently_due_json, []),
        requirementsEventuallyDue: parseJson(row.requirements_eventually_due_json, []),
        requirementsPastDue: parseJson(row.requirements_past_due_json, []),
        requirementsDisabledReason: row.requirements_disabled_reason,
        capabilities: parseJson(row.capabilities_json, {}),
        onboardingStartedAt: row.onboarding_started_at,
        onboardingCompletedAt: row.onboarding_completed_at,
        lastSyncedAt: row.last_synced_at,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeCommerceCart(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        buyerTeamId: row.buyer_team_id,
        buyerUserId: row.buyer_user_id,
        status: row.status,
        currency: row.currency,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeCommerceCartItem(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        cartId: row.cart_id,
        vendorId: row.vendor_id,
        sellerTeamId: row.seller_team_id,
        productId: row.product_id,
        productVersionId: row.product_version_id,
        offerId: row.offer_id,
        priceId: row.price_id,
        quantity: Number(row.quantity ?? 1),
        unitAmount: Number(row.unit_amount ?? 0),
        currency: row.currency,
        mode: row.mode,
        status: row.status,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeCommerceCheckout(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        cartId: row.cart_id,
        buyerTeamId: row.buyer_team_id,
        buyerUserId: row.buyer_user_id,
        status: row.status,
        checkoutMode: row.checkout_mode,
        groupCount: Number(row.group_count ?? 0),
        completedGroupCount: Number(row.completed_group_count ?? 0),
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeCommerceOrder(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        checkoutId: row.checkout_id,
        cartId: row.cart_id,
        buyerTeamId: row.buyer_team_id,
        buyerUserId: row.buyer_user_id,
        vendorId: row.vendor_id,
        sellerTeamId: row.seller_team_id,
        status: row.status,
        currency: row.currency,
        subtotalAmount: Number(row.subtotal_amount ?? 0),
        totalAmount: Number(row.total_amount ?? 0),
        refundedAmount: Number(row.refunded_amount ?? 0),
        refundStatus: row.refund_status ?? 'none',
        stripeCheckoutSessionId: row.stripe_checkout_session_id,
        stripePaymentIntentId: row.stripe_payment_intent_id,
        stripeSubscriptionId: row.stripe_subscription_id,
        stripeCustomerId: row.stripe_customer_id,
        stripeConnectedAccountId: row.stripe_connected_account_id,
        ownershipSnapshot: parseJson(row.ownership_snapshot_json, {}),
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeCommerceOrderItem(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        orderId: row.order_id,
        vendorId: row.vendor_id,
        sellerTeamId: row.seller_team_id,
        productId: row.product_id,
        productVersionId: row.product_version_id,
        offerId: row.offer_id,
        priceId: row.price_id,
        mode: row.mode,
        quantity: Number(row.quantity ?? 1),
        unitAmount: Number(row.unit_amount ?? 0),
        totalAmount: Number(row.total_amount ?? 0),
        refundedAmount: Number(row.refunded_amount ?? 0),
        refundStatus: row.refund_status ?? 'none',
        currency: row.currency,
        status: row.status,
        entitlementId: row.entitlement_id,
        ownershipSnapshot: parseJson(row.ownership_snapshot_json, {}),
        accessScope: parseJson(row.access_scope_json, {}),
        supportScope: parseJson(row.support_scope_json, {}),
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeCommerceRefund(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        orderId: row.order_id,
        orderItemId: row.order_item_id,
        paymentGroupId: row.payment_group_id,
        vendorId: row.vendor_id,
        sellerTeamId: row.seller_team_id,
        buyerTeamId: row.buyer_team_id,
        buyerUserId: row.buyer_user_id,
        amount: Number(row.amount ?? 0),
        currency: row.currency,
        status: row.status,
        reason: row.reason,
        stripeRefundId: row.stripe_refund_id,
        stripePaymentIntentId: row.stripe_payment_intent_id,
        stripeConnectedAccountId: row.stripe_connected_account_id,
        idempotencyKey: row.idempotency_key,
        requestedByType: row.requested_by_type,
        requestedById: row.requested_by_id,
        failureReason: row.failure_reason,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeCommerceFulfillmentEvent(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        orderId: row.order_id,
        orderItemId: row.order_item_id,
        entitlementId: row.entitlement_id,
        vendorId: row.vendor_id,
        sellerTeamId: row.seller_team_id,
        productId: row.product_id,
        productVersionId: row.product_version_id,
        catalogItemId: row.catalog_item_id,
        catalogArtifactVersionId: row.catalog_artifact_version_id,
        eventType: row.event_type,
        status: row.status,
        artifactRefs: parseJson(row.artifact_refs_json, []),
        deliveryRefs: parseJson(row.delivery_refs_json, []),
        message: row.message,
        actorType: row.actor_type,
        actorId: row.actor_id,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
    };
}

export function serializeCommerceVendorOrderSummary(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        checkoutId: row.checkout_id,
        status: row.status,
        currency: row.currency,
        totalAmount: Number(row.total_amount ?? 0),
        refundedAmount: Number(row.refunded_amount ?? 0),
        buyerTeamId: row.buyer_team_id,
        buyerDisplayName: row.buyer_team_name ?? null,
        buyerUserIdRedacted: redactBuyerUserId(row.buyer_user_id),
        itemCount: Number(row.item_count ?? 0),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeCommercePaymentGroup(row, clientSecret = null) {
    if (!row)
        return null;
    return {
        id: row.id,
        checkoutId: row.checkout_id,
        orderId: row.order_id,
        vendorId: row.vendor_id,
        sellerTeamId: row.seller_team_id,
        connectedAccountId: row.connected_account_id,
        groupKind: row.group_kind,
        billingInterval: row.billing_interval,
        status: row.status,
        currency: row.currency,
        subtotalAmount: Number(row.subtotal_amount ?? 0),
        totalAmount: Number(row.total_amount ?? 0),
        stripePaymentIntentId: row.stripe_payment_intent_id,
        stripeSubscriptionId: row.stripe_subscription_id,
        stripeCustomerId: row.stripe_customer_id,
        clientSecret,
        clientSecretLast4: row.client_secret_last4,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeCommerceSubscription(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        orderId: row.order_id,
        vendorId: row.vendor_id,
        sellerTeamId: row.seller_team_id,
        buyerTeamId: row.buyer_team_id,
        buyerUserId: row.buyer_user_id,
        offerId: row.offer_id,
        priceId: row.price_id,
        status: row.status,
        renewalState: row.renewal_state,
        stripeSubscriptionId: row.stripe_subscription_id,
        stripeCustomerId: row.stripe_customer_id,
        stripeConnectedAccountId: row.stripe_connected_account_id,
        currentPeriodStart: row.current_period_start,
        currentPeriodEnd: row.current_period_end,
        cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
        canceledAt: row.canceled_at,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeCommerceEntitlement(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        buyerTeamId: row.buyer_team_id,
        buyerUserId: row.buyer_user_id,
        sellerTeamId: row.seller_team_id,
        productId: row.product_id,
        productVersionId: row.product_version_id,
        offerId: row.offer_id,
        orderId: row.order_id,
        orderItemId: row.order_item_id,
        subscriptionId: row.subscription_id,
        status: row.status,
        accessScope: parseJson(row.access_scope_json, {}),
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        renewalState: row.renewal_state,
        fulfillmentArtifactRefs: parseJson(row.fulfillment_artifact_refs_json, []),
        projectId: row.project_id,
        catalogItemId: row.catalog_item_id,
        ownershipSnapshot: parseJson(row.ownership_snapshot_json, {}),
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeCommerceBuyerStripeCustomer(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        buyerTeamId: row.buyer_team_id,
        buyerUserId: row.buyer_user_id,
        vendorId: row.vendor_id,
        connectedAccountId: row.connected_account_id,
        environment: row.environment,
        stripeCustomerId: row.stripe_customer_id,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

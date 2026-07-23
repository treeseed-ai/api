import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { governanceVotingProvider } from '@treeseed/sdk';
import { containsTreeseedPlaintextSecretMaterial, validateTreeseedClientEncryptedEscrowMetadata, validateTreeseedSecretsCapabilityRegistry, validateTreeseedWritableSecretMetadata, } from '@treeseed/sdk/secrets-capability';
import { redactDeploymentValue } from '../../../market/deployment-actions.ts';
import { projectDeploymentAuditPayload } from '../../../market/deployment-governance.ts';
import { parseJson, redactBuyerUserId } from './foundation.ts';
import { COMMERCE_PRODUCT_KINDS, COMMERCE_OFFER_MODES, COMMERCE_VENDOR_TRUST_LEVELS, COMMERCE_GOVERNANCE_STATES, COMMERCE_OWNERSHIP_MODELS, COMMERCE_STEWARDSHIP_ROLES, COMMERCE_STRIPE_ACCOUNT_STATUSES, COMMERCE_STRIPE_ONBOARDING_STATUSES, COMMERCE_STRIPE_ENVIRONMENTS, COMMERCE_STRIPE_SYNC_STATUSES, COMMERCE_ENTITLEMENT_STATUSES, COMMERCE_CART_STATUSES, COMMERCE_CHECKOUT_STATUSES, COMMERCE_ORDER_STATUSES, COMMERCE_ORDER_ITEM_STATUSES, COMMERCE_SUBSCRIPTION_STATUSES, COMMERCE_PAYMENT_GROUP_STATUSES, COMMERCE_WEBHOOK_EVENT_STATUSES, COMMERCE_REFUND_STATUSES, COMMERCE_FULFILLMENT_STATUSES, COMMERCE_FULFILLMENT_EVENT_TYPES, COMMERCE_SERVICE_REQUEST_STATUSES, COMMERCE_SERVICE_QUOTE_STATUSES, COMMERCE_SERVICE_CONTRACT_STATUSES, COMMERCE_SERVICE_EVENT_TYPES, COMMERCE_CAPACITY_LISTING_STATUSES, COMMERCE_CAPACITY_INQUIRY_STATUSES, COMMERCE_CAPACITY_ACCESS_LEVELS, COMMERCE_CAPACITY_RUNTIME_ISOLATION_LEVELS, COMMERCE_CAPACITY_HUMAN_INVOLVEMENT_LEVELS, COMMERCE_CAPACITY_AI_INVOLVEMENT_LEVELS, COMMERCE_CAPACITY_DATA_ACCESS_LEVELS, COMMERCE_CAPACITY_SECRET_ACCESS_LEVELS, COMMERCE_PRODUCT_KIND_SET, COMMERCE_OFFER_MODE_SET, COMMERCE_VENDOR_TRUST_LEVEL_SET, COMMERCE_GOVERNANCE_STATE_SET, COMMERCE_OWNERSHIP_MODEL_SET, COMMERCE_STEWARDSHIP_ROLE_SET, COMMERCE_STRIPE_ACCOUNT_STATUS_SET, COMMERCE_STRIPE_ONBOARDING_STATUS_SET, COMMERCE_STRIPE_ENVIRONMENT_SET, COMMERCE_STRIPE_SYNC_STATUS_SET, COMMERCE_ENTITLEMENT_STATUS_SET, COMMERCE_CART_STATUS_SET, COMMERCE_CHECKOUT_STATUS_SET, COMMERCE_ORDER_STATUS_SET, COMMERCE_ORDER_ITEM_STATUS_SET, COMMERCE_SUBSCRIPTION_STATUS_SET, COMMERCE_PAYMENT_GROUP_STATUS_SET, COMMERCE_WEBHOOK_EVENT_STATUS_SET, COMMERCE_REFUND_STATUS_SET, COMMERCE_FULFILLMENT_STATUS_SET, COMMERCE_FULFILLMENT_EVENT_TYPE_SET, COMMERCE_SERVICE_REQUEST_STATUS_SET, COMMERCE_SERVICE_QUOTE_STATUS_SET, COMMERCE_SERVICE_CONTRACT_STATUS_SET, COMMERCE_SERVICE_EVENT_TYPE_SET, COMMERCE_CAPACITY_LISTING_STATUS_SET, COMMERCE_CAPACITY_INQUIRY_STATUS_SET, COMMERCE_CAPACITY_ACCESS_LEVEL_SET, COMMERCE_CAPACITY_RUNTIME_ISOLATION_LEVEL_SET, COMMERCE_CAPACITY_HUMAN_INVOLVEMENT_LEVEL_SET, COMMERCE_CAPACITY_AI_INVOLVEMENT_LEVEL_SET, COMMERCE_CAPACITY_DATA_ACCESS_LEVEL_SET, COMMERCE_CAPACITY_SECRET_ACCESS_LEVEL_SET, COMMERCE_VISIBILITY_SET, COMMERCE_FULFILLMENT_MODE_SET, COMMERCE_PRICE_STATUS_SET, COMMERCE_PRICE_INTERVAL_SET, COMMERCE_TAX_BEHAVIOR_SET, COMMERCE_COMMERCIAL_OFFER_MODES, COMMERCE_ZERO_PRICE_OFFER_MODES, COMMERCE_CAPACITY_LISTING_OFFER_MODES, serializeCommerceVendor, serializeCommerceProduct, serializeCommerceOwnershipRecord, serializeCommerceStewardshipAssignment, serializeCommerceContribution, serializeCommerceGovernancePolicy, serializeCommerceOwnershipTransfer, serializeCommerceSuccessionEvent, serializeCommerceOwnershipWorkflowSummary, serializeCommerceProductVersion, serializeCommerceOffer, serializeCommercePrice, serializeCommerceGovernanceEvent, serializeCommerceServiceRequest, serializeCommerceServiceQuote, serializeCommerceServiceContract, serializeCommerceServiceEvent, serializeCommerceCapacityListing, serializeCommerceCapacityListingInquiry, serializeCommerceWebhookEvent } from './index.ts';

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

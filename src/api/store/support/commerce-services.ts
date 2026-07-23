import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { governanceVotingProvider } from '@treeseed/sdk';
import { containsTreeseedPlaintextSecretMaterial, validateTreeseedClientEncryptedEscrowMetadata, validateTreeseedSecretsCapabilityRegistry, validateTreeseedWritableSecretMetadata, } from '@treeseed/sdk/secrets-capability';
import { redactDeploymentValue } from '../../../market/deployment-actions.ts';
import { projectDeploymentAuditPayload } from '../../../market/deployment-governance.ts';
import { parseJson } from './foundation.ts';
import { COMMERCE_PRODUCT_KINDS, COMMERCE_OFFER_MODES, COMMERCE_VENDOR_TRUST_LEVELS, COMMERCE_GOVERNANCE_STATES, COMMERCE_OWNERSHIP_MODELS, COMMERCE_STEWARDSHIP_ROLES, COMMERCE_STRIPE_ACCOUNT_STATUSES, COMMERCE_STRIPE_ONBOARDING_STATUSES, COMMERCE_STRIPE_ENVIRONMENTS, COMMERCE_STRIPE_SYNC_STATUSES, COMMERCE_ENTITLEMENT_STATUSES, COMMERCE_CART_STATUSES, COMMERCE_CHECKOUT_STATUSES, COMMERCE_ORDER_STATUSES, COMMERCE_ORDER_ITEM_STATUSES, COMMERCE_SUBSCRIPTION_STATUSES, COMMERCE_PAYMENT_GROUP_STATUSES, COMMERCE_WEBHOOK_EVENT_STATUSES, COMMERCE_REFUND_STATUSES, COMMERCE_FULFILLMENT_STATUSES, COMMERCE_FULFILLMENT_EVENT_TYPES, COMMERCE_SERVICE_REQUEST_STATUSES, COMMERCE_SERVICE_QUOTE_STATUSES, COMMERCE_SERVICE_CONTRACT_STATUSES, COMMERCE_SERVICE_EVENT_TYPES, COMMERCE_CAPACITY_LISTING_STATUSES, COMMERCE_CAPACITY_INQUIRY_STATUSES, COMMERCE_CAPACITY_ACCESS_LEVELS, COMMERCE_CAPACITY_RUNTIME_ISOLATION_LEVELS, COMMERCE_CAPACITY_HUMAN_INVOLVEMENT_LEVELS, COMMERCE_CAPACITY_AI_INVOLVEMENT_LEVELS, COMMERCE_CAPACITY_DATA_ACCESS_LEVELS, COMMERCE_CAPACITY_SECRET_ACCESS_LEVELS, COMMERCE_PRODUCT_KIND_SET, COMMERCE_OFFER_MODE_SET, COMMERCE_VENDOR_TRUST_LEVEL_SET, COMMERCE_GOVERNANCE_STATE_SET, COMMERCE_OWNERSHIP_MODEL_SET, COMMERCE_STEWARDSHIP_ROLE_SET, COMMERCE_STRIPE_ACCOUNT_STATUS_SET, COMMERCE_STRIPE_ONBOARDING_STATUS_SET, COMMERCE_STRIPE_ENVIRONMENT_SET, COMMERCE_STRIPE_SYNC_STATUS_SET, COMMERCE_ENTITLEMENT_STATUS_SET, COMMERCE_CART_STATUS_SET, COMMERCE_CHECKOUT_STATUS_SET, COMMERCE_ORDER_STATUS_SET, COMMERCE_ORDER_ITEM_STATUS_SET, COMMERCE_SUBSCRIPTION_STATUS_SET, COMMERCE_PAYMENT_GROUP_STATUS_SET, COMMERCE_WEBHOOK_EVENT_STATUS_SET, COMMERCE_REFUND_STATUS_SET, COMMERCE_FULFILLMENT_STATUS_SET, COMMERCE_FULFILLMENT_EVENT_TYPE_SET, COMMERCE_SERVICE_REQUEST_STATUS_SET, COMMERCE_SERVICE_QUOTE_STATUS_SET, COMMERCE_SERVICE_CONTRACT_STATUS_SET, COMMERCE_SERVICE_EVENT_TYPE_SET, COMMERCE_CAPACITY_LISTING_STATUS_SET, COMMERCE_CAPACITY_INQUIRY_STATUS_SET, COMMERCE_CAPACITY_ACCESS_LEVEL_SET, COMMERCE_CAPACITY_RUNTIME_ISOLATION_LEVEL_SET, COMMERCE_CAPACITY_HUMAN_INVOLVEMENT_LEVEL_SET, COMMERCE_CAPACITY_AI_INVOLVEMENT_LEVEL_SET, COMMERCE_CAPACITY_DATA_ACCESS_LEVEL_SET, COMMERCE_CAPACITY_SECRET_ACCESS_LEVEL_SET, COMMERCE_VISIBILITY_SET, COMMERCE_FULFILLMENT_MODE_SET, COMMERCE_PRICE_STATUS_SET, COMMERCE_PRICE_INTERVAL_SET, COMMERCE_TAX_BEHAVIOR_SET, COMMERCE_COMMERCIAL_OFFER_MODES, COMMERCE_ZERO_PRICE_OFFER_MODES, COMMERCE_CAPACITY_LISTING_OFFER_MODES, serializeCommerceVendor, serializeCommerceVendorStripeAccount, serializeCommerceProduct, serializeCommerceOwnershipRecord, serializeCommerceStewardshipAssignment, serializeCommerceContribution, serializeCommerceGovernancePolicy, serializeCommerceOwnershipTransfer, serializeCommerceSuccessionEvent, serializeCommerceOwnershipWorkflowSummary, serializeCommerceProductVersion, serializeCommerceOffer, serializeCommercePrice, serializeCommerceGovernanceEvent, serializeCommerceCart, serializeCommerceCartItem, serializeCommerceCheckout, serializeCommerceOrder, serializeCommerceOrderItem, serializeCommerceRefund, serializeCommerceFulfillmentEvent, serializeCommerceVendorOrderSummary, serializeCommercePaymentGroup, serializeCommerceSubscription, serializeCommerceEntitlement, serializeCommerceBuyerStripeCustomer, serializeCommerceWebhookEvent } from './index.ts';

export function serializeCommerceServiceRequest(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        buyerTeamId: row.buyer_team_id,
        buyerUserId: row.buyer_user_id,
        vendorId: row.vendor_id,
        sellerTeamId: row.seller_team_id,
        productId: row.product_id,
        offerId: row.offer_id,
        status: row.status,
        requestedScope: row.requested_scope,
        approvedScope: row.approved_scope,
        accessNeeds: parseJson(row.access_needs_json, {}),
        buyerVisibleSummary: row.buyer_visible_summary,
        vendorPrivateNotes: row.vendor_private_notes,
        activeQuoteId: row.active_quote_id,
        approvedQuoteId: row.approved_quote_id,
        contractId: row.contract_id,
        relatedProjectId: row.related_project_id,
        relatedWorkdayId: row.related_workday_id,
        orderId: row.order_id,
        entitlementId: row.entitlement_id,
        ownershipSnapshot: parseJson(row.ownership_snapshot_json, {}),
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeCommerceServiceQuote(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        requestId: row.request_id,
        vendorId: row.vendor_id,
        sellerTeamId: row.seller_team_id,
        buyerTeamId: row.buyer_team_id,
        buyerUserId: row.buyer_user_id,
        quoteVersion: Number(row.quote_version ?? 1),
        status: row.status,
        title: row.title,
        scopeSummary: row.scope_summary,
        deliverables: parseJson(row.deliverables_json, []),
        assumptions: parseJson(row.assumptions_json, []),
        accessRequirements: parseJson(row.access_requirements_json, {}),
        governanceRequirements: parseJson(row.governance_requirements_json, {}),
        amount: Number(row.amount ?? 0),
        currency: row.currency,
        expiresAt: row.expires_at,
        buyerApprovedAt: row.buyer_approved_at,
        vendorApprovedAt: row.vendor_approved_at,
        acceptedAt: row.accepted_at,
        rejectedAt: row.rejected_at,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeCommerceServiceContract(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        requestId: row.request_id,
        quoteId: row.quote_id,
        vendorId: row.vendor_id,
        sellerTeamId: row.seller_team_id,
        buyerTeamId: row.buyer_team_id,
        buyerUserId: row.buyer_user_id,
        productId: row.product_id,
        offerId: row.offer_id,
        status: row.status,
        amount: Number(row.amount ?? 0),
        currency: row.currency,
        orderId: row.order_id,
        orderItemId: row.order_item_id,
        paymentGroupId: row.payment_group_id,
        entitlementId: row.entitlement_id,
        relatedProjectId: row.related_project_id,
        relatedWorkdayId: row.related_workday_id,
        ownershipSnapshot: parseJson(row.ownership_snapshot_json, {}),
        accessApprovalSnapshot: parseJson(row.access_approval_snapshot_json, {}),
        fulfillmentSummary: row.fulfillment_summary,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeCommerceServiceEvent(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        requestId: row.request_id,
        quoteId: row.quote_id,
        contractId: row.contract_id,
        eventType: row.event_type,
        actorType: row.actor_type,
        actorId: row.actor_id,
        priorState: row.prior_state,
        nextState: row.next_state,
        message: row.message,
        evidence: parseJson(row.evidence_json, {}),
        createdAt: row.created_at,
    };
}

export function serializeCommerceCapacityListing(row, options: any = {}) {
    if (!row)
        return null;
    const listing = {
        id: row.id,
        productId: row.product_id,
        vendorId: row.vendor_id,
        sellerTeamId: row.seller_team_id,
        capacityProviderId: row.capacity_provider_id,
        executionProviderId: row.execution_provider_id,
        status: row.status,
        accessLevel: row.access_level,
        runtimeIsolationLevel: row.runtime_isolation_level,
        humanInvolvementLevel: row.human_involvement_level,
        aiInvolvementLevel: row.ai_involvement_level,
        dataAccessLevel: row.data_access_level,
        secretAccessLevel: row.secret_access_level,
        supportedServiceTypes: parseJson(row.supported_service_types_json, []),
        supportedRegions: parseJson(row.supported_regions_json, []),
        runtimeRequirements: parseJson(row.runtime_requirements_json, {}),
        dataHandlingSummary: row.data_handling_summary,
        buyerVisibleRiskSummary: row.buyer_visible_risk_summary,
        governanceRequirements: parseJson(row.governance_requirements_json, {}),
        supportPolicy: row.support_policy,
        availabilitySummary: row.availability_summary,
        ownershipSnapshot: parseJson(row.ownership_snapshot_json, {}),
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
    if (options.publicSafe) {
        return {
            ...listing,
            capacityProviderId: null,
            executionProviderId: null,
            runtimeRequirements: {},
            governanceRequirements: {},
            metadata: {},
        };
    }
    return listing;
}

export function serializeCommerceCapacityListingInquiry(row, options: any = {}) {
    if (!row)
        return null;
    const inquiry = {
        id: row.id,
        listingId: row.listing_id,
        productId: row.product_id,
        vendorId: row.vendor_id,
        sellerTeamId: row.seller_team_id,
        buyerTeamId: row.buyer_team_id,
        buyerUserId: row.buyer_user_id,
        status: row.status,
        requestedServiceType: row.requested_service_type,
        requestedScope: row.requested_scope,
        dataAccessRequested: parseJson(row.data_access_requested_json, {}),
        secretAccessRequested: parseJson(row.secret_access_requested_json, {}),
        relatedProjectId: row.related_project_id,
        relatedWorkdayId: row.related_workday_id,
        governanceEvidence: parseJson(row.governance_evidence_json, {}),
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
    if (options.publicSafe) {
        return {
            ...inquiry,
            governanceEvidence: {},
            metadata: {},
        };
    }
    return inquiry;
}

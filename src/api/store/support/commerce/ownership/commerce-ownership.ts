import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { governanceVotingProvider } from '@treeseed/sdk';
import { containsPlaintextSecretMaterial, validateClientEncryptedEscrowMetadata, validateSecretsCapabilityRegistry, validateWritableSecretMetadata, } from '@treeseed/sdk/secrets-capability';
import { redactDeploymentValue } from '../../../../../market/hosting/deployment-actions.ts';
import { projectDeploymentAuditPayload } from '../../../../../market/governance/policy/deployment-governance.ts';
import { numberValue, parseJson } from '../../foundation.ts';
import { COMMERCE_PRODUCT_KINDS, COMMERCE_OFFER_MODES, COMMERCE_VENDOR_TRUST_LEVELS, COMMERCE_GOVERNANCE_STATES, COMMERCE_OWNERSHIP_MODELS, COMMERCE_STEWARDSHIP_ROLES, COMMERCE_STRIPE_ACCOUNT_STATUSES, COMMERCE_STRIPE_ONBOARDING_STATUSES, COMMERCE_STRIPE_ENVIRONMENTS, COMMERCE_STRIPE_SYNC_STATUSES, COMMERCE_ENTITLEMENT_STATUSES, COMMERCE_CART_STATUSES, COMMERCE_CHECKOUT_STATUSES, COMMERCE_ORDER_STATUSES, COMMERCE_ORDER_ITEM_STATUSES, COMMERCE_SUBSCRIPTION_STATUSES, COMMERCE_PAYMENT_GROUP_STATUSES, COMMERCE_WEBHOOK_EVENT_STATUSES, COMMERCE_REFUND_STATUSES, COMMERCE_FULFILLMENT_STATUSES, COMMERCE_FULFILLMENT_EVENT_TYPES, COMMERCE_SERVICE_REQUEST_STATUSES, COMMERCE_SERVICE_QUOTE_STATUSES, COMMERCE_SERVICE_CONTRACT_STATUSES, COMMERCE_SERVICE_EVENT_TYPES, COMMERCE_CAPACITY_LISTING_STATUSES, COMMERCE_CAPACITY_INQUIRY_STATUSES, COMMERCE_CAPACITY_ACCESS_LEVELS, COMMERCE_CAPACITY_RUNTIME_ISOLATION_LEVELS, COMMERCE_CAPACITY_HUMAN_INVOLVEMENT_LEVELS, COMMERCE_CAPACITY_AI_INVOLVEMENT_LEVELS, COMMERCE_CAPACITY_DATA_ACCESS_LEVELS, COMMERCE_CAPACITY_SECRET_ACCESS_LEVELS, COMMERCE_PRODUCT_KIND_SET, COMMERCE_OFFER_MODE_SET, COMMERCE_VENDOR_TRUST_LEVEL_SET, COMMERCE_GOVERNANCE_STATE_SET, COMMERCE_OWNERSHIP_MODEL_SET, COMMERCE_STEWARDSHIP_ROLE_SET, COMMERCE_STRIPE_ACCOUNT_STATUS_SET, COMMERCE_STRIPE_ONBOARDING_STATUS_SET, COMMERCE_STRIPE_ENVIRONMENT_SET, COMMERCE_STRIPE_SYNC_STATUS_SET, COMMERCE_ENTITLEMENT_STATUS_SET, COMMERCE_CART_STATUS_SET, COMMERCE_CHECKOUT_STATUS_SET, COMMERCE_ORDER_STATUS_SET, COMMERCE_ORDER_ITEM_STATUS_SET, COMMERCE_SUBSCRIPTION_STATUS_SET, COMMERCE_PAYMENT_GROUP_STATUS_SET, COMMERCE_WEBHOOK_EVENT_STATUS_SET, COMMERCE_REFUND_STATUS_SET, COMMERCE_FULFILLMENT_STATUS_SET, COMMERCE_FULFILLMENT_EVENT_TYPE_SET, COMMERCE_SERVICE_REQUEST_STATUS_SET, COMMERCE_SERVICE_QUOTE_STATUS_SET, COMMERCE_SERVICE_CONTRACT_STATUS_SET, COMMERCE_SERVICE_EVENT_TYPE_SET, COMMERCE_CAPACITY_LISTING_STATUS_SET, COMMERCE_CAPACITY_INQUIRY_STATUS_SET, COMMERCE_CAPACITY_ACCESS_LEVEL_SET, COMMERCE_CAPACITY_RUNTIME_ISOLATION_LEVEL_SET, COMMERCE_CAPACITY_HUMAN_INVOLVEMENT_LEVEL_SET, COMMERCE_CAPACITY_AI_INVOLVEMENT_LEVEL_SET, COMMERCE_CAPACITY_DATA_ACCESS_LEVEL_SET, COMMERCE_CAPACITY_SECRET_ACCESS_LEVEL_SET, COMMERCE_VISIBILITY_SET, COMMERCE_FULFILLMENT_MODE_SET, COMMERCE_PRICE_STATUS_SET, COMMERCE_PRICE_INTERVAL_SET, COMMERCE_TAX_BEHAVIOR_SET, COMMERCE_COMMERCIAL_OFFER_MODES, COMMERCE_ZERO_PRICE_OFFER_MODES, COMMERCE_CAPACITY_LISTING_OFFER_MODES, serializeCommerceVendor, serializeCommerceVendorStripeAccount, serializeCommerceProduct, serializeCommerceProductVersion, serializeCommerceOffer, serializeCommercePrice, serializeCommerceCart, serializeCommerceCartItem, serializeCommerceCheckout, serializeCommerceOrder, serializeCommerceOrderItem, serializeCommerceRefund, serializeCommerceFulfillmentEvent, serializeCommerceServiceRequest, serializeCommerceServiceQuote, serializeCommerceServiceContract, serializeCommerceServiceEvent, serializeCommerceCapacityListing, serializeCommerceCapacityListingInquiry, serializeCommerceVendorOrderSummary, serializeCommercePaymentGroup, serializeCommerceSubscription, serializeCommerceEntitlement, serializeCommerceBuyerStripeCustomer, serializeCommerceWebhookEvent } from '../../index.ts';

export function serializeCommerceOwnershipRecord(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        productId: row.product_id,
        model: row.model,
        canonicalOwnerType: row.canonical_owner_type,
        canonicalOwnerId: row.canonical_owner_id,
        sellerTeamId: row.seller_team_id,
        stewardTeamId: row.steward_team_id,
        governancePolicyId: row.governance_policy_id,
        publicSummary: row.public_summary,
        buyerVisible: Boolean(row.buyer_visible),
        effectiveAt: row.effective_at,
        supersededAt: row.superseded_at,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeCommerceStewardshipAssignment(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        ownershipRecordId: row.ownership_record_id,
        productId: row.product_id,
        role: row.role,
        assigneeType: row.assignee_type,
        assigneeId: row.assignee_id,
        displayName: row.display_name,
        responsibilities: parseJson(row.responsibilities_json, []),
        visibleToBuyers: Boolean(row.visible_to_buyers),
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeCommerceContribution(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        productId: row.product_id,
        productVersionId: row.product_version_id,
        contributorType: row.contributor_type,
        contributorId: row.contributor_id,
        displayName: row.display_name,
        role: row.role,
        summary: row.summary,
        attributionVisibility: row.attribution_visibility,
        agreementRef: row.agreement_ref,
        benefitWeight: numberValue(row.benefit_weight, null),
        effectiveAt: row.effective_at,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeCommerceGovernancePolicy(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        productId: row.product_id,
        teamId: row.team_id,
        policyKind: row.policy_kind,
        title: row.title,
        approvalRules: parseJson(row.approval_rules_json, {}),
        quorumRules: parseJson(row.quorum_rules_json, {}),
        buyerVisibleSummary: row.buyer_visible_summary,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeCommerceOwnershipTransfer(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        productId: row.product_id,
        fromOwnershipRecordId: row.from_ownership_record_id,
        toOwnershipRecordId: row.to_ownership_record_id,
        status: row.status ?? 'draft',
        reason: row.reason,
        approvalEvidence: parseJson(row.approval_evidence_json, {}),
        buyerVisibleImpact: row.buyer_visible_impact,
        effectiveAt: row.effective_at,
        requestedByType: row.requested_by_type ?? 'user',
        requestedById: row.requested_by_id ?? 'system',
        approvedByType: row.approved_by_type ?? null,
        approvedById: row.approved_by_id ?? null,
        approvedAt: row.approved_at ?? null,
        rejectedAt: row.rejected_at ?? null,
        supersededAt: row.superseded_at ?? null,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
    };
}

export function serializeCommerceSuccessionEvent(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        productId: row.product_id,
        ownershipRecordId: row.ownership_record_id,
        stewardshipAssignmentId: row.stewardship_assignment_id,
        successorType: row.successor_type,
        successorId: row.successor_id,
        eventType: row.event_type,
        status: row.status,
        reason: row.reason,
        evidence: parseJson(row.evidence_json, {}),
        effectiveAt: row.effective_at,
        createdByType: row.created_by_type,
        createdById: row.created_by_id,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
    };
}

export function serializeCommerceOwnershipWorkflowSummary(input: any = {}) {
    return {
        productId: input.productId,
        currentOwnershipRecord: input.currentOwnershipRecord ?? null,
        buyerVisibleOwnershipRecords: input.buyerVisibleOwnershipRecords ?? [],
        stewardshipAssignments: input.stewardshipAssignments ?? [],
        contributions: input.contributions ?? [],
        governancePolicies: input.governancePolicies ?? [],
        pendingTransfers: input.pendingTransfers ?? [],
        successionEvents: input.successionEvents ?? [],
    };
}

export function serializeCommerceGovernanceEvent(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        actorType: row.actor_type,
        actorId: row.actor_id,
        action: row.action,
        objectType: row.object_type,
        objectId: row.object_id,
        priorState: row.prior_state,
        nextState: row.next_state,
        reason: row.reason,
        evidence: parseJson(row.evidence_json, {}),
        relatedOrderId: row.related_order_id,
        relatedOfferId: row.related_offer_id,
        relatedProductId: row.related_product_id,
        relatedTeamId: row.related_team_id,
        createdAt: row.created_at,
    };
}

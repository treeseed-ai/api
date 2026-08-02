import { parseJson } from '../../foundation.ts';

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

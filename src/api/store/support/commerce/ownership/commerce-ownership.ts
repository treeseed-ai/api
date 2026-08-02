import { numberValue,parseJson } from '../../foundation.ts';

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

import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { governanceVotingProvider } from '@treeseed/sdk';
import { containsTreeseedPlaintextSecretMaterial, validateTreeseedClientEncryptedEscrowMetadata, validateTreeseedSecretsCapabilityRegistry, validateTreeseedWritableSecretMetadata, } from '@treeseed/sdk/secrets-capability';
import { redactDeploymentValue } from '../../../market/deployment-actions.ts';
import { projectDeploymentAuditPayload } from '../../../market/deployment-governance.ts';
import { getNodeBuiltin, safeStoragePathSegment, safeIdPart, artifactStorageRoot, isoNow, parseJson, missingSchemaError, objectValue, arrayValue, PROJECT_ARCHITECTURE_TOPOLOGIES, CONTENT_RUNTIME_SOURCES, LOCAL_CONTENT_MATERIALIZATIONS, CONTENT_PUBLISH_TARGETS, LEGACY_PROJECT_TOPOLOGIES, projectArchitectureError, normalizeProjectPath, normalizeProjectContentPublishTarget, normalizeProjectArchitecture, projectArchitectureContentSource, stringValue, optionalStringValue, numberValue, enumValue, requireEnumValue, stableHash, equalHash, tokenPrefix, normalizeOperationCapabilities, COMMERCE_PRODUCT_KINDS, COMMERCE_OFFER_MODES, COMMERCE_VENDOR_TRUST_LEVELS, COMMERCE_GOVERNANCE_STATES, COMMERCE_OWNERSHIP_MODELS, COMMERCE_STEWARDSHIP_ROLES, COMMERCE_STRIPE_ACCOUNT_STATUSES, COMMERCE_STRIPE_ONBOARDING_STATUSES, COMMERCE_STRIPE_ENVIRONMENTS, COMMERCE_STRIPE_SYNC_STATUSES, COMMERCE_ENTITLEMENT_STATUSES, COMMERCE_CART_STATUSES, COMMERCE_CHECKOUT_STATUSES, COMMERCE_ORDER_STATUSES, COMMERCE_ORDER_ITEM_STATUSES, COMMERCE_SUBSCRIPTION_STATUSES, COMMERCE_PAYMENT_GROUP_STATUSES, COMMERCE_WEBHOOK_EVENT_STATUSES, COMMERCE_REFUND_STATUSES, COMMERCE_FULFILLMENT_STATUSES, COMMERCE_FULFILLMENT_EVENT_TYPES, COMMERCE_SERVICE_REQUEST_STATUSES, COMMERCE_SERVICE_QUOTE_STATUSES, COMMERCE_SERVICE_CONTRACT_STATUSES, COMMERCE_SERVICE_EVENT_TYPES, COMMERCE_CAPACITY_LISTING_STATUSES, COMMERCE_CAPACITY_INQUIRY_STATUSES, COMMERCE_CAPACITY_ACCESS_LEVELS, COMMERCE_CAPACITY_RUNTIME_ISOLATION_LEVELS, COMMERCE_CAPACITY_HUMAN_INVOLVEMENT_LEVELS, COMMERCE_CAPACITY_AI_INVOLVEMENT_LEVELS, COMMERCE_CAPACITY_DATA_ACCESS_LEVELS, COMMERCE_CAPACITY_SECRET_ACCESS_LEVELS, COMMERCE_PRODUCT_KIND_SET, COMMERCE_OFFER_MODE_SET, COMMERCE_VENDOR_TRUST_LEVEL_SET, COMMERCE_GOVERNANCE_STATE_SET, COMMERCE_OWNERSHIP_MODEL_SET, COMMERCE_STEWARDSHIP_ROLE_SET, COMMERCE_STRIPE_ACCOUNT_STATUS_SET, COMMERCE_STRIPE_ONBOARDING_STATUS_SET, COMMERCE_STRIPE_ENVIRONMENT_SET, COMMERCE_STRIPE_SYNC_STATUS_SET, COMMERCE_ENTITLEMENT_STATUS_SET, COMMERCE_CART_STATUS_SET, COMMERCE_CHECKOUT_STATUS_SET, COMMERCE_ORDER_STATUS_SET, COMMERCE_ORDER_ITEM_STATUS_SET, COMMERCE_SUBSCRIPTION_STATUS_SET, COMMERCE_PAYMENT_GROUP_STATUS_SET, COMMERCE_WEBHOOK_EVENT_STATUS_SET, COMMERCE_REFUND_STATUS_SET, COMMERCE_FULFILLMENT_STATUS_SET, COMMERCE_FULFILLMENT_EVENT_TYPE_SET, COMMERCE_SERVICE_REQUEST_STATUS_SET, COMMERCE_SERVICE_QUOTE_STATUS_SET, COMMERCE_SERVICE_CONTRACT_STATUS_SET, COMMERCE_SERVICE_EVENT_TYPE_SET, COMMERCE_CAPACITY_LISTING_STATUS_SET, COMMERCE_CAPACITY_INQUIRY_STATUS_SET, COMMERCE_CAPACITY_ACCESS_LEVEL_SET, COMMERCE_CAPACITY_RUNTIME_ISOLATION_LEVEL_SET, COMMERCE_CAPACITY_HUMAN_INVOLVEMENT_LEVEL_SET, COMMERCE_CAPACITY_AI_INVOLVEMENT_LEVEL_SET, COMMERCE_CAPACITY_DATA_ACCESS_LEVEL_SET, COMMERCE_CAPACITY_SECRET_ACCESS_LEVEL_SET, COMMERCE_VISIBILITY_SET, COMMERCE_FULFILLMENT_MODE_SET, COMMERCE_PRICE_STATUS_SET, COMMERCE_PRICE_INTERVAL_SET, COMMERCE_TAX_BEHAVIOR_SET, COMMERCE_COMMERCIAL_OFFER_MODES, COMMERCE_ZERO_PRICE_OFFER_MODES, COMMERCE_CAPACITY_LISTING_OFFER_MODES, principalIsAdmin, TEAM_ROLE_CAPABILITIES, TEAM_ROLE_DESCRIPTIONS, ALL_TEAM_CAPABILITIES, CAPABILITY_PERMISSIONS, TEAM_DELETION_CONFIRMATION_PREFIX, TEAM_MANAGEMENT_ROLES, TEAM_RESERVED_NAMES, normalizeTeamName, validateTeamName, teamDeletionConfirmationMatches, projectDeletionConfirmationMatches, normalizeProjectSlug, validateProjectSlug, normalizeBaseUrl, signAssertionPayload, uniqueCapabilities, normalizeTeamRoleKey, primaryTeamRole, projectConnectionModeFromHosting, serializeTeam, teamIsPrivate, centralTreeDxRegistryUrl, normalizeAllocationSlices, serializeTeamMember, serializeTeamWebHost, SUPPORTED_TEAM_HOST_PROVIDERS, normalizedStrings, serializeApprovalRequest, serializeSeedRun, serializeTeamInvite, serializeProject, isoDate, compareDatesDesc, latestDate, uniqueStrings, PROJECT_DEPLOYMENT_TERMINAL_STATUSES, PROJECT_DEPLOYMENT_ACTIVE_STATUSES, normalizeProjectDeploymentStatus, deploymentKindForAction, summarizeProjectHealth, summarizeDeploymentStatus, toActivityItem, serializeConnection, serializeRepositoryHost, serializeHubRepository, serializeHubContentSource, serializeTreeDxInstance, serializeTreeDxProjectLibrary, serializeTreeDxMirror, serializeTreeDxShare, serializeTreeDxDeployment, serializeHubLaunch, serializeHubLaunchEvent, serializeHubWorkspaceLink, serializeProjectUpdatePlan, serializeProviderCredentialSession, serializeCapability, serializeEntitlement, serializeJob, serializeJobEvent, serializePlatformOperation, serializePlatformOperationEvent, serializeMarketOperationRunner, serializePlatformRepositoryClaim, platformRepositoryKey, platformRepositoryWorkspacePath, serializeAuditEvent, serializeSecretMetadataRecord, serializeClientEncryptedEscrowRecord, serializeGitHubRepositoryGrant, serializeGitHubAppInstallationRecord, serializeGitHubAppTokenIssuanceRecord, serializeWorkflowOperationRecord, serializeWorkflowDispatchRecord, serializeTreeDxCredentialIssuanceRecord, secretCapabilityValidationError, rejectSecretCapabilityPlaintext, serializeKnowledgePack, serializeTeamStorageLocator, serializeCatalogItem, serializeCatalogArtifactVersion, serializeCommerceVendor, serializeCommerceVendorStripeAccount, serializeCommerceProduct, serializeCommerceOwnershipRecord, serializeCommerceStewardshipAssignment, serializeCommerceContribution, serializeCommerceGovernancePolicy, serializeCommerceOwnershipTransfer, serializeCommerceSuccessionEvent, serializeCommerceOwnershipWorkflowSummary, serializeCommerceProductVersion, serializeCommerceOffer, serializeCommercePrice, serializeCommerceGovernanceEvent, serializeCommerceCart, serializeCommerceCartItem, serializeCommerceCheckout, serializeCommerceOrder, serializeCommerceOrderItem, serializeCommerceRefund, serializeCommerceFulfillmentEvent, serializeCommerceServiceRequest, serializeCommerceServiceQuote, serializeCommerceServiceContract, serializeCommerceServiceEvent, serializeCommerceCapacityListing, serializeCommerceCapacityListingInquiry, redactBuyerUserId, serializeCommerceVendorOrderSummary, serializeCommercePaymentGroup, serializeCommerceSubscription, serializeCommerceEntitlement, serializeCommerceBuyerStripeCustomer, serializeCommerceWebhookEvent, serializeProjectHosting, serializeProjectEnvironment, serializeProjectInfrastructureResource, serializeProjectDeployment, serializeProjectDeploymentEvent, serializeTeamInboxItem, serializeProjectSummarySnapshot } from './index.ts';

export function governanceContentHash(input: any = {}) {
    const payload = {
        title: String(input.title ?? '').trim(),
        summary: String(input.summary ?? '').trim(),
        body: String(input.body ?? '').trim(),
        proposalType: String(input.proposalType ?? input.proposal_type ?? '').trim(),
        relatedObjectives: arrayValue(input.relatedObjectives ?? input.related_objectives).map(String).sort(),
        relatedQuestions: arrayValue(input.relatedQuestions ?? input.related_questions).map(String).sort(),
        relatedNotes: arrayValue(input.relatedNotes ?? input.related_notes).map(String).sort(),
        relatedBooks: arrayValue(input.relatedBooks ?? input.related_books).map(String).sort(),
    };
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function governanceSlug(value, fallback = 'proposal') {
    return safeIdPart(value, fallback).replace(/_+/gu, '-');
}

export const TREESEED_COMMONS_TEAM_SLUG = 'treeseed';

export const COMMONS_WEIGHT_POLICY_VERSION = 'commons-v1';

export const COMMONS_BACKING_THRESHOLD = 3;

export const COMMONS_WEIGHT_THRESHOLD = 3;

export const COMMONS_TOTAL_WEIGHT_CAP = 5;

export const COMMONS_DELEGATED_WEIGHT_CAP = 2;

export function serializeCommonsParticipant(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        userId: row.user_id,
        teamId: row.team_id,
        status: row.status,
        displayName: row.display_name,
        verifiedEmail: Number(row.verified_email ?? 0) === 1,
        baseWeight: Number(row.base_weight ?? 1),
        trustWeight: Number(row.trust_weight ?? 0),
        contributionWeight: Number(row.contribution_weight ?? 0),
        stakeholderWeight: Number(row.stakeholder_weight ?? 0),
        delegatedWeight: Number(row.delegated_weight ?? 0),
        totalWeight: Number(row.total_weight ?? 1),
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeCommonsQuestion(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        participantId: row.participant_id,
        userId: row.user_id,
        teamId: row.team_id,
        status: row.status,
        title: row.title,
        body: row.body,
        answer: row.answer,
        convertedProposalId: row.converted_proposal_id,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeCommonsProposal(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        participantId: row.participant_id,
        userId: row.user_id,
        teamId: row.team_id,
        status: row.status,
        title: row.title,
        summary: row.summary,
        body: row.body,
        scope: row.scope,
        decisionType: row.decision_type,
        contentProposalSlug: row.content_proposal_slug,
        contentDecisionSlug: row.content_decision_slug,
        backingCount: Number(row.backing_count ?? 0),
        voteSupportWeight: Number(row.vote_support_weight ?? 0),
        voteObjectWeight: Number(row.vote_object_weight ?? 0),
        voteAbstainWeight: Number(row.vote_abstain_weight ?? 0),
        qualifiedAt: row.qualified_at,
        votingStartsAt: row.voting_starts_at,
        votingEndsAt: row.voting_ends_at,
        stewardDecisionAt: row.steward_decision_at,
        stewardDecisionBy: row.steward_decision_by,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeCommonsWeightSnapshot(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        participantId: row.participant_id,
        policyVersion: row.policy_version,
        baseWeight: Number(row.base_weight ?? 1),
        verifiedEmailWeight: Number(row.verified_email_weight ?? 0),
        accountAgeWeight: Number(row.account_age_weight ?? 0),
        contributionWeight: Number(row.contribution_weight ?? 0),
        stakeholderWeight: Number(row.stakeholder_weight ?? 0),
        trustRoleWeight: Number(row.trust_role_weight ?? 0),
        delegatedWeight: Number(row.delegated_weight ?? 0),
        totalWeight: Number(row.total_weight ?? 1),
        evidence: parseJson(row.evidence_json, {}),
        createdAt: row.created_at,
    };
}

export function serializeCommonsProposalBacking(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        proposalId: row.proposal_id,
        participantId: row.participant_id,
        userId: row.user_id,
        weightSnapshotId: row.weight_snapshot_id,
        weight: Number(row.weight ?? 0),
        reason: row.reason,
        createdAt: row.created_at,
    };
}

export function serializeCommonsProposalVote(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        proposalId: row.proposal_id,
        participantId: row.participant_id,
        userId: row.user_id,
        vote: row.vote,
        weightSnapshotId: row.weight_snapshot_id,
        weight: Number(row.weight ?? 0),
        reason: row.reason,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeCommonsDelegation(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        fromParticipantId: row.from_participant_id,
        toParticipantId: row.to_participant_id,
        scope: row.scope,
        status: row.status,
        weightLimit: row.weight_limit == null ? null : Number(row.weight_limit),
        reason: row.reason,
        createdAt: row.created_at,
        revokedAt: row.revoked_at,
    };
}

export function serializeCommonsDecision(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        proposalId: row.proposal_id,
        status: row.status,
        decisionRecordId: row.decision_record_id,
        decisionRecordSlug: row.decision_record_slug,
        title: row.title,
        summary: row.summary,
        stewardReason: row.steward_reason,
        capacityBudget: row.capacity_budget,
        scheduledFor: row.scheduled_for,
        implementedAt: row.implemented_at,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeCommonsGovernanceEvent(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        eventType: row.event_type,
        actorType: row.actor_type,
        actorId: row.actor_id,
        participantId: row.participant_id,
        proposalId: row.proposal_id,
        questionId: row.question_id,
        decisionId: row.decision_id,
        priorState: row.prior_state,
        nextState: row.next_state,
        message: row.message,
        evidence: parseJson(row.evidence_json, {}),
        createdAt: row.created_at,
    };
}

export function serializeGovernancePolicy(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        teamId: row.team_id,
        projectId: row.project_id ?? null,
        scope: row.scope ?? 'team',
        providerId: row.provider_id,
        providerVersion: row.provider_version,
        config: parseJson(row.config_json, {}),
        active: Number(row.active ?? 1) === 1,
        createdBy: row.created_by ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        supersededAt: row.superseded_at ?? null,
    };
}

export function serializeGovernanceProposal(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        teamId: row.team_id,
        projectId: row.project_id,
        scope: row.scope,
        status: row.status,
        title: row.title,
        summary: row.summary,
        body: row.body,
        proposalType: row.proposal_type,
        contentProposalSlug: row.content_proposal_slug,
        contentDecisionSlug: row.content_decision_slug,
        activeVersion: Number(row.active_version ?? 1),
        activeContentHash: row.active_content_hash,
        governanceProviderId: row.governance_provider_id,
        governanceProviderVersion: row.governance_provider_version,
        governancePolicyId: row.governance_policy_id,
        decisionId: row.decision_id,
        votingStartsAt: row.voting_starts_at,
        votingEndsAt: row.voting_ends_at,
        closedAt: row.closed_at,
        closedReason: row.closed_reason,
        createdByType: row.created_by_type,
        createdById: row.created_by_id,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeGovernanceElectorateSnapshot(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        proposalId: row.proposal_id,
        proposalVersion: Number(row.proposal_version ?? 1),
        providerId: row.provider_id,
        providerVersion: row.provider_version,
        ruleSnapshot: parseJson(row.rule_snapshot_json, {}),
        chambers: parseJson(row.chambers_json, []),
        eligibleVoters: parseJson(row.eligible_voters_json, []),
        delegations: parseJson(row.delegations_json, []),
        eligibleWeightTotal: Number(row.eligible_weight_total ?? 0),
        activeWeightTotal: Number(row.active_weight_total ?? 0),
        createdAt: row.created_at,
    };
}

export function serializeGovernanceVote(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        proposalId: row.proposal_id,
        proposalVersion: Number(row.proposal_version ?? 1),
        userId: row.user_id,
        vote: row.vote,
        reason: row.reason,
        chamberVotes: parseJson(row.chamber_votes_json, {}),
        effectiveWeights: parseJson(row.effective_weights_json, {}),
        delegatedFrom: parseJson(row.delegated_from_json, []),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeGovernanceDelegation(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        teamId: row.team_id,
        scope: row.scope,
        fromUserId: row.from_user_id,
        toUserId: row.to_user_id,
        chambers: parseJson(row.chambers_json, []),
        status: row.status,
        reason: row.reason,
        createdAt: row.created_at,
        revokedAt: row.revoked_at,
        expiresAt: row.expires_at,
        metadata: parseJson(row.metadata_json, {}),
    };
}

export function serializeGovernanceDecision(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        teamId: row.team_id,
        projectId: row.project_id,
        proposalId: row.proposal_id,
        proposalVersion: Number(row.proposal_version ?? 1),
        proposalContentHash: row.proposal_content_hash,
        status: row.status,
        title: row.title,
        summary: row.summary,
        contentDecisionSlug: row.content_decision_slug,
        governanceProviderId: row.governance_provider_id,
        governanceRule: parseJson(row.governance_rule_json, {}),
        electorateSnapshotId: row.electorate_snapshot_id,
        voteResult: parseJson(row.vote_result_json, {}),
        voterReasons: parseJson(row.voter_reasons_json, []),
        proposalSnapshot: parseJson(row.proposal_snapshot_json, {}),
        decisionRecord: parseJson(row.decision_record_json, {}),
        createdByType: row.created_by_type,
        createdById: row.created_by_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        supersededAt: row.superseded_at,
    };
}

export function serializeGovernanceEvent(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        eventType: row.event_type,
        actorType: row.actor_type,
        actorId: row.actor_id,
        teamId: row.team_id,
        projectId: row.project_id,
        proposalId: row.proposal_id,
        decisionId: row.decision_id,
        proposalVersion: row.proposal_version == null ? null : Number(row.proposal_version),
        priorState: row.prior_state,
        nextState: row.next_state,
        message: row.message,
        evidence: parseJson(row.evidence_json, {}),
        createdAt: row.created_at,
    };
}

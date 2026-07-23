import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { governanceVotingProvider } from '@treeseed/sdk';
import { containsTreeseedPlaintextSecretMaterial, validateTreeseedClientEncryptedEscrowMetadata, validateTreeseedSecretsCapabilityRegistry, validateTreeseedWritableSecretMetadata, } from '@treeseed/sdk/secrets-capability';
import { redactDeploymentValue } from '../../../market/deployment-actions.ts';
import { projectDeploymentAuditPayload } from '../../../market/deployment-governance.ts';
import { getNodeBuiltin, safeStoragePathSegment, safeIdPart, artifactStorageRoot, isoNow, parseJson, missingSchemaError, objectValue, arrayValue, governanceContentHash, governanceSlug, PROJECT_ARCHITECTURE_TOPOLOGIES, CONTENT_RUNTIME_SOURCES, LOCAL_CONTENT_MATERIALIZATIONS, CONTENT_PUBLISH_TARGETS, LEGACY_PROJECT_TOPOLOGIES, projectArchitectureError, normalizeProjectPath, normalizeProjectContentPublishTarget, normalizeProjectArchitecture, projectArchitectureContentSource, stringValue, optionalStringValue, numberValue, enumValue, requireEnumValue, stableHash, equalHash, tokenPrefix, normalizeOperationCapabilities, COMMERCE_PRODUCT_KINDS, COMMERCE_OFFER_MODES, COMMERCE_VENDOR_TRUST_LEVELS, COMMERCE_GOVERNANCE_STATES, COMMERCE_OWNERSHIP_MODELS, COMMERCE_STEWARDSHIP_ROLES, COMMERCE_STRIPE_ACCOUNT_STATUSES, COMMERCE_STRIPE_ONBOARDING_STATUSES, COMMERCE_STRIPE_ENVIRONMENTS, COMMERCE_STRIPE_SYNC_STATUSES, COMMERCE_ENTITLEMENT_STATUSES, COMMERCE_CART_STATUSES, COMMERCE_CHECKOUT_STATUSES, COMMERCE_ORDER_STATUSES, COMMERCE_ORDER_ITEM_STATUSES, COMMERCE_SUBSCRIPTION_STATUSES, COMMERCE_PAYMENT_GROUP_STATUSES, COMMERCE_WEBHOOK_EVENT_STATUSES, COMMERCE_REFUND_STATUSES, COMMERCE_FULFILLMENT_STATUSES, COMMERCE_FULFILLMENT_EVENT_TYPES, COMMERCE_SERVICE_REQUEST_STATUSES, COMMERCE_SERVICE_QUOTE_STATUSES, COMMERCE_SERVICE_CONTRACT_STATUSES, COMMERCE_SERVICE_EVENT_TYPES, COMMERCE_CAPACITY_LISTING_STATUSES, COMMERCE_CAPACITY_INQUIRY_STATUSES, COMMERCE_CAPACITY_ACCESS_LEVELS, COMMERCE_CAPACITY_RUNTIME_ISOLATION_LEVELS, COMMERCE_CAPACITY_HUMAN_INVOLVEMENT_LEVELS, COMMERCE_CAPACITY_AI_INVOLVEMENT_LEVELS, COMMERCE_CAPACITY_DATA_ACCESS_LEVELS, COMMERCE_CAPACITY_SECRET_ACCESS_LEVELS, COMMERCE_PRODUCT_KIND_SET, COMMERCE_OFFER_MODE_SET, COMMERCE_VENDOR_TRUST_LEVEL_SET, COMMERCE_GOVERNANCE_STATE_SET, COMMERCE_OWNERSHIP_MODEL_SET, COMMERCE_STEWARDSHIP_ROLE_SET, COMMERCE_STRIPE_ACCOUNT_STATUS_SET, COMMERCE_STRIPE_ONBOARDING_STATUS_SET, COMMERCE_STRIPE_ENVIRONMENT_SET, COMMERCE_STRIPE_SYNC_STATUS_SET, COMMERCE_ENTITLEMENT_STATUS_SET, COMMERCE_CART_STATUS_SET, COMMERCE_CHECKOUT_STATUS_SET, COMMERCE_ORDER_STATUS_SET, COMMERCE_ORDER_ITEM_STATUS_SET, COMMERCE_SUBSCRIPTION_STATUS_SET, COMMERCE_PAYMENT_GROUP_STATUS_SET, COMMERCE_WEBHOOK_EVENT_STATUS_SET, COMMERCE_REFUND_STATUS_SET, COMMERCE_FULFILLMENT_STATUS_SET, COMMERCE_FULFILLMENT_EVENT_TYPE_SET, COMMERCE_SERVICE_REQUEST_STATUS_SET, COMMERCE_SERVICE_QUOTE_STATUS_SET, COMMERCE_SERVICE_CONTRACT_STATUS_SET, COMMERCE_SERVICE_EVENT_TYPE_SET, COMMERCE_CAPACITY_LISTING_STATUS_SET, COMMERCE_CAPACITY_INQUIRY_STATUS_SET, COMMERCE_CAPACITY_ACCESS_LEVEL_SET, COMMERCE_CAPACITY_RUNTIME_ISOLATION_LEVEL_SET, COMMERCE_CAPACITY_HUMAN_INVOLVEMENT_LEVEL_SET, COMMERCE_CAPACITY_AI_INVOLVEMENT_LEVEL_SET, COMMERCE_CAPACITY_DATA_ACCESS_LEVEL_SET, COMMERCE_CAPACITY_SECRET_ACCESS_LEVEL_SET, COMMERCE_VISIBILITY_SET, COMMERCE_FULFILLMENT_MODE_SET, COMMERCE_PRICE_STATUS_SET, COMMERCE_PRICE_INTERVAL_SET, COMMERCE_TAX_BEHAVIOR_SET, COMMERCE_COMMERCIAL_OFFER_MODES, COMMERCE_ZERO_PRICE_OFFER_MODES, COMMERCE_CAPACITY_LISTING_OFFER_MODES, principalIsAdmin, TEAM_ROLE_CAPABILITIES, TEAM_ROLE_DESCRIPTIONS, ALL_TEAM_CAPABILITIES, CAPABILITY_PERMISSIONS, TEAM_DELETION_CONFIRMATION_PREFIX, TEAM_MANAGEMENT_ROLES, TEAM_RESERVED_NAMES, TREESEED_COMMONS_TEAM_SLUG, COMMONS_WEIGHT_POLICY_VERSION, COMMONS_BACKING_THRESHOLD, COMMONS_WEIGHT_THRESHOLD, COMMONS_TOTAL_WEIGHT_CAP, COMMONS_DELEGATED_WEIGHT_CAP, normalizeTeamName, validateTeamName, teamDeletionConfirmationMatches, projectDeletionConfirmationMatches, normalizeProjectSlug, validateProjectSlug, normalizeBaseUrl, signAssertionPayload, uniqueCapabilities, normalizeTeamRoleKey, primaryTeamRole, serializeTeam, teamIsPrivate, centralTreeDxRegistryUrl, normalizeAllocationSlices, serializeTeamMember, serializeTeamWebHost, SUPPORTED_TEAM_HOST_PROVIDERS, normalizedStrings, serializeApprovalRequest, serializeCommonsParticipant, serializeCommonsQuestion, serializeCommonsProposal, serializeCommonsWeightSnapshot, serializeCommonsProposalBacking, serializeCommonsProposalVote, serializeCommonsDelegation, serializeCommonsDecision, serializeCommonsGovernanceEvent, serializeGovernancePolicy, serializeGovernanceProposal, serializeGovernanceElectorateSnapshot, serializeGovernanceVote, serializeGovernanceDelegation, serializeGovernanceDecision, serializeGovernanceEvent, serializeSeedRun, serializeTeamInvite, serializeProject, isoDate, compareDatesDesc, latestDate, uniqueStrings, summarizeProjectHealth, toActivityItem, serializeConnection, serializeRepositoryHost, serializeHubRepository, serializeHubContentSource, serializeTreeDxInstance, serializeTreeDxProjectLibrary, serializeTreeDxMirror, serializeTreeDxShare, serializeTreeDxDeployment, serializeHubLaunch, serializeHubLaunchEvent, serializeHubWorkspaceLink, serializeProjectUpdatePlan, serializeProviderCredentialSession, serializeCapability, serializeEntitlement, serializeJob, serializeJobEvent, serializePlatformOperation, serializePlatformOperationEvent, serializeMarketOperationRunner, serializePlatformRepositoryClaim, platformRepositoryKey, platformRepositoryWorkspacePath, serializeAuditEvent, serializeSecretMetadataRecord, serializeClientEncryptedEscrowRecord, serializeGitHubRepositoryGrant, serializeGitHubAppInstallationRecord, serializeGitHubAppTokenIssuanceRecord, serializeWorkflowOperationRecord, serializeWorkflowDispatchRecord, serializeTreeDxCredentialIssuanceRecord, secretCapabilityValidationError, rejectSecretCapabilityPlaintext, serializeKnowledgePack, serializeTeamStorageLocator, serializeCatalogItem, serializeCatalogArtifactVersion, serializeCommerceVendor, serializeCommerceVendorStripeAccount, serializeCommerceProduct, serializeCommerceOwnershipRecord, serializeCommerceStewardshipAssignment, serializeCommerceContribution, serializeCommerceGovernancePolicy, serializeCommerceOwnershipTransfer, serializeCommerceSuccessionEvent, serializeCommerceOwnershipWorkflowSummary, serializeCommerceProductVersion, serializeCommerceOffer, serializeCommercePrice, serializeCommerceGovernanceEvent, serializeCommerceCart, serializeCommerceCartItem, serializeCommerceCheckout, serializeCommerceOrder, serializeCommerceOrderItem, serializeCommerceRefund, serializeCommerceFulfillmentEvent, serializeCommerceServiceRequest, serializeCommerceServiceQuote, serializeCommerceServiceContract, serializeCommerceServiceEvent, serializeCommerceCapacityListing, serializeCommerceCapacityListingInquiry, redactBuyerUserId, serializeCommerceVendorOrderSummary, serializeCommercePaymentGroup, serializeCommerceSubscription, serializeCommerceEntitlement, serializeCommerceBuyerStripeCustomer, serializeCommerceWebhookEvent, serializeProjectEnvironment, serializeTeamInboxItem, serializeProjectSummarySnapshot } from './index.ts';

export function projectConnectionModeFromHosting(kind, registration = 'none') {
    if (kind === 'hosted_project') {
        return 'hosted';
    }
    if (kind === 'self_hosted_project') {
        return registration === 'optional' ? 'hybrid' : 'self_hosted';
    }
    return 'hosted';
}

export const PROJECT_DEPLOYMENT_TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);

export const PROJECT_DEPLOYMENT_ACTIVE_STATUSES = new Set(['queued', 'claimed', 'dispatching', 'running', 'monitoring']);

export function normalizeProjectDeploymentStatus(value, fallback = 'queued') {
    const status = typeof value === 'string' ? value.trim() : '';
    if (status === 'success')
        return 'succeeded';
    if (status === 'pending')
        return 'queued';
    return status || fallback;
}

export function deploymentKindForAction(action) {
    if (action === 'publish_content')
        return 'content';
    if (action === 'monitor')
        return 'mixed';
    return 'code';
}

export function summarizeDeploymentStatus(deployment) {
    if (!deployment) {
        return null;
    }
    return {
        id: deployment.id,
        environment: deployment.environment,
        status: deployment.status,
        deploymentKind: deployment.deploymentKind,
        releaseTag: deployment.releaseTag,
        commitSha: deployment.commitSha,
        sourceRef: deployment.sourceRef,
        finishedAt: deployment.finishedAt,
        startedAt: deployment.startedAt,
    };
}

export function serializeProjectHosting(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        projectId: row.project_id,
        kind: row.hosting_kind,
        registration: row.registration,
        marketBaseUrl: row.market_base_url,
        sourceRepoOwner: row.source_repo_owner,
        sourceRepoName: row.source_repo_name,
        sourceRepoUrl: row.source_repo_url,
        sourceRepoWorkflowPath: row.source_repo_workflow_path,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeProjectInfrastructureResource(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        projectId: row.project_id,
        environment: row.environment,
        provider: row.provider,
        resourceKind: row.resource_kind,
        logicalName: row.logical_name,
        locator: row.locator,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeProjectDeployment(row) {
    if (!row)
        return null;
    const metadata = redactDeploymentValue(parseJson(row.metadata_json, {}));
    return {
        id: row.id,
        teamId: row.team_id ?? metadata.teamId ?? null,
        projectId: row.project_id,
        environment: row.environment,
        deploymentKind: row.deployment_kind,
        action: row.action ?? metadata.action ?? (row.deployment_kind === 'content' ? 'publish_content' : 'deploy_web'),
        status: row.status,
        platformOperationId: row.platform_operation_id ?? null,
        retryOfDeploymentId: row.retry_of_deployment_id ?? null,
        resumedFromDeploymentId: row.resumed_from_deployment_id ?? null,
        idempotencyKey: row.idempotency_key ?? null,
        requestedByUserId: row.requested_by_user_id ?? null,
        sourceRef: row.source_ref,
        releaseTag: row.release_tag,
        commitSha: row.commit_sha,
        triggeredByType: row.triggered_by_type,
        triggeredById: row.triggered_by_id,
        repository: redactDeploymentValue(parseJson(row.repository_json, metadata.repository ?? {})),
        externalWorkflow: redactDeploymentValue(parseJson(row.external_workflow_json, metadata.externalWorkflow ?? {})),
        target: redactDeploymentValue(parseJson(row.target_json, metadata.target ?? {})),
        monitor: redactDeploymentValue(parseJson(row.monitor_json, metadata.monitor ?? {})),
        summary: row.summary ?? metadata.summary ?? null,
        error: redactDeploymentValue(parseJson(row.error_json, metadata.error ?? {})),
        metadata,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at ?? row.finished_at ?? null,
    };
}

export function serializeProjectDeploymentEvent(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        deploymentId: row.deployment_id,
        projectId: row.project_id,
        teamId: row.team_id,
        operationId: row.operation_id ?? null,
        kind: row.kind,
        message: row.message,
        status: row.status ?? null,
        severity: row.severity ?? 'info',
        sequence: Number(row.sequence ?? 0),
        payload: redactDeploymentValue(parseJson(row.payload_json, {})),
        createdAt: row.created_at,
    };
}

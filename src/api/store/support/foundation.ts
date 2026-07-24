import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { governanceVotingProvider } from '@treeseed/sdk';
import { containsPlaintextSecretMaterial, validateClientEncryptedEscrowMetadata, validateSecretsCapabilityRegistry, validateWritableSecretMetadata, } from '@treeseed/sdk/secrets-capability';
import { redactDeploymentValue } from '../../../market/hosting/deployment-actions.ts';
import { projectDeploymentAuditPayload } from '../../../market/governance/policy/deployment-governance.ts';
import { artifactStorageRoot, governanceContentHash, governanceSlug, PROJECT_ARCHITECTURE_TOPOLOGIES, LEGACY_PROJECT_TOPOLOGIES, projectArchitectureError, normalizeProjectPath, normalizeProjectContentPublishTarget, normalizeProjectArchitecture, projectArchitectureContentSource, stableHash, equalHash, tokenPrefix, normalizeOperationCapabilities, COMMERCE_PRODUCT_KINDS, COMMERCE_OFFER_MODES, COMMERCE_VENDOR_TRUST_LEVELS, COMMERCE_GOVERNANCE_STATES, COMMERCE_OWNERSHIP_MODELS, COMMERCE_STEWARDSHIP_ROLES, COMMERCE_STRIPE_ACCOUNT_STATUSES, COMMERCE_STRIPE_ONBOARDING_STATUSES, COMMERCE_STRIPE_ENVIRONMENTS, COMMERCE_STRIPE_SYNC_STATUSES, COMMERCE_ENTITLEMENT_STATUSES, COMMERCE_CART_STATUSES, COMMERCE_CHECKOUT_STATUSES, COMMERCE_ORDER_STATUSES, COMMERCE_ORDER_ITEM_STATUSES, COMMERCE_SUBSCRIPTION_STATUSES, COMMERCE_PAYMENT_GROUP_STATUSES, COMMERCE_WEBHOOK_EVENT_STATUSES, COMMERCE_REFUND_STATUSES, COMMERCE_FULFILLMENT_STATUSES, COMMERCE_FULFILLMENT_EVENT_TYPES, COMMERCE_SERVICE_REQUEST_STATUSES, COMMERCE_SERVICE_QUOTE_STATUSES, COMMERCE_SERVICE_CONTRACT_STATUSES, COMMERCE_SERVICE_EVENT_TYPES, COMMERCE_CAPACITY_LISTING_STATUSES, COMMERCE_CAPACITY_INQUIRY_STATUSES, COMMERCE_CAPACITY_ACCESS_LEVELS, COMMERCE_CAPACITY_RUNTIME_ISOLATION_LEVELS, COMMERCE_CAPACITY_HUMAN_INVOLVEMENT_LEVELS, COMMERCE_CAPACITY_AI_INVOLVEMENT_LEVELS, COMMERCE_CAPACITY_DATA_ACCESS_LEVELS, COMMERCE_CAPACITY_SECRET_ACCESS_LEVELS, COMMERCE_PRODUCT_KIND_SET, COMMERCE_OFFER_MODE_SET, COMMERCE_VENDOR_TRUST_LEVEL_SET, COMMERCE_GOVERNANCE_STATE_SET, COMMERCE_OWNERSHIP_MODEL_SET, COMMERCE_STEWARDSHIP_ROLE_SET, COMMERCE_STRIPE_ACCOUNT_STATUS_SET, COMMERCE_STRIPE_ONBOARDING_STATUS_SET, COMMERCE_STRIPE_ENVIRONMENT_SET, COMMERCE_STRIPE_SYNC_STATUS_SET, COMMERCE_ENTITLEMENT_STATUS_SET, COMMERCE_CART_STATUS_SET, COMMERCE_CHECKOUT_STATUS_SET, COMMERCE_ORDER_STATUS_SET, COMMERCE_ORDER_ITEM_STATUS_SET, COMMERCE_SUBSCRIPTION_STATUS_SET, COMMERCE_PAYMENT_GROUP_STATUS_SET, COMMERCE_WEBHOOK_EVENT_STATUS_SET, COMMERCE_REFUND_STATUS_SET, COMMERCE_FULFILLMENT_STATUS_SET, COMMERCE_FULFILLMENT_EVENT_TYPE_SET, COMMERCE_SERVICE_REQUEST_STATUS_SET, COMMERCE_SERVICE_QUOTE_STATUS_SET, COMMERCE_SERVICE_CONTRACT_STATUS_SET, COMMERCE_SERVICE_EVENT_TYPE_SET, COMMERCE_CAPACITY_LISTING_STATUS_SET, COMMERCE_CAPACITY_INQUIRY_STATUS_SET, COMMERCE_CAPACITY_ACCESS_LEVEL_SET, COMMERCE_CAPACITY_RUNTIME_ISOLATION_LEVEL_SET, COMMERCE_CAPACITY_HUMAN_INVOLVEMENT_LEVEL_SET, COMMERCE_CAPACITY_AI_INVOLVEMENT_LEVEL_SET, COMMERCE_CAPACITY_DATA_ACCESS_LEVEL_SET, COMMERCE_CAPACITY_SECRET_ACCESS_LEVEL_SET, COMMERCE_VISIBILITY_SET, COMMERCE_FULFILLMENT_MODE_SET, COMMERCE_PRICE_STATUS_SET, COMMERCE_PRICE_INTERVAL_SET, COMMERCE_TAX_BEHAVIOR_SET, COMMERCE_COMMERCIAL_OFFER_MODES, COMMERCE_ZERO_PRICE_OFFER_MODES, COMMERCE_CAPACITY_LISTING_OFFER_MODES, TEAM_ROLE_CAPABILITIES, TEAM_ROLE_DESCRIPTIONS, ALL_TEAM_CAPABILITIES, CAPABILITY_PERMISSIONS, TEAM_DELETION_CONFIRMATION_PREFIX, TEAM_MANAGEMENT_ROLES, TEAM_RESERVED_NAMES, COMMONS_TEAM_SLUG, COMMONS_WEIGHT_POLICY_VERSION, COMMONS_BACKING_THRESHOLD, COMMONS_WEIGHT_THRESHOLD, COMMONS_TOTAL_WEIGHT_CAP, COMMONS_DELEGATED_WEIGHT_CAP, normalizeTeamName, validateTeamName, teamDeletionConfirmationMatches, projectDeletionConfirmationMatches, normalizeProjectSlug, validateProjectSlug, normalizeTeamRoleKey, primaryTeamRole, projectConnectionModeFromHosting, serializeTeam, teamIsPrivate, centralTreeDxRegistryUrl, serializeTeamMember, serializeTeamWebHost, SUPPORTED_TEAM_HOST_PROVIDERS, serializeCommonsParticipant, serializeCommonsQuestion, serializeCommonsProposal, serializeCommonsWeightSnapshot, serializeCommonsProposalBacking, serializeCommonsProposalVote, serializeCommonsDelegation, serializeCommonsDecision, serializeCommonsGovernanceEvent, serializeGovernancePolicy, serializeGovernanceProposal, serializeGovernanceElectorateSnapshot, serializeGovernanceVote, serializeGovernanceDelegation, serializeGovernanceDecision, serializeGovernanceEvent, serializeSeedRun, serializeTeamInvite, serializeProject, PROJECT_DEPLOYMENT_TERMINAL_STATUSES, PROJECT_DEPLOYMENT_ACTIVE_STATUSES, normalizeProjectDeploymentStatus, deploymentKindForAction, summarizeProjectHealth, summarizeDeploymentStatus, serializeConnection, serializeRepositoryHost, serializeHubRepository, serializeHubContentSource, serializeTreeDxInstance, serializeTreeDxProjectLibrary, serializeTreeDxMirror, serializeTreeDxShare, serializeTreeDxDeployment, serializeHubLaunch, serializeHubLaunchEvent, serializeHubWorkspaceLink, serializeProjectUpdatePlan, serializeProviderCredentialSession, serializeCapability, serializeJob, serializeJobEvent, serializePlatformOperation, serializePlatformOperationEvent, serializeMarketOperationRunner, serializePlatformRepositoryClaim, platformRepositoryKey, platformRepositoryWorkspacePath, serializeAuditEvent, serializeSecretMetadataRecord, serializeGitHubRepositoryGrant, serializeGitHubAppInstallationRecord, serializeGitHubAppTokenIssuanceRecord, serializeWorkflowOperationRecord, serializeWorkflowDispatchRecord, serializeTreeDxCredentialIssuanceRecord, secretCapabilityValidationError, rejectSecretCapabilityPlaintext, serializeKnowledgePack, serializeTeamStorageLocator, serializeCatalogItem, serializeCatalogArtifactVersion, serializeCommerceVendor, serializeCommerceVendorStripeAccount, serializeCommerceProduct, serializeCommerceOwnershipRecord, serializeCommerceStewardshipAssignment, serializeCommerceContribution, serializeCommerceGovernancePolicy, serializeCommerceOwnershipTransfer, serializeCommerceSuccessionEvent, serializeCommerceOwnershipWorkflowSummary, serializeCommerceProductVersion, serializeCommerceOffer, serializeCommercePrice, serializeCommerceGovernanceEvent, serializeCommerceCart, serializeCommerceCartItem, serializeCommerceCheckout, serializeCommerceOrder, serializeCommerceOrderItem, serializeCommerceRefund, serializeCommerceFulfillmentEvent, serializeCommerceServiceRequest, serializeCommerceServiceQuote, serializeCommerceServiceContract, serializeCommerceServiceEvent, serializeCommerceCapacityListing, serializeCommerceCapacityListingInquiry, serializeCommerceVendorOrderSummary, serializeCommercePaymentGroup, serializeCommerceSubscription, serializeCommerceEntitlement, serializeCommerceBuyerStripeCustomer, serializeCommerceWebhookEvent, serializeProjectHosting, serializeProjectEnvironment, serializeProjectInfrastructureResource, serializeProjectDeployment, serializeProjectDeploymentEvent, serializeTeamInboxItem, serializeProjectSummarySnapshot } from './index.ts';

export function getNodeBuiltin(name) {
    return globalThis.process?.getBuiltinModule?.(name) ?? null;
}

export function safeStoragePathSegment(value) {
    return String(value ?? '')
        .split('/')
        .map((part) => part.trim())
        .filter((part) => part && part !== '.' && part !== '../../../persistence/store')
        .join('/');
}

export function safeIdPart(value, fallback = 'item') {
    return String(value ?? fallback)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
        || fallback;
}

export function isoNow() {
    return new Date().toISOString();
}

export function parseJson(value, fallback) {
    if (!value)
        return fallback;
    try {
        return JSON.parse(value);
    }
    catch {
        return fallback;
    }
}

export function missingSchemaError(error) {
    const message = String(error?.message ?? error ?? '').toLowerCase();
    return message.includes('no such table')
        || message.includes('no such column')
        || message.includes('does not exist')
        || message.includes('undefined column');
}

export function objectValue(value, fallback: any = {}) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

export function arrayValue(value) {
    return Array.isArray(value) ? value : [];
}

export const CONTENT_RUNTIME_SOURCES = new Set(['local_directory', 'treedx_snapshot', 'r2_published_manifest', 'r2_preview_overlay']);

export const LOCAL_CONTENT_MATERIALIZATIONS = new Set(['none', 'existing_path', 'managed_clone', 'submodule']);

export const CONTENT_PUBLISH_TARGETS = new Set(['none', 'cloudflare_r2']);

export function stringValue(value, fallback = '') {
    const next = typeof value === 'string' ? value.trim() : '';
    return next || fallback;
}

export function optionalStringValue(value, fallback = null) {
    const next = typeof value === 'string' ? value.trim() : '';
    return next || fallback;
}

export function numberValue(value, fallback = null) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return fallback;
}

export function enumValue(value, allowed, fallback) {
    const next = typeof value === 'string' ? value.trim() : '';
    return allowed.has(next) ? next : fallback;
}

export function requireEnumValue(value, allowed, label) {
    const next = typeof value === 'string' ? value.trim() : '';
    if (allowed.has(next))
        return next;
    const error: Error & Record<string, any> = new Error(`Invalid ${label}.`);
    error.status = 400;
    error.details = { label, value };
    throw error;
}

export function principalIsAdmin(principal) {
    return Boolean(principal
        && (principal.permissions?.includes?.('*:*:*')
            || principal.roles?.includes?.('platform_admin')
            || principal.roles?.includes?.('market_admin')));
}

export function normalizeBaseUrl(baseUrl) {
    return String(baseUrl ?? '').trim().replace(/\/+$/u, '');
}

export function signAssertionPayload(payload, secret) {
    return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function uniqueCapabilities(roles: any = []) {
    const capabilities = roles.flatMap((role) => TEAM_ROLE_CAPABILITIES[role] ?? []);
    return [...new Set(capabilities)];
}

export function normalizeAllocationSlices(value, fallback: any = []) {
    const raw = Array.isArray(value) ? value : fallback;
    return raw
        .map((slice) => ({
        id: String(slice?.id ?? '').trim(),
        name: String(slice?.name ?? slice?.label ?? slice?.id ?? '').trim(),
        percentage: numberValue(slice?.percentage ?? slice?.allocationPercent, null),
    }))
        .filter((slice) => slice.id && slice.name && slice.percentage !== null)
        .map((slice) => ({
        ...slice,
        percentage: Math.max(0, Math.min(100, slice.percentage)),
    }));
}

export function normalizedStrings(values) {
    return arrayValue(values).map((value) => String(value ?? '').trim()).filter(Boolean);
}

export function serializeApprovalRequest(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        teamId: row.team_id,
        projectId: row.project_id,
        workDayId: row.work_day_id,
        taskId: row.task_id,
        kind: row.kind,
        state: row.state,
        severity: row.severity,
        requestedByType: row.requested_by_type,
        requestedById: row.requested_by_id,
        title: row.title,
        summary: row.summary,
        options: parseJson(row.options_json, []),
        recommendation: parseJson(row.recommendation_json, {}),
        policySnapshot: parseJson(row.policy_snapshot_json, {}),
        expiresAt: row.expires_at,
        decidedByType: row.decided_by_type,
        decidedById: row.decided_by_id,
        decidedAt: row.decided_at,
        decision: parseJson(row.decision_json, null),
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function isoDate(value) {
    if (typeof value !== 'string' || !value.trim()) {
        return null;
    }
    const parsed = new Date(value);
    return Number.isFinite(parsed.valueOf()) ? parsed.toISOString() : null;
}

export function compareDatesDesc(left, right) {
    const leftTime = isoDate(left) ? new Date(left).getTime() : 0;
    const rightTime = isoDate(right) ? new Date(right).getTime() : 0;
    return rightTime - leftTime;
}

export function latestDate(...values) {
    return values
        .map((value) => isoDate(value))
        .filter(Boolean)
        .sort(compareDatesDesc)[0] ?? null;
}

export function uniqueStrings(values) {
    return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))];
}

export function toActivityItem(kind, input) {
    return {
        kind,
        id: input.id,
        title: input.title,
        status: input.status,
        timestamp: input.timestamp,
        href: input.href ?? null,
        summary: input.summary ?? null,
        metadata: input.metadata ?? {},
    };
}

export function serializeEntitlement(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        teamId: row.team_id,
        projectId: row.project_id,
        tier: row.tier,
        status: row.status,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeClientEncryptedEscrowRecord(row) {
    if (!row)
        return null;
    const rawMetadata = parseJson(row.metadata_json, {});
    const rawEnvelope = rawMetadata?.envelope && typeof rawMetadata.envelope === 'object' ? rawMetadata.envelope : {};
    const metadata = {
        ...redactDeploymentValue(rawMetadata),
        envelope: {
            ciphertext: rawEnvelope.ciphertext ?? null,
            nonce: rawEnvelope.nonce ?? null,
            salt: rawEnvelope.salt ?? null,
            kdf: rawEnvelope.kdf ?? null,
            kdfParams: rawEnvelope.kdfParams ?? null,
            encryptionVersion: rawEnvelope.encryptionVersion ?? null,
            deploymentIntent: rawEnvelope.deploymentIntent ?? null,
        },
    };
    const envelope = metadata.envelope;
    return {
        id: row.id,
        teamId: row.team_id,
        projectId: row.project_id,
        secretId: row.secret_id,
        status: row.status,
        ciphertext: envelope.ciphertext ?? null,
        ciphertextRef: row.ciphertext_ref,
        algorithm: row.algorithm,
        nonce: envelope.nonce ?? null,
        salt: envelope.salt ?? null,
        kdf: envelope.kdf ?? null,
        kdfParams: envelope.kdfParams ?? null,
        wrappingKeyId: row.wrapping_key_id,
        encryptionVersion: envelope.encryptionVersion ?? null,
        createdByClientId: row.created_by_client_id,
        expiresAt: row.expires_at,
        deploymentIntent: envelope.deploymentIntent ?? null,
        migratedTo: row.migrated_to,
        metadata,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        tombstonedAt: row.tombstoned_at,
    };
}

export function redactBuyerUserId(value) {
    if (!value)
        return null;
    const text = String(value);
    return text.length <= 8 ? 'buyer-user' : `${text.slice(0, 4)}...${text.slice(-4)}`;
}

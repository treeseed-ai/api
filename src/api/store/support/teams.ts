import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { governanceVotingProvider } from '@treeseed/sdk';
import { containsTreeseedPlaintextSecretMaterial, validateTreeseedClientEncryptedEscrowMetadata, validateTreeseedSecretsCapabilityRegistry, validateTreeseedWritableSecretMetadata, } from '@treeseed/sdk/secrets-capability';
import { redactDeploymentValue } from '../../../market/deployment-actions.ts';
import { projectDeploymentAuditPayload } from '../../../market/deployment-governance.ts';
import { getNodeBuiltin, safeStoragePathSegment, safeIdPart, artifactStorageRoot, isoNow, parseJson, missingSchemaError, objectValue, arrayValue, governanceContentHash, governanceSlug, PROJECT_ARCHITECTURE_TOPOLOGIES, CONTENT_RUNTIME_SOURCES, LOCAL_CONTENT_MATERIALIZATIONS, CONTENT_PUBLISH_TARGETS, LEGACY_PROJECT_TOPOLOGIES, projectArchitectureError, normalizeProjectPath, normalizeProjectContentPublishTarget, normalizeProjectArchitecture, projectArchitectureContentSource, stringValue, optionalStringValue, numberValue, enumValue, requireEnumValue, stableHash, equalHash, tokenPrefix, normalizeOperationCapabilities, COMMERCE_PRODUCT_KINDS, COMMERCE_OFFER_MODES, COMMERCE_VENDOR_TRUST_LEVELS, COMMERCE_GOVERNANCE_STATES, COMMERCE_OWNERSHIP_MODELS, COMMERCE_STEWARDSHIP_ROLES, COMMERCE_STRIPE_ACCOUNT_STATUSES, COMMERCE_STRIPE_ONBOARDING_STATUSES, COMMERCE_STRIPE_ENVIRONMENTS, COMMERCE_STRIPE_SYNC_STATUSES, COMMERCE_ENTITLEMENT_STATUSES, COMMERCE_CART_STATUSES, COMMERCE_CHECKOUT_STATUSES, COMMERCE_ORDER_STATUSES, COMMERCE_ORDER_ITEM_STATUSES, COMMERCE_SUBSCRIPTION_STATUSES, COMMERCE_PAYMENT_GROUP_STATUSES, COMMERCE_WEBHOOK_EVENT_STATUSES, COMMERCE_REFUND_STATUSES, COMMERCE_FULFILLMENT_STATUSES, COMMERCE_FULFILLMENT_EVENT_TYPES, COMMERCE_SERVICE_REQUEST_STATUSES, COMMERCE_SERVICE_QUOTE_STATUSES, COMMERCE_SERVICE_CONTRACT_STATUSES, COMMERCE_SERVICE_EVENT_TYPES, COMMERCE_CAPACITY_LISTING_STATUSES, COMMERCE_CAPACITY_INQUIRY_STATUSES, COMMERCE_CAPACITY_ACCESS_LEVELS, COMMERCE_CAPACITY_RUNTIME_ISOLATION_LEVELS, COMMERCE_CAPACITY_HUMAN_INVOLVEMENT_LEVELS, COMMERCE_CAPACITY_AI_INVOLVEMENT_LEVELS, COMMERCE_CAPACITY_DATA_ACCESS_LEVELS, COMMERCE_CAPACITY_SECRET_ACCESS_LEVELS, COMMERCE_PRODUCT_KIND_SET, COMMERCE_OFFER_MODE_SET, COMMERCE_VENDOR_TRUST_LEVEL_SET, COMMERCE_GOVERNANCE_STATE_SET, COMMERCE_OWNERSHIP_MODEL_SET, COMMERCE_STEWARDSHIP_ROLE_SET, COMMERCE_STRIPE_ACCOUNT_STATUS_SET, COMMERCE_STRIPE_ONBOARDING_STATUS_SET, COMMERCE_STRIPE_ENVIRONMENT_SET, COMMERCE_STRIPE_SYNC_STATUS_SET, COMMERCE_ENTITLEMENT_STATUS_SET, COMMERCE_CART_STATUS_SET, COMMERCE_CHECKOUT_STATUS_SET, COMMERCE_ORDER_STATUS_SET, COMMERCE_ORDER_ITEM_STATUS_SET, COMMERCE_SUBSCRIPTION_STATUS_SET, COMMERCE_PAYMENT_GROUP_STATUS_SET, COMMERCE_WEBHOOK_EVENT_STATUS_SET, COMMERCE_REFUND_STATUS_SET, COMMERCE_FULFILLMENT_STATUS_SET, COMMERCE_FULFILLMENT_EVENT_TYPE_SET, COMMERCE_SERVICE_REQUEST_STATUS_SET, COMMERCE_SERVICE_QUOTE_STATUS_SET, COMMERCE_SERVICE_CONTRACT_STATUS_SET, COMMERCE_SERVICE_EVENT_TYPE_SET, COMMERCE_CAPACITY_LISTING_STATUS_SET, COMMERCE_CAPACITY_INQUIRY_STATUS_SET, COMMERCE_CAPACITY_ACCESS_LEVEL_SET, COMMERCE_CAPACITY_RUNTIME_ISOLATION_LEVEL_SET, COMMERCE_CAPACITY_HUMAN_INVOLVEMENT_LEVEL_SET, COMMERCE_CAPACITY_AI_INVOLVEMENT_LEVEL_SET, COMMERCE_CAPACITY_DATA_ACCESS_LEVEL_SET, COMMERCE_CAPACITY_SECRET_ACCESS_LEVEL_SET, COMMERCE_VISIBILITY_SET, COMMERCE_FULFILLMENT_MODE_SET, COMMERCE_PRICE_STATUS_SET, COMMERCE_PRICE_INTERVAL_SET, COMMERCE_TAX_BEHAVIOR_SET, COMMERCE_COMMERCIAL_OFFER_MODES, COMMERCE_ZERO_PRICE_OFFER_MODES, COMMERCE_CAPACITY_LISTING_OFFER_MODES, principalIsAdmin, TREESEED_COMMONS_TEAM_SLUG, COMMONS_WEIGHT_POLICY_VERSION, COMMONS_BACKING_THRESHOLD, COMMONS_WEIGHT_THRESHOLD, COMMONS_TOTAL_WEIGHT_CAP, COMMONS_DELEGATED_WEIGHT_CAP, projectDeletionConfirmationMatches, normalizeProjectSlug, validateProjectSlug, normalizeBaseUrl, signAssertionPayload, uniqueCapabilities, projectConnectionModeFromHosting, centralTreeDxRegistryUrl, normalizeAllocationSlices, normalizedStrings, serializeApprovalRequest, serializeCommonsParticipant, serializeCommonsQuestion, serializeCommonsProposal, serializeCommonsWeightSnapshot, serializeCommonsProposalBacking, serializeCommonsProposalVote, serializeCommonsDelegation, serializeCommonsDecision, serializeCommonsGovernanceEvent, serializeGovernancePolicy, serializeGovernanceProposal, serializeGovernanceElectorateSnapshot, serializeGovernanceVote, serializeGovernanceDelegation, serializeGovernanceDecision, serializeGovernanceEvent, serializeSeedRun, serializeProject, isoDate, compareDatesDesc, latestDate, uniqueStrings, PROJECT_DEPLOYMENT_TERMINAL_STATUSES, PROJECT_DEPLOYMENT_ACTIVE_STATUSES, normalizeProjectDeploymentStatus, deploymentKindForAction, summarizeProjectHealth, summarizeDeploymentStatus, toActivityItem, serializeConnection, serializeRepositoryHost, serializeHubRepository, serializeHubContentSource, serializeTreeDxInstance, serializeTreeDxProjectLibrary, serializeTreeDxMirror, serializeTreeDxShare, serializeTreeDxDeployment, serializeHubLaunch, serializeHubLaunchEvent, serializeHubWorkspaceLink, serializeProjectUpdatePlan, serializeProviderCredentialSession, serializeEntitlement, serializeJob, serializeJobEvent, serializePlatformOperation, serializePlatformOperationEvent, serializeMarketOperationRunner, serializePlatformRepositoryClaim, platformRepositoryKey, platformRepositoryWorkspacePath, serializeAuditEvent, serializeSecretMetadataRecord, serializeClientEncryptedEscrowRecord, serializeGitHubRepositoryGrant, serializeGitHubAppInstallationRecord, serializeGitHubAppTokenIssuanceRecord, serializeWorkflowOperationRecord, serializeWorkflowDispatchRecord, serializeTreeDxCredentialIssuanceRecord, serializeKnowledgePack, serializeCatalogItem, serializeCatalogArtifactVersion, serializeCommerceVendor, serializeCommerceVendorStripeAccount, serializeCommerceProduct, serializeCommerceOwnershipRecord, serializeCommerceStewardshipAssignment, serializeCommerceContribution, serializeCommerceGovernancePolicy, serializeCommerceOwnershipTransfer, serializeCommerceSuccessionEvent, serializeCommerceOwnershipWorkflowSummary, serializeCommerceProductVersion, serializeCommerceOffer, serializeCommercePrice, serializeCommerceGovernanceEvent, serializeCommerceCart, serializeCommerceCartItem, serializeCommerceCheckout, serializeCommerceOrder, serializeCommerceOrderItem, serializeCommerceRefund, serializeCommerceFulfillmentEvent, serializeCommerceServiceRequest, serializeCommerceServiceQuote, serializeCommerceServiceContract, serializeCommerceServiceEvent, serializeCommerceCapacityListing, serializeCommerceCapacityListingInquiry, redactBuyerUserId, serializeCommerceVendorOrderSummary, serializeCommercePaymentGroup, serializeCommerceSubscription, serializeCommerceEntitlement, serializeCommerceBuyerStripeCustomer, serializeCommerceWebhookEvent, serializeProjectHosting, serializeProjectEnvironment, serializeProjectInfrastructureResource, serializeProjectDeployment, serializeProjectDeploymentEvent, serializeProjectSummarySnapshot } from './index.ts';

export const TEAM_ROLE_CAPABILITIES = {
    team_owner: [
        'launch_projects',
        'edit_direct',
        'manage_workstreams',
        'stage_releases',
        'publish_releases',
        'publish_market_listings',
        'manage_products',
        'manage_billing',
        'approve_remote_execution',
    ],
    market_steward: ['manage_products', 'publish_market_listings'],
    project_lead: ['launch_projects', 'edit_direct', 'manage_workstreams', 'stage_releases', 'publish_releases', 'approve_remote_execution'],
    contributor: ['edit_direct', 'manage_workstreams'],
    reviewer: ['stage_releases', 'approve_remote_execution'],
    finance: ['manage_billing', 'manage_products'],
    viewer: [],
};

export const TEAM_ROLE_DESCRIPTIONS = {
    team_owner: 'Own the team portfolio and all project capabilities.',
    market_steward: 'Manage market products and publish listings.',
    project_lead: 'Lead projects, workstreams, and release promotion.',
    contributor: 'Edit direction and move workstreams forward.',
    reviewer: 'Review staged work and approve remote execution.',
    finance: 'Manage billing and commercial product settings.',
    viewer: 'Read-only participant in team and Commons governance surfaces.',
};

export const ALL_TEAM_CAPABILITIES = [...new Set(Object.values(TEAM_ROLE_CAPABILITIES).flat())];

export const CAPABILITY_PERMISSIONS = {
    launch_projects: 'project:create',
    edit_direct: 'project:edit',
    manage_workstreams: 'project:workstream:manage',
    stage_releases: 'project:stage:admin',
    publish_releases: 'project:production:admin',
    publish_market_listings: 'catalog:publish',
    manage_products: 'catalog:manage',
    manage_billing: 'billing:manage',
    approve_remote_execution: 'remote:execution:approve',
};

export const TEAM_DELETION_CONFIRMATION_PREFIX = 'DELETE ';

export const TEAM_MANAGEMENT_ROLES = new Set(['team_owner', 'project_lead']);

export const TEAM_RESERVED_NAMES = new Set([
    'app',
    'api',
    'auth',
    'market',
    'templates',
    'admin',
    'settings',
    'u',
    't',
    'users',
    'teams',
    'new',
    'me',
    'account',
    'login',
    'logout',
    'signup',
]);

export function normalizeTeamName(value) {
    return String(value ?? '').trim().toLowerCase();
}

export function validateTeamName(value) {
    const name = normalizeTeamName(value);
    if (!name) {
        return { ok: false, code: 'missing', message: 'Team name is required.' };
    }
    if (TEAM_RESERVED_NAMES.has(name)) {
        return { ok: false, code: 'reserved', message: 'That team name is reserved.' };
    }
    if (name.length > 39
        || !/^[a-z0-9-]+$/u.test(name)
        || name.startsWith('-')
        || name.endsWith('-')
        || name.includes('--')) {
        return {
            ok: false,
            code: 'format',
            message: 'Team names can use 1-39 letters, numbers, or single hyphens, with no leading or trailing hyphen.',
        };
    }
    return { ok: true, name };
}

export function teamDeletionConfirmationMatches(value, teamName) {
    return String(value ?? '') === `${TEAM_DELETION_CONFIRMATION_PREFIX}${normalizeTeamName(teamName)}`;
}

export function normalizeTeamRoleKey(value, fallback = 'contributor') {
    const key = String(value ?? '').trim();
    if (key === 'owner')
        return 'team_owner';
    return TEAM_ROLE_CAPABILITIES[key] ? key : fallback;
}

export function primaryTeamRole(roles: any = []) {
    const preferredOrder = ['team_owner', 'project_lead', 'market_steward', 'contributor', 'reviewer', 'finance', 'viewer'];
    return preferredOrder.find((role) => roles.includes(role)) ?? roles[0] ?? null;
}

export function serializeTeam(row) {
    if (!row)
        return null;
    const metadata = parseJson(row.metadata_json, {});
    const handle = row.name ?? row.slug;
    return {
        id: row.id,
        slug: row.slug ?? handle,
        name: handle,
        displayName: row.display_name ?? metadata.displayName ?? row.name ?? row.slug,
        logoUrl: row.logo_url ?? metadata.logoUrl ?? null,
        profileSummary: row.profile_summary ?? metadata.profileSummary ?? metadata.description ?? null,
        metadata,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function teamIsPrivate(team) {
    const visibility = String(team?.metadata?.visibility ?? team?.metadata?.access ?? 'private').toLowerCase();
    return team?.metadata?.privateTreeDx !== false && visibility !== 'public' && team?.metadata?.publicTeam !== true;
}

export function serializeTeamMember(row, roles: any = []) {
    if (!row)
        return null;
    const roleKey = primaryTeamRole(roles);
    return {
        id: row.id,
        teamId: row.team_id,
        userId: row.user_id,
        status: row.status,
        displayName: row.display_name,
        email: row.email,
        roleKey,
        role: roleKey,
        roles,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeTeamWebHost(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        teamId: row.team_id,
        provider: row.provider,
        ownership: row.ownership,
        name: row.name,
        accountLabel: row.account_label,
        allowedEnvironments: parseJson(row.allowed_environments_json, []),
        status: row.status,
        encryptedPayload: parseJson(row.encrypted_payload_json, null),
        metadata: parseJson(row.metadata_json, {}),
        createdById: row.created_by_id,
        updatedById: row.updated_by_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export const SUPPORTED_TEAM_HOST_PROVIDERS = new Set(['cloudflare', 'railway', 'smtp', 'openai', 'github_copilot', 'openrouter', 'custom']);

export function serializeTeamInvite(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        teamId: row.team_id,
        email: row.email,
        roleKey: row.role_key,
        status: row.status,
        invitedByUserId: row.invited_by_user_id,
        acceptedByUserId: row.accepted_by_user_id,
        acceptedAt: row.accepted_at,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeCapability(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        projectId: row.project_id,
        namespace: row.namespace,
        operation: row.operation,
        label: row.label ?? null,
        executionClass: row.execution_class,
        allowedTargets: parseJson(row.allowed_targets_json, []),
        defaultDispatchMode: row.default_dispatch_mode,
        enabled: Boolean(row.enabled),
        approvalPolicy: parseJson(row.approval_policy_json, {}),
        resourceScope: parseJson(row.resource_scope_json, {}),
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function secretCapabilityValidationError(problems, message = 'Invalid secret capability record.') {
    const error: Error & Record<string, any> = new Error(message);
    error.status = 400;
    error.code = problems?.[0]?.code ?? 'invalid_secret_capability_record';
    error.details = { problems };
    return error;
}

export function rejectSecretCapabilityPlaintext(input, path = '$') {
    if (!containsTreeseedPlaintextSecretMaterial(input))
        return;
    throw secretCapabilityValidationError([{
            path,
            code: 'plaintext_escrow_material',
            message: 'Secret capability records must not include plaintext secret material.',
        }], 'Secret capability records must not include plaintext secret material.');
}

export function serializeTeamStorageLocator(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        teamId: row.team_id,
        bucketName: row.bucket_name,
        manifestKeyTemplate: row.manifest_key_template,
        previewRootTemplate: row.preview_root_template,
        publicBaseUrl: row.public_base_url,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeTeamInboxItem(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        teamId: row.team_id,
        projectId: row.project_id,
        kind: row.kind,
        state: row.state,
        title: row.title,
        summary: row.summary,
        href: row.href,
        itemKey: row.item_key,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

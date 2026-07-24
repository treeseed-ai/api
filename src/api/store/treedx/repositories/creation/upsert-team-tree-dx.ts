import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { governanceVotingProvider } from '@treeseed/sdk';
import { containsPlaintextSecretMaterial, validateClientEncryptedEscrowMetadata, validateSecretsCapabilityRegistry, validateWritableSecretMetadata, } from '@treeseed/sdk/secrets-capability';
import { redactDeploymentValue } from "../../../../../market/hosting/deployment-actions.ts";
import { projectDeploymentAuditPayload } from "../../../../../market/governance/policy/deployment-governance.ts";
import { getNodeBuiltin, safeStoragePathSegment, safeIdPart, artifactStorageRoot, isoNow, parseJson, missingSchemaError, objectValue, arrayValue, governanceContentHash, governanceSlug, PROJECT_ARCHITECTURE_TOPOLOGIES, CONTENT_RUNTIME_SOURCES, LOCAL_CONTENT_MATERIALIZATIONS, CONTENT_PUBLISH_TARGETS, LEGACY_PROJECT_TOPOLOGIES, projectArchitectureError, normalizeProjectPath, normalizeProjectContentPublishTarget, normalizeProjectArchitecture, projectArchitectureContentSource, stringValue, optionalStringValue, numberValue, enumValue, requireEnumValue, stableHash, equalHash, tokenPrefix, normalizeOperationCapabilities, COMMERCE_PRODUCT_KINDS, COMMERCE_OFFER_MODES, COMMERCE_VENDOR_TRUST_LEVELS, COMMERCE_GOVERNANCE_STATES, COMMERCE_OWNERSHIP_MODELS, COMMERCE_STEWARDSHIP_ROLES, COMMERCE_STRIPE_ACCOUNT_STATUSES, COMMERCE_STRIPE_ONBOARDING_STATUSES, COMMERCE_STRIPE_ENVIRONMENTS, COMMERCE_STRIPE_SYNC_STATUSES, COMMERCE_ENTITLEMENT_STATUSES, COMMERCE_CART_STATUSES, COMMERCE_CHECKOUT_STATUSES, COMMERCE_ORDER_STATUSES, COMMERCE_ORDER_ITEM_STATUSES, COMMERCE_SUBSCRIPTION_STATUSES, COMMERCE_PAYMENT_GROUP_STATUSES, COMMERCE_WEBHOOK_EVENT_STATUSES, COMMERCE_REFUND_STATUSES, COMMERCE_FULFILLMENT_STATUSES, COMMERCE_FULFILLMENT_EVENT_TYPES, COMMERCE_SERVICE_REQUEST_STATUSES, COMMERCE_SERVICE_QUOTE_STATUSES, COMMERCE_SERVICE_CONTRACT_STATUSES, COMMERCE_SERVICE_EVENT_TYPES, COMMERCE_CAPACITY_LISTING_STATUSES, COMMERCE_CAPACITY_INQUIRY_STATUSES, COMMERCE_CAPACITY_ACCESS_LEVELS, COMMERCE_CAPACITY_RUNTIME_ISOLATION_LEVELS, COMMERCE_CAPACITY_HUMAN_INVOLVEMENT_LEVELS, COMMERCE_CAPACITY_AI_INVOLVEMENT_LEVELS, COMMERCE_CAPACITY_DATA_ACCESS_LEVELS, COMMERCE_CAPACITY_SECRET_ACCESS_LEVELS, COMMERCE_PRODUCT_KIND_SET, COMMERCE_OFFER_MODE_SET, COMMERCE_VENDOR_TRUST_LEVEL_SET, COMMERCE_GOVERNANCE_STATE_SET, COMMERCE_OWNERSHIP_MODEL_SET, COMMERCE_STEWARDSHIP_ROLE_SET, COMMERCE_STRIPE_ACCOUNT_STATUS_SET, COMMERCE_STRIPE_ONBOARDING_STATUS_SET, COMMERCE_STRIPE_ENVIRONMENT_SET, COMMERCE_STRIPE_SYNC_STATUS_SET, COMMERCE_ENTITLEMENT_STATUS_SET, COMMERCE_CART_STATUS_SET, COMMERCE_CHECKOUT_STATUS_SET, COMMERCE_ORDER_STATUS_SET, COMMERCE_ORDER_ITEM_STATUS_SET, COMMERCE_SUBSCRIPTION_STATUS_SET, COMMERCE_PAYMENT_GROUP_STATUS_SET, COMMERCE_WEBHOOK_EVENT_STATUS_SET, COMMERCE_REFUND_STATUS_SET, COMMERCE_FULFILLMENT_STATUS_SET, COMMERCE_FULFILLMENT_EVENT_TYPE_SET, COMMERCE_SERVICE_REQUEST_STATUS_SET, COMMERCE_SERVICE_QUOTE_STATUS_SET, COMMERCE_SERVICE_CONTRACT_STATUS_SET, COMMERCE_SERVICE_EVENT_TYPE_SET, COMMERCE_CAPACITY_LISTING_STATUS_SET, COMMERCE_CAPACITY_INQUIRY_STATUS_SET, COMMERCE_CAPACITY_ACCESS_LEVEL_SET, COMMERCE_CAPACITY_RUNTIME_ISOLATION_LEVEL_SET, COMMERCE_CAPACITY_HUMAN_INVOLVEMENT_LEVEL_SET, COMMERCE_CAPACITY_AI_INVOLVEMENT_LEVEL_SET, COMMERCE_CAPACITY_DATA_ACCESS_LEVEL_SET, COMMERCE_CAPACITY_SECRET_ACCESS_LEVEL_SET, COMMERCE_VISIBILITY_SET, COMMERCE_FULFILLMENT_MODE_SET, COMMERCE_PRICE_STATUS_SET, COMMERCE_PRICE_INTERVAL_SET, COMMERCE_TAX_BEHAVIOR_SET, COMMERCE_COMMERCIAL_OFFER_MODES, COMMERCE_ZERO_PRICE_OFFER_MODES, COMMERCE_CAPACITY_LISTING_OFFER_MODES, principalIsAdmin, TEAM_ROLE_CAPABILITIES, TEAM_ROLE_DESCRIPTIONS, ALL_TEAM_CAPABILITIES, CAPABILITY_PERMISSIONS, TEAM_DELETION_CONFIRMATION_PREFIX, TEAM_MANAGEMENT_ROLES, TEAM_RESERVED_NAMES, COMMONS_TEAM_SLUG, COMMONS_WEIGHT_POLICY_VERSION, COMMONS_BACKING_THRESHOLD, COMMONS_WEIGHT_THRESHOLD, COMMONS_TOTAL_WEIGHT_CAP, COMMONS_DELEGATED_WEIGHT_CAP, normalizeTeamName, validateTeamName, teamDeletionConfirmationMatches, projectDeletionConfirmationMatches, normalizeProjectSlug, validateProjectSlug, normalizeBaseUrl, signAssertionPayload, uniqueCapabilities, normalizeTeamRoleKey, primaryTeamRole, projectConnectionModeFromHosting, serializeTeam, teamIsPrivate, centralTreeDxRegistryUrl, normalizeAllocationSlices, serializeTeamMember, serializeTeamWebHost, SUPPORTED_TEAM_HOST_PROVIDERS, normalizedStrings, serializeApprovalRequest, serializeCommonsParticipant, serializeCommonsQuestion, serializeCommonsProposal, serializeCommonsWeightSnapshot, serializeCommonsProposalBacking, serializeCommonsProposalVote, serializeCommonsDelegation, serializeCommonsDecision, serializeCommonsGovernanceEvent, serializeGovernancePolicy, serializeGovernanceProposal, serializeGovernanceElectorateSnapshot, serializeGovernanceVote, serializeGovernanceDelegation, serializeGovernanceDecision, serializeGovernanceEvent, serializeSeedRun, serializeTeamInvite, serializeProject, isoDate, compareDatesDesc, latestDate, uniqueStrings, PROJECT_DEPLOYMENT_TERMINAL_STATUSES, PROJECT_DEPLOYMENT_ACTIVE_STATUSES, normalizeProjectDeploymentStatus, deploymentKindForAction, summarizeProjectHealth, summarizeDeploymentStatus, toActivityItem, serializeConnection, serializeRepositoryHost, serializeHubRepository, serializeHubContentSource, serializeTreeDxInstance, serializeTreeDxProjectLibrary, serializeTreeDxMirror, serializeTreeDxShare, serializeTreeDxDeployment, serializeHubLaunch, serializeHubLaunchEvent, serializeHubWorkspaceLink, serializeProjectUpdatePlan, serializeProviderCredentialSession, serializeCapability, serializeEntitlement, serializeJob, serializeJobEvent, serializePlatformOperation, serializePlatformOperationEvent, serializeMarketOperationRunner, serializePlatformRepositoryClaim, platformRepositoryKey, platformRepositoryWorkspacePath, serializeAuditEvent, serializeSecretMetadataRecord, serializeClientEncryptedEscrowRecord, serializeGitHubRepositoryGrant, serializeGitHubAppInstallationRecord, serializeGitHubAppTokenIssuanceRecord, serializeWorkflowOperationRecord, serializeWorkflowDispatchRecord, serializeTreeDxCredentialIssuanceRecord, secretCapabilityValidationError, rejectSecretCapabilityPlaintext, serializeKnowledgePack, serializeTeamStorageLocator, serializeCatalogItem, serializeCatalogArtifactVersion, serializeCommerceVendor, serializeCommerceVendorStripeAccount, serializeCommerceProduct, serializeCommerceOwnershipRecord, serializeCommerceStewardshipAssignment, serializeCommerceContribution, serializeCommerceGovernancePolicy, serializeCommerceOwnershipTransfer, serializeCommerceSuccessionEvent, serializeCommerceOwnershipWorkflowSummary, serializeCommerceProductVersion, serializeCommerceOffer, serializeCommercePrice, serializeCommerceGovernanceEvent, serializeCommerceCart, serializeCommerceCartItem, serializeCommerceCheckout, serializeCommerceOrder, serializeCommerceOrderItem, serializeCommerceRefund, serializeCommerceFulfillmentEvent, serializeCommerceServiceRequest, serializeCommerceServiceQuote, serializeCommerceServiceContract, serializeCommerceServiceEvent, serializeCommerceCapacityListing, serializeCommerceCapacityListingInquiry, redactBuyerUserId, serializeCommerceVendorOrderSummary, serializeCommercePaymentGroup, serializeCommerceSubscription, serializeCommerceEntitlement, serializeCommerceBuyerStripeCustomer, serializeCommerceWebhookEvent, serializeProjectHosting, serializeProjectEnvironment, serializeProjectInfrastructureResource, serializeProjectDeployment, serializeProjectDeploymentEvent, serializeTeamInboxItem, serializeProjectSummarySnapshot, MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function upsertTeamTreeDxMethod(this: MarketControlPlaneStore, teamId, input: any = {}) {
    await this.ensureInitialized();
    const timestamp = isoNow();
    const existing = await this.getPrimaryTreeDxInstance(teamId);
    const id = input.id ?? existing?.id ?? randomUUID();
    const kind = String(input.kind ?? existing?.kind ?? (input.publicRead ? 'managed_public_federation' : 'managed_private'));
    const provider = String(input.provider ?? existing?.provider ?? (kind === 'managed_public_federation' ? 'public_federation' : kind === 'self_hosted' ? 'self_hosted' : 'railway'));
    const status = String(input.status ?? existing?.status ?? (input.baseUrl ? 'active' : 'pending'));
    if (status === 'active') {
        await this.run(`UPDATE treedx_instances SET status = 'disabled', updated_at = ? WHERE team_id = ? AND COALESCE("primary", 1) != 0 AND id != ? AND status = 'active'`, [timestamp, teamId, id]);
    }
    await this.run(`INSERT INTO treedx_instances (
				id, team_id, kind, provider, name, base_url, registry_url, public_read, "primary", status, image_ref,
				railway_project_id, railway_service_id, railway_environment_id, volume_mount_path, metadata_json, created_at, updated_at
			) VALUES (
				?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
			)
			ON CONFLICT (id) DO UPDATE SET
				kind = EXCLUDED.kind,
				provider = EXCLUDED.provider,
				name = EXCLUDED.name,
				base_url = EXCLUDED.base_url,
				registry_url = EXCLUDED.registry_url,
				public_read = EXCLUDED.public_read,
				"primary" = EXCLUDED."primary",
				status = EXCLUDED.status,
				image_ref = EXCLUDED.image_ref,
				railway_project_id = EXCLUDED.railway_project_id,
				railway_service_id = EXCLUDED.railway_service_id,
				railway_environment_id = EXCLUDED.railway_environment_id,
				volume_mount_path = EXCLUDED.volume_mount_path,
				metadata_json = EXCLUDED.metadata_json,
				updated_at = EXCLUDED.updated_at`, [
        id,
        teamId,
        kind,
        provider,
        String(input.name ?? existing?.name ?? 'TreeDX Knowledge Library'),
        input.baseUrl ?? existing?.baseUrl ?? null,
        input.registryUrl ?? input.baseUrl ?? existing?.registryUrl ?? null,
        input.publicRead === undefined ? Number(existing?.publicRead ?? false) : Number(Boolean(input.publicRead)),
        1,
        status,
        input.imageRef ?? existing?.imageRef ?? 'treeseed/treedx:latest',
        input.railwayProjectId ?? existing?.railwayProjectId ?? null,
        input.railwayServiceId ?? existing?.railwayServiceId ?? null,
        input.railwayEnvironmentId ?? existing?.railwayEnvironmentId ?? null,
        input.volumeMountPath ?? existing?.volumeMountPath ?? (provider === 'railway' ? '/data' : null),
        JSON.stringify({
            ...(existing?.metadata ?? {}),
            ...(objectValue(input.metadata, {}) ?? {}),
            hostRole: 'knowledge-library',
            contentCanonical: 'treedx',
        }),
        existing?.createdAt ?? timestamp,
        timestamp,
    ]);
    return serializeTreeDxInstance(await this.first(`SELECT * FROM treedx_instances WHERE team_id = ? AND id = ? LIMIT 1`, [teamId, id])) ?? {
        id,
        teamId,
        kind,
        provider,
        name: String(input.name ?? existing?.name ?? 'TreeDX Knowledge Library'),
        baseUrl: input.baseUrl ?? existing?.baseUrl ?? null,
        registryUrl: input.registryUrl ?? input.baseUrl ?? existing?.registryUrl ?? null,
        publicRead: input.publicRead === undefined ? Boolean(existing?.publicRead ?? false) : Boolean(input.publicRead),
        primary: true,
        status,
        imageRef: input.imageRef ?? existing?.imageRef ?? 'treeseed/treedx:latest',
        railwayProjectId: input.railwayProjectId ?? existing?.railwayProjectId ?? null,
        railwayServiceId: input.railwayServiceId ?? existing?.railwayServiceId ?? null,
        railwayEnvironmentId: input.railwayEnvironmentId ?? existing?.railwayEnvironmentId ?? null,
        volumeMountPath: input.volumeMountPath ?? existing?.volumeMountPath ?? (provider === 'railway' ? '/data' : null),
        metadata: {
            ...(existing?.metadata ?? {}),
            ...(objectValue(input.metadata, {}) ?? {}),
            hostRole: 'knowledge-library',
            contentCanonical: 'treedx',
        },
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
    };
}

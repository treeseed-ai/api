import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { governanceVotingProvider } from '@treeseed/sdk';
import { containsTreeseedPlaintextSecretMaterial, validateTreeseedClientEncryptedEscrowMetadata, validateTreeseedSecretsCapabilityRegistry, validateTreeseedWritableSecretMetadata, } from '@treeseed/sdk/secrets-capability';
import { redactDeploymentValue } from "../../market/deployment-actions.ts";
import { projectDeploymentAuditPayload } from "../../market/deployment-governance.ts";
import { getNodeBuiltin, safeStoragePathSegment, safeIdPart, artifactStorageRoot, isoNow, parseJson, missingSchemaError, objectValue, arrayValue, governanceContentHash, governanceSlug, PROJECT_ARCHITECTURE_TOPOLOGIES, CONTENT_RUNTIME_SOURCES, LOCAL_CONTENT_MATERIALIZATIONS, CONTENT_PUBLISH_TARGETS, LEGACY_PROJECT_TOPOLOGIES, projectArchitectureError, normalizeProjectPath, normalizeProjectContentPublishTarget, normalizeProjectArchitecture, projectArchitectureContentSource, stringValue, optionalStringValue, numberValue, enumValue, requireEnumValue, stableHash, equalHash, tokenPrefix, normalizeOperationCapabilities, COMMERCE_PRODUCT_KINDS, COMMERCE_OFFER_MODES, COMMERCE_VENDOR_TRUST_LEVELS, COMMERCE_GOVERNANCE_STATES, COMMERCE_OWNERSHIP_MODELS, COMMERCE_STEWARDSHIP_ROLES, COMMERCE_STRIPE_ACCOUNT_STATUSES, COMMERCE_STRIPE_ONBOARDING_STATUSES, COMMERCE_STRIPE_ENVIRONMENTS, COMMERCE_STRIPE_SYNC_STATUSES, COMMERCE_ENTITLEMENT_STATUSES, COMMERCE_CART_STATUSES, COMMERCE_CHECKOUT_STATUSES, COMMERCE_ORDER_STATUSES, COMMERCE_ORDER_ITEM_STATUSES, COMMERCE_SUBSCRIPTION_STATUSES, COMMERCE_PAYMENT_GROUP_STATUSES, COMMERCE_WEBHOOK_EVENT_STATUSES, COMMERCE_REFUND_STATUSES, COMMERCE_FULFILLMENT_STATUSES, COMMERCE_FULFILLMENT_EVENT_TYPES, COMMERCE_SERVICE_REQUEST_STATUSES, COMMERCE_SERVICE_QUOTE_STATUSES, COMMERCE_SERVICE_CONTRACT_STATUSES, COMMERCE_SERVICE_EVENT_TYPES, COMMERCE_CAPACITY_LISTING_STATUSES, COMMERCE_CAPACITY_INQUIRY_STATUSES, COMMERCE_CAPACITY_ACCESS_LEVELS, COMMERCE_CAPACITY_RUNTIME_ISOLATION_LEVELS, COMMERCE_CAPACITY_HUMAN_INVOLVEMENT_LEVELS, COMMERCE_CAPACITY_AI_INVOLVEMENT_LEVELS, COMMERCE_CAPACITY_DATA_ACCESS_LEVELS, COMMERCE_CAPACITY_SECRET_ACCESS_LEVELS, COMMERCE_PRODUCT_KIND_SET, COMMERCE_OFFER_MODE_SET, COMMERCE_VENDOR_TRUST_LEVEL_SET, COMMERCE_GOVERNANCE_STATE_SET, COMMERCE_OWNERSHIP_MODEL_SET, COMMERCE_STEWARDSHIP_ROLE_SET, COMMERCE_STRIPE_ACCOUNT_STATUS_SET, COMMERCE_STRIPE_ONBOARDING_STATUS_SET, COMMERCE_STRIPE_ENVIRONMENT_SET, COMMERCE_STRIPE_SYNC_STATUS_SET, COMMERCE_ENTITLEMENT_STATUS_SET, COMMERCE_CART_STATUS_SET, COMMERCE_CHECKOUT_STATUS_SET, COMMERCE_ORDER_STATUS_SET, COMMERCE_ORDER_ITEM_STATUS_SET, COMMERCE_SUBSCRIPTION_STATUS_SET, COMMERCE_PAYMENT_GROUP_STATUS_SET, COMMERCE_WEBHOOK_EVENT_STATUS_SET, COMMERCE_REFUND_STATUS_SET, COMMERCE_FULFILLMENT_STATUS_SET, COMMERCE_FULFILLMENT_EVENT_TYPE_SET, COMMERCE_SERVICE_REQUEST_STATUS_SET, COMMERCE_SERVICE_QUOTE_STATUS_SET, COMMERCE_SERVICE_CONTRACT_STATUS_SET, COMMERCE_SERVICE_EVENT_TYPE_SET, COMMERCE_CAPACITY_LISTING_STATUS_SET, COMMERCE_CAPACITY_INQUIRY_STATUS_SET, COMMERCE_CAPACITY_ACCESS_LEVEL_SET, COMMERCE_CAPACITY_RUNTIME_ISOLATION_LEVEL_SET, COMMERCE_CAPACITY_HUMAN_INVOLVEMENT_LEVEL_SET, COMMERCE_CAPACITY_AI_INVOLVEMENT_LEVEL_SET, COMMERCE_CAPACITY_DATA_ACCESS_LEVEL_SET, COMMERCE_CAPACITY_SECRET_ACCESS_LEVEL_SET, COMMERCE_VISIBILITY_SET, COMMERCE_FULFILLMENT_MODE_SET, COMMERCE_PRICE_STATUS_SET, COMMERCE_PRICE_INTERVAL_SET, COMMERCE_TAX_BEHAVIOR_SET, COMMERCE_COMMERCIAL_OFFER_MODES, COMMERCE_ZERO_PRICE_OFFER_MODES, COMMERCE_CAPACITY_LISTING_OFFER_MODES, principalIsAdmin, TEAM_ROLE_CAPABILITIES, TEAM_ROLE_DESCRIPTIONS, ALL_TEAM_CAPABILITIES, CAPABILITY_PERMISSIONS, TEAM_DELETION_CONFIRMATION_PREFIX, TEAM_MANAGEMENT_ROLES, TEAM_RESERVED_NAMES, TREESEED_COMMONS_TEAM_SLUG, COMMONS_WEIGHT_POLICY_VERSION, COMMONS_BACKING_THRESHOLD, COMMONS_WEIGHT_THRESHOLD, COMMONS_TOTAL_WEIGHT_CAP, COMMONS_DELEGATED_WEIGHT_CAP, normalizeTeamName, validateTeamName, teamDeletionConfirmationMatches, projectDeletionConfirmationMatches, normalizeProjectSlug, validateProjectSlug, normalizeBaseUrl, signAssertionPayload, uniqueCapabilities, normalizeTeamRoleKey, primaryTeamRole, projectConnectionModeFromHosting, serializeTeam, teamIsPrivate, centralTreeDxRegistryUrl, normalizeAllocationSlices, serializeTeamMember, serializeTeamWebHost, SUPPORTED_TEAM_HOST_PROVIDERS, normalizedStrings, serializeApprovalRequest, serializeCommonsParticipant, serializeCommonsQuestion, serializeCommonsProposal, serializeCommonsWeightSnapshot, serializeCommonsProposalBacking, serializeCommonsProposalVote, serializeCommonsDelegation, serializeCommonsDecision, serializeCommonsGovernanceEvent, serializeGovernancePolicy, serializeGovernanceProposal, serializeGovernanceElectorateSnapshot, serializeGovernanceVote, serializeGovernanceDelegation, serializeGovernanceDecision, serializeGovernanceEvent, serializeSeedRun, serializeTeamInvite, serializeProject, isoDate, compareDatesDesc, latestDate, uniqueStrings, PROJECT_DEPLOYMENT_TERMINAL_STATUSES, PROJECT_DEPLOYMENT_ACTIVE_STATUSES, normalizeProjectDeploymentStatus, deploymentKindForAction, summarizeProjectHealth, summarizeDeploymentStatus, toActivityItem, serializeConnection, serializeRepositoryHost, serializeHubRepository, serializeHubContentSource, serializeTreeDxInstance, serializeTreeDxProjectLibrary, serializeTreeDxMirror, serializeTreeDxShare, serializeTreeDxDeployment, serializeHubLaunch, serializeHubLaunchEvent, serializeHubWorkspaceLink, serializeProjectUpdatePlan, serializeProviderCredentialSession, serializeCapability, serializeEntitlement, serializeJob, serializeJobEvent, serializePlatformOperation, serializePlatformOperationEvent, serializeMarketOperationRunner, serializePlatformRepositoryClaim, platformRepositoryKey, platformRepositoryWorkspacePath, serializeAuditEvent, serializeSecretMetadataRecord, serializeClientEncryptedEscrowRecord, serializeGitHubRepositoryGrant, serializeGitHubAppInstallationRecord, serializeGitHubAppTokenIssuanceRecord, serializeWorkflowOperationRecord, serializeWorkflowDispatchRecord, serializeTreeDxCredentialIssuanceRecord, secretCapabilityValidationError, rejectSecretCapabilityPlaintext, serializeKnowledgePack, serializeTeamStorageLocator, serializeCatalogItem, serializeCatalogArtifactVersion, serializeCommerceVendor, serializeCommerceVendorStripeAccount, serializeCommerceProduct, serializeCommerceOwnershipRecord, serializeCommerceStewardshipAssignment, serializeCommerceContribution, serializeCommerceGovernancePolicy, serializeCommerceOwnershipTransfer, serializeCommerceSuccessionEvent, serializeCommerceOwnershipWorkflowSummary, serializeCommerceProductVersion, serializeCommerceOffer, serializeCommercePrice, serializeCommerceGovernanceEvent, serializeCommerceCart, serializeCommerceCartItem, serializeCommerceCheckout, serializeCommerceOrder, serializeCommerceOrderItem, serializeCommerceRefund, serializeCommerceFulfillmentEvent, serializeCommerceServiceRequest, serializeCommerceServiceQuote, serializeCommerceServiceContract, serializeCommerceServiceEvent, serializeCommerceCapacityListing, serializeCommerceCapacityListingInquiry, redactBuyerUserId, serializeCommerceVendorOrderSummary, serializeCommercePaymentGroup, serializeCommerceSubscription, serializeCommerceEntitlement, serializeCommerceBuyerStripeCustomer, serializeCommerceWebhookEvent, serializeProjectHosting, serializeProjectEnvironment, serializeProjectInfrastructureResource, serializeProjectDeployment, serializeProjectDeploymentEvent, serializeTeamInboxItem, serializeProjectSummarySnapshot, MarketControlPlaneStore } from "../store.ts";
export async function importProjectRepositoryPlanMethod(this: MarketControlPlaneStore, teamId, input: any = {}) {
    await this.ensureInitialized();
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw projectArchitectureError('Project repository import requires a safe import plan.', 'invalid_project_import_plan');
    }
    if (containsTreeseedPlaintextSecretMaterial(input)) {
        throw projectArchitectureError('Project repository import cannot contain plaintext credentials, tokens, or secret material.', 'project_import_secret_material_rejected');
    }
    if (input.repositoryTopology !== undefined
        || input.contentRoot !== undefined
        || input.metadata?.repositoryTopology !== undefined
        || input.metadata?.contentRoot !== undefined) {
        throw projectArchitectureError('Project imports must use canonical architecture, not legacy topology metadata.', 'legacy_project_topology_rejected');
    }
    const repository = objectValue(input.repository, {});
    const plannedRecords = objectValue(input.plannedRecords, {});
    const plannedProject = objectValue(plannedRecords.project, {});
    const plannedRepository = objectValue(plannedRecords.hubRepository, {});
    const architecture = normalizeProjectArchitecture(input.architecture);
    const owner = normalizeProjectPath(repository.owner ?? plannedRepository.owner, '');
    const name = normalizeProjectPath(repository.name ?? plannedRepository.name, '');
    if (!owner || !name) {
        throw projectArchitectureError('Project repository import requires repository owner and name.', 'invalid_project_import_plan');
    }
    const slugResult = validateProjectSlug(plannedProject.slug ?? name);
    if (!slugResult.ok) {
        throw projectArchitectureError(slugResult.message, 'invalid_project_import_plan');
    }
    const visibility = normalizeProjectPath(repository.visibility ?? plannedProject.visibility, 'public') === 'private' ? 'private' : 'public';
    const defaultBranch = normalizeProjectPath(repository.defaultBranch ?? plannedRepository.defaultBranch, 'main');
    const url = normalizeProjectPath(repository.htmlUrl ?? plannedRepository.url, `https://github.com/${owner}/${name}`);
    const cloneUrl = normalizeProjectPath(repository.cloneUrl, `${url}.git`);
    const credentialRef = normalizeProjectPath(input.credentialRef ?? plannedRepository.credentialRef, '');
    if (credentialRef && !credentialRef.startsWith('env:TREESEED_GITHUB_TOKEN')) {
        throw projectArchitectureError('Project repository import credentialRef must be an env:TREESEED_GITHUB_TOKEN reference.', 'invalid_project_import_plan');
    }
    const existing = await this.getProjectByTeamAndSlug(teamId, slugResult.slug);
    const metadata = {
        ...(existing?.metadata ?? {}),
        architecture,
        visibility,
        import: {
            provider: 'github',
            importedAt: isoNow(),
            repository: `${owner}/${name}`,
            credentialRef: credentialRef || null,
            source: 'project_repository_import',
        },
    };
    const details = existing
        ? await this.updateProject(existing.id, {
            name: normalizeProjectPath(plannedProject.name, existing.name),
            description: existing.description,
            metadata,
        }).then(() => this.getProjectDetails(existing.id))
        : await this.createProject(teamId, {
            slug: slugResult.slug,
            name: normalizeProjectPath(plannedProject.name, name),
            description: input.description ?? null,
            metadata,
        });
    const project = (details && 'project' in details ? details.project : details) as {
        id: string;
        teamId: string;
        slug: string;
        name: string;
        description?: string | null;
        metadata?: Record<string, unknown>;
    } | null;
    if (!project?.id) {
        throw projectArchitectureError('Project repository import could not create or update the project.', 'invalid_project_import_plan');
    }
    const hubRepository = await this.upsertHubRepository(project.id, {
        teamId,
        role: 'software',
        provider: 'github',
        owner,
        name,
        url,
        defaultBranch,
        currentBranch: defaultBranch,
        status: 'active',
        metadata: {
            credentialRef: credentialRef || null,
            cloneUrl,
            importedFromExistingRepository: true,
            projectArchitecture: architecture,
        },
    });
    const normalizedArchitecture = await this.upsertProjectArchitecture(project.id, architecture);
    const treeDxLibrary = await this.upsertProjectTreeDxLibrary(project.id, {
        libraryId: plannedRecords.treeDxLibrary?.libraryId ?? `${teamId}/${slugResult.slug}`,
        contentPath: architecture.contentPath ?? null,
        contentRepositoryUrl: url,
        contentRepositoryDefaultBranch: defaultBranch,
        contentRepositoryRef: defaultBranch,
        r2BucketName: architecture.contentPublishTarget?.kind === 'cloudflare_r2' ? architecture.contentPublishTarget.bucket ?? null : null,
        r2ManifestKey: architecture.contentPublishTarget?.kind === 'cloudflare_r2'
            ? architecture.contentPublishTarget.manifestPath ?? architecture.contentPublishTarget.prefix ?? null
            : null,
        metadata: {
            projectArchitecture: architecture,
            importedFromExistingRepository: true,
        },
    }).catch(() => null);
    const contentSource = await this.getHubContentSource(project.id);
    return {
        project: (await this.getProjectDetails(project.id))?.project ?? project,
        architecture: normalizedArchitecture,
        hubRepository,
        contentSource,
        treeDxLibrary,
        diagnostics: Array.isArray(input.diagnostics) ? input.diagnostics : [],
        plannedRecords,
    };
}

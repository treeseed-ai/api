import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { governanceVotingProvider } from '@treeseed/sdk';
import { containsPlaintextSecretMaterial, validateClientEncryptedEscrowMetadata, validateSecretsCapabilityRegistry, validateWritableSecretMetadata, } from '@treeseed/sdk/secrets-capability';
import { redactDeploymentValue } from "../../../../../market/hosting/deployment-actions.ts";
import { projectDeploymentAuditPayload } from "../../../../../market/governance/policy/deployment-governance.ts";
import { getNodeBuiltin, safeStoragePathSegment, safeIdPart, artifactStorageRoot, isoNow, parseJson, missingSchemaError, objectValue, arrayValue, governanceContentHash, governanceSlug, PROJECT_ARCHITECTURE_TOPOLOGIES, CONTENT_RUNTIME_SOURCES, LOCAL_CONTENT_MATERIALIZATIONS, CONTENT_PUBLISH_TARGETS, LEGACY_PROJECT_TOPOLOGIES, projectArchitectureError, normalizeProjectPath, normalizeProjectContentPublishTarget, normalizeProjectArchitecture, projectArchitectureContentSource, stringValue, optionalStringValue, numberValue, enumValue, requireEnumValue, stableHash, equalHash, tokenPrefix, normalizeOperationCapabilities, COMMERCE_PRODUCT_KINDS, COMMERCE_OFFER_MODES, COMMERCE_VENDOR_TRUST_LEVELS, COMMERCE_GOVERNANCE_STATES, COMMERCE_OWNERSHIP_MODELS, COMMERCE_STEWARDSHIP_ROLES, COMMERCE_STRIPE_ACCOUNT_STATUSES, COMMERCE_STRIPE_ONBOARDING_STATUSES, COMMERCE_STRIPE_ENVIRONMENTS, COMMERCE_STRIPE_SYNC_STATUSES, COMMERCE_ENTITLEMENT_STATUSES, COMMERCE_CART_STATUSES, COMMERCE_CHECKOUT_STATUSES, COMMERCE_ORDER_STATUSES, COMMERCE_ORDER_ITEM_STATUSES, COMMERCE_SUBSCRIPTION_STATUSES, COMMERCE_PAYMENT_GROUP_STATUSES, COMMERCE_WEBHOOK_EVENT_STATUSES, COMMERCE_REFUND_STATUSES, COMMERCE_FULFILLMENT_STATUSES, COMMERCE_FULFILLMENT_EVENT_TYPES, COMMERCE_SERVICE_REQUEST_STATUSES, COMMERCE_SERVICE_QUOTE_STATUSES, COMMERCE_SERVICE_CONTRACT_STATUSES, COMMERCE_SERVICE_EVENT_TYPES, COMMERCE_CAPACITY_LISTING_STATUSES, COMMERCE_CAPACITY_INQUIRY_STATUSES, COMMERCE_CAPACITY_ACCESS_LEVELS, COMMERCE_CAPACITY_RUNTIME_ISOLATION_LEVELS, COMMERCE_CAPACITY_HUMAN_INVOLVEMENT_LEVELS, COMMERCE_CAPACITY_AI_INVOLVEMENT_LEVELS, COMMERCE_CAPACITY_DATA_ACCESS_LEVELS, COMMERCE_CAPACITY_SECRET_ACCESS_LEVELS, COMMERCE_PRODUCT_KIND_SET, COMMERCE_OFFER_MODE_SET, COMMERCE_VENDOR_TRUST_LEVEL_SET, COMMERCE_GOVERNANCE_STATE_SET, COMMERCE_OWNERSHIP_MODEL_SET, COMMERCE_STEWARDSHIP_ROLE_SET, COMMERCE_STRIPE_ACCOUNT_STATUS_SET, COMMERCE_STRIPE_ONBOARDING_STATUS_SET, COMMERCE_STRIPE_ENVIRONMENT_SET, COMMERCE_STRIPE_SYNC_STATUS_SET, COMMERCE_ENTITLEMENT_STATUS_SET, COMMERCE_CART_STATUS_SET, COMMERCE_CHECKOUT_STATUS_SET, COMMERCE_ORDER_STATUS_SET, COMMERCE_ORDER_ITEM_STATUS_SET, COMMERCE_SUBSCRIPTION_STATUS_SET, COMMERCE_PAYMENT_GROUP_STATUS_SET, COMMERCE_WEBHOOK_EVENT_STATUS_SET, COMMERCE_REFUND_STATUS_SET, COMMERCE_FULFILLMENT_STATUS_SET, COMMERCE_FULFILLMENT_EVENT_TYPE_SET, COMMERCE_SERVICE_REQUEST_STATUS_SET, COMMERCE_SERVICE_QUOTE_STATUS_SET, COMMERCE_SERVICE_CONTRACT_STATUS_SET, COMMERCE_SERVICE_EVENT_TYPE_SET, COMMERCE_CAPACITY_LISTING_STATUS_SET, COMMERCE_CAPACITY_INQUIRY_STATUS_SET, COMMERCE_CAPACITY_ACCESS_LEVEL_SET, COMMERCE_CAPACITY_RUNTIME_ISOLATION_LEVEL_SET, COMMERCE_CAPACITY_HUMAN_INVOLVEMENT_LEVEL_SET, COMMERCE_CAPACITY_AI_INVOLVEMENT_LEVEL_SET, COMMERCE_CAPACITY_DATA_ACCESS_LEVEL_SET, COMMERCE_CAPACITY_SECRET_ACCESS_LEVEL_SET, COMMERCE_VISIBILITY_SET, COMMERCE_FULFILLMENT_MODE_SET, COMMERCE_PRICE_STATUS_SET, COMMERCE_PRICE_INTERVAL_SET, COMMERCE_TAX_BEHAVIOR_SET, COMMERCE_COMMERCIAL_OFFER_MODES, COMMERCE_ZERO_PRICE_OFFER_MODES, COMMERCE_CAPACITY_LISTING_OFFER_MODES, principalIsAdmin, TEAM_ROLE_CAPABILITIES, TEAM_ROLE_DESCRIPTIONS, ALL_TEAM_CAPABILITIES, CAPABILITY_PERMISSIONS, TEAM_DELETION_CONFIRMATION_PREFIX, TEAM_MANAGEMENT_ROLES, TEAM_RESERVED_NAMES, COMMONS_TEAM_SLUG, COMMONS_WEIGHT_POLICY_VERSION, COMMONS_BACKING_THRESHOLD, COMMONS_WEIGHT_THRESHOLD, COMMONS_TOTAL_WEIGHT_CAP, COMMONS_DELEGATED_WEIGHT_CAP, normalizeTeamName, validateTeamName, teamDeletionConfirmationMatches, projectDeletionConfirmationMatches, normalizeProjectSlug, validateProjectSlug, normalizeBaseUrl, signAssertionPayload, uniqueCapabilities, normalizeTeamRoleKey, primaryTeamRole, projectConnectionModeFromHosting, serializeTeam, teamIsPrivate, centralTreeDxRegistryUrl, normalizeAllocationSlices, serializeTeamMember, serializeTeamWebHost, SUPPORTED_TEAM_HOST_PROVIDERS, normalizedStrings, serializeApprovalRequest, serializeCommonsParticipant, serializeCommonsQuestion, serializeCommonsProposal, serializeCommonsWeightSnapshot, serializeCommonsProposalBacking, serializeCommonsProposalVote, serializeCommonsDelegation, serializeCommonsDecision, serializeCommonsGovernanceEvent, serializeGovernancePolicy, serializeGovernanceProposal, serializeGovernanceElectorateSnapshot, serializeGovernanceVote, serializeGovernanceDelegation, serializeGovernanceDecision, serializeGovernanceEvent, serializeSeedRun, serializeTeamInvite, serializeProject, isoDate, compareDatesDesc, latestDate, uniqueStrings, PROJECT_DEPLOYMENT_TERMINAL_STATUSES, PROJECT_DEPLOYMENT_ACTIVE_STATUSES, normalizeProjectDeploymentStatus, deploymentKindForAction, summarizeProjectHealth, summarizeDeploymentStatus, toActivityItem, serializeConnection, serializeRepositoryHost, serializeHubRepository, serializeHubContentSource, serializeTreeDxInstance, serializeTreeDxProjectLibrary, serializeTreeDxMirror, serializeTreeDxShare, serializeTreeDxDeployment, serializeHubLaunch, serializeHubLaunchEvent, serializeHubWorkspaceLink, serializeProjectUpdatePlan, serializeProviderCredentialSession, serializeCapability, serializeEntitlement, serializeJob, serializeJobEvent, serializePlatformOperation, serializePlatformOperationEvent, serializeMarketOperationRunner, serializePlatformRepositoryClaim, platformRepositoryKey, platformRepositoryWorkspacePath, serializeAuditEvent, serializeSecretMetadataRecord, serializeClientEncryptedEscrowRecord, serializeGitHubRepositoryGrant, serializeGitHubAppInstallationRecord, serializeGitHubAppTokenIssuanceRecord, serializeWorkflowOperationRecord, serializeWorkflowDispatchRecord, serializeTreeDxCredentialIssuanceRecord, secretCapabilityValidationError, rejectSecretCapabilityPlaintext, serializeKnowledgePack, serializeTeamStorageLocator, serializeCatalogItem, serializeCatalogArtifactVersion, serializeCommerceVendor, serializeCommerceVendorStripeAccount, serializeCommerceProduct, serializeCommerceOwnershipRecord, serializeCommerceStewardshipAssignment, serializeCommerceContribution, serializeCommerceGovernancePolicy, serializeCommerceOwnershipTransfer, serializeCommerceSuccessionEvent, serializeCommerceOwnershipWorkflowSummary, serializeCommerceProductVersion, serializeCommerceOffer, serializeCommercePrice, serializeCommerceGovernanceEvent, serializeCommerceCart, serializeCommerceCartItem, serializeCommerceCheckout, serializeCommerceOrder, serializeCommerceOrderItem, serializeCommerceRefund, serializeCommerceFulfillmentEvent, serializeCommerceServiceRequest, serializeCommerceServiceQuote, serializeCommerceServiceContract, serializeCommerceServiceEvent, serializeCommerceCapacityListing, serializeCommerceCapacityListingInquiry, redactBuyerUserId, serializeCommerceVendorOrderSummary, serializeCommercePaymentGroup, serializeCommerceSubscription, serializeCommerceEntitlement, serializeCommerceBuyerStripeCustomer, serializeCommerceWebhookEvent, serializeProjectHosting, serializeProjectEnvironment, serializeProjectInfrastructureResource, serializeProjectDeployment, serializeProjectDeploymentEvent, serializeTeamInboxItem, serializeProjectSummarySnapshot, MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function createGovernanceProposalMethod(this: MarketControlPlaneStore, principal, input: any = {}) {
    await this.ensureInitialized();
    const title = stringValue(input.title);
    const summary = stringValue(input.summary);
    const body = stringValue(input.body);
    if (!title || !summary || !body) {
        const error: Error & Record<string, any> = new Error('Proposal title, summary, and body are required.');
        error.status = 400;
        throw error;
    }
    const project = input.projectId ? await this.getProject(input.projectId) : null;
    const teamId = input.teamId ?? project?.teamId ?? COMMONS_TEAM_SLUG;
    const scope = optionalStringValue(input.scope, project ? 'project' : 'commons');
    const policy = await this.resolveGovernancePolicy({ teamId, projectId: project?.id ?? null, scope });
    const provider = governanceVotingProvider(policy?.providerId);
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    const proposalType = optionalStringValue(input.proposalType ?? input.decisionType, 'implementation');
    const contentHash = governanceContentHash({ title, summary, body, proposalType });
    const contentProposalSlug = optionalStringValue(input.contentProposalSlug) ?? governanceSlug(title, 'proposal');
    await this.run(`INSERT INTO governance_proposals (
				id, team_id, project_id, scope, status, title, summary, body, proposal_type,
				content_proposal_slug, content_decision_slug, active_version, active_content_hash,
				governance_provider_id, governance_provider_version, governance_policy_id, decision_id,
				voting_starts_at, voting_ends_at, closed_at, closed_reason, created_by_type, created_by_id,
				metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?)`, [
        id,
        teamId,
        project?.id ?? input.projectId ?? null,
        scope,
        input.status === 'open' || input.status === 'submitted' ? 'open' : 'draft',
        title,
        summary,
        body,
        proposalType,
        contentProposalSlug,
        contentHash,
        provider.id,
        provider.version,
        policy?.id ?? null,
        input.createdByType ?? 'user',
        input.createdById ?? principal?.id ?? null,
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        timestamp,
    ]);
    await this.run(`INSERT INTO governance_proposal_versions (
				id, proposal_id, version, title, summary, body, content_hash, change_reason,
				created_by_type, created_by_id, created_at
			) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`, [randomUUID(), id, title, summary, body, contentHash, 'Initial proposal version.', input.createdByType ?? 'user', input.createdById ?? principal?.id ?? null, timestamp]);
    await this.recordGovernanceEvent({
        eventType: 'proposal.created',
        actorType: input.createdByType ?? 'user',
        actorId: input.createdById ?? principal?.id ?? null,
        teamId,
        projectId: project?.id ?? input.projectId ?? null,
        proposalId: id,
        proposalVersion: 1,
        nextState: input.status === 'open' || input.status === 'submitted' ? 'open' : 'draft',
        evidence: { providerId: provider.id, policyId: policy?.id ?? null },
    });
    return this.getGovernanceProposal(id);
}

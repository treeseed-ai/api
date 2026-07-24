import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { governanceVotingProvider } from '@treeseed/sdk';
import { containsPlaintextSecretMaterial, validateClientEncryptedEscrowMetadata, validateSecretsCapabilityRegistry, validateWritableSecretMetadata, } from '@treeseed/sdk/secrets-capability';
import { redactDeploymentValue } from "../../../../../market/hosting/deployment-actions.ts";
import { projectDeploymentAuditPayload } from "../../../../../market/governance/policy/deployment-governance.ts";
import { getNodeBuiltin, safeStoragePathSegment, safeIdPart, artifactStorageRoot, isoNow, parseJson, missingSchemaError, objectValue, arrayValue, governanceContentHash, governanceSlug, PROJECT_ARCHITECTURE_TOPOLOGIES, CONTENT_RUNTIME_SOURCES, LOCAL_CONTENT_MATERIALIZATIONS, CONTENT_PUBLISH_TARGETS, LEGACY_PROJECT_TOPOLOGIES, projectArchitectureError, normalizeProjectPath, normalizeProjectContentPublishTarget, normalizeProjectArchitecture, projectArchitectureContentSource, stringValue, optionalStringValue, numberValue, enumValue, requireEnumValue, stableHash, equalHash, tokenPrefix, normalizeOperationCapabilities, COMMERCE_PRODUCT_KINDS, COMMERCE_OFFER_MODES, COMMERCE_VENDOR_TRUST_LEVELS, COMMERCE_GOVERNANCE_STATES, COMMERCE_OWNERSHIP_MODELS, COMMERCE_STEWARDSHIP_ROLES, COMMERCE_STRIPE_ACCOUNT_STATUSES, COMMERCE_STRIPE_ONBOARDING_STATUSES, COMMERCE_STRIPE_ENVIRONMENTS, COMMERCE_STRIPE_SYNC_STATUSES, COMMERCE_ENTITLEMENT_STATUSES, COMMERCE_CART_STATUSES, COMMERCE_CHECKOUT_STATUSES, COMMERCE_ORDER_STATUSES, COMMERCE_ORDER_ITEM_STATUSES, COMMERCE_SUBSCRIPTION_STATUSES, COMMERCE_PAYMENT_GROUP_STATUSES, COMMERCE_WEBHOOK_EVENT_STATUSES, COMMERCE_REFUND_STATUSES, COMMERCE_FULFILLMENT_STATUSES, COMMERCE_FULFILLMENT_EVENT_TYPES, COMMERCE_SERVICE_REQUEST_STATUSES, COMMERCE_SERVICE_QUOTE_STATUSES, COMMERCE_SERVICE_CONTRACT_STATUSES, COMMERCE_SERVICE_EVENT_TYPES, COMMERCE_CAPACITY_LISTING_STATUSES, COMMERCE_CAPACITY_INQUIRY_STATUSES, COMMERCE_CAPACITY_ACCESS_LEVELS, COMMERCE_CAPACITY_RUNTIME_ISOLATION_LEVELS, COMMERCE_CAPACITY_HUMAN_INVOLVEMENT_LEVELS, COMMERCE_CAPACITY_AI_INVOLVEMENT_LEVELS, COMMERCE_CAPACITY_DATA_ACCESS_LEVELS, COMMERCE_CAPACITY_SECRET_ACCESS_LEVELS, COMMERCE_PRODUCT_KIND_SET, COMMERCE_OFFER_MODE_SET, COMMERCE_VENDOR_TRUST_LEVEL_SET, COMMERCE_GOVERNANCE_STATE_SET, COMMERCE_OWNERSHIP_MODEL_SET, COMMERCE_STEWARDSHIP_ROLE_SET, COMMERCE_STRIPE_ACCOUNT_STATUS_SET, COMMERCE_STRIPE_ONBOARDING_STATUS_SET, COMMERCE_STRIPE_ENVIRONMENT_SET, COMMERCE_STRIPE_SYNC_STATUS_SET, COMMERCE_ENTITLEMENT_STATUS_SET, COMMERCE_CART_STATUS_SET, COMMERCE_CHECKOUT_STATUS_SET, COMMERCE_ORDER_STATUS_SET, COMMERCE_ORDER_ITEM_STATUS_SET, COMMERCE_SUBSCRIPTION_STATUS_SET, COMMERCE_PAYMENT_GROUP_STATUS_SET, COMMERCE_WEBHOOK_EVENT_STATUS_SET, COMMERCE_REFUND_STATUS_SET, COMMERCE_FULFILLMENT_STATUS_SET, COMMERCE_FULFILLMENT_EVENT_TYPE_SET, COMMERCE_SERVICE_REQUEST_STATUS_SET, COMMERCE_SERVICE_QUOTE_STATUS_SET, COMMERCE_SERVICE_CONTRACT_STATUS_SET, COMMERCE_SERVICE_EVENT_TYPE_SET, COMMERCE_CAPACITY_LISTING_STATUS_SET, COMMERCE_CAPACITY_INQUIRY_STATUS_SET, COMMERCE_CAPACITY_ACCESS_LEVEL_SET, COMMERCE_CAPACITY_RUNTIME_ISOLATION_LEVEL_SET, COMMERCE_CAPACITY_HUMAN_INVOLVEMENT_LEVEL_SET, COMMERCE_CAPACITY_AI_INVOLVEMENT_LEVEL_SET, COMMERCE_CAPACITY_DATA_ACCESS_LEVEL_SET, COMMERCE_CAPACITY_SECRET_ACCESS_LEVEL_SET, COMMERCE_VISIBILITY_SET, COMMERCE_FULFILLMENT_MODE_SET, COMMERCE_PRICE_STATUS_SET, COMMERCE_PRICE_INTERVAL_SET, COMMERCE_TAX_BEHAVIOR_SET, COMMERCE_COMMERCIAL_OFFER_MODES, COMMERCE_ZERO_PRICE_OFFER_MODES, COMMERCE_CAPACITY_LISTING_OFFER_MODES, principalIsAdmin, TEAM_ROLE_CAPABILITIES, TEAM_ROLE_DESCRIPTIONS, ALL_TEAM_CAPABILITIES, CAPABILITY_PERMISSIONS, TEAM_DELETION_CONFIRMATION_PREFIX, TEAM_MANAGEMENT_ROLES, TEAM_RESERVED_NAMES, COMMONS_TEAM_SLUG, COMMONS_WEIGHT_POLICY_VERSION, COMMONS_BACKING_THRESHOLD, COMMONS_WEIGHT_THRESHOLD, COMMONS_TOTAL_WEIGHT_CAP, COMMONS_DELEGATED_WEIGHT_CAP, normalizeTeamName, validateTeamName, teamDeletionConfirmationMatches, projectDeletionConfirmationMatches, normalizeProjectSlug, validateProjectSlug, normalizeBaseUrl, signAssertionPayload, uniqueCapabilities, normalizeTeamRoleKey, primaryTeamRole, projectConnectionModeFromHosting, serializeTeam, teamIsPrivate, centralTreeDxRegistryUrl, normalizeAllocationSlices, serializeTeamMember, serializeTeamWebHost, SUPPORTED_TEAM_HOST_PROVIDERS, normalizedStrings, serializeApprovalRequest, serializeCommonsParticipant, serializeCommonsQuestion, serializeCommonsProposal, serializeCommonsWeightSnapshot, serializeCommonsProposalBacking, serializeCommonsProposalVote, serializeCommonsDelegation, serializeCommonsDecision, serializeCommonsGovernanceEvent, serializeGovernancePolicy, serializeGovernanceProposal, serializeGovernanceElectorateSnapshot, serializeGovernanceVote, serializeGovernanceDelegation, serializeGovernanceDecision, serializeGovernanceEvent, serializeSeedRun, serializeTeamInvite, serializeProject, isoDate, compareDatesDesc, latestDate, uniqueStrings, PROJECT_DEPLOYMENT_TERMINAL_STATUSES, PROJECT_DEPLOYMENT_ACTIVE_STATUSES, normalizeProjectDeploymentStatus, deploymentKindForAction, summarizeProjectHealth, summarizeDeploymentStatus, toActivityItem, serializeConnection, serializeRepositoryHost, serializeHubRepository, serializeHubContentSource, serializeTreeDxInstance, serializeTreeDxProjectLibrary, serializeTreeDxMirror, serializeTreeDxShare, serializeTreeDxDeployment, serializeHubLaunch, serializeHubLaunchEvent, serializeHubWorkspaceLink, serializeProjectUpdatePlan, serializeProviderCredentialSession, serializeCapability, serializeEntitlement, serializeJob, serializeJobEvent, serializePlatformOperation, serializePlatformOperationEvent, serializeMarketOperationRunner, serializePlatformRepositoryClaim, platformRepositoryKey, platformRepositoryWorkspacePath, serializeAuditEvent, serializeSecretMetadataRecord, serializeClientEncryptedEscrowRecord, serializeGitHubRepositoryGrant, serializeGitHubAppInstallationRecord, serializeGitHubAppTokenIssuanceRecord, serializeWorkflowOperationRecord, serializeWorkflowDispatchRecord, serializeTreeDxCredentialIssuanceRecord, secretCapabilityValidationError, rejectSecretCapabilityPlaintext, serializeKnowledgePack, serializeTeamStorageLocator, serializeCatalogItem, serializeCatalogArtifactVersion, serializeCommerceVendor, serializeCommerceVendorStripeAccount, serializeCommerceProduct, serializeCommerceOwnershipRecord, serializeCommerceStewardshipAssignment, serializeCommerceContribution, serializeCommerceGovernancePolicy, serializeCommerceOwnershipTransfer, serializeCommerceSuccessionEvent, serializeCommerceOwnershipWorkflowSummary, serializeCommerceProductVersion, serializeCommerceOffer, serializeCommercePrice, serializeCommerceGovernanceEvent, serializeCommerceCart, serializeCommerceCartItem, serializeCommerceCheckout, serializeCommerceOrder, serializeCommerceOrderItem, serializeCommerceRefund, serializeCommerceFulfillmentEvent, serializeCommerceServiceRequest, serializeCommerceServiceQuote, serializeCommerceServiceContract, serializeCommerceServiceEvent, serializeCommerceCapacityListing, serializeCommerceCapacityListingInquiry, redactBuyerUserId, serializeCommerceVendorOrderSummary, serializeCommercePaymentGroup, serializeCommerceSubscription, serializeCommerceEntitlement, serializeCommerceBuyerStripeCustomer, serializeCommerceWebhookEvent, serializeProjectHosting, serializeProjectEnvironment, serializeProjectInfrastructureResource, serializeProjectDeployment, serializeProjectDeploymentEvent, serializeTeamInboxItem, serializeProjectSummarySnapshot, MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function createCommercePriceMethod(this: MarketControlPlaneStore, offerId, input: any = {}) {
    await this.ensureInitialized();
    const offer = await this.getCommerceOffer(offerId);
    if (!offer)
        return null;
    const amount = numberValue(input.amount, 0);
    if (amount < 0) {
        const error: Error & Record<string, any> = new Error('Price amount must be non-negative.');
        error.status = 400;
        throw error;
    }
    if (COMMERCE_ZERO_PRICE_OFFER_MODES.has(offer.mode) && amount !== 0) {
        const error: Error & Record<string, any> = new Error('Non-checkout offer modes must use zero display prices in Phase 2.');
        error.status = 400;
        throw error;
    }
    const billingInterval = enumValue(input.billingInterval, COMMERCE_PRICE_INTERVAL_SET, COMMERCE_COMMERCIAL_OFFER_MODES.has(offer.mode) && offer.mode !== 'one_time' && offer.mode !== 'one_time_current_version' ? 'month' : 'one_time');
    if (['one_time', 'one_time_current_version'].includes(offer.mode) && billingInterval !== 'one_time') {
        const error: Error & Record<string, any> = new Error('One-time offers must use one_time billing interval.');
        error.status = 400;
        throw error;
    }
    if (['subscription', 'subscription_updates', 'professional_hosting', 'scoped_contract'].includes(offer.mode) && billingInterval === 'one_time') {
        const error: Error & Record<string, any> = new Error('Recurring or scoped offers must use month, year, or custom billing interval.');
        error.status = 400;
        throw error;
    }
    const currency = stringValue(input.currency, 'usd').toLowerCase();
    if (!/^[a-z]{3}$/u.test(currency)) {
        const error: Error & Record<string, any> = new Error('Currency must be a lowercase 3-letter code.');
        error.status = 400;
        throw error;
    }
    const latest = await this.first(`SELECT MAX(price_version) AS max_version FROM commerce_prices WHERE offer_id = ?`, [offerId]);
    const priceVersion = Number(latest?.max_version ?? 0) + 1;
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    await this.run(`INSERT INTO commerce_prices (
				id, offer_id, amount, currency, billing_interval, status, stripe_product_id, stripe_price_id,
				stripe_lookup_key, stripe_sync_status, stripe_synced_at, stripe_sync_error, stripe_metadata_json, price_version,
				tax_behavior, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        offerId,
        amount,
        currency,
        billingInterval,
        enumValue(input.status, COMMERCE_PRICE_STATUS_SET, 'draft'),
        null,
        null,
        null,
        'not_synced',
        null,
        null,
        '{}',
        priceVersion,
        enumValue(input.taxBehavior, COMMERCE_TAX_BEHAVIOR_SET, 'unspecified'),
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        timestamp,
    ]);
    return serializeCommercePrice(await this.first(`SELECT * FROM commerce_prices WHERE id = ?`, [id]));
}

import type { Hono } from 'hono';
import { AgentSdk, RemoteClient, RemoteOperationsClient, RemoteSdkClient, signEditorialPreviewToken, OperationsSdk, executeSdkOperation, findDispatchCapability, planKnowledgeHubLaunch, derivePlatformOperationNavigation, deriveProjectHostBindingsView, isPlatformOperationTerminal, normalizeProjectLaunchHostBindings, normalizePlatformContentInput as normalizeRepositoryContentInput, normalizePlatformRelationArray as normalizeRepositoryRelationArray, platformContentRelationPolicy as repositoryContentRelationPolicy, normalizeTemplateLaunchRequirements, normalizeTemplateId, planProjectHostBindingOperation, resolveProjectLaunchHostBindings, slugifyPlatformContent as slugifyRepositoryContent, } from '@treeseed/sdk';
import { runHostingAudit } from '@treeseed/sdk/workflow-support';
import { createApiApp as createSdkApiApp, D1AuthProvider as DatabaseAuthProvider, loadTemplateCatalog, resolveApiConfig, } from '@treeseed/sdk/api';
import { MarketControlPlaneStore, validateProjectSlug } from '../../../persistence/store.js';
import { createClientEncryptedEscrowService } from '../../../support/client-encrypted-escrow.ts';
import { createGitHubAppAdapter } from '../../../reconciliation/github-app-adapter.ts';
import { createGitHubActionsSecretEnclave } from '../../../configuration/github-actions-secret-enclave.ts';
import { bearerTokenFromRequest } from '../../../accounts/request-auth.ts';
import { createTreeDxCredentialBridge } from '../../../treedx/repositories/treedx-credential-bridge.ts';
import { createMarketPostgresDatabase } from '../../../support/market-postgres.js';
import { installProjectDeploymentRoutes } from '../../../projects/deployments/project-deployment-routes.js';
import { installCapacityRoutes } from '../../../capacity/routes/index.ts';
import { createCapacityControlPlane } from '../../../capacity/control-plane.ts';
import { deleteTeamCapacityAggregate } from '../../../capacity/services/teams/team-deletion-service.ts';
import { readCapacityRequestObject } from '../../../capacity/routes/support/request-json.ts';
import { createStripeConnectService, resolveStripeEnvironment, stripeAccountToConnectedAccountPatch } from '../../../commerce/commerce-core/stripe-connect.js';
import { applySeedWithStore, exportSeedWithStore, planSeedWithStore } from '../../../../market/seeds/apply.js';
import { buildGovernanceApprovalProjection, buildGovernanceProjection } from '../../../../market/projects/projects-core/governance-projection.js';
import { buildInfrastructureProjection } from '../../../../market/projects/hosting/infrastructure-projection.js';
import { loadInfrastructureSeedState } from '../../../../market/seeds/infrastructure-seeds.js';
import { buildKnowledgeArtifactProjection, buildKnowledgeProjection } from '../../../../market/projects/knowledge/knowledge-projection.js';
import { buildWorkdayProjection } from '../../../../market/capacity/workdays/workday-projection.js';
import { loadKnowledgeContentEntries } from '../../../../view-models/knowledge-content.js';
import { listManagedHostsFromConfig, managedCloudflareConfigMissing, resolveManagedCloudflareHostConfigFromConfig, } from '../../../../market/hosting/managed-hosts.js';
import { decryptHostConfig } from '../../../../crypto/host-crypto.ts';
import { getSiteAuthConfig } from '../../../../auth/config.ts';
import { accountDeletionConfirmationMatches } from '../../../../auth/account.ts';
import { validateUsername as validatePublicUsername } from '../../../../auth/profile-validation.ts';
import { authEmailDeliveryFailureDetail, authEmailDeliveryFailureReason, sendAuthEmail } from '../../../../auth/email.ts';
import { recordContentNotificationEvent } from '../../../../notifications/service.ts';
import { sendEmailConfirmation } from '../../../../auth/email-confirmation.ts';
import { sendWelcomeEmail } from '../../../../auth/welcome-email.ts';
import { createCipheriv, createDecipheriv, createHash, createHmac, createPublicKey, createVerify, pbkdf2Sync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { contentRelationPolicy } from '../../../../market/content/content-relations.js';
import { NOTIFICATION_CONTENT_CAPABILITIES, PERSONAL_THEME_COMPILER_VERSION, isValidPersonalThemeDraft, normalizeNotificationPreferences, } from '@treeseed/sdk/account-contracts';
import { jsonError, jsonThrownError, POSTGRES_AUTH_PROVIDER_ID, availabilityAttempts, AUTH_PROVIDERS, providerJwksCache, availabilityRateLimit, personalThemeFromRow, accountDeletionBlockers, consumeReauthentication, loadNotificationPreferences, providerConfigFor, base64Url, verifyProviderIdToken, exchangeProviderIdentity, sourceFromProjectDetails, repositoryInventoryWithPlatform, createProjectHostCredentialSessions, rejectProjectSecretUnlockMaterial, markdownToPlainProjectSummary, parseBooleanEnvValue, shouldLogApiRequests, shouldExposeNonProductionAuthDiagnostics, SENSITIVE_QUERY_PARAM_PATTERN, redactedRequestTarget, installApiRequestLogger, AGENT_PROMOTION_APPROVAL_DECISIONS, readJsonOrFormBody, normalizeEmail, normalizeUsername, parseJsonObject, trimmedHeaderValue, requestClientIp, requestSessionMetadata, webSessionData, validateMarketPassword, hashMarketPassword, verifyMarketPassword, ensureMarketCredentialSchema, MARKET_EMAIL_CONFIRMATION_PREFIX, marketAuthContext, shouldBypassAcceptanceAuthEmailDelivery, marketEmailTokenHash, exposeAuthTokenForTests, authTokenTimestampSeconds, authTokenTimestampMillis, sanitizedReturnTo, confirmationUrlFor, teamInviteAcceptUrlFor, passwordResetUrlFor, sendTeamInviteEmail, createMarketEmailConfirmation, serializeUserEmailAddress, backfillUserEmailAddresses, listUserEmailAddresses, getUserEmailAddress, verifiedEmailCount, setPrimaryEmailAddress, syncPrimaryEmailCaches, createOrResendUserEmailAddress, createMarketWebSession, webAuthPayload, normalizeAppearancePreference, normalizeBaseUrl, optionalTrimmedString, enumValue, unknownKeys, LOCAL_CONTENT_COLLECTIONS, LOCAL_WORK_CONTENT_COLLECTIONS, LOCAL_DECISION_TYPE_VALUES, PROPOSAL_VERDICT_DECISION_TYPES, PLATFORM_OPERATION_SCOPES, LOCAL_CONTENT_DEFAULTS, slugifyContent, yamlScalar, yamlLines, serializeFrontmatter, normalizeRelationArray, uniqueRelationArray, addRelationValue, normalizeLocalContentInput, writeLocalContentRecord, localContentRoot, localContentPath, readLocalContentRecord, writeParsedLocalContentRecord, createRelatedLocalContentRecord, createDecisionFromProposals, isLoopbackUrl, resolveAuthApprovalBaseUrl, findById, resolveAgentArtifactBucket, centralMarketProfile, normalizeMarketProfile, credentialSessionSecret, credentialSessionKey, encryptCredentialSessionPayload, decryptCredentialSessionPayload, normalizeProviderCredentialConfig, HOST_KIND_SESSION_KEYS, providerCredentialValuesForAudit, mergeStringConfig, scheduleBackgroundBootstrap, projectDeletionConfirmationMatches, projectDeletionBlockerRows, githubRequestForProjectDeletion, projectDeletionOperation, cloudflareDeletionAuthenticationMessage, appendProjectDeletionProgress, runProjectDeletionApiDestroy, GITHUB_ACTIONS_OIDC_ISSUER, githubOidcJwksCache, base64urlJson, parseBase64urlJson, operationTokenSecret, signOperationToken, verifyOperationToken, loadGitHubOidcJwks, verifyGitHubOidcToken, normalizeCiEnvironment, ciOperationForAction, fallbackRemoteCapability, normalizeRepositorySlug, projectAllowedCiRepositories, validateCiRefForEnvironment, marketProfilesForTeams, artifactDownloadPayload, principalHasPermission, principalIsSeedAdmin, isTeamApiPrincipal, isLocalAcceptanceServicePrincipal, localAcceptanceAdminToken, localAcceptanceAuthEnabled, decorateJob, safePlatformOperationOutput, decoratePlatformOperation, safeTokenEquals, resolvePlatformRunnerSecret, platformOperationMutationError, requirePlatformRunner, resolvePlatformRepositoryDescriptor, mergeCapability, canonicalArchitectureTopology, ensurePrincipal, resolveUiProjectionContext, decodeRouteParam, uiRuntimeLocals, requireConfiguredServiceCredential, resolvePublicTreeDxTeam, enqueueTreeDxProvisionOperation, principalHasGlobalPlatformRole, requireTeamAccess, requireProjectAccess, safePrivateKnowledgeSlug, privateKnowledgeAuditPayload, recordPrivateKnowledgeAudit, FEEDBACK_TYPES, FEEDBACK_SCREENSHOT_TYPES, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, cleanFeedbackString, safeFeedbackContext, safeFeedbackClient, safeFeedbackScreenshot, validateFeedbackAccess, recordFeedbackSubmission, normalizeSeedEnvironments, seedActor, seedExistingTeamIds, seedCreatesMissingTeams, requireSeedPlanAccess, requireSeedApplyAccess, requireProjectRunner, AGENT_TASK_SIGNATURES, resolveAgentTaskSignature, commerceErrorResponse, stripeConfiguredError, stripeVendorApprovalError, stripeAccountMissingError, stripeCommerceUrl, requireCommerceVendorForStripe, refreshCommerceStripeAccount, STRIPE_PRODUCT_MIRROR_OFFER_MODES, STRIPE_PRICE_MIRROR_OFFER_MODES, stripeMetadataValue, buildCommerceStripeMetadata, commerceStripeProductParams, commerceStripeLookupKey, commerceStripePriceParams, stripePriceTermsDrift, commerceStripeSyncContext, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, CHECKOUT_OFFER_MODES, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, resolveStripePublishableKey, resolveStripeWebhookSecret, commerceCheckoutError, normalizeCheckoutQuantity, stripeClientSecret, paymentGroupStatusFromPaymentIntent, orderStatusFromPaymentGroup, subscriptionStatusFromStripe, entitlementRenewalStateFromSubscription, stripeTimestampToIso, subscriptionClientSecret, publicPaymentGroups, buildCommerceCheckoutMetadata, resolveCommerceCheckoutItem, checkoutGroupKind, checkoutGroupKey, checkoutGroupStatus, grantCommerceEntitlementsForOrder, requireSellerTeamAccess, requireVendorOrderManager, requireServiceBuyerAccess, requireServiceSellerAccess, requireServiceParticipantAccess, redactCommerceServiceRequestForBuyer, requireCommerceCapacityListingAccess, requireCommerceCapacityInquiryAccess, remainingRefundableAmount, stripeRefundStatus, applyCommerceRefundState, resolveOrderItemForRefund, resolveFulfillmentArtifact, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, ensureCommerceStripeCustomer, refreshCommercePaymentGroupState, updateCheckoutCompletionFromGroup, syncCommerceSubscriptionFromStripe, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, handleCommerceInvoiceWebhook, processCommerceStripeWebhook, requireCommerceProductAccess, principalCanManageCommerceProduct, redactCommerceOwnershipWorkflow, requireCommerceOfferAccess, requireCatalogItemAccess, requireConnectedProjectRuntime, projectAppHref, hubRepositoryPolicies, unwrapOperationPayload, applyContentPublishResult, executeInline, projectApiConnection, createProjectInternalClient, executeProjectApi, selectDispatchTarget, defaultConfig, createApiExtension, projectHostBindingMetadata, loadProjectHostBindingContext, projectHostResponsePayload, hostBindingRequiresUnlock, hostKindForBinding, persistProjectHostBindingOperationMetadata, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, plaintextHostCredentialFieldPaths, rejectPlaintextHostCredentialFields, normalizeDomainName, normalizeProjectDomainInput, inferZoneNameForDomain, domainInZone, encryptedHostPayloadLooksValid, decryptedHostConfigSummary, normalizeAuditHostKinds, collectHostingAuditCredentialOverlay, cloudflareErrorMessage, cloudflareRequestForLaunchPreflight, resolveCloudflareZoneForLaunchPreflight, verifyCloudflareDnsWriteForLaunch, cloudflareRequestForProjectDeletion, hasRecordedCloudflareRuntimeResources, canSkipCloudflareCleanupAfterFailedLaunch, projectDeletionHostname, normalizedCloudflareKvNamespaceReference, uniqueCloudflareKvNamespaceReferences, cloudflareProjectDeletionResourceNames, resolveProjectDeletionCloudflareZone, deleteCloudflareDnsRecordsForProject, listCloudflareNamedResources, deleteCloudflareProjectResources, cloudflareDnsDomainsForHostValidation, validateTeamHostCredentialPayload, buildLaunchCredentialOverlay, patchLaunchIntentForCredentialOverlay, appendLaunchDeploymentEvent, sanitizeLaunchResultForStorage, runProjectLaunchApiBootstrap, retryApiLaunchBootstrapFromRequest, resourceRowsFromLaunch, unwrapLaunchOperationOutput, appendLaunchPhaseProjection, updateLaunchDeployments, applyHubLaunchResult, applyHubLaunchFailure } from '../index.ts';
export async function resolveLaunchTemplateRequirements({ store, principal, config, sourceKind, sourceRef, requireKnownTemplate = false }) {
    if (!['template', 'market_listing'].includes(sourceKind) || typeof sourceRef !== 'string' || !sourceRef.trim()) {
        return null;
    }
    const ref = normalizeTemplateId(sourceRef);
    try {
        const catalog = loadTemplateCatalog(config);
        const catalogEntry = catalog.items.find((item) => item.id === ref);
        if (catalogEntry?.launchRequirements)
            return catalogEntry.launchRequirements;
        if (catalogEntry)
            return null;
    }
    catch {
        // Catalog lookup is best-effort here; custom catalog metadata can still provide requirements.
    }
    const item = await store.getCatalogItem(ref).catch(() => null)
        ?? await store.getCatalogItemBySlug('template', ref).catch(() => null);
    if (!item) {
        if (requireKnownTemplate)
            throw new Error(`Unknown template "${ref}".`);
        return null;
    }
    const canAccess = await store.principalCanAccessCatalogItem(principal, item).catch(() => false);
    if (!canAccess)
        return null;
    return normalizeTemplateLaunchRequirements(item.metadata?.launchRequirements, `catalog item ${ref} launchRequirements`) ?? null;
}
export function nonSecretLaunchJobInput(input: any = {}) {
    const clone = JSON.parse(JSON.stringify(input ?? {}));
    delete clone.credentialSessions;
    delete clone.sensitivePassphrase;
    if (clone.launchIntent?.execution?.providerLaunchInput?.repositoryHostConfig) {
        delete clone.launchIntent.execution.providerLaunchInput.repositoryHostConfig;
    }
    if (clone.launchIntent?.execution?.providerLaunchInput?.cloudflareHost?.config) {
        delete clone.launchIntent.execution.providerLaunchInput.cloudflareHost.config;
    }
    if (clone.launchIntent?.execution?.providerLaunchInput?.emailHost?.config) {
        delete clone.launchIntent.execution.providerLaunchInput.emailHost.config;
    }
    return clone;
}
export async function decryptTeamHostForLaunch(hostKind, host, passphrase) {
    if (!host?.encryptedPayload) {
        throw new Error('Selected host does not have encrypted provider credentials.');
    }
    const decryptedConfig = await decryptHostConfig(host.encryptedPayload, passphrase);
    return normalizeProviderCredentialConfig(hostKind, decryptedConfig, host);
}
export function launchPlannerRepositoryTopology(value) {
    if (value === undefined || value === null || value === '')
        return 'split_software_content';
    if (value === 'single_repository_site' || value === 'parent_workspace')
        return 'combined_compatibility';
    if (value === 'split_site_content')
        return 'split_software_content';
    if (value === 'combined_compatibility' || value === 'split_software_content') {
        const error: Error & Record<string, any> = new Error('Project launch repository topology must use canonical project architecture values.');
        error.code = 'legacy_project_topology_rejected';
        throw error;
    }
    const error: Error & Record<string, any> = new Error(`Unsupported project architecture topology: ${String(value)}.`);
    error.code = 'invalid_project_architecture';
    throw error;
}
export function launchCapabilityPreset(projectTopology = 'split_site_content') {
    const architectureTopology = canonicalArchitectureTopology(projectTopology);
    const approvalDefaults = {
        'repository.create': {
            requiresApproval: true,
            allowedRoles: ['team_owner', 'technical_steward'],
            reason: 'Repository creation can create or change team-owned infrastructure.',
        },
        'repository.configure': {
            requiresApproval: true,
            allowedRoles: ['team_owner', 'technical_steward'],
            reason: 'Repository configuration changes access and workflow policy.',
        },
        'content.publish': {
            requiresApproval: true,
            allowedRoles: ['content_policy_approver'],
            reason: 'Content publish changes what the hub contains.',
        },
        'workflow.deploy_runtime': {
            requiresApproval: true,
            allowedRoles: ['technical_steward', 'release_approver'],
            reason: 'Runtime deployment changes how the hub runs.',
        },
        'workflow.publish_release': {
            requiresApproval: true,
            allowedRoles: ['technical_steward', 'release_approver'],
            reason: 'Software release changes how the hub works.',
        },
        'market.publish': {
            requiresApproval: true,
            allowedRoles: ['market_steward'],
            reason: 'Treeseed publishing makes project outputs externally visible.',
        },
    };
    const resourceScope = (namespace, operation) => ({
        architectureTopology,
        repositories: {
            software: ['workflow', 'repository'].includes(namespace) || operation.includes('release') || operation.includes('deploy'),
            content: namespace === 'content' || operation.includes('publish'),
            parentWorkspace: false,
        },
        runtimeResources: namespace === 'workflow',
        marketListing: namespace === 'market',
    });
    const remoteJob = (namespace, operation, allowedTargets: any = ['project_runner']) => ({
        namespace,
        operation,
        label: `${namespace}.${operation}`,
        executionClass: 'remote_job',
        allowedTargets,
        defaultDispatchMode: 'auto',
        enabled: true,
        approvalPolicy: approvalDefaults[`${namespace}.${operation}`] ?? {
            requiresApproval: false,
            allowedRoles: ['team_owner', 'project_lead', 'technical_steward'],
            reason: 'Team permission is verified before execution.',
        },
        resourceScope: resourceScope(namespace, operation),
        metadata: {
            architectureTopology,
        },
    });
    const inline = (namespace, operation) => ({
        namespace,
        operation,
        label: `${namespace}.${operation}`,
        executionClass: 'remote_inline',
        allowedTargets: ['project_api', 'project_runner'],
        defaultDispatchMode: 'auto',
        enabled: true,
        approvalPolicy: { requiresApproval: false, allowedRoles: ['team_member'], reason: 'Read or draft-only project SDK operation.' },
        resourceScope: resourceScope(namespace, operation),
        metadata: { architectureTopology },
    });
    return [
        remoteJob('workflow', 'launch_project'),
        remoteJob('repository', 'create'),
        remoteJob('repository', 'configure'),
        remoteJob('workflow', 'apply_config'),
        remoteJob('workflow', 'reconcile_runtime'),
        remoteJob('workflow', 'deploy_runtime'),
        remoteJob('workflow', 'verify_runtime'),
        remoteJob('content', 'verify_package'),
        remoteJob('content', 'publish'),
        remoteJob('workflow', 'stage_release'),
        remoteJob('workflow', 'publish_release'),
        inline('sdk', 'read'),
        inline('sdk', 'search'),
        inline('sdk', 'create_direct_item'),
        inline('sdk', 'update_direct_item'),
    ];
}

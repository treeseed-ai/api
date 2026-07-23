import type { Hono } from 'hono';
import { AgentSdk, RemoteTreeseedClient, RemoteTreeseedOperationsClient, RemoteTreeseedSdkClient, signEditorialPreviewToken, TreeseedOperationsSdk, executeSdkOperation, findDispatchCapability, planKnowledgeHubLaunch, derivePlatformOperationNavigation, deriveProjectHostBindingsView, isPlatformOperationTerminal, normalizeProjectLaunchHostBindings, normalizePlatformContentInput as normalizeRepositoryContentInput, normalizePlatformRelationArray as normalizeRepositoryRelationArray, platformContentRelationPolicy as repositoryContentRelationPolicy, normalizeTemplateLaunchRequirements, normalizeTreeseedTemplateId, planProjectHostBindingOperation, resolveProjectLaunchHostBindings, slugifyPlatformContent as slugifyRepositoryContent, } from '@treeseed/sdk';
import { runTreeseedHostingAudit } from '@treeseed/sdk/workflow-support';
import { createTreeseedApiApp, D1AuthProvider as DatabaseAuthProvider, loadTemplateCatalog, resolveApiConfig, } from '@treeseed/sdk/api';
import { MarketControlPlaneStore, validateProjectSlug } from '../../store.js';
import { createClientEncryptedEscrowService } from '../../client-encrypted-escrow.ts';
import { createGitHubAppAdapter } from '../../github-app-adapter.ts';
import { createGitHubActionsSecretEnclave } from '../../github-actions-secret-enclave.ts';
import { bearerTokenFromRequest } from '../../request-auth.ts';
import { createTreeDxCredentialBridge } from '../../treedx-credential-bridge.ts';
import { createMarketPostgresDatabase } from '../../market-postgres.js';
import { installProjectDeploymentRoutes } from '../../project-deployment-routes.js';
import { installCapacityRoutes } from '../../capacity/routes/index.ts';
import { createCapacityControlPlane } from '../../capacity/control-plane.ts';
import { deleteTeamCapacityAggregate } from '../../capacity/services/team-deletion-service.ts';
import { readCapacityRequestObject } from '../../capacity/routes/request-json.ts';
import { createStripeConnectService, resolveStripeEnvironment, stripeAccountToConnectedAccountPatch } from '../../stripe-connect.js';
import { applySeedWithStore, exportSeedWithStore, planSeedWithStore } from '../../../market/seeds/apply.js';
import { buildGovernanceApprovalProjection, buildGovernanceProjection } from '../../../market/governance-projection.js';
import { buildInfrastructureProjection } from '../../../market/infrastructure-projection.js';
import { loadInfrastructureSeedState } from '../../../market/infrastructure-seeds.js';
import { buildKnowledgeArtifactProjection, buildKnowledgeProjection } from '../../../market/knowledge-projection.js';
import { buildWorkdayProjection } from '../../../market/workday-projection.js';
import { loadKnowledgeContentEntries } from '../../../view-models/knowledge-content.js';
import { listTreeseedManagedHostsFromConfig, managedCloudflareConfigMissing, resolveTreeseedManagedCloudflareHostConfigFromConfig, } from '../../../market/managed-hosts.js';
import { decryptHostConfig } from '../../../crypto/host-crypto.ts';
import { getSiteAuthConfig } from '../../../auth/config.ts';
import { accountDeletionConfirmationMatches } from '../../../auth/account.ts';
import { validateUsername as validatePublicUsername } from '../../../auth/profile-validation.ts';
import { authEmailDeliveryFailureDetail, authEmailDeliveryFailureReason, sendAuthEmail } from '../../../auth/email.ts';
import { recordContentNotificationEvent } from '../../../notifications/service.ts';
import { sendEmailConfirmation } from '../../../auth/email-confirmation.ts';
import { sendWelcomeEmail } from '../../../auth/welcome-email.ts';
import { createCipheriv, createDecipheriv, createHash, createHmac, createPublicKey, createVerify, pbkdf2Sync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { contentRelationPolicy } from '../../../market/content-relations.js';
import { NOTIFICATION_CONTENT_CAPABILITIES, PERSONAL_THEME_COMPILER_VERSION, isValidPersonalThemeDraft, normalizeNotificationPreferences, } from '@treeseed/sdk/account-contracts';
import { POSTGRES_AUTH_PROVIDER_ID, AUTH_PROVIDERS, consumeReauthentication, loadNotificationPreferences, verifyProviderIdToken, resolveLaunchTemplateRequirements, projectHostBindingMetadata, sourceFromProjectDetails, repositoryInventoryWithPlatform, loadProjectHostBindingContext, projectHostResponsePayload, hostBindingRequiresUnlock, hostKindForBinding, createProjectHostCredentialSessions, persistProjectHostBindingOperationMetadata, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, plaintextHostCredentialFieldPaths, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, markdownToPlainProjectSummary, shouldExposeNonProductionAuthDiagnostics, AGENT_PROMOTION_APPROVAL_DECISIONS, normalizeEmail, requestSessionMetadata, webSessionData, validateMarketPassword, hashMarketPassword, verifyMarketPassword, MARKET_EMAIL_CONFIRMATION_PREFIX, marketAuthContext, shouldBypassAcceptanceAuthEmailDelivery, marketEmailTokenHash, exposeAuthTokenForTests, authTokenTimestampSeconds, authTokenTimestampMillis, passwordResetUrlFor, sendTeamInviteEmail, createMarketEmailConfirmation, serializeUserEmailAddress, backfillUserEmailAddresses, listUserEmailAddresses, getUserEmailAddress, verifiedEmailCount, setPrimaryEmailAddress, syncPrimaryEmailCaches, createOrResendUserEmailAddress, createMarketWebSession, webAuthPayload, normalizeAppearancePreference, normalizeDomainName, normalizeProjectDomainInput, inferZoneNameForDomain, domainInZone, LOCAL_CONTENT_COLLECTIONS, LOCAL_WORK_CONTENT_COLLECTIONS, LOCAL_DECISION_TYPE_VALUES, PROPOSAL_VERDICT_DECISION_TYPES, PLATFORM_OPERATION_SCOPES, LOCAL_CONTENT_DEFAULTS, slugifyContent, serializeFrontmatter, normalizeRelationArray, uniqueRelationArray, addRelationValue, normalizeLocalContentInput, writeLocalContentRecord, localContentRoot, localContentPath, readLocalContentRecord, writeParsedLocalContentRecord, createRelatedLocalContentRecord, createDecisionFromProposals, resolveAuthApprovalBaseUrl, encryptedHostPayloadLooksValid, decryptedHostConfigSummary, credentialSessionSecret, credentialSessionKey, encryptCredentialSessionPayload, decryptCredentialSessionPayload, HOST_KIND_SESSION_KEYS, normalizeAuditHostKinds, collectHostingAuditCredentialOverlay, nonSecretLaunchJobInput, decryptTeamHostForLaunch, buildLaunchCredentialOverlay, patchLaunchIntentForCredentialOverlay, appendLaunchDeploymentEvent, sanitizeLaunchResultForStorage, cloudflareErrorMessage, cloudflareRequestForLaunchPreflight, resolveCloudflareZoneForLaunchPreflight, verifyCloudflareDnsWriteForLaunch, projectDeletionConfirmationMatches, projectDeletionBlockerRows, cloudflareRequestForProjectDeletion, githubRequestForProjectDeletion, projectDeletionOperation, cloudflareDeletionAuthenticationMessage, hasRecordedCloudflareRuntimeResources, canSkipCloudflareCleanupAfterFailedLaunch, projectDeletionHostname, normalizedCloudflareKvNamespaceReference, uniqueCloudflareKvNamespaceReferences, cloudflareProjectDeletionResourceNames, resolveProjectDeletionCloudflareZone, deleteCloudflareDnsRecordsForProject, listCloudflareNamedResources, deleteCloudflareProjectResources, appendProjectDeletionProgress, cloudflareDnsDomainsForHostValidation, validateTeamHostCredentialPayload, runProjectLaunchApiBootstrap, runProjectDeletionApiDestroy, retryApiLaunchBootstrapFromRequest, operationTokenSecret, signOperationToken, verifyOperationToken, normalizeCiEnvironment, ciOperationForAction, normalizeRepositorySlug, projectAllowedCiRepositories, validateCiRefForEnvironment, principalHasPermission, principalIsSeedAdmin, isTeamApiPrincipal, isLocalAcceptanceServicePrincipal, localAcceptanceAuthEnabled, decorateJob, safePlatformOperationOutput, decoratePlatformOperation, resolvePlatformRunnerSecret, platformOperationMutationError, requirePlatformRunner, resolvePlatformRepositoryDescriptor, launchPlannerRepositoryTopology, launchCapabilityPreset, resourceRowsFromLaunch, ensurePrincipal, resolveUiProjectionContext, resolvePublicTreeDxTeam, enqueueTreeDxProvisionOperation, principalHasGlobalPlatformRole, requireTeamAccess, requireProjectAccess, FEEDBACK_TYPES, FEEDBACK_SCREENSHOT_TYPES, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, cleanFeedbackString, safeFeedbackContext, safeFeedbackClient, safeFeedbackScreenshot, validateFeedbackAccess, recordFeedbackSubmission, normalizeSeedEnvironments, seedActor, seedExistingTeamIds, seedCreatesMissingTeams, requireSeedPlanAccess, requireSeedApplyAccess, requireProjectRunner, commerceErrorResponse, stripeConfiguredError, stripeVendorApprovalError, stripeAccountMissingError, stripeCommerceUrl, requireCommerceVendorForStripe, refreshCommerceStripeAccount, STRIPE_PRODUCT_MIRROR_OFFER_MODES, STRIPE_PRICE_MIRROR_OFFER_MODES, stripeMetadataValue, buildCommerceStripeMetadata, commerceStripeProductParams, commerceStripeLookupKey, commerceStripePriceParams, stripePriceTermsDrift, commerceStripeSyncContext, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, CHECKOUT_OFFER_MODES, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, resolveStripePublishableKey, resolveStripeWebhookSecret, commerceCheckoutError, normalizeCheckoutQuantity, stripeClientSecret, paymentGroupStatusFromPaymentIntent, orderStatusFromPaymentGroup, subscriptionStatusFromStripe, entitlementRenewalStateFromSubscription, stripeTimestampToIso, subscriptionClientSecret, publicPaymentGroups, buildCommerceCheckoutMetadata, resolveCommerceCheckoutItem, checkoutGroupKind, checkoutGroupKey, checkoutGroupStatus, grantCommerceEntitlementsForOrder, requireSellerTeamAccess, requireServiceParticipantAccess, redactCommerceServiceRequestForBuyer, requireCommerceCapacityListingAccess, requireCommerceCapacityInquiryAccess, stripeRefundStatus, applyCommerceRefundState, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, ensureCommerceStripeCustomer, refreshCommercePaymentGroupState, updateCheckoutCompletionFromGroup, syncCommerceSubscriptionFromStripe, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, handleCommerceInvoiceWebhook, processCommerceStripeWebhook, requireCommerceProductAccess, principalCanManageCommerceProduct, redactCommerceOwnershipWorkflow, requireCommerceOfferAccess, requireConnectedProjectRuntime, projectAppHref, unwrapLaunchOperationOutput, appendLaunchPhaseProjection, updateLaunchDeployments, hubRepositoryPolicies, applyHubLaunchResult, applyHubLaunchFailure, unwrapOperationPayload, applyContentPublishResult, projectApiConnection, createProjectInternalClient, executeProjectApi, jsonError, jsonThrownError, providerConfigFor, parseBooleanEnvValue, redactedRequestTarget, normalizeUsername, parseJsonObject, normalizeBaseUrl, normalizeMarketProfile, normalizeProviderCredentialConfig, mergeStringConfig, parseBase64urlJson, safeTokenEquals, requireConfiguredServiceCredential, safePrivateKnowledgeSlug, requireServiceBuyerAccess, requireServiceSellerAccess, requireCatalogItemAccess, defaultConfig, availabilityAttempts, providerJwksCache, availabilityRateLimit, personalThemeFromRow, accountDeletionBlockers, base64Url, exchangeProviderIdentity, shouldLogApiRequests, SENSITIVE_QUERY_PARAM_PATTERN, installApiRequestLogger, readJsonOrFormBody, trimmedHeaderValue, requestClientIp, ensureMarketCredentialSchema, sanitizedReturnTo, confirmationUrlFor, teamInviteAcceptUrlFor, optionalTrimmedString, enumValue, unknownKeys, yamlScalar, yamlLines, isLoopbackUrl, findById, resolveAgentArtifactBucket, centralMarketProfile, providerCredentialValuesForAudit, scheduleBackgroundBootstrap, GITHUB_ACTIONS_OIDC_ISSUER, githubOidcJwksCache, base64urlJson, loadGitHubOidcJwks, verifyGitHubOidcToken, marketProfilesForTeams, artifactDownloadPayload, localAcceptanceAdminToken, canonicalArchitectureTopology, decodeRouteParam, uiRuntimeLocals, privateKnowledgeAuditPayload, recordPrivateKnowledgeAudit, AGENT_TASK_SIGNATURES, requireVendorOrderManager, remainingRefundableAmount, resolveOrderItemForRefund, resolveFulfillmentArtifact, createApiExtension } from './index.ts';
export function fallbackRemoteCapability(namespace, operation) {
    return {
        namespace,
        operation,
        label: `${namespace}.${operation}`,
        executionClass: 'remote_job',
        allowedTargets: ['project_runner'],
        defaultTarget: 'project_runner',
        defaultDispatchMode: 'auto',
        approvalPolicy: {},
        resourceScope: {},
        metadata: {},
    };
}
export function mergeCapability(baseCapability, override) {
    if (!override) {
        return baseCapability;
    }
    return {
        ...baseCapability,
        executionClass: override.executionClass,
        allowedTargets: [...override.allowedTargets],
        defaultDispatchMode: override.defaultDispatchMode,
        label: override.label ?? baseCapability.label ?? `${baseCapability.namespace}.${baseCapability.operation}`,
        approvalPolicy: override.approvalPolicy ?? baseCapability.approvalPolicy ?? {},
        resourceScope: override.resourceScope ?? baseCapability.resourceScope ?? {},
        metadata: override.metadata ?? baseCapability.metadata ?? {},
    };
}
export function resolveAgentTaskSignature(value) {
    const signature = typeof value === 'string' && value.trim() ? value.trim() : 'proposal.draft';
    return {
        signature,
        definition: AGENT_TASK_SIGNATURES[signature] ?? AGENT_TASK_SIGNATURES['proposal.draft'],
    };
}
export async function executeInline(runtime, request) {
    if (request.namespace === 'workflow') {
        const operations = new TreeseedOperationsSdk();
        return operations.execute({
            operationName: request.operation,
            input: request.input ?? {},
        }, {
            cwd: runtime.resolved.config.repoRoot,
            env: process.env,
            transport: 'api',
        });
    }
    return executeSdkOperation(runtime.sharedSdk, request.operation, request.input ?? {});
}
export function selectDispatchTarget(runtime, projectDetails, capability, preferredMode) {
    const currentProject = projectDetails.project.id === runtime.resolved.config.projectId;
    const mode = projectDetails.connection?.mode ?? (currentProject ? 'hosted' : 'self_hosted');
    const projectApiBaseUrl = projectApiConnection(projectDetails);
    if (capability.executionClass === 'local_only') {
        return 'local';
    }
    if (preferredMode === 'prefer_local' && currentProject && capability.allowedTargets.includes('local')) {
        return 'local';
    }
    if (capability.defaultTarget === 'market_catalog' && capability.allowedTargets.includes('market_catalog')) {
        return 'market_catalog';
    }
    if (capability.executionClass === 'remote_inline'
        && capability.allowedTargets.includes('project_api')
        && (projectApiBaseUrl || (currentProject && mode === 'hosted'))) {
        return 'project_api';
    }
    if ((mode === 'self_hosted' || mode === 'hybrid' || capability.executionClass === 'remote_job') && capability.allowedTargets.includes('project_runner')) {
        return 'project_runner';
    }
    if (currentProject && capability.allowedTargets.includes('local')) {
        return 'local';
    }
    if (capability.allowedTargets.includes('market_catalog')) {
        return 'market_catalog';
    }
    return null;
}

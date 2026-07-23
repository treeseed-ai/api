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
import { POSTGRES_AUTH_PROVIDER_ID, AUTH_PROVIDERS, consumeReauthentication, loadNotificationPreferences, verifyProviderIdToken, resolveLaunchTemplateRequirements, projectHostBindingMetadata, sourceFromProjectDetails, repositoryInventoryWithPlatform, loadProjectHostBindingContext, projectHostResponsePayload, hostBindingRequiresUnlock, hostKindForBinding, createProjectHostCredentialSessions, persistProjectHostBindingOperationMetadata, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, plaintextHostCredentialFieldPaths, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, markdownToPlainProjectSummary, shouldExposeNonProductionAuthDiagnostics, AGENT_PROMOTION_APPROVAL_DECISIONS, normalizeEmail, requestSessionMetadata, webSessionData, validateMarketPassword, hashMarketPassword, verifyMarketPassword, MARKET_EMAIL_CONFIRMATION_PREFIX, marketAuthContext, shouldBypassAcceptanceAuthEmailDelivery, marketEmailTokenHash, exposeAuthTokenForTests, authTokenTimestampSeconds, authTokenTimestampMillis, passwordResetUrlFor, sendTeamInviteEmail, createMarketEmailConfirmation, serializeUserEmailAddress, backfillUserEmailAddresses, listUserEmailAddresses, getUserEmailAddress, verifiedEmailCount, setPrimaryEmailAddress, syncPrimaryEmailCaches, createOrResendUserEmailAddress, createMarketWebSession, webAuthPayload, normalizeAppearancePreference, normalizeDomainName, normalizeProjectDomainInput, inferZoneNameForDomain, domainInZone, LOCAL_CONTENT_COLLECTIONS, LOCAL_WORK_CONTENT_COLLECTIONS, LOCAL_DECISION_TYPE_VALUES, PROPOSAL_VERDICT_DECISION_TYPES, PLATFORM_OPERATION_SCOPES, LOCAL_CONTENT_DEFAULTS, slugifyContent, serializeFrontmatter, normalizeRelationArray, uniqueRelationArray, addRelationValue, normalizeLocalContentInput, writeLocalContentRecord, localContentRoot, localContentPath, readLocalContentRecord, writeParsedLocalContentRecord, createRelatedLocalContentRecord, createDecisionFromProposals, resolveAuthApprovalBaseUrl, encryptedHostPayloadLooksValid, decryptedHostConfigSummary, credentialSessionSecret, credentialSessionKey, encryptCredentialSessionPayload, decryptCredentialSessionPayload, HOST_KIND_SESSION_KEYS, normalizeAuditHostKinds, collectHostingAuditCredentialOverlay, nonSecretLaunchJobInput, decryptTeamHostForLaunch, buildLaunchCredentialOverlay, patchLaunchIntentForCredentialOverlay, appendLaunchDeploymentEvent, sanitizeLaunchResultForStorage, cloudflareErrorMessage, cloudflareRequestForLaunchPreflight, resolveCloudflareZoneForLaunchPreflight, verifyCloudflareDnsWriteForLaunch, projectDeletionConfirmationMatches, projectDeletionBlockerRows, cloudflareRequestForProjectDeletion, githubRequestForProjectDeletion, projectDeletionOperation, cloudflareDeletionAuthenticationMessage, hasRecordedCloudflareRuntimeResources, canSkipCloudflareCleanupAfterFailedLaunch, projectDeletionHostname, normalizedCloudflareKvNamespaceReference, uniqueCloudflareKvNamespaceReferences, cloudflareProjectDeletionResourceNames, resolveProjectDeletionCloudflareZone, deleteCloudflareDnsRecordsForProject, listCloudflareNamedResources, deleteCloudflareProjectResources, appendProjectDeletionProgress, cloudflareDnsDomainsForHostValidation, validateTeamHostCredentialPayload, runProjectLaunchApiBootstrap, runProjectDeletionApiDestroy, retryApiLaunchBootstrapFromRequest, operationTokenSecret, signOperationToken, verifyOperationToken, normalizeCiEnvironment, ciOperationForAction, normalizeRepositorySlug, projectAllowedCiRepositories, validateCiRefForEnvironment, principalHasPermission, principalIsSeedAdmin, isTeamApiPrincipal, isLocalAcceptanceServicePrincipal, localAcceptanceAuthEnabled, decorateJob, safePlatformOperationOutput, decoratePlatformOperation, resolvePlatformRunnerSecret, platformOperationMutationError, requirePlatformRunner, resolvePlatformRepositoryDescriptor, launchPlannerRepositoryTopology, launchCapabilityPreset, resourceRowsFromLaunch, ensurePrincipal, resolveUiProjectionContext, resolvePublicTreeDxTeam, enqueueTreeDxProvisionOperation, principalHasGlobalPlatformRole, requireTeamAccess, requireProjectAccess, FEEDBACK_TYPES, FEEDBACK_SCREENSHOT_TYPES, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, cleanFeedbackString, safeFeedbackContext, safeFeedbackClient, safeFeedbackScreenshot, validateFeedbackAccess, recordFeedbackSubmission, normalizeSeedEnvironments, seedActor, seedExistingTeamIds, seedCreatesMissingTeams, requireSeedPlanAccess, requireSeedApplyAccess, requireProjectRunner, commerceErrorResponse, stripeConfiguredError, stripeVendorApprovalError, stripeAccountMissingError, stripeCommerceUrl, requireCommerceVendorForStripe, refreshCommerceStripeAccount, STRIPE_PRODUCT_MIRROR_OFFER_MODES, STRIPE_PRICE_MIRROR_OFFER_MODES, stripeMetadataValue, buildCommerceStripeMetadata, commerceStripeProductParams, commerceStripeLookupKey, commerceStripePriceParams, stripePriceTermsDrift, commerceStripeSyncContext, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, CHECKOUT_OFFER_MODES, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, resolveStripePublishableKey, resolveStripeWebhookSecret, commerceCheckoutError, normalizeCheckoutQuantity, stripeClientSecret, paymentGroupStatusFromPaymentIntent, orderStatusFromPaymentGroup, subscriptionStatusFromStripe, entitlementRenewalStateFromSubscription, stripeTimestampToIso, subscriptionClientSecret, publicPaymentGroups, buildCommerceCheckoutMetadata, resolveCommerceCheckoutItem, checkoutGroupKind, checkoutGroupKey, checkoutGroupStatus, grantCommerceEntitlementsForOrder, requireSellerTeamAccess, requireServiceParticipantAccess, redactCommerceServiceRequestForBuyer, requireCommerceCapacityListingAccess, requireCommerceCapacityInquiryAccess, stripeRefundStatus, applyCommerceRefundState, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, ensureCommerceStripeCustomer, refreshCommercePaymentGroupState, updateCheckoutCompletionFromGroup, syncCommerceSubscriptionFromStripe, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, handleCommerceInvoiceWebhook, processCommerceStripeWebhook, requireCommerceProductAccess, principalCanManageCommerceProduct, redactCommerceOwnershipWorkflow, requireCommerceOfferAccess, requireConnectedProjectRuntime, projectAppHref, unwrapLaunchOperationOutput, appendLaunchPhaseProjection, updateLaunchDeployments, hubRepositoryPolicies, applyHubLaunchResult, applyHubLaunchFailure, unwrapOperationPayload, applyContentPublishResult, projectApiConnection, createProjectInternalClient, executeProjectApi, jsonError, jsonThrownError, availabilityAttempts, providerJwksCache, availabilityRateLimit, personalThemeFromRow, accountDeletionBlockers, base64Url, exchangeProviderIdentity, parseBooleanEnvValue, shouldLogApiRequests, SENSITIVE_QUERY_PARAM_PATTERN, redactedRequestTarget, installApiRequestLogger, readJsonOrFormBody, normalizeUsername, parseJsonObject, trimmedHeaderValue, requestClientIp, ensureMarketCredentialSchema, sanitizedReturnTo, confirmationUrlFor, teamInviteAcceptUrlFor, normalizeBaseUrl, optionalTrimmedString, enumValue, unknownKeys, yamlScalar, yamlLines, isLoopbackUrl, findById, resolveAgentArtifactBucket, centralMarketProfile, normalizeMarketProfile, providerCredentialValuesForAudit, scheduleBackgroundBootstrap, GITHUB_ACTIONS_OIDC_ISSUER, githubOidcJwksCache, base64urlJson, parseBase64urlJson, loadGitHubOidcJwks, verifyGitHubOidcToken, fallbackRemoteCapability, marketProfilesForTeams, artifactDownloadPayload, localAcceptanceAdminToken, safeTokenEquals, mergeCapability, canonicalArchitectureTopology, decodeRouteParam, uiRuntimeLocals, safePrivateKnowledgeSlug, privateKnowledgeAuditPayload, recordPrivateKnowledgeAudit, AGENT_TASK_SIGNATURES, resolveAgentTaskSignature, requireVendorOrderManager, requireServiceBuyerAccess, requireServiceSellerAccess, remainingRefundableAmount, resolveOrderItemForRefund, resolveFulfillmentArtifact, requireCatalogItemAccess, executeInline, selectDispatchTarget, createApiExtension } from './index.ts';
export function providerConfigFor(c, provider) {
    const config = getSiteAuthConfig(marketAuthContext(c));
    const spec = AUTH_PROVIDERS[provider];
    const credentials = config.providers?.[provider];
    return spec && credentials?.clientId && credentials?.clientSecret ? { ...spec, ...credentials } : null;
}
export function normalizeProviderCredentialConfig(hostKind, config, host = null) {
    const source = config && typeof config === 'object' ? config : {};
    if (hostKind === 'repository_host') {
        const token = source.TREESEED_GITHUB_TOKEN ?? source.githubToken ?? source.token;
        if (!token || typeof token !== 'string') {
            throw new Error('Repository Host credentials must include TREESEED_GITHUB_TOKEN.');
        }
        return {
            TREESEED_GITHUB_TOKEN: token,
            GH_TOKEN: token,
            GITHUB_TOKEN: token,
            ...(typeof source.owner === 'string' && source.owner.trim() ? { owner: source.owner.trim() } : {}),
            ...(typeof source.organizationOrOwner === 'string' && source.organizationOrOwner.trim() ? { organizationOrOwner: source.organizationOrOwner.trim() } : {}),
        };
    }
    if (hostKind === 'email_host') {
        const smtp = host?.metadata?.smtp && typeof host.metadata.smtp === 'object' ? host.metadata.smtp : {};
        return {
            ...(typeof smtp.host === 'string' && smtp.host.trim() ? { SMTP_HOST: smtp.host.trim() } : {}),
            ...(typeof smtp.port === 'string' && smtp.port.trim() ? { SMTP_PORT: smtp.port.trim() } : {}),
            ...(typeof source.SMTP_USERNAME === 'string' && source.SMTP_USERNAME.trim() ? { SMTP_USERNAME: source.SMTP_USERNAME } : {}),
            ...(typeof source.SMTP_PASSWORD === 'string' && source.SMTP_PASSWORD ? { SMTP_PASSWORD: source.SMTP_PASSWORD } : {}),
            ...(typeof smtp.fromEmail === 'string' && smtp.fromEmail.trim() ? { SMTP_FROM_EMAIL: smtp.fromEmail.trim() } : {}),
            ...(typeof smtp.replyTo === 'string' && smtp.replyTo.trim() ? { SMTP_REPLY_TO: smtp.replyTo.trim() } : {}),
            ...(typeof smtp.secure === 'string' && smtp.secure.trim() ? { SMTP_SECURE: smtp.secure.trim() } : {}),
        };
    }
    if (hostKind === 'web_host') {
        const token = source.TREESEED_CLOUDFLARE_API_TOKEN ?? source.cloudflareApiToken ?? source.apiToken ?? source.token;
        const accountId = source.TREESEED_CLOUDFLARE_ACCOUNT_ID ?? source.cloudflareAccountId ?? source.accountId;
        if (!token || typeof token !== 'string') {
            throw new Error('Web Host credentials must include TREESEED_CLOUDFLARE_API_TOKEN.');
        }
        if (!accountId || typeof accountId !== 'string') {
            throw new Error('Web Host credentials must include TREESEED_CLOUDFLARE_ACCOUNT_ID.');
        }
        return {
            TREESEED_CLOUDFLARE_API_TOKEN: token,
            TREESEED_CLOUDFLARE_ACCOUNT_ID: accountId,
            CLOUDFLARE_API_TOKEN: token,
            CLOUDFLARE_ACCOUNT_ID: accountId,
        };
    }
    return source;
}
export function mergeStringConfig(target, config) {
    for (const [key, value] of Object.entries(config ?? {})) {
        if (typeof value === 'string' && value.trim())
            target[key] = value;
    }
    return target;
}
export function requireConfiguredServiceCredential(c, config) {
    const serviceId = c.req.header('x-treeseed-service-id') ?? '';
    const serviceSecret = c.req.header('x-treeseed-service-secret') ?? '';
    if (!config.webServiceId || !config.webServiceSecret || serviceId !== config.webServiceId || serviceSecret !== config.webServiceSecret) {
        return {
            response: jsonError(c, 401, 'Trusted Treeseed service credential required.'),
        };
    }
    return { ok: true };
}
export function defaultConfig(overrides: any = {}) {
    const resolved = resolveApiConfig();
    const config = {
        ...resolved,
        projectId: overrides.projectId ?? resolved.projectId ?? 'treeseed-market',
        repoRoot: overrides.repoRoot ?? resolved.repoRoot ?? process.cwd(),
        d1DatabaseId: undefined,
        d1DatabaseName: undefined,
        d1LocalPersistTo: undefined,
        d1WranglerConfigPath: undefined,
        ...overrides,
    };
    if (overrides.authApprovalBaseUrl == null && typeof overrides.siteUrl === 'string' && overrides.siteUrl.trim()) {
        config.authApprovalBaseUrl = overrides.siteUrl.trim();
    }
    return config;
}

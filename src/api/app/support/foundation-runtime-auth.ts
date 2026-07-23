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
import { POSTGRES_AUTH_PROVIDER_ID, AUTH_PROVIDERS, consumeReauthentication, loadNotificationPreferences, verifyProviderIdToken, resolveLaunchTemplateRequirements, projectHostBindingMetadata, sourceFromProjectDetails, repositoryInventoryWithPlatform, loadProjectHostBindingContext, projectHostResponsePayload, hostBindingRequiresUnlock, hostKindForBinding, createProjectHostCredentialSessions, persistProjectHostBindingOperationMetadata, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, plaintextHostCredentialFieldPaths, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, markdownToPlainProjectSummary, shouldExposeNonProductionAuthDiagnostics, AGENT_PROMOTION_APPROVAL_DECISIONS, normalizeEmail, requestSessionMetadata, webSessionData, validateMarketPassword, hashMarketPassword, verifyMarketPassword, MARKET_EMAIL_CONFIRMATION_PREFIX, marketAuthContext, shouldBypassAcceptanceAuthEmailDelivery, marketEmailTokenHash, exposeAuthTokenForTests, authTokenTimestampSeconds, authTokenTimestampMillis, passwordResetUrlFor, sendTeamInviteEmail, createMarketEmailConfirmation, serializeUserEmailAddress, backfillUserEmailAddresses, listUserEmailAddresses, getUserEmailAddress, verifiedEmailCount, setPrimaryEmailAddress, syncPrimaryEmailCaches, createOrResendUserEmailAddress, createMarketWebSession, webAuthPayload, normalizeAppearancePreference, normalizeDomainName, normalizeProjectDomainInput, inferZoneNameForDomain, domainInZone, LOCAL_CONTENT_COLLECTIONS, LOCAL_WORK_CONTENT_COLLECTIONS, LOCAL_DECISION_TYPE_VALUES, PROPOSAL_VERDICT_DECISION_TYPES, PLATFORM_OPERATION_SCOPES, LOCAL_CONTENT_DEFAULTS, slugifyContent, serializeFrontmatter, normalizeRelationArray, uniqueRelationArray, addRelationValue, normalizeLocalContentInput, writeLocalContentRecord, localContentRoot, localContentPath, readLocalContentRecord, writeParsedLocalContentRecord, createRelatedLocalContentRecord, createDecisionFromProposals, resolveAuthApprovalBaseUrl, encryptedHostPayloadLooksValid, decryptedHostConfigSummary, credentialSessionSecret, credentialSessionKey, encryptCredentialSessionPayload, decryptCredentialSessionPayload, HOST_KIND_SESSION_KEYS, normalizeAuditHostKinds, collectHostingAuditCredentialOverlay, nonSecretLaunchJobInput, decryptTeamHostForLaunch, buildLaunchCredentialOverlay, patchLaunchIntentForCredentialOverlay, appendLaunchDeploymentEvent, sanitizeLaunchResultForStorage, cloudflareErrorMessage, cloudflareRequestForLaunchPreflight, resolveCloudflareZoneForLaunchPreflight, verifyCloudflareDnsWriteForLaunch, projectDeletionConfirmationMatches, projectDeletionBlockerRows, cloudflareRequestForProjectDeletion, githubRequestForProjectDeletion, projectDeletionOperation, cloudflareDeletionAuthenticationMessage, hasRecordedCloudflareRuntimeResources, canSkipCloudflareCleanupAfterFailedLaunch, projectDeletionHostname, normalizedCloudflareKvNamespaceReference, uniqueCloudflareKvNamespaceReferences, cloudflareProjectDeletionResourceNames, resolveProjectDeletionCloudflareZone, deleteCloudflareDnsRecordsForProject, listCloudflareNamedResources, deleteCloudflareProjectResources, appendProjectDeletionProgress, cloudflareDnsDomainsForHostValidation, validateTeamHostCredentialPayload, runProjectLaunchApiBootstrap, runProjectDeletionApiDestroy, retryApiLaunchBootstrapFromRequest, operationTokenSecret, signOperationToken, verifyOperationToken, normalizeCiEnvironment, ciOperationForAction, normalizeRepositorySlug, projectAllowedCiRepositories, validateCiRefForEnvironment, principalHasPermission, principalIsSeedAdmin, isTeamApiPrincipal, isLocalAcceptanceServicePrincipal, localAcceptanceAuthEnabled, decorateJob, safePlatformOperationOutput, decoratePlatformOperation, resolvePlatformRunnerSecret, platformOperationMutationError, requirePlatformRunner, resolvePlatformRepositoryDescriptor, launchPlannerRepositoryTopology, launchCapabilityPreset, resourceRowsFromLaunch, ensurePrincipal, resolveUiProjectionContext, resolvePublicTreeDxTeam, enqueueTreeDxProvisionOperation, principalHasGlobalPlatformRole, requireTeamAccess, requireProjectAccess, FEEDBACK_TYPES, FEEDBACK_SCREENSHOT_TYPES, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, cleanFeedbackString, safeFeedbackContext, safeFeedbackClient, safeFeedbackScreenshot, validateFeedbackAccess, recordFeedbackSubmission, normalizeSeedEnvironments, seedActor, seedExistingTeamIds, seedCreatesMissingTeams, requireSeedPlanAccess, requireSeedApplyAccess, requireProjectRunner, commerceErrorResponse, stripeConfiguredError, stripeVendorApprovalError, stripeAccountMissingError, stripeCommerceUrl, requireCommerceVendorForStripe, refreshCommerceStripeAccount, STRIPE_PRODUCT_MIRROR_OFFER_MODES, STRIPE_PRICE_MIRROR_OFFER_MODES, stripeMetadataValue, buildCommerceStripeMetadata, commerceStripeProductParams, commerceStripeLookupKey, commerceStripePriceParams, stripePriceTermsDrift, commerceStripeSyncContext, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, CHECKOUT_OFFER_MODES, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, resolveStripePublishableKey, resolveStripeWebhookSecret, commerceCheckoutError, normalizeCheckoutQuantity, stripeClientSecret, paymentGroupStatusFromPaymentIntent, orderStatusFromPaymentGroup, subscriptionStatusFromStripe, entitlementRenewalStateFromSubscription, stripeTimestampToIso, subscriptionClientSecret, publicPaymentGroups, buildCommerceCheckoutMetadata, resolveCommerceCheckoutItem, checkoutGroupKind, checkoutGroupKey, checkoutGroupStatus, grantCommerceEntitlementsForOrder, requireSellerTeamAccess, requireServiceParticipantAccess, redactCommerceServiceRequestForBuyer, requireCommerceCapacityListingAccess, requireCommerceCapacityInquiryAccess, stripeRefundStatus, applyCommerceRefundState, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, ensureCommerceStripeCustomer, refreshCommercePaymentGroupState, updateCheckoutCompletionFromGroup, syncCommerceSubscriptionFromStripe, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, handleCommerceInvoiceWebhook, processCommerceStripeWebhook, requireCommerceProductAccess, principalCanManageCommerceProduct, redactCommerceOwnershipWorkflow, requireCommerceOfferAccess, requireConnectedProjectRuntime, projectAppHref, unwrapLaunchOperationOutput, appendLaunchPhaseProjection, updateLaunchDeployments, hubRepositoryPolicies, applyHubLaunchResult, applyHubLaunchFailure, unwrapOperationPayload, applyContentPublishResult, projectApiConnection, createProjectInternalClient, executeProjectApi, jsonError, jsonThrownError, providerConfigFor, parseBooleanEnvValue, redactedRequestTarget, normalizeUsername, parseJsonObject, normalizeBaseUrl, normalizeMarketProfile, normalizeProviderCredentialConfig, mergeStringConfig, parseBase64urlJson, safeTokenEquals, requireConfiguredServiceCredential, safePrivateKnowledgeSlug, requireServiceBuyerAccess, requireServiceSellerAccess, requireCatalogItemAccess, defaultConfig, personalThemeFromRow, accountDeletionBlockers, base64Url, shouldLogApiRequests, SENSITIVE_QUERY_PARAM_PATTERN, installApiRequestLogger, readJsonOrFormBody, trimmedHeaderValue, requestClientIp, ensureMarketCredentialSchema, sanitizedReturnTo, confirmationUrlFor, teamInviteAcceptUrlFor, optionalTrimmedString, enumValue, unknownKeys, yamlScalar, yamlLines, isLoopbackUrl, findById, resolveAgentArtifactBucket, centralMarketProfile, scheduleBackgroundBootstrap, GITHUB_ACTIONS_OIDC_ISSUER, githubOidcJwksCache, base64urlJson, loadGitHubOidcJwks, verifyGitHubOidcToken, fallbackRemoteCapability, marketProfilesForTeams, artifactDownloadPayload, localAcceptanceAdminToken, mergeCapability, canonicalArchitectureTopology, decodeRouteParam, uiRuntimeLocals, privateKnowledgeAuditPayload, recordPrivateKnowledgeAudit, AGENT_TASK_SIGNATURES, resolveAgentTaskSignature, requireVendorOrderManager, remainingRefundableAmount, resolveOrderItemForRefund, resolveFulfillmentArtifact, executeInline, selectDispatchTarget, createApiExtension } from './index.ts';
export const availabilityAttempts = new Map();
export const providerJwksCache = new Map();
export function availabilityRateLimit(c, kind, value) {
    const key = `${kind}:${c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'local'}:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
    const now = Date.now();
    const current = availabilityAttempts.get(key);
    const source = { ...process.env, ...(c.env ?? {}) };
    const windowMs = Math.max(1000, Number(source.TREESEED_AUTH_AVAILABILITY_WINDOW_MS ?? 60000) || 60000);
    const limit = Math.max(1, Number(source.TREESEED_AUTH_AVAILABILITY_LIMIT ?? 10) || 10);
    const next = !current || current.resetAt <= now ? { count: 1, resetAt: now + windowMs } : { ...current, count: current.count + 1 };
    availabilityAttempts.set(key, next);
    return next.count > limit ? Math.max(1, Math.ceil((next.resetAt - now) / 1000)) : 0;
}
export async function exchangeProviderIdentity(provider, configured, code, redirectUri, verifier, expectedNonce) {
    const body = new URLSearchParams({ code, client_id: configured.clientId, client_secret: configured.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' });
    if (verifier)
        body.set('code_verifier', verifier);
    const tokenResponse = await fetch(configured.tokenUrl, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body });
    const tokens = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || !tokens.access_token)
        throw new Error('The identity provider did not accept the authorization response.');
    const claims = provider === 'github' ? {} : await verifyProviderIdToken(tokens.id_token, configured, expectedNonce);
    if (provider === 'github') {
        const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${tokens.access_token}`, 'user-agent': 'TreeSeed' };
        const [userResponse, emailsResponse] = await Promise.all([fetch('https://api.github.com/user', { headers }), fetch('https://api.github.com/user/emails', { headers })]);
        const user = await userResponse.json();
        const emails = await emailsResponse.json().catch(() => []);
        const email = emails.find?.((entry) => entry.primary && entry.verified)?.email ?? user.email;
        return { subject: String(user.id), email, emailVerified: Boolean(email), displayName: user.name ?? user.login, profile: { image: user.avatar_url } };
    }
    if (provider === 'microsoft') {
        const response = await fetch('https://graph.microsoft.com/v1.0/me', { headers: { authorization: `Bearer ${tokens.access_token}` } });
        const user = await response.json();
        return { subject: String(user.id), email: user.mail ?? user.userPrincipalName, emailVerified: true, displayName: user.displayName };
    }
    return { subject: String(claims.sub ?? ''), email: claims.email, emailVerified: claims.email_verified === true || claims.email_verified === 'true', displayName: claims.name ?? claims.email };
}
export function providerCredentialValuesForAudit(hostKind, payload) {
    const config = payload?.config && typeof payload.config === 'object' ? payload.config : {};
    if (hostKind === 'repository_host') {
        const token = config.TREESEED_GITHUB_TOKEN ?? config.token ?? null;
        const owner = config.organizationOrOwner ?? config.owner ?? null;
        return {
            ...(typeof token === 'string' ? { TREESEED_GITHUB_TOKEN: token } : {}),
            ...(typeof owner === 'string' ? {
                TREESEED_HOSTED_HUBS_GITHUB_OWNER: owner,
            } : {}),
        };
    }
    if (hostKind === 'web_host') {
        return {
            ...(typeof config.TREESEED_CLOUDFLARE_API_TOKEN === 'string' ? { TREESEED_CLOUDFLARE_API_TOKEN: config.TREESEED_CLOUDFLARE_API_TOKEN } : {}),
            ...(typeof config.TREESEED_CLOUDFLARE_ACCOUNT_ID === 'string' ? { TREESEED_CLOUDFLARE_ACCOUNT_ID: config.TREESEED_CLOUDFLARE_ACCOUNT_ID } : {}),
        };
    }
    if (hostKind === 'capacity_provider_host') {
        return {
            ...(typeof config.TREESEED_RAILWAY_API_TOKEN === 'string' ? { TREESEED_RAILWAY_API_TOKEN: config.TREESEED_RAILWAY_API_TOKEN } : {}),
            ...(typeof config.TREESEED_RAILWAY_WORKSPACE === 'string' ? { TREESEED_RAILWAY_WORKSPACE: config.TREESEED_RAILWAY_WORKSPACE } : {}),
        };
    }
    if (hostKind === 'email_host') {
        return {
            ...(typeof config.SMTP_HOST === 'string' ? { TREESEED_SMTP_HOST: config.SMTP_HOST } : {}),
            ...(typeof config.SMTP_PORT === 'string' ? { TREESEED_SMTP_PORT: config.SMTP_PORT } : {}),
            ...(typeof config.SMTP_USERNAME === 'string' ? { TREESEED_SMTP_USERNAME: config.SMTP_USERNAME } : {}),
            ...(typeof config.SMTP_PASSWORD === 'string' ? { TREESEED_SMTP_PASSWORD: config.SMTP_PASSWORD } : {}),
            ...(typeof config.SMTP_FROM_EMAIL === 'string' ? { TREESEED_SMTP_FROM: config.SMTP_FROM_EMAIL } : {}),
            ...(typeof config.SMTP_REPLY_TO === 'string' ? { TREESEED_SMTP_REPLY_TO: config.SMTP_REPLY_TO } : {}),
            ...(typeof config.SMTP_SECURE === 'string' ? { TREESEED_SMTP_SECURE: config.SMTP_SECURE } : {}),
        };
    }
    return {};
}

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
import { jsonError, jsonThrownError, POSTGRES_AUTH_PROVIDER_ID, availabilityAttempts, AUTH_PROVIDERS, providerJwksCache, availabilityRateLimit, personalThemeFromRow, accountDeletionBlockers, consumeReauthentication, loadNotificationPreferences, providerConfigFor, base64Url, verifyProviderIdToken, exchangeProviderIdentity, sourceFromProjectDetails, repositoryInventoryWithPlatform, createProjectHostCredentialSessions, rejectProjectSecretUnlockMaterial, markdownToPlainProjectSummary, parseBooleanEnvValue, shouldLogApiRequests, shouldExposeNonProductionAuthDiagnostics, SENSITIVE_QUERY_PARAM_PATTERN, redactedRequestTarget, installApiRequestLogger, AGENT_PROMOTION_APPROVAL_DECISIONS, readJsonOrFormBody, normalizeEmail, normalizeUsername, parseJsonObject, trimmedHeaderValue, requestClientIp, requestSessionMetadata, webSessionData, validateMarketPassword, hashMarketPassword, verifyMarketPassword, ensureMarketCredentialSchema, MARKET_EMAIL_CONFIRMATION_PREFIX, marketAuthContext, shouldBypassAcceptanceAuthEmailDelivery, marketEmailTokenHash, exposeAuthTokenForTests, authTokenTimestampSeconds, authTokenTimestampMillis, sanitizedReturnTo, confirmationUrlFor, teamInviteAcceptUrlFor, passwordResetUrlFor, sendTeamInviteEmail, createMarketEmailConfirmation, serializeUserEmailAddress, backfillUserEmailAddresses, listUserEmailAddresses, getUserEmailAddress, verifiedEmailCount, setPrimaryEmailAddress, syncPrimaryEmailCaches, createOrResendUserEmailAddress, createMarketWebSession, webAuthPayload, normalizeAppearancePreference, normalizeBaseUrl, optionalTrimmedString, enumValue, unknownKeys, LOCAL_CONTENT_COLLECTIONS, LOCAL_WORK_CONTENT_COLLECTIONS, LOCAL_DECISION_TYPE_VALUES, PROPOSAL_VERDICT_DECISION_TYPES, PLATFORM_OPERATION_SCOPES, LOCAL_CONTENT_DEFAULTS, slugifyContent, yamlScalar, yamlLines, serializeFrontmatter, normalizeRelationArray, uniqueRelationArray, addRelationValue, normalizeLocalContentInput, writeLocalContentRecord, localContentRoot, localContentPath, readLocalContentRecord, writeParsedLocalContentRecord, createRelatedLocalContentRecord, createDecisionFromProposals, isLoopbackUrl, resolveAuthApprovalBaseUrl, findById, resolveAgentArtifactBucket, centralMarketProfile, normalizeMarketProfile, credentialSessionSecret, credentialSessionKey, encryptCredentialSessionPayload, decryptCredentialSessionPayload, normalizeProviderCredentialConfig, HOST_KIND_SESSION_KEYS, providerCredentialValuesForAudit, mergeStringConfig, scheduleBackgroundBootstrap, projectDeletionConfirmationMatches, projectDeletionBlockerRows, githubRequestForProjectDeletion, projectDeletionOperation, cloudflareDeletionAuthenticationMessage, appendProjectDeletionProgress, runProjectDeletionApiDestroy, GITHUB_ACTIONS_OIDC_ISSUER, githubOidcJwksCache, base64urlJson, parseBase64urlJson, operationTokenSecret, signOperationToken, verifyOperationToken, loadGitHubOidcJwks, verifyGitHubOidcToken, normalizeCiEnvironment, ciOperationForAction, fallbackRemoteCapability, normalizeRepositorySlug, projectAllowedCiRepositories, validateCiRefForEnvironment, marketProfilesForTeams, artifactDownloadPayload, principalHasPermission, principalIsSeedAdmin, isTeamApiPrincipal, isLocalAcceptanceServicePrincipal, localAcceptanceAdminToken, localAcceptanceAuthEnabled, decorateJob, safePlatformOperationOutput, decoratePlatformOperation, safeTokenEquals, resolvePlatformRunnerSecret, platformOperationMutationError, requirePlatformRunner, resolvePlatformRepositoryDescriptor, mergeCapability, canonicalArchitectureTopology, ensurePrincipal, resolveUiProjectionContext, decodeRouteParam, uiRuntimeLocals, requireConfiguredServiceCredential, resolvePublicTreeDxTeam, enqueueTreeDxProvisionOperation, principalHasGlobalPlatformRole, requireTeamAccess, requireProjectAccess, safePrivateKnowledgeSlug, privateKnowledgeAuditPayload, recordPrivateKnowledgeAudit, FEEDBACK_TYPES, FEEDBACK_SCREENSHOT_TYPES, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, cleanFeedbackString, safeFeedbackContext, safeFeedbackClient, safeFeedbackScreenshot, validateFeedbackAccess, recordFeedbackSubmission, normalizeSeedEnvironments, seedActor, seedExistingTeamIds, seedCreatesMissingTeams, requireSeedPlanAccess, requireSeedApplyAccess, requireProjectRunner, AGENT_TASK_SIGNATURES, resolveAgentTaskSignature, commerceErrorResponse, stripeConfiguredError, stripeVendorApprovalError, stripeAccountMissingError, stripeCommerceUrl, requireCommerceVendorForStripe, refreshCommerceStripeAccount, STRIPE_PRODUCT_MIRROR_OFFER_MODES, STRIPE_PRICE_MIRROR_OFFER_MODES, stripeMetadataValue, buildCommerceStripeMetadata, commerceStripeProductParams, commerceStripeLookupKey, commerceStripePriceParams, stripePriceTermsDrift, commerceStripeSyncContext, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, CHECKOUT_OFFER_MODES, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, resolveStripePublishableKey, resolveStripeWebhookSecret, commerceCheckoutError, normalizeCheckoutQuantity, stripeClientSecret, paymentGroupStatusFromPaymentIntent, orderStatusFromPaymentGroup, subscriptionStatusFromStripe, entitlementRenewalStateFromSubscription, stripeTimestampToIso, subscriptionClientSecret, publicPaymentGroups, buildCommerceCheckoutMetadata, resolveCommerceCheckoutItem, checkoutGroupKind, checkoutGroupKey, checkoutGroupStatus, grantCommerceEntitlementsForOrder, requireSellerTeamAccess, requireVendorOrderManager, requireServiceBuyerAccess, requireServiceSellerAccess, requireServiceParticipantAccess, redactCommerceServiceRequestForBuyer, requireCommerceCapacityListingAccess, requireCommerceCapacityInquiryAccess, remainingRefundableAmount, stripeRefundStatus, applyCommerceRefundState, resolveOrderItemForRefund, resolveFulfillmentArtifact, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, ensureCommerceStripeCustomer, refreshCommercePaymentGroupState, updateCheckoutCompletionFromGroup, syncCommerceSubscriptionFromStripe, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, handleCommerceInvoiceWebhook, processCommerceStripeWebhook, requireCommerceProductAccess, principalCanManageCommerceProduct, redactCommerceOwnershipWorkflow, requireCommerceOfferAccess, requireCatalogItemAccess, requireConnectedProjectRuntime, projectAppHref, hubRepositoryPolicies, unwrapOperationPayload, applyContentPublishResult, executeInline, projectApiConnection, createProjectInternalClient, executeProjectApi, selectDispatchTarget, defaultConfig, createApiExtension, resolveLaunchTemplateRequirements, projectHostBindingMetadata, loadProjectHostBindingContext, projectHostResponsePayload, hostBindingRequiresUnlock, hostKindForBinding, persistProjectHostBindingOperationMetadata, normalizeDomainName, normalizeProjectDomainInput, inferZoneNameForDomain, domainInZone, decryptedHostConfigSummary, normalizeAuditHostKinds, nonSecretLaunchJobInput, decryptTeamHostForLaunch, buildLaunchCredentialOverlay, patchLaunchIntentForCredentialOverlay, appendLaunchDeploymentEvent, sanitizeLaunchResultForStorage, cloudflareErrorMessage, cloudflareRequestForLaunchPreflight, resolveCloudflareZoneForLaunchPreflight, verifyCloudflareDnsWriteForLaunch, cloudflareRequestForProjectDeletion, hasRecordedCloudflareRuntimeResources, canSkipCloudflareCleanupAfterFailedLaunch, projectDeletionHostname, normalizedCloudflareKvNamespaceReference, uniqueCloudflareKvNamespaceReferences, cloudflareProjectDeletionResourceNames, resolveProjectDeletionCloudflareZone, deleteCloudflareDnsRecordsForProject, listCloudflareNamedResources, deleteCloudflareProjectResources, cloudflareDnsDomainsForHostValidation, runProjectLaunchApiBootstrap, retryApiLaunchBootstrapFromRequest, launchPlannerRepositoryTopology, launchCapabilityPreset, resourceRowsFromLaunch, unwrapLaunchOperationOutput, appendLaunchPhaseProjection, updateLaunchDeployments, applyHubLaunchResult, applyHubLaunchFailure } from './index.ts';
export const PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES = new Set([
    'githubToken',
    'TREESEED_GITHUB_TOKEN',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'cloudflareAccountId',
    'cloudflareApiToken',
    'TREESEED_CLOUDFLARE_ACCOUNT_ID',
    'TREESEED_CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_API_TOKEN',
    'railwayApiToken',
    'TREESEED_RAILWAY_API_TOKEN',
    'railwayWorkspace',
    'RAILWAY_API_TOKEN',
    'TREESEED_RAILWAY_WORKSPACE',
    'smtpUsername',
    'smtpPassword',
    'SMTP_USERNAME',
    'SMTP_PASSWORD',
    'aiApiKey',
    'aiBaseUrl',
    'aiDefaultModel',
    'AI_API_KEY',
    'AI_BASE_URL',
    'AI_DEFAULT_MODEL',
]);
export function plaintextHostCredentialFieldPaths(value, path = '') {
    if (!value || typeof value !== 'object')
        return [];
    if (Array.isArray(value)) {
        return value.flatMap((entry, index) => plaintextHostCredentialFieldPaths(entry, `${path}[${index}]`));
    }
    const paths = [];
    for (const [key, entry] of Object.entries(value)) {
        if (key === 'encryptedPayload')
            continue;
        const nextPath = path ? `${path}.${key}` : key;
        if (PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES.has(key)) {
            paths.push(nextPath);
            continue;
        }
        paths.push(...plaintextHostCredentialFieldPaths(entry, nextPath));
    }
    return paths;
}
export function rejectPlaintextHostCredentialFields(c, body) {
    const fields = plaintextHostCredentialFieldPaths(body);
    if (fields.length === 0)
        return null;
    return jsonError(c, 400, 'Host credential values must be encrypted in encryptedPayload before submission.', {
        fields,
    });
}
export function encryptedHostPayloadLooksValid(value) {
    return Boolean(value
        && typeof value === 'object'
        && typeof value.version === 'number'
        && typeof value.algorithm === 'string'
        && typeof value.kdf === 'object'
        && typeof value.salt === 'string'
        && typeof value.nonce === 'string'
        && typeof value.ciphertext === 'string');
}
export async function collectHostingAuditCredentialOverlay({ store, runtime, teamId, hostKinds, credentialSessions = {}, requiredPurpose = null }) {
    const overlay = {};
    const sessions = {};
    for (const hostKind of hostKinds) {
        const definition = HOST_KIND_SESSION_KEYS[hostKind];
        const sessionId = typeof credentialSessions?.[definition.sessionKey] === 'string'
            ? credentialSessions[definition.sessionKey].trim()
            : '';
        if (!sessionId)
            continue;
        const session = await store.getProviderCredentialSession(teamId, sessionId, { includeEncryptedPayload: true });
        if (!session) {
            throw new Error(`Credential session "${definition.sessionKey}" is not available for this team.`);
        }
        if (session.hostKind !== definition.hostKind) {
            throw new Error(`Credential session "${definition.sessionKey}" is not scoped to ${hostKind} hosting.`);
        }
        if (session.status !== 'active' || new Date(session.expiresAt).getTime() <= Date.now()) {
            throw new Error(`Credential session "${definition.sessionKey}" has expired. Unlock the host again.`);
        }
        if (requiredPurpose && session.purpose !== requiredPurpose) {
            throw new Error(`Credential session "${definition.sessionKey}" is not valid for ${requiredPurpose}.`);
        }
        const decrypted = decryptCredentialSessionPayload(runtime, session.encryptedPayload);
        Object.assign(overlay, providerCredentialValuesForAudit(session.hostKind, decrypted));
        sessions[definition.sessionKey] = {
            id: session.id,
            hostKind: session.hostKind,
            hostId: session.hostId,
            purpose: session.purpose,
            expiresAt: session.expiresAt,
        };
    }
    return { overlay, sessions };
}
export async function validateTeamHostCredentialPayload(host, decryptedConfig) {
    const summary = decryptedHostConfigSummary(decryptedConfig);
    const validation = {
        status: 'unchecked',
        checkedAt: new Date().toISOString(),
        receivedKeys: summary.keys,
        mode: host?.ownership ?? null,
        message: 'Provider credentials were received but no live provider check was available for this host type.',
        issues: [],
    };
    const hostType = host?.metadata?.hostType;
    const isCloudflareWebHost = host?.provider === 'cloudflare' || hostType === 'web';
    if (!isCloudflareWebHost) {
        return validation;
    }
    try {
        const config = normalizeProviderCredentialConfig('web_host', decryptedConfig, host);
        const domains = cloudflareDnsDomainsForHostValidation(host);
        if (domains.manageDns) {
            const dnsPreflight = await verifyCloudflareDnsWriteForLaunch({
                overlay: config,
                domains,
            });
            return {
                ...validation,
                status: 'passed',
                message: `Cloudflare DNS write access verified for ${dnsPreflight?.zoneName ?? domains.zoneName ?? 'the selected zone'}.`,
                checkedCapabilities: ['cloudflare.token', 'cloudflare.dns.write'],
                zoneName: dnsPreflight?.zoneName ?? domains.zoneName ?? null,
            };
        }
        return {
            ...validation,
            status: 'unchecked',
            message: 'Cloudflare credentials include the required fields. DNS write access was not checked because this host does not define a root zone.',
            checkedCapabilities: ['cloudflare.required_fields'],
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            ...validation,
            status: 'failed',
            message,
            issues: [message],
            checkedCapabilities: ['cloudflare.token', 'cloudflare.dns.write'],
        };
    }
}

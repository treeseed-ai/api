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
import { jsonError, jsonThrownError, availabilityAttempts, providerJwksCache, availabilityRateLimit, personalThemeFromRow, accountDeletionBlockers, providerConfigFor, base64Url, exchangeProviderIdentity, resolveLaunchTemplateRequirements, projectHostBindingMetadata, sourceFromProjectDetails, repositoryInventoryWithPlatform, loadProjectHostBindingContext, projectHostResponsePayload, hostBindingRequiresUnlock, hostKindForBinding, persistProjectHostBindingOperationMetadata, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, plaintextHostCredentialFieldPaths, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, markdownToPlainProjectSummary, parseBooleanEnvValue, shouldLogApiRequests, SENSITIVE_QUERY_PARAM_PATTERN, redactedRequestTarget, installApiRequestLogger, AGENT_PROMOTION_APPROVAL_DECISIONS, readJsonOrFormBody, normalizeUsername, parseJsonObject, trimmedHeaderValue, requestClientIp, ensureMarketCredentialSchema, sanitizedReturnTo, confirmationUrlFor, teamInviteAcceptUrlFor, normalizeBaseUrl, normalizeDomainName, normalizeProjectDomainInput, inferZoneNameForDomain, domainInZone, optionalTrimmedString, enumValue, unknownKeys, LOCAL_CONTENT_COLLECTIONS, LOCAL_WORK_CONTENT_COLLECTIONS, LOCAL_DECISION_TYPE_VALUES, PROPOSAL_VERDICT_DECISION_TYPES, PLATFORM_OPERATION_SCOPES, LOCAL_CONTENT_DEFAULTS, slugifyContent, yamlScalar, yamlLines, serializeFrontmatter, normalizeRelationArray, uniqueRelationArray, addRelationValue, normalizeLocalContentInput, writeLocalContentRecord, localContentRoot, localContentPath, readLocalContentRecord, writeParsedLocalContentRecord, createRelatedLocalContentRecord, createDecisionFromProposals, isLoopbackUrl, findById, resolveAgentArtifactBucket, centralMarketProfile, normalizeMarketProfile, encryptedHostPayloadLooksValid, decryptedHostConfigSummary, normalizeProviderCredentialConfig, normalizeAuditHostKinds, providerCredentialValuesForAudit, collectHostingAuditCredentialOverlay, nonSecretLaunchJobInput, decryptTeamHostForLaunch, mergeStringConfig, buildLaunchCredentialOverlay, patchLaunchIntentForCredentialOverlay, appendLaunchDeploymentEvent, scheduleBackgroundBootstrap, sanitizeLaunchResultForStorage, cloudflareErrorMessage, cloudflareRequestForLaunchPreflight, resolveCloudflareZoneForLaunchPreflight, verifyCloudflareDnsWriteForLaunch, projectDeletionConfirmationMatches, projectDeletionBlockerRows, cloudflareRequestForProjectDeletion, githubRequestForProjectDeletion, projectDeletionOperation, hasRecordedCloudflareRuntimeResources, canSkipCloudflareCleanupAfterFailedLaunch, projectDeletionHostname, normalizedCloudflareKvNamespaceReference, uniqueCloudflareKvNamespaceReferences, cloudflareProjectDeletionResourceNames, resolveProjectDeletionCloudflareZone, deleteCloudflareDnsRecordsForProject, listCloudflareNamedResources, deleteCloudflareProjectResources, appendProjectDeletionProgress, cloudflareDnsDomainsForHostValidation, validateTeamHostCredentialPayload, runProjectLaunchApiBootstrap, runProjectDeletionApiDestroy, retryApiLaunchBootstrapFromRequest, GITHUB_ACTIONS_OIDC_ISSUER, githubOidcJwksCache, base64urlJson, parseBase64urlJson, operationTokenSecret, signOperationToken, verifyOperationToken, loadGitHubOidcJwks, verifyGitHubOidcToken, normalizeCiEnvironment, ciOperationForAction, fallbackRemoteCapability, normalizeRepositorySlug, projectAllowedCiRepositories, validateCiRefForEnvironment, marketProfilesForTeams, artifactDownloadPayload, principalHasPermission, principalIsSeedAdmin, isTeamApiPrincipal, isLocalAcceptanceServicePrincipal, localAcceptanceAdminToken, decorateJob, safePlatformOperationOutput, decoratePlatformOperation, safeTokenEquals, resolvePlatformRunnerSecret, platformOperationMutationError, requirePlatformRunner, resolvePlatformRepositoryDescriptor, mergeCapability, canonicalArchitectureTopology, launchPlannerRepositoryTopology, launchCapabilityPreset, resourceRowsFromLaunch, ensurePrincipal, resolveUiProjectionContext, decodeRouteParam, uiRuntimeLocals, requireConfiguredServiceCredential, resolvePublicTreeDxTeam, enqueueTreeDxProvisionOperation, principalHasGlobalPlatformRole, requireTeamAccess, requireProjectAccess, safePrivateKnowledgeSlug, privateKnowledgeAuditPayload, recordPrivateKnowledgeAudit, FEEDBACK_TYPES, FEEDBACK_SCREENSHOT_TYPES, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, cleanFeedbackString, safeFeedbackContext, safeFeedbackClient, safeFeedbackScreenshot, validateFeedbackAccess, recordFeedbackSubmission, normalizeSeedEnvironments, seedActor, seedExistingTeamIds, seedCreatesMissingTeams, requireSeedPlanAccess, requireSeedApplyAccess, requireProjectRunner, AGENT_TASK_SIGNATURES, resolveAgentTaskSignature, commerceErrorResponse, stripeConfiguredError, stripeVendorApprovalError, stripeAccountMissingError, stripeCommerceUrl, requireCommerceVendorForStripe, refreshCommerceStripeAccount, STRIPE_PRODUCT_MIRROR_OFFER_MODES, STRIPE_PRICE_MIRROR_OFFER_MODES, stripeMetadataValue, buildCommerceStripeMetadata, commerceStripeProductParams, commerceStripeLookupKey, commerceStripePriceParams, stripePriceTermsDrift, commerceStripeSyncContext, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, CHECKOUT_OFFER_MODES, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, resolveStripePublishableKey, resolveStripeWebhookSecret, commerceCheckoutError, normalizeCheckoutQuantity, stripeClientSecret, paymentGroupStatusFromPaymentIntent, orderStatusFromPaymentGroup, subscriptionStatusFromStripe, entitlementRenewalStateFromSubscription, stripeTimestampToIso, subscriptionClientSecret, publicPaymentGroups, buildCommerceCheckoutMetadata, resolveCommerceCheckoutItem, checkoutGroupKind, checkoutGroupKey, checkoutGroupStatus, grantCommerceEntitlementsForOrder, requireSellerTeamAccess, requireVendorOrderManager, requireServiceBuyerAccess, requireServiceSellerAccess, requireServiceParticipantAccess, redactCommerceServiceRequestForBuyer, requireCommerceCapacityListingAccess, requireCommerceCapacityInquiryAccess, remainingRefundableAmount, stripeRefundStatus, applyCommerceRefundState, resolveOrderItemForRefund, resolveFulfillmentArtifact, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, ensureCommerceStripeCustomer, refreshCommercePaymentGroupState, updateCheckoutCompletionFromGroup, syncCommerceSubscriptionFromStripe, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, handleCommerceInvoiceWebhook, processCommerceStripeWebhook, requireCommerceProductAccess, principalCanManageCommerceProduct, redactCommerceOwnershipWorkflow, requireCommerceOfferAccess, requireCatalogItemAccess, requireConnectedProjectRuntime, projectAppHref, unwrapLaunchOperationOutput, appendLaunchPhaseProjection, updateLaunchDeployments, hubRepositoryPolicies, applyHubLaunchResult, applyHubLaunchFailure, unwrapOperationPayload, applyContentPublishResult, executeInline, projectApiConnection, createProjectInternalClient, executeProjectApi, selectDispatchTarget, defaultConfig, createApiExtension, POSTGRES_AUTH_PROVIDER_ID, AUTH_PROVIDERS, consumeReauthentication, verifyProviderIdToken, normalizeEmail, validateMarketPassword, hashMarketPassword, verifyMarketPassword, MARKET_EMAIL_CONFIRMATION_PREFIX, shouldBypassAcceptanceAuthEmailDelivery, marketEmailTokenHash, passwordResetUrlFor, sendTeamInviteEmail, createMarketEmailConfirmation, serializeUserEmailAddress, backfillUserEmailAddresses, listUserEmailAddresses, getUserEmailAddress, verifiedEmailCount, setPrimaryEmailAddress, syncPrimaryEmailCaches, createOrResendUserEmailAddress } from './index.ts';
export async function loadNotificationPreferences(store, userId) {
    const settings = await store.first(`SELECT * FROM user_notification_preferences WHERE user_id = ? LIMIT 1`, [userId]);
    const globalRows = await store.all(`SELECT content_type FROM user_notification_global_content_types WHERE user_id = ? ORDER BY content_type`, [userId]);
    const overrideRows = await store.all(`SELECT project_id FROM user_notification_project_overrides WHERE user_id = ? ORDER BY project_id`, [userId]);
    const typeRows = await store.all(`SELECT project_id, content_type FROM user_notification_project_content_types WHERE user_id = ? ORDER BY project_id, content_type`, [userId]);
    return normalizeNotificationPreferences({
        emailCadence: settings?.email_cadence,
        timeZone: settings?.time_zone,
        globalContentTypes: globalRows.map((row) => row.content_type),
        projectOverrides: overrideRows.map((row) => ({ projectId: row.project_id, contentTypes: typeRows.filter((entry) => entry.project_id === row.project_id).map((entry) => entry.content_type) })),
    });
}
export async function createProjectHostCredentialSessions({ store, runtime, teamId, principalId, hostBindings, requirementKeys, passphrase }) {
    if (!passphrase)
        return {};
    const sessions = {};
    for (const [requirementKey, rawBinding] of Object.entries(hostBindings ?? {})) {
        const binding = rawBinding as {
            hostId?: string;
            host?: { id?: string };
            provider?: string;
        };
        if (requirementKeys?.length && !requirementKeys.includes(requirementKey))
            continue;
        if (!hostBindingRequiresUnlock(binding))
            continue;
        const hostKind = hostKindForBinding(binding);
        const hostId = binding.hostId ?? binding.host?.id ?? null;
        if (!hostId)
            continue;
        const host = hostKind === 'repository_host'
            ? await store.getRepositoryHost(teamId, hostId)
            : await store.getTeamWebHost(teamId, hostId);
        if (!host || host.ownership !== 'team_owned')
            continue;
        const normalizedConfig = await decryptTeamHostForLaunch(hostKind, host, passphrase);
        const session = await store.createProviderCredentialSession(teamId, {
            hostKind,
            hostId,
            purpose: 'project_host_operation',
            expiresAt: new Date(Date.now() + 900000).toISOString(),
            createdById: principalId,
            encryptedPayload: encryptCredentialSessionPayload(runtime, {
                provider: host.provider ?? binding.provider,
                ownership: host.ownership,
                config: normalizedConfig,
            }),
            metadata: {
                requirementKey,
                hostName: host.name ?? null,
                provider: host.provider ?? binding.provider ?? null,
                configSummary: decryptedHostConfigSummary(normalizedConfig),
            },
        });
        sessions[requirementKey] = {
            id: session.id,
            hostKind: session.hostKind,
            hostId: session.hostId,
            purpose: session.purpose,
            expiresAt: session.expiresAt,
        };
    }
    return sessions;
}
export function shouldExposeNonProductionAuthDiagnostics(c, runtime) {
    const environment = String(runtime?.resolved?.config?.environment ?? process.env.TREESEED_API_ENVIRONMENT ?? process.env.TREESEED_ENVIRONMENT ?? '').trim().toLowerCase();
    if (environment && !['prod', 'production'].includes(environment))
        return true;
    try {
        const host = new URL(c.req.url).hostname.toLowerCase();
        return host.includes('staging') || host.endsWith('.localhost') || host === 'localhost' || host === '127.0.0.1' || host === '::1';
    }
    catch {
        return false;
    }
}
export function requestSessionMetadata(c) {
    const userAgent = trimmedHeaderValue(c, 'user-agent');
    const ipAddress = requestClientIp(c);
    return {
        ipAddress: ipAddress ? ipAddress.slice(0, 128) : null,
        userAgent: userAgent ? userAgent.slice(0, 512) : null,
    };
}
export function webSessionData(c, source) {
    return {
        source,
        ...requestSessionMetadata(c),
    };
}
export function marketAuthContext(c) {
    return {
        locals: {
            runtime: {
                env: {
                    ...process.env,
                    ...(c.env ?? {}),
                },
            },
        },
        url: new URL(c.req.url),
    };
}
export function exposeAuthTokenForTests(c = null, config: any = {}) {
    return process.env.NODE_ENV === 'test'
        || process.env.TREESEED_ACCEPTANCE_EXPOSE_AUTH_TOKENS === '1'
        || (c ? shouldBypassAcceptanceAuthEmailDelivery(c, config) : false);
}
export function authTokenTimestampSeconds(value = Date.now()) {
    return Math.floor(Number(value) / 1000);
}
export function authTokenTimestampMillis(value) {
    const number = Number(value ?? 0);
    if (!Number.isFinite(number) || number <= 0)
        return 0;
    return number < 10000000000 ? number * 1000 : number;
}
export async function createMarketWebSession(marketAuthProvider, userId, data: any = {}, options: any = {}) {
    if (typeof marketAuthProvider.issueUserSession === 'function') {
        return marketAuthProvider.issueUserSession(userId, {
            sessionType: 'web',
            data,
        });
    }
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const token = await marketAuthProvider.createPersonalAccessToken(userId, {
        name: 'Treeseed web session',
        scopes: ['auth:me'],
        expiresAt,
    });
    const authenticated = await marketAuthProvider.authenticateBearerToken(token.token);
    const sessionId = randomUUID();
    const now = new Date().toISOString();
    if (options.store?.run) {
        await options.store.run(`INSERT INTO auth_sessions (id, user_id, session_type, refresh_token_hash, scopes_json, expires_at, revoked_at, data_json, created_at, updated_at)
			 VALUES (?, ?, 'web', ?, ?, ?, NULL, ?, ?, ?)`, [
            sessionId,
            userId,
            createHash('sha256').update(`${options.authSecret ?? 'market'}:${sessionId}`).digest('hex'),
            JSON.stringify(['auth:me']),
            expiresAt,
            JSON.stringify({ ...data, tokenId: token.id }),
            now,
            now,
        ]).catch(() => null);
    }
    return {
        ok: true,
        status: 'approved',
        accessToken: token.token,
        refreshToken: null,
        tokenType: 'Bearer',
        expiresAt,
        expiresInSeconds: 15 * 60,
        principal: authenticated?.principal ?? { id: userId, type: 'user', roles: [], scopes: ['auth:me'], metadata: { sessionId } },
    };
}
export function webAuthPayload(session) {
    return {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        tokenType: session.tokenType,
        expiresAt: session.expiresAt,
        expiresInSeconds: session.expiresInSeconds,
        principal: session.principal,
    };
}
export function normalizeAppearancePreference(input: any = {}) {
    const scheme = optionalTrimmedString(input.colorScheme ?? input.scheme) ?? 'fern';
    const mode = optionalTrimmedString(input.themeMode ?? input.mode) ?? 'system';
    return {
        scheme,
        mode: ['light', 'dark', 'system'].includes(mode) ? mode : 'system',
    };
}
export function resolveAuthApprovalBaseUrl(config) {
    const baseUrl = normalizeBaseUrl(config.baseUrl);
    const configured = normalizeBaseUrl(config.authApprovalBaseUrl ?? config.siteUrl ?? '');
    const remoteApi = baseUrl && !isLoopbackUrl(baseUrl);
    if (configured) {
        if (remoteApi && isLoopbackUrl(configured)) {
            throw new Error(`Refusing loopback device approval URL "${configured}" for remote API "${baseUrl}".`);
        }
        return configured;
    }
    const environment = normalizeBaseUrl(process.env.TREESEED_SITE_URL ?? process.env.TREESEED_BETTER_AUTH_URL ?? '');
    if (remoteApi && environment && isLoopbackUrl(environment)) {
        throw new Error(`Refusing loopback device approval URL "${environment}" for remote API "${baseUrl}".`);
    }
    const candidate = environment || baseUrl;
    const normalized = normalizeBaseUrl(candidate);
    if (normalized === 'https://api.treeseed.dev') {
        return 'https://treeseed.dev';
    }
    return normalized || baseUrl;
}
export function credentialSessionSecret(runtime) {
    const configured = process.env.TREESEED_CREDENTIAL_SESSION_SECRET
        ?? runtime?.resolved?.config?.credentialSessionSecret
        ?? null;
    if (configured && String(configured).trim()) {
        return String(configured);
    }
    const runtimeConfig = runtime?.resolved?.config ?? {};
    const environment = String(runtimeConfig.environment ?? process.env.TREESEED_API_ENVIRONMENT ?? process.env.TREESEED_ENVIRONMENT ?? '').trim().toLowerCase();
    const localDatabase = isLoopbackUrl(runtimeConfig.apiDatabaseUrl ?? process.env.TREESEED_DATABASE_URL ?? '');
    const localBaseUrl = isLoopbackUrl(runtimeConfig.baseUrl ?? process.env.TREESEED_SITE_URL ?? process.env.TREESEED_BETTER_AUTH_URL ?? '');
    if (process.env.NODE_ENV === 'test'
        || process.env.TREESEED_LOCAL_DEV_MODE
        || environment === 'local'
        || localDatabase
        || localBaseUrl) {
        return 'treeseed-local-test-credential-session-secret';
    }
    throw new Error('TREESEED_CREDENTIAL_SESSION_SECRET is required for provider credential sessions.');
}
export function credentialSessionKey(runtime) {
    return createHash('sha256').update(credentialSessionSecret(runtime)).digest();
}
export function encryptCredentialSessionPayload(runtime, payload) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', credentialSessionKey(runtime), iv);
    const plaintext = Buffer.from(JSON.stringify(payload ?? {}), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
        version: 1,
        algorithm: 'aes-256-gcm',
        iv: iv.toString('base64url'),
        tag: cipher.getAuthTag().toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
    };
}
export function decryptCredentialSessionPayload(runtime, envelope) {
    if (!envelope || typeof envelope !== 'object') {
        throw new Error('Credential session payload is missing.');
    }
    const decipher = createDecipheriv('aes-256-gcm', credentialSessionKey(runtime), Buffer.from(String(envelope.iv ?? ''), 'base64url'));
    decipher.setAuthTag(Buffer.from(String(envelope.tag ?? ''), 'base64url'));
    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(String(envelope.ciphertext ?? ''), 'base64url')),
        decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8'));
}
export const HOST_KIND_SESSION_KEYS = {
    repository: { sessionKey: 'repositoryHost', hostKind: 'repository_host' },
    web: { sessionKey: 'webHost', hostKind: 'web_host' },
    capacityProvider: { sessionKey: 'capacityProviderHost', hostKind: 'capacity_provider_host' },
    email: { sessionKey: 'emailHost', hostKind: 'email_host' },
};
export function cloudflareDeletionAuthenticationMessage(message) {
    return /authentication error|invalid token|unauthorized|forbidden|10000/iu.test(String(message ?? ''));
}
export function localAcceptanceAuthEnabled(runtime) {
    const environment = String(runtime?.resolved?.config?.environment ?? process.env.TREESEED_API_ENVIRONMENT ?? process.env.TREESEED_ENVIRONMENT ?? '').trim().toLowerCase();
    const baseUrl = String(runtime?.resolved?.config?.baseUrl ?? process.env.TREESEED_API_BASE_URL ?? '').trim();
    return environment === 'local' || process.env.TREESEED_LOCAL_DEV_MODE === '1' || isLoopbackUrl(baseUrl);
}

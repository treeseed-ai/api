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
import { POSTGRES_AUTH_PROVIDER_ID, AUTH_PROVIDERS, consumeReauthentication, loadNotificationPreferences, verifyProviderIdToken, resolveLaunchTemplateRequirements, projectHostBindingMetadata, sourceFromProjectDetails, repositoryInventoryWithPlatform, loadProjectHostBindingContext, projectHostResponsePayload, hostBindingRequiresUnlock, hostKindForBinding, createProjectHostCredentialSessions, persistProjectHostBindingOperationMetadata, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, plaintextHostCredentialFieldPaths, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, markdownToPlainProjectSummary, shouldExposeNonProductionAuthDiagnostics, AGENT_PROMOTION_APPROVAL_DECISIONS, normalizeEmail, requestSessionMetadata, webSessionData, validateMarketPassword, hashMarketPassword, verifyMarketPassword, MARKET_EMAIL_CONFIRMATION_PREFIX, marketAuthContext, shouldBypassAcceptanceAuthEmailDelivery, marketEmailTokenHash, exposeAuthTokenForTests, authTokenTimestampSeconds, authTokenTimestampMillis, passwordResetUrlFor, sendTeamInviteEmail, createMarketEmailConfirmation, serializeUserEmailAddress, backfillUserEmailAddresses, listUserEmailAddresses, getUserEmailAddress, verifiedEmailCount, setPrimaryEmailAddress, syncPrimaryEmailCaches, createOrResendUserEmailAddress, createMarketWebSession, webAuthPayload, normalizeAppearancePreference, normalizeDomainName, normalizeProjectDomainInput, inferZoneNameForDomain, domainInZone, LOCAL_CONTENT_COLLECTIONS, LOCAL_WORK_CONTENT_COLLECTIONS, LOCAL_DECISION_TYPE_VALUES, PROPOSAL_VERDICT_DECISION_TYPES, PLATFORM_OPERATION_SCOPES, LOCAL_CONTENT_DEFAULTS, slugifyContent, serializeFrontmatter, normalizeRelationArray, uniqueRelationArray, addRelationValue, normalizeLocalContentInput, writeLocalContentRecord, localContentRoot, localContentPath, readLocalContentRecord, writeParsedLocalContentRecord, createRelatedLocalContentRecord, createDecisionFromProposals, resolveAuthApprovalBaseUrl, encryptedHostPayloadLooksValid, decryptedHostConfigSummary, credentialSessionSecret, credentialSessionKey, encryptCredentialSessionPayload, decryptCredentialSessionPayload, HOST_KIND_SESSION_KEYS, normalizeAuditHostKinds, collectHostingAuditCredentialOverlay, nonSecretLaunchJobInput, decryptTeamHostForLaunch, buildLaunchCredentialOverlay, patchLaunchIntentForCredentialOverlay, appendLaunchDeploymentEvent, sanitizeLaunchResultForStorage, cloudflareErrorMessage, cloudflareRequestForLaunchPreflight, resolveCloudflareZoneForLaunchPreflight, verifyCloudflareDnsWriteForLaunch, projectDeletionConfirmationMatches, projectDeletionBlockerRows, cloudflareRequestForProjectDeletion, githubRequestForProjectDeletion, projectDeletionOperation, cloudflareDeletionAuthenticationMessage, hasRecordedCloudflareRuntimeResources, canSkipCloudflareCleanupAfterFailedLaunch, projectDeletionHostname, normalizedCloudflareKvNamespaceReference, uniqueCloudflareKvNamespaceReferences, cloudflareProjectDeletionResourceNames, resolveProjectDeletionCloudflareZone, deleteCloudflareDnsRecordsForProject, listCloudflareNamedResources, deleteCloudflareProjectResources, appendProjectDeletionProgress, cloudflareDnsDomainsForHostValidation, validateTeamHostCredentialPayload, runProjectLaunchApiBootstrap, runProjectDeletionApiDestroy, retryApiLaunchBootstrapFromRequest, operationTokenSecret, signOperationToken, verifyOperationToken, normalizeCiEnvironment, ciOperationForAction, normalizeRepositorySlug, projectAllowedCiRepositories, validateCiRefForEnvironment, principalHasPermission, principalIsSeedAdmin, isTeamApiPrincipal, isLocalAcceptanceServicePrincipal, localAcceptanceAuthEnabled, decorateJob, safePlatformOperationOutput, decoratePlatformOperation, resolvePlatformRunnerSecret, platformOperationMutationError, requirePlatformRunner, resolvePlatformRepositoryDescriptor, launchPlannerRepositoryTopology, launchCapabilityPreset, resourceRowsFromLaunch, ensurePrincipal, resolveUiProjectionContext, resolvePublicTreeDxTeam, enqueueTreeDxProvisionOperation, principalHasGlobalPlatformRole, requireTeamAccess, requireProjectAccess, FEEDBACK_TYPES, FEEDBACK_SCREENSHOT_TYPES, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, cleanFeedbackString, safeFeedbackContext, safeFeedbackClient, safeFeedbackScreenshot, validateFeedbackAccess, recordFeedbackSubmission, normalizeSeedEnvironments, seedActor, seedExistingTeamIds, seedCreatesMissingTeams, requireSeedPlanAccess, requireSeedApplyAccess, requireProjectRunner, commerceErrorResponse, stripeConfiguredError, stripeVendorApprovalError, stripeAccountMissingError, stripeCommerceUrl, requireCommerceVendorForStripe, refreshCommerceStripeAccount, STRIPE_PRODUCT_MIRROR_OFFER_MODES, STRIPE_PRICE_MIRROR_OFFER_MODES, stripeMetadataValue, buildCommerceStripeMetadata, commerceStripeProductParams, commerceStripeLookupKey, commerceStripePriceParams, stripePriceTermsDrift, commerceStripeSyncContext, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, CHECKOUT_OFFER_MODES, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, resolveStripePublishableKey, resolveStripeWebhookSecret, commerceCheckoutError, normalizeCheckoutQuantity, stripeClientSecret, paymentGroupStatusFromPaymentIntent, orderStatusFromPaymentGroup, subscriptionStatusFromStripe, entitlementRenewalStateFromSubscription, stripeTimestampToIso, subscriptionClientSecret, publicPaymentGroups, buildCommerceCheckoutMetadata, resolveCommerceCheckoutItem, checkoutGroupKind, checkoutGroupKey, checkoutGroupStatus, grantCommerceEntitlementsForOrder, requireSellerTeamAccess, requireServiceParticipantAccess, redactCommerceServiceRequestForBuyer, requireCommerceCapacityListingAccess, requireCommerceCapacityInquiryAccess, stripeRefundStatus, applyCommerceRefundState, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, ensureCommerceStripeCustomer, refreshCommercePaymentGroupState, updateCheckoutCompletionFromGroup, syncCommerceSubscriptionFromStripe, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, handleCommerceInvoiceWebhook, processCommerceStripeWebhook, requireCommerceProductAccess, principalCanManageCommerceProduct, redactCommerceOwnershipWorkflow, requireCommerceOfferAccess, requireConnectedProjectRuntime, projectAppHref, unwrapLaunchOperationOutput, appendLaunchPhaseProjection, updateLaunchDeployments, hubRepositoryPolicies, applyHubLaunchResult, applyHubLaunchFailure, unwrapOperationPayload, applyContentPublishResult, projectApiConnection, createProjectInternalClient, executeProjectApi, jsonError, jsonThrownError, providerConfigFor, parseBooleanEnvValue, redactedRequestTarget, normalizeUsername, parseJsonObject, normalizeBaseUrl, normalizeMarketProfile, normalizeProviderCredentialConfig, mergeStringConfig, parseBase64urlJson, safeTokenEquals, requireConfiguredServiceCredential, safePrivateKnowledgeSlug, requireServiceBuyerAccess, requireServiceSellerAccess, requireCatalogItemAccess, defaultConfig, availabilityAttempts, providerJwksCache, availabilityRateLimit, exchangeProviderIdentity, providerCredentialValuesForAudit, GITHUB_ACTIONS_OIDC_ISSUER, githubOidcJwksCache, loadGitHubOidcJwks, verifyGitHubOidcToken, fallbackRemoteCapability, mergeCapability, resolveAgentTaskSignature, requireVendorOrderManager, remainingRefundableAmount, resolveOrderItemForRefund, resolveFulfillmentArtifact, executeInline, selectDispatchTarget } from './index.ts';
export function personalThemeFromRow(row) {
    return {
        id: row.id,
        schemeId: `personal-${row.id}`,
        name: row.name,
        baseScheme: row.base_scheme,
        palette: parseJsonObject(row.palette_json),
        compilerVersion: Number(row.compiler_version ?? PERSONAL_THEME_COMPILER_VERSION),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
export async function accountDeletionBlockers(store, principal) {
    const teams = await store.listTeamsForPrincipal(principal);
    const blockers = teams
        .filter((team) => Array.isArray(team.roles) ? team.roles.includes('owner') : team.role === 'owner')
        .map((team) => ({
        code: 'team_owner',
        message: `Transfer or delete team "${team.displayName ?? team.name ?? team.slug}" before deleting this account.`,
        teamId: team.id,
        teamSlug: team.slug,
        teamName: team.displayName ?? team.name ?? team.slug,
    }));
    if (principal.roles?.includes?.('platform_admin'))
        blockers.push({ code: 'platform_admin', message: 'Remove platform admin role before deleting this account.' });
    return blockers;
}
export function base64Url(value) {
    return Buffer.from(value).toString('base64url');
}
export function shouldLogApiRequests(config, options: any = {}) {
    if (typeof options.logRequests === 'boolean')
        return options.logRequests;
    const explicit = parseBooleanEnvValue(process.env.TREESEED_MARKET_API_REQUEST_LOGS ?? process.env.TREESEED_API_REQUEST_LOGS);
    if (explicit != null)
        return explicit;
    if (process.env.NODE_ENV === 'test')
        return false;
    const environment = String(config?.environment ?? process.env.TREESEED_API_ENVIRONMENT ?? process.env.TREESEED_ENVIRONMENT ?? '').trim();
    return environment === 'local';
}
export const SENSITIVE_QUERY_PARAM_PATTERN = /(?:token|secret|password|credential|assertion|signature|api[_-]?key|access[_-]?key|private[_-]?key|code)/iu;
export function installApiRequestLogger(app) {
    app.use('*', async (c, next) => {
        const startedAt = Date.now();
        const method = c.req.method;
        const target = redactedRequestTarget(c.req.url);
        try {
            await next();
        }
        finally {
            const elapsedMs = Date.now() - startedAt;
            const status = c.res?.status ?? 500;
            process.stdout.write(`[api] ${method} ${target} -> ${status} ${elapsedMs}ms\n`);
        }
    });
}
export async function readJsonOrFormBody(c) {
    const contentType = c.req.header('content-type') ?? '';
    if (contentType.includes('application/json')) {
        const json = await c.req.json().catch(() => null);
        if (json && typeof json === 'object' && !Array.isArray(json)) {
            return json;
        }
    }
    const form = await c.req.parseBody?.().catch(() => ({}));
    if (!form || typeof form !== 'object') {
        return {};
    }
    return Object.fromEntries(Object.entries(form).map(([key, value]) => [key, typeof value === 'string' ? value : String(value ?? '')]));
}
export function trimmedHeaderValue(c, name) {
    const value = c.req.header(name);
    return typeof value === 'string' ? value.trim() : '';
}
export function requestClientIp(c) {
    const forwardedFor = trimmedHeaderValue(c, 'x-forwarded-for')
        .split(',')
        .map((part) => part.trim())
        .find(Boolean);
    return (trimmedHeaderValue(c, 'cf-connecting-ip')
        || trimmedHeaderValue(c, 'true-client-ip')
        || trimmedHeaderValue(c, 'x-real-ip')
        || trimmedHeaderValue(c, 'x-treeseed-client-ip')
        || forwardedFor
        || null);
}
export async function ensureMarketCredentialSchema(store) {
    await store.ensureInitialized();
    await backfillUserEmailAddresses(store);
}
export function sanitizedReturnTo(value) {
    const target = String(value ?? '/app/');
    return target.startsWith('/') && !target.startsWith('//') ? target : '/app/';
}
export function confirmationUrlFor(context, token, returnTo) {
    const authConfig = getSiteAuthConfig(context);
    const target = new URL('/auth/confirm-email', `${authConfig.siteBaseUrl.replace(/\/+$/u, '')}/`);
    target.searchParams.set('token', token);
    target.searchParams.set('returnTo', sanitizedReturnTo(returnTo));
    return target.toString();
}
export function teamInviteAcceptUrlFor(context, token) {
    const authConfig = getSiteAuthConfig(context);
    return new URL(`/team-invites/${encodeURIComponent(token)}/accept`, `${authConfig.siteBaseUrl.replace(/\/+$/u, '')}/`).toString();
}
export function optionalTrimmedString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}
export function enumValue(value, allowed, fallback = null) {
    const candidate = typeof value === 'string' ? value.trim() : '';
    return allowed.includes(candidate) ? candidate : fallback;
}
export function unknownKeys(body, allowed) {
    const allow = new Set(allowed);
    return Object.keys(body && typeof body === 'object' && !Array.isArray(body) ? body : {})
        .filter((key) => !allow.has(key));
}
export function yamlScalar(value) {
    const text = String(value ?? '');
    if (/^[a-zA-Z0-9_:/.-]+$/u.test(text) && !['true', 'false', 'null'].includes(text.toLowerCase())) {
        return text;
    }
    return JSON.stringify(text);
}
export function yamlLines(value, indent = 0) {
    const pad = ' '.repeat(indent);
    if (Array.isArray(value)) {
        if (value.length === 0)
            return [`${pad}[]`];
        return value.flatMap((entry) => {
            if (entry && typeof entry === 'object') {
                return [``, ...yamlLines(entry, indent + 2)].map((line, index) => index === 0 ? `${pad}-` : line);
            }
            return [`${pad}- ${yamlScalar(entry)}`];
        });
    }
    if (value && typeof value === 'object') {
        return Object.entries(value).flatMap(([key, entry]) => {
            if (Array.isArray(entry) || (entry && typeof entry === 'object')) {
                return [`${pad}${key}:`, ...yamlLines(entry, indent + 2)];
            }
            return [`${pad}${key}: ${yamlScalar(entry)}`];
        });
    }
    return [`${pad}${yamlScalar(value)}`];
}
export function isLoopbackUrl(value) {
    try {
        const url = new URL(value);
        return url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    }
    catch {
        return false;
    }
}
export function findById(items, id) {
    const key = String(id ?? '');
    return Array.isArray(items)
        ? items.find((item) => String(item?.id ?? item?.taskId ?? item?.workDayId ?? item?.work_day_id ?? '') === key)
        : null;
}
export function resolveAgentArtifactBucket(runtime) {
    const env = runtime?.env && typeof runtime.env === 'object' ? runtime.env : {};
    const binding = String(env.TREESEED_AGENT_ARTIFACT_BUCKET_BINDING
        ?? env.TREESEED_CONTENT_BUCKET_BINDING
        ?? 'TREESEED_CONTENT_BUCKET').trim();
    const candidates = [
        env.TREESEED_AGENT_ARTIFACT_BUCKET,
        binding ? env[binding] : null,
        env.TREESEED_CONTENT_BUCKET,
    ];
    return candidates.find((candidate) => candidate && typeof candidate === 'object' && typeof candidate.put === 'function') ?? null;
}
export function centralMarketProfile(baseUrl) {
    return {
        id: 'central',
        label: 'TreeSeed Central Market',
        baseUrl: normalizeBaseUrl(baseUrl),
        kind: 'central',
        alwaysAvailable: true,
    };
}
export function scheduleBackgroundBootstrap(c, task) {
    const promise = Promise.resolve()
        .then(task)
        .catch((error) => {
        process.stderr.write(`[api] project launch bootstrap failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    });
    let executionCtx = null;
    try {
        executionCtx = c.executionCtx;
    }
    catch {
        executionCtx = null;
    }
    if (typeof executionCtx?.waitUntil === 'function') {
        executionCtx.waitUntil(promise);
    }
    return promise;
}
export function base64urlJson(value) {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}
export function marketProfilesForTeams(teams: any = [], baseUrl) {
    const byId = new Map();
    const central = centralMarketProfile(baseUrl);
    byId.set(central.id, central);
    for (const team of teams) {
        const metadata = team?.metadata && typeof team.metadata === 'object' ? team.metadata : {};
        const profiles = Array.isArray(metadata.marketProfiles)
            ? metadata.marketProfiles
            : Array.isArray(metadata.markets)
                ? metadata.markets
                : [];
        for (const profile of profiles) {
            const normalized = normalizeMarketProfile(profile, team.id);
            if (normalized) {
                byId.set(normalized.id, normalized);
            }
        }
    }
    return [...byId.values()];
}
export function artifactDownloadPayload(baseUrl, item, artifact) {
    const metadata = artifact.metadata && typeof artifact.metadata === 'object' ? artifact.metadata : {};
    const downloadUrl = typeof metadata.downloadUrl === 'string' && metadata.downloadUrl.trim()
        ? metadata.downloadUrl
        : typeof metadata.publicUrl === 'string' && metadata.publicUrl.trim()
            ? metadata.publicUrl
            : `${normalizeBaseUrl(baseUrl)}/v1/catalog/${encodeURIComponent(item.id)}/artifacts/${encodeURIComponent(artifact.version)}/content`;
    return {
        itemId: item.id,
        slug: item.slug,
        kind: item.kind,
        version: artifact.version,
        contentType: typeof metadata.contentType === 'string' && metadata.contentType.trim()
            ? metadata.contentType
            : item.kind === 'knowledge_pack'
                ? 'application/vnd.treeseed.knowledge-pack+tar'
                : 'application/vnd.treeseed.template+tar',
        sha256: typeof metadata.sha256 === 'string' && metadata.sha256.trim() ? metadata.sha256.trim() : null,
        downloadUrl,
        expiresAt: typeof metadata.expiresAt === 'string' ? metadata.expiresAt : null,
        installStrategy: typeof metadata.installStrategy === 'string'
            ? metadata.installStrategy
            : typeof item.metadata?.installStrategy === 'string'
                ? item.metadata.installStrategy
                : null,
    };
}
export function localAcceptanceAdminToken() {
    return process.env.TREESEED_CAPACITY_ACCEPTANCE_ADMIN_TOKEN || 'tsk_local_treeseed_acceptance_admin';
}
export function canonicalArchitectureTopology(value) {
    if (value === 'combined_compatibility')
        return 'single_repository_site';
    if (value === 'split_software_content')
        return 'split_site_content';
    if (['single_repository_site', 'split_site_content', 'parent_workspace'].includes(value))
        return value;
    return 'split_site_content';
}
export function decodeRouteParam(value) {
    let decoded = String(value ?? '');
    for (let index = 0; index < 2; index += 1) {
        try {
            const next = decodeURIComponent(decoded);
            if (next === decoded)
                break;
            decoded = next;
        }
        catch {
            break;
        }
    }
    return decoded;
}
export function uiRuntimeLocals(config) {
    return {
        runtime: {
            resolved: {
                config: {
                    repoRoot: config?.repoRoot ?? process.cwd(),
                },
            },
            env: {
                TREESEED_ENVIRONMENT: config?.environment ?? process.env.TREESEED_ENVIRONMENT ?? 'prod',
            },
        },
    };
}
export function privateKnowledgeAuditPayload(body, extra: any = {}) {
    return {
        slug: safePrivateKnowledgeSlug(body?.slug),
        route: typeof body?.route === 'string' && body.route.startsWith('/app/projects/') ? body.route : null,
        summary: extra.summary ?? null,
        status: extra.status ?? null,
    };
}
export async function recordPrivateKnowledgeAudit(store, input: any = {}) {
    if (typeof store.recordAuditEvent !== 'function')
        return null;
    return store.recordAuditEvent({
        eventType: input.eventType,
        actorType: input.actorType ?? 'user',
        actorId: input.actorId ?? null,
        targetType: 'project',
        targetId: input.projectId,
        data: privateKnowledgeAuditPayload(input.body, {
            status: input.status,
            summary: input.summary,
        }),
    });
}
export const AGENT_TASK_SIGNATURES = {
    'question.summarize': {
        defaultCredits: 3,
        requiredCapabilities: ['agent_execution'],
        repositoryMutation: false,
        bindingWork: false,
        productionAllowed: true,
        priorityClass: 'background',
    },
    'proposal.draft': {
        defaultCredits: 5,
        requiredCapabilities: ['agent_execution'],
        repositoryMutation: false,
        bindingWork: false,
        productionAllowed: true,
        priorityClass: 'interactive',
    },
    'proposal.compare': {
        defaultCredits: 5,
        requiredCapabilities: ['agent_execution'],
        repositoryMutation: false,
        bindingWork: false,
        productionAllowed: true,
        priorityClass: 'background',
    },
    'decision.summary': {
        defaultCredits: 4,
        requiredCapabilities: ['agent_execution', 'reporting'],
        repositoryMutation: false,
        bindingWork: false,
        productionAllowed: true,
        priorityClass: 'background',
    },
    'release.summary': {
        defaultCredits: 4,
        requiredCapabilities: ['agent_execution', 'reporting'],
        repositoryMutation: false,
        bindingWork: false,
        productionAllowed: true,
        priorityClass: 'background',
    },
    'market.description.draft': {
        defaultCredits: 4,
        requiredCapabilities: ['agent_execution'],
        repositoryMutation: false,
        bindingWork: false,
        productionAllowed: true,
        priorityClass: 'interactive',
    },
    'repository.change.apply': {
        defaultCredits: 10,
        requiredCapabilities: ['agent_execution', 'repository_work'],
        repositoryMutation: true,
        bindingWork: true,
        productionAllowed: false,
        priorityClass: 'interactive',
    },
    'verification.run': {
        defaultCredits: 6,
        requiredCapabilities: ['agent_execution', 'repository_work', 'reporting'],
        repositoryMutation: false,
        bindingWork: false,
        productionAllowed: false,
        priorityClass: 'background',
    },
    'workday.report': {
        defaultCredits: 2,
        requiredCapabilities: ['agent_execution', 'reporting'],
        repositoryMutation: false,
        bindingWork: false,
        productionAllowed: true,
        priorityClass: 'background',
    },
};
export function createApiExtension(options: any = {}) {
    return {
        name: options.name ?? 'treeseed-market',
        mount: options.mount ?? ((app, runtime) => options.extendApp?.(app, runtime)),
    };
}

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
import { jsonError, jsonThrownError, POSTGRES_AUTH_PROVIDER_ID, availabilityAttempts, AUTH_PROVIDERS, providerJwksCache, availabilityRateLimit, personalThemeFromRow, accountDeletionBlockers, consumeReauthentication, loadNotificationPreferences, providerConfigFor, base64Url, verifyProviderIdToken, exchangeProviderIdentity, sourceFromProjectDetails, repositoryInventoryWithPlatform, createProjectHostCredentialSessions, rejectProjectSecretUnlockMaterial, markdownToPlainProjectSummary, parseBooleanEnvValue, shouldLogApiRequests, shouldExposeNonProductionAuthDiagnostics, SENSITIVE_QUERY_PARAM_PATTERN, redactedRequestTarget, installApiRequestLogger, AGENT_PROMOTION_APPROVAL_DECISIONS, readJsonOrFormBody, normalizeEmail, normalizeUsername, parseJsonObject, trimmedHeaderValue, requestClientIp, requestSessionMetadata, webSessionData, validateMarketPassword, hashMarketPassword, verifyMarketPassword, ensureMarketCredentialSchema, MARKET_EMAIL_CONFIRMATION_PREFIX, marketAuthContext, shouldBypassAcceptanceAuthEmailDelivery, marketEmailTokenHash, exposeAuthTokenForTests, authTokenTimestampSeconds, authTokenTimestampMillis, sanitizedReturnTo, confirmationUrlFor, teamInviteAcceptUrlFor, passwordResetUrlFor, sendTeamInviteEmail, createMarketEmailConfirmation, serializeUserEmailAddress, backfillUserEmailAddresses, listUserEmailAddresses, getUserEmailAddress, verifiedEmailCount, setPrimaryEmailAddress, syncPrimaryEmailCaches, createOrResendUserEmailAddress, createMarketWebSession, webAuthPayload, normalizeAppearancePreference, normalizeBaseUrl, optionalTrimmedString, enumValue, unknownKeys, LOCAL_CONTENT_COLLECTIONS, LOCAL_WORK_CONTENT_COLLECTIONS, LOCAL_DECISION_TYPE_VALUES, PROPOSAL_VERDICT_DECISION_TYPES, PLATFORM_OPERATION_SCOPES, LOCAL_CONTENT_DEFAULTS, slugifyContent, yamlScalar, yamlLines, serializeFrontmatter, normalizeRelationArray, uniqueRelationArray, addRelationValue, normalizeLocalContentInput, writeLocalContentRecord, localContentRoot, localContentPath, readLocalContentRecord, writeParsedLocalContentRecord, createRelatedLocalContentRecord, createDecisionFromProposals, isLoopbackUrl, resolveAuthApprovalBaseUrl, findById, resolveAgentArtifactBucket, centralMarketProfile, normalizeMarketProfile, credentialSessionSecret, credentialSessionKey, encryptCredentialSessionPayload, decryptCredentialSessionPayload, normalizeProviderCredentialConfig, HOST_KIND_SESSION_KEYS, providerCredentialValuesForAudit, mergeStringConfig, scheduleBackgroundBootstrap, projectDeletionConfirmationMatches, projectDeletionBlockerRows, githubRequestForProjectDeletion, projectDeletionOperation, cloudflareDeletionAuthenticationMessage, appendProjectDeletionProgress, runProjectDeletionApiDestroy, GITHUB_ACTIONS_OIDC_ISSUER, githubOidcJwksCache, base64urlJson, parseBase64urlJson, operationTokenSecret, signOperationToken, verifyOperationToken, loadGitHubOidcJwks, verifyGitHubOidcToken, normalizeCiEnvironment, ciOperationForAction, fallbackRemoteCapability, normalizeRepositorySlug, projectAllowedCiRepositories, validateCiRefForEnvironment, marketProfilesForTeams, artifactDownloadPayload, principalHasPermission, principalIsSeedAdmin, isTeamApiPrincipal, isLocalAcceptanceServicePrincipal, localAcceptanceAdminToken, localAcceptanceAuthEnabled, decorateJob, safePlatformOperationOutput, decoratePlatformOperation, safeTokenEquals, resolvePlatformRunnerSecret, platformOperationMutationError, requirePlatformRunner, resolvePlatformRepositoryDescriptor, mergeCapability, canonicalArchitectureTopology, ensurePrincipal, resolveUiProjectionContext, decodeRouteParam, uiRuntimeLocals, requireConfiguredServiceCredential, resolvePublicTreeDxTeam, enqueueTreeDxProvisionOperation, principalHasGlobalPlatformRole, requireTeamAccess, requireProjectAccess, safePrivateKnowledgeSlug, privateKnowledgeAuditPayload, recordPrivateKnowledgeAudit, FEEDBACK_TYPES, FEEDBACK_SCREENSHOT_TYPES, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, cleanFeedbackString, safeFeedbackContext, safeFeedbackClient, safeFeedbackScreenshot, validateFeedbackAccess, recordFeedbackSubmission, normalizeSeedEnvironments, seedActor, seedExistingTeamIds, seedCreatesMissingTeams, requireSeedPlanAccess, requireSeedApplyAccess, requireProjectRunner, AGENT_TASK_SIGNATURES, resolveAgentTaskSignature, commerceErrorResponse, stripeConfiguredError, stripeVendorApprovalError, stripeAccountMissingError, stripeCommerceUrl, requireCommerceVendorForStripe, refreshCommerceStripeAccount, STRIPE_PRODUCT_MIRROR_OFFER_MODES, STRIPE_PRICE_MIRROR_OFFER_MODES, stripeMetadataValue, buildCommerceStripeMetadata, commerceStripeProductParams, commerceStripeLookupKey, commerceStripePriceParams, stripePriceTermsDrift, commerceStripeSyncContext, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, CHECKOUT_OFFER_MODES, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, resolveStripePublishableKey, resolveStripeWebhookSecret, commerceCheckoutError, normalizeCheckoutQuantity, stripeClientSecret, paymentGroupStatusFromPaymentIntent, orderStatusFromPaymentGroup, subscriptionStatusFromStripe, entitlementRenewalStateFromSubscription, stripeTimestampToIso, subscriptionClientSecret, publicPaymentGroups, buildCommerceCheckoutMetadata, resolveCommerceCheckoutItem, checkoutGroupKind, checkoutGroupKey, checkoutGroupStatus, grantCommerceEntitlementsForOrder, requireSellerTeamAccess, requireVendorOrderManager, requireServiceBuyerAccess, requireServiceSellerAccess, requireServiceParticipantAccess, redactCommerceServiceRequestForBuyer, requireCommerceCapacityListingAccess, requireCommerceCapacityInquiryAccess, remainingRefundableAmount, stripeRefundStatus, applyCommerceRefundState, resolveOrderItemForRefund, resolveFulfillmentArtifact, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, ensureCommerceStripeCustomer, refreshCommercePaymentGroupState, updateCheckoutCompletionFromGroup, syncCommerceSubscriptionFromStripe, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, handleCommerceInvoiceWebhook, processCommerceStripeWebhook, requireCommerceProductAccess, principalCanManageCommerceProduct, redactCommerceOwnershipWorkflow, requireCommerceOfferAccess, requireCatalogItemAccess, requireConnectedProjectRuntime, projectAppHref, hubRepositoryPolicies, unwrapOperationPayload, applyContentPublishResult, executeInline, projectApiConnection, createProjectInternalClient, executeProjectApi, selectDispatchTarget, defaultConfig, createApiExtension, resolveLaunchTemplateRequirements, projectHostBindingMetadata, loadProjectHostBindingContext, projectHostResponsePayload, hostBindingRequiresUnlock, hostKindForBinding, persistProjectHostBindingOperationMetadata, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, plaintextHostCredentialFieldPaths, rejectPlaintextHostCredentialFields, normalizeDomainName, normalizeProjectDomainInput, encryptedHostPayloadLooksValid, decryptedHostConfigSummary, normalizeAuditHostKinds, collectHostingAuditCredentialOverlay, nonSecretLaunchJobInput, decryptTeamHostForLaunch, buildLaunchCredentialOverlay, patchLaunchIntentForCredentialOverlay, appendLaunchDeploymentEvent, sanitizeLaunchResultForStorage, projectDeletionHostname, validateTeamHostCredentialPayload, runProjectLaunchApiBootstrap, retryApiLaunchBootstrapFromRequest, launchPlannerRepositoryTopology, launchCapabilityPreset, resourceRowsFromLaunch, unwrapLaunchOperationOutput, appendLaunchPhaseProjection, updateLaunchDeployments, applyHubLaunchResult, applyHubLaunchFailure } from './index.ts';
export function inferZoneNameForDomain(domain, fallbackZoneName = null) {
    if (!domain)
        return fallbackZoneName;
    if (fallbackZoneName && (domain === fallbackZoneName || domain.endsWith(`.${fallbackZoneName}`)))
        return fallbackZoneName;
    const parts = domain.split('.');
    return parts.length >= 2 ? parts.slice(-2).join('.') : fallbackZoneName;
}
export function domainInZone(domain, zoneName) {
    return Boolean(domain && zoneName && (domain === zoneName || domain.endsWith(`.${zoneName}`)));
}
export function cloudflareErrorMessage(payload, fallback) {
    const errors = Array.isArray(payload?.errors) ? payload.errors : [];
    const messages = errors
        .map((error) => [error?.code, error?.message].filter(Boolean).join(' '))
        .filter(Boolean);
    return messages[0] ?? payload?.message ?? fallback;
}
export async function cloudflareRequestForLaunchPreflight({ token, path, method = 'GET', body = null }) {
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
        method,
        headers: {
            authorization: `Bearer ${token}`,
            ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success === false) {
        throw new Error(cloudflareErrorMessage(payload, `${method} ${path} failed with HTTP ${response.status}.`));
    }
    return payload;
}
export async function resolveCloudflareZoneForLaunchPreflight({ token, zoneId, zoneName }) {
    if (zoneId)
        return zoneId;
    if (!zoneName)
        return null;
    const payload = await cloudflareRequestForLaunchPreflight({
        token,
        path: `/zones?name=${encodeURIComponent(zoneName)}&per_page=1`,
    });
    const resolvedZoneId = payload?.result?.[0]?.id;
    return typeof resolvedZoneId === 'string' && resolvedZoneId.trim() ? resolvedZoneId.trim() : null;
}
export async function verifyCloudflareDnsWriteForLaunch({ overlay, domains }) {
    if (!domains?.manageDns)
        return null;
    const token = overlay.CLOUDFLARE_API_TOKEN;
    if (!token) {
        throw new Error('Cloudflare DNS cannot be managed because the selected Web Host did not provide a Cloudflare API token.');
    }
    const zoneName = normalizeDomainName(domains.zoneName);
    const zoneId = await resolveCloudflareZoneForLaunchPreflight({
        token,
        zoneId: domains.zoneId,
        zoneName,
    });
    if (!zoneId) {
        throw new Error(`Cloudflare DNS zone could not be resolved for ${zoneName || 'the selected project domains'}.`);
    }
    const recordName = `_treeseed-dns-preflight-${randomUUID().slice(0, 8)}.${zoneName}`;
    let recordId = null;
    try {
        const created = await cloudflareRequestForLaunchPreflight({
            token,
            path: `/zones/${encodeURIComponent(zoneId)}/dns_records`,
            method: 'POST',
            body: {
                type: 'TXT',
                name: recordName,
                content: `treeseed launch dns preflight ${new Date().toISOString()}`,
                ttl: 60,
            },
        });
        recordId = created?.result?.id ?? null;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Cloudflare DNS write preflight failed for ${zoneName}: ${message}. The selected Web Host token must include DNS Write and Zone Read access for this root domain.`);
    }
    finally {
        if (recordId) {
            await cloudflareRequestForLaunchPreflight({
                token,
                path: `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
                method: 'DELETE',
            }).catch(() => null);
        }
    }
    return { zoneId, zoneName };
}
export async function cloudflareRequestForProjectDeletion({ token, path, method = 'GET', body = null, allowMissing = true }) {
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
        method,
        headers: {
            authorization: `Bearer ${token}`,
            ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success === false) {
        const message = cloudflareErrorMessage(payload, `${method} ${path} failed with HTTP ${response.status}.`);
        if (allowMissing && /not found|does not exist|could not find|couldn't find|unknown/iu.test(message)) {
            return { success: false, missing: true, result: null, errors: payload?.errors ?? [] };
        }
        throw new Error(message);
    }
    return payload;
}
export function hasRecordedCloudflareRuntimeResources(names) {
    return [
        names.pagesProjects,
        names.workers,
        names.turnstileWidgets,
        names.kvNamespaces,
        names.buckets,
        names.databases,
        names.queues,
    ].some((entries) => Array.isArray(entries) && entries.length > 0);
}
export function canSkipCloudflareCleanupAfterFailedLaunch(project, names, message) {
    if (!cloudflareDeletionAuthenticationMessage(message))
        return false;
    if (hasRecordedCloudflareRuntimeResources(names))
        return false;
    const metadata = project?.metadata ?? {};
    const launchFailureMessage = String(metadata.launchFailure?.message ?? '');
    return metadata.launchPhase === 'failed'
        && /cloudflare|dns_records|dns-record/iu.test(launchFailureMessage)
        && cloudflareDeletionAuthenticationMessage(launchFailureMessage);
}
export function normalizedCloudflareKvNamespaceReference(value) {
    if (!value)
        return null;
    if (typeof value === 'string') {
        const name = value.trim();
        return name ? { id: null, name, binding: null } : null;
    }
    if (typeof value !== 'object')
        return null;
    const id = value.id ?? value.namespaceId ?? value.uuid ?? value.sitekey ?? value.siteKey ?? value.locator ?? null;
    const name = value.name ?? value.title ?? value.namespaceName ?? value.logicalName ?? null;
    const binding = value.binding ?? value.bindingName ?? null;
    if (!id && !name)
        return null;
    return {
        id: id ? String(id) : null,
        name: name ? String(name) : null,
        binding: binding ? String(binding) : null,
    };
}
export function uniqueCloudflareKvNamespaceReferences(entries) {
    const seen = new Set();
    const result = [];
    for (const entry of entries.map(normalizedCloudflareKvNamespaceReference).filter(Boolean)) {
        const key = entry.id ? `id:${entry.id}` : `name:${entry.name}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        result.push(entry);
    }
    return result;
}
interface CloudflareDeletionEnvironment {
    environment?: string;
    cloudflareAccountId?: unknown;
    metadata?: { siteUrl?: unknown };
    baseUrl?: unknown;
    pagesProjectName?: unknown;
    workerName?: unknown;
    r2BucketName?: unknown;
    d1DatabaseName?: unknown;
}

interface CloudflareDeletionResource {
    provider?: string;
    resourceKind?: string;
    locator?: unknown;
    logicalName?: unknown;
    metadata?: {
        name?: unknown;
        projectName?: unknown;
        databaseName?: unknown;
        [key: string]: unknown;
    };
}

interface CloudflareDeletionSnapshot {
    accountId?: unknown;
    pages?: { projectName?: unknown };
    workerName?: unknown;
    turnstileWidget?: unknown;
    formGuardKv?: unknown;
    kvNamespaces?: { FORM_GUARD_KV?: unknown };
    content?: { bucketName?: unknown };
    siteDataDb?: { databaseName?: unknown };
}

interface CloudflareDeletionMetadata {
    domains?: Record<string, unknown>;
    cloudflareHost?: { domains?: Record<string, unknown>; dns?: { zoneId?: unknown; zoneName?: unknown } };
    cloudflare?: { staging?: CloudflareDeletionSnapshot; prod?: CloudflareDeletionSnapshot };
}

export function cloudflareProjectDeletionResourceNames(
    project: { metadata?: CloudflareDeletionMetadata } | null | undefined,
    details: { environments?: CloudflareDeletionEnvironment[]; resources?: CloudflareDeletionResource[] } | null | undefined,
) {
    const metadata = project?.metadata ?? {};
    const domains = metadata.domains ?? metadata.cloudflareHost?.domains ?? {};
    const environments = Array.isArray(details?.environments) ? details.environments : [];
    const resources = Array.isArray(details?.resources) ? details.resources : [];
    const byEnvironment = new Map(environments.map((entry) => [entry.environment, entry] as const));
    const resourceValues = (kind) => resources
        .filter((resource) => resource.provider === 'cloudflare' && resource.resourceKind === kind)
        .map((resource) => resource.locator ?? resource.metadata?.name ?? resource.metadata?.projectName ?? null)
        .filter(Boolean);
    const staging = byEnvironment.get('staging');
    const prod = byEnvironment.get('prod');
    return {
        accountId: staging?.cloudflareAccountId ?? prod?.cloudflareAccountId ?? metadata.cloudflare?.staging?.accountId ?? metadata.cloudflare?.prod?.accountId ?? null,
        zoneId: domains.zoneId ?? metadata.cloudflareHost?.dns?.zoneId ?? null,
        zoneName: domains.zoneName ?? metadata.cloudflareHost?.dns?.zoneName ?? null,
        domains: [...new Set([
                domains.stagingDomain,
                domains.productionDomain,
                staging?.metadata?.siteUrl,
                prod?.metadata?.siteUrl,
                staging?.baseUrl,
                prod?.baseUrl,
            ].map(projectDeletionHostname).filter(Boolean))],
        pagesProjects: [...new Set([
                staging?.pagesProjectName,
                prod?.pagesProjectName,
                metadata.cloudflare?.staging?.pages?.projectName,
                metadata.cloudflare?.prod?.pages?.projectName,
                ...resourceValues('pages'),
            ].filter(Boolean))],
        workers: [...new Set([
                staging?.workerName,
                prod?.workerName,
                metadata.cloudflare?.staging?.workerName,
                metadata.cloudflare?.prod?.workerName,
                ...resourceValues('worker'),
            ].filter(Boolean))],
        turnstileWidgets: uniqueCloudflareKvNamespaceReferences([
            metadata.cloudflare?.staging?.turnstileWidget,
            metadata.cloudflare?.prod?.turnstileWidget,
            ...resources
                .filter((resource) => resource.provider === 'cloudflare' && ['turnstile', 'turnstile-widget'].includes(resource.resourceKind))
                .map((resource) => ({
                ...(resource.metadata ?? {}),
                locator: resource.locator,
                logicalName: resource.logicalName,
            })),
        ]).map((entry) => ({
            sitekey: entry.id,
            name: entry.name,
            binding: entry.binding,
        })),
        kvNamespaces: uniqueCloudflareKvNamespaceReferences([
            metadata.cloudflare?.staging?.formGuardKv,
            metadata.cloudflare?.prod?.formGuardKv,
            metadata.cloudflare?.staging?.kvNamespaces?.FORM_GUARD_KV,
            metadata.cloudflare?.prod?.kvNamespaces?.FORM_GUARD_KV,
            ...resources
                .filter((resource) => resource.provider === 'cloudflare' && ['kv', 'kv_namespace', 'kv-namespace'].includes(resource.resourceKind))
                .map((resource) => ({
                ...(resource.metadata ?? {}),
                locator: resource.locator,
                logicalName: resource.logicalName,
            })),
        ]),
        buckets: [...new Set([
                staging?.r2BucketName,
                prod?.r2BucketName,
                metadata.cloudflare?.staging?.content?.bucketName,
                metadata.cloudflare?.prod?.content?.bucketName,
                ...resourceValues('r2'),
            ].filter(Boolean))],
        databases: [...new Set([
                staging?.d1DatabaseName,
                prod?.d1DatabaseName,
                metadata.cloudflare?.staging?.siteDataDb?.databaseName,
                metadata.cloudflare?.prod?.siteDataDb?.databaseName,
                ...resources
                    .filter((resource) => resource.provider === 'cloudflare' && resource.resourceKind === 'd1')
                    .map((resource) => resource.metadata?.databaseName ?? resource.locator)
                    .filter(Boolean),
            ].filter(Boolean))],
    };
}
export async function resolveProjectDeletionCloudflareZone({ token, names }) {
    if (names.zoneId)
        return names.zoneId;
    if (!names.zoneName)
        return null;
    const payload = await cloudflareRequestForProjectDeletion({
        token,
        path: `/zones?name=${encodeURIComponent(names.zoneName)}&per_page=1`,
    });
    return payload?.result?.[0]?.id ?? null;
}
export async function deleteCloudflareDnsRecordsForProject({ token, zoneId, name }) {
    if (!zoneId || !name)
        return [projectDeletionOperation('cloudflare', 'dns-record', name, 'missing')];
    const listed = await cloudflareRequestForProjectDeletion({
        token,
        path: `/zones/${encodeURIComponent(zoneId)}/dns_records?name=${encodeURIComponent(name)}&per_page=100`,
    });
    const records = Array.isArray(listed?.result) ? listed.result : [];
    if (records.length === 0)
        return [projectDeletionOperation('cloudflare', 'dns-record', name, 'missing', { zoneId })];
    return Promise.all(records.map(async (record) => {
        await cloudflareRequestForProjectDeletion({
            token,
            method: 'DELETE',
            path: `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(record.id)}`,
        });
        return projectDeletionOperation('cloudflare', 'dns-record', record.name ?? name, 'deleted', { zoneId });
    }));
}
export async function listCloudflareNamedResources({ token, accountId, path, name }) {
    if (!accountId || !name)
        return [];
    const payload = await cloudflareRequestForProjectDeletion({
        token,
        path: `/accounts/${encodeURIComponent(accountId)}${path}`,
    });
    return (Array.isArray(payload?.result) ? payload.result : [])
        .filter((entry) => entry?.name === name || entry?.queue_name === name || entry?.title === name);
}
export async function deleteCloudflareProjectResources({ token, accountId, zoneId, names }) {
    const operations = [];
    if (!accountId) {
        return [projectDeletionOperation('cloudflare', 'account', null, 'blocked', { reason: 'missing_cloudflare_account_id' })];
    }
    for (const pagesProject of names.pagesProjects) {
        const result = await cloudflareRequestForProjectDeletion({
            token,
            method: 'DELETE',
            path: `/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(pagesProject)}`,
        });
        operations.push(projectDeletionOperation('cloudflare', 'pages-project', pagesProject, result?.missing ? 'missing' : 'deleted'));
    }
    for (const worker of names.workers) {
        const result = await cloudflareRequestForProjectDeletion({
            token,
            method: 'DELETE',
            path: `/accounts/${encodeURIComponent(accountId)}/workers/services/${encodeURIComponent(worker)}`,
        });
        operations.push(projectDeletionOperation('cloudflare', 'worker', worker, result?.missing ? 'missing' : 'deleted'));
    }
    for (const widget of names.turnstileWidgets ?? []) {
        const widgetName = widget.name ?? widget.sitekey;
        let sitekey = widget.sitekey ?? null;
        if (!sitekey && widget.name) {
            const matches = await listCloudflareNamedResources({
                token,
                accountId,
                path: '/challenges/widgets?per_page=100',
                name: widget.name,
            });
            sitekey = matches[0]?.sitekey ?? null;
        }
        if (!sitekey) {
            operations.push(projectDeletionOperation('cloudflare', 'turnstile-widget', widgetName, 'missing'));
            continue;
        }
        const result = await cloudflareRequestForProjectDeletion({
            token,
            method: 'DELETE',
            path: `/accounts/${encodeURIComponent(accountId)}/challenges/widgets/${encodeURIComponent(sitekey)}`,
        });
        operations.push(projectDeletionOperation('cloudflare', 'turnstile-widget', widgetName, result?.missing ? 'missing' : 'deleted', { sitekey }));
    }
    for (const namespace of names.kvNamespaces ?? []) {
        const namespaceName = namespace.name ?? namespace.id;
        let namespaceId = namespace.id ?? null;
        if (!namespaceId && namespace.name) {
            const matches = await listCloudflareNamedResources({
                token,
                accountId,
                path: '/storage/kv/namespaces?per_page=1000&order=title&direction=asc',
                name: namespace.name,
            });
            namespaceId = matches[0]?.id ?? null;
        }
        if (!namespaceId) {
            operations.push(projectDeletionOperation('cloudflare', 'kv-namespace', namespaceName, 'missing', { binding: namespace.binding ?? null }));
            continue;
        }
        const result = await cloudflareRequestForProjectDeletion({
            token,
            method: 'DELETE',
            path: `/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces/${encodeURIComponent(namespaceId)}`,
        });
        operations.push(projectDeletionOperation('cloudflare', 'kv-namespace', namespaceName, result?.missing ? 'missing' : 'deleted', {
            id: namespaceId,
            binding: namespace.binding ?? null,
        }));
    }
    for (const bucket of names.buckets) {
        const result = await cloudflareRequestForProjectDeletion({
            token,
            method: 'DELETE',
            path: `/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucket)}`,
        });
        operations.push(projectDeletionOperation('cloudflare', 'r2-bucket', bucket, result?.missing ? 'missing' : 'deleted'));
    }
    for (const database of names.databases) {
        const matches = await listCloudflareNamedResources({ token, accountId, path: '/d1/database', name: database });
        if (matches.length === 0) {
            operations.push(projectDeletionOperation('cloudflare', 'd1-database', database, 'missing'));
            continue;
        }
        for (const match of matches) {
            const result = await cloudflareRequestForProjectDeletion({
                token,
                method: 'DELETE',
                path: `/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(match.uuid ?? match.id)}`,
            });
            operations.push(projectDeletionOperation('cloudflare', 'd1-database', database, result?.missing ? 'missing' : 'deleted'));
        }
    }
    for (const queue of names.queues) {
        const matches = await listCloudflareNamedResources({ token, accountId, path: '/queues', name: queue });
        if (matches.length === 0) {
            operations.push(projectDeletionOperation('cloudflare', 'queue', queue, 'missing'));
            continue;
        }
        for (const match of matches) {
            const result = await cloudflareRequestForProjectDeletion({
                token,
                method: 'DELETE',
                path: `/accounts/${encodeURIComponent(accountId)}/queues/${encodeURIComponent(match.queue_id ?? match.id)}`,
            });
            operations.push(projectDeletionOperation('cloudflare', 'queue', queue, result?.missing ? 'missing' : 'deleted'));
        }
    }
    for (const domain of names.domains) {
        operations.push(...await deleteCloudflareDnsRecordsForProject({ token, zoneId, name: domain }));
    }
    return operations;
}
export function cloudflareDnsDomainsForHostValidation(host) {
    const dns = host?.metadata?.dns && typeof host.metadata.dns === 'object' ? host.metadata.dns : {};
    const zoneName = normalizeDomainName(dns.zoneName ?? dns.rootZone ?? dns.zone);
    const zoneId = optionalTrimmedString(dns.zoneId);
    const manageDns = dns.managed !== false && Boolean(zoneName || zoneId);
    return {
        zoneName,
        zoneId,
        manageDns,
    };
}

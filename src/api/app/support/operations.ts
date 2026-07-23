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
import { jsonError, jsonThrownError, POSTGRES_AUTH_PROVIDER_ID, availabilityAttempts, AUTH_PROVIDERS, providerJwksCache, availabilityRateLimit, personalThemeFromRow, accountDeletionBlockers, consumeReauthentication, loadNotificationPreferences, providerConfigFor, base64Url, verifyProviderIdToken, exchangeProviderIdentity, resolveLaunchTemplateRequirements, projectHostBindingMetadata, sourceFromProjectDetails, repositoryInventoryWithPlatform, loadProjectHostBindingContext, projectHostResponsePayload, hostBindingRequiresUnlock, hostKindForBinding, createProjectHostCredentialSessions, persistProjectHostBindingOperationMetadata, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, plaintextHostCredentialFieldPaths, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, markdownToPlainProjectSummary, parseBooleanEnvValue, shouldLogApiRequests, shouldExposeNonProductionAuthDiagnostics, SENSITIVE_QUERY_PARAM_PATTERN, redactedRequestTarget, installApiRequestLogger, readJsonOrFormBody, normalizeEmail, normalizeUsername, parseJsonObject, trimmedHeaderValue, requestClientIp, requestSessionMetadata, webSessionData, validateMarketPassword, hashMarketPassword, verifyMarketPassword, ensureMarketCredentialSchema, MARKET_EMAIL_CONFIRMATION_PREFIX, marketAuthContext, shouldBypassAcceptanceAuthEmailDelivery, marketEmailTokenHash, exposeAuthTokenForTests, authTokenTimestampSeconds, authTokenTimestampMillis, sanitizedReturnTo, confirmationUrlFor, teamInviteAcceptUrlFor, passwordResetUrlFor, sendTeamInviteEmail, createMarketEmailConfirmation, serializeUserEmailAddress, backfillUserEmailAddresses, listUserEmailAddresses, getUserEmailAddress, verifiedEmailCount, setPrimaryEmailAddress, syncPrimaryEmailCaches, createOrResendUserEmailAddress, createMarketWebSession, webAuthPayload, normalizeAppearancePreference, normalizeBaseUrl, normalizeDomainName, normalizeProjectDomainInput, inferZoneNameForDomain, domainInZone, optionalTrimmedString, enumValue, unknownKeys, LOCAL_CONTENT_COLLECTIONS, LOCAL_WORK_CONTENT_COLLECTIONS, LOCAL_CONTENT_DEFAULTS, slugifyContent, yamlScalar, yamlLines, serializeFrontmatter, normalizeRelationArray, uniqueRelationArray, addRelationValue, normalizeLocalContentInput, writeLocalContentRecord, localContentRoot, localContentPath, readLocalContentRecord, writeParsedLocalContentRecord, createRelatedLocalContentRecord, isLoopbackUrl, resolveAuthApprovalBaseUrl, findById, resolveAgentArtifactBucket, centralMarketProfile, normalizeMarketProfile, encryptedHostPayloadLooksValid, decryptedHostConfigSummary, credentialSessionSecret, credentialSessionKey, encryptCredentialSessionPayload, decryptCredentialSessionPayload, normalizeProviderCredentialConfig, HOST_KIND_SESSION_KEYS, normalizeAuditHostKinds, providerCredentialValuesForAudit, collectHostingAuditCredentialOverlay, nonSecretLaunchJobInput, decryptTeamHostForLaunch, mergeStringConfig, buildLaunchCredentialOverlay, patchLaunchIntentForCredentialOverlay, appendLaunchDeploymentEvent, scheduleBackgroundBootstrap, sanitizeLaunchResultForStorage, cloudflareErrorMessage, cloudflareRequestForLaunchPreflight, resolveCloudflareZoneForLaunchPreflight, verifyCloudflareDnsWriteForLaunch, projectDeletionConfirmationMatches, projectDeletionBlockerRows, cloudflareRequestForProjectDeletion, githubRequestForProjectDeletion, projectDeletionOperation, cloudflareDeletionAuthenticationMessage, hasRecordedCloudflareRuntimeResources, canSkipCloudflareCleanupAfterFailedLaunch, projectDeletionHostname, normalizedCloudflareKvNamespaceReference, uniqueCloudflareKvNamespaceReferences, cloudflareProjectDeletionResourceNames, resolveProjectDeletionCloudflareZone, deleteCloudflareDnsRecordsForProject, listCloudflareNamedResources, deleteCloudflareProjectResources, appendProjectDeletionProgress, cloudflareDnsDomainsForHostValidation, validateTeamHostCredentialPayload, runProjectLaunchApiBootstrap, runProjectDeletionApiDestroy, retryApiLaunchBootstrapFromRequest, GITHUB_ACTIONS_OIDC_ISSUER, githubOidcJwksCache, base64urlJson, parseBase64urlJson, loadGitHubOidcJwks, verifyGitHubOidcToken, fallbackRemoteCapability, normalizeRepositorySlug, projectAllowedCiRepositories, marketProfilesForTeams, artifactDownloadPayload, localAcceptanceAdminToken, localAcceptanceAuthEnabled, safeTokenEquals, resolvePlatformRepositoryDescriptor, mergeCapability, canonicalArchitectureTopology, launchPlannerRepositoryTopology, launchCapabilityPreset, resourceRowsFromLaunch, resolveUiProjectionContext, decodeRouteParam, uiRuntimeLocals, requireConfiguredServiceCredential, resolvePublicTreeDxTeam, enqueueTreeDxProvisionOperation, requireTeamAccess, requireProjectAccess, safePrivateKnowledgeSlug, privateKnowledgeAuditPayload, recordPrivateKnowledgeAudit, FEEDBACK_TYPES, FEEDBACK_SCREENSHOT_TYPES, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, cleanFeedbackString, safeFeedbackContext, safeFeedbackClient, safeFeedbackScreenshot, validateFeedbackAccess, recordFeedbackSubmission, normalizeSeedEnvironments, seedActor, seedExistingTeamIds, seedCreatesMissingTeams, requireSeedPlanAccess, requireSeedApplyAccess, requireProjectRunner, AGENT_TASK_SIGNATURES, resolveAgentTaskSignature, commerceErrorResponse, stripeConfiguredError, stripeVendorApprovalError, stripeAccountMissingError, stripeCommerceUrl, requireCommerceVendorForStripe, refreshCommerceStripeAccount, STRIPE_PRODUCT_MIRROR_OFFER_MODES, STRIPE_PRICE_MIRROR_OFFER_MODES, stripeMetadataValue, buildCommerceStripeMetadata, commerceStripeProductParams, commerceStripeLookupKey, commerceStripePriceParams, stripePriceTermsDrift, commerceStripeSyncContext, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, CHECKOUT_OFFER_MODES, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, resolveStripePublishableKey, resolveStripeWebhookSecret, commerceCheckoutError, normalizeCheckoutQuantity, stripeClientSecret, paymentGroupStatusFromPaymentIntent, orderStatusFromPaymentGroup, subscriptionStatusFromStripe, entitlementRenewalStateFromSubscription, stripeTimestampToIso, subscriptionClientSecret, publicPaymentGroups, buildCommerceCheckoutMetadata, resolveCommerceCheckoutItem, checkoutGroupKind, checkoutGroupKey, checkoutGroupStatus, grantCommerceEntitlementsForOrder, requireSellerTeamAccess, requireVendorOrderManager, requireServiceBuyerAccess, requireServiceSellerAccess, redactCommerceServiceRequestForBuyer, requireCommerceCapacityListingAccess, requireCommerceCapacityInquiryAccess, remainingRefundableAmount, stripeRefundStatus, applyCommerceRefundState, resolveOrderItemForRefund, resolveFulfillmentArtifact, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, ensureCommerceStripeCustomer, refreshCommercePaymentGroupState, updateCheckoutCompletionFromGroup, syncCommerceSubscriptionFromStripe, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, handleCommerceInvoiceWebhook, processCommerceStripeWebhook, requireCommerceProductAccess, principalCanManageCommerceProduct, redactCommerceOwnershipWorkflow, requireCommerceOfferAccess, requireCatalogItemAccess, requireConnectedProjectRuntime, projectAppHref, unwrapLaunchOperationOutput, appendLaunchPhaseProjection, updateLaunchDeployments, hubRepositoryPolicies, applyHubLaunchResult, applyHubLaunchFailure, applyContentPublishResult, executeInline, projectApiConnection, createProjectInternalClient, executeProjectApi, selectDispatchTarget, defaultConfig, createApiExtension } from './index.ts';
export const AGENT_PROMOTION_APPROVAL_DECISIONS = new Set([
    'approve',
    'approve_as_book_content',
    'request_changes',
    'request_more_research',
    'defer',
    'reject',
    'approve_release',
    'reject_release',
]);
export const LOCAL_DECISION_TYPE_VALUES = ['approved', 'rejected', 'deferred', 'request_changes', 'superseded'];
export const PROPOSAL_VERDICT_DECISION_TYPES = new Set(['approved', 'rejected', 'deferred', 'request_changes']);
export const PLATFORM_OPERATION_SCOPES = [
    'platform:runners:register',
    'platform:runners:claim',
    'platform:runners:update',
    'platform:operations:create',
    'platform:operations:read',
    'platform:operations:cancel',
    'platform:operations:retry',
    'platform:repository:write',
    'platform:deploy:write',
    'platform:database:migrate',
];
export async function createDecisionFromProposals(input) {
    const proposalSlugs = [...new Set(normalizeRelationArray(input.proposalSlugs))];
    if (proposalSlugs.length === 0)
        return { error: 'Select at least one proposal.' };
    for (const slug of proposalSlugs) {
        if (!slug || slugifyContent(slug) !== slug)
            return { error: 'Unsafe proposal slug.' };
    }
    const decisionType = enumValue(input.decisionType, [...PROPOSAL_VERDICT_DECISION_TYPES], null);
    if (!decisionType)
        return { error: 'Unsupported proposal verdict.' };
    const reason = optionalTrimmedString(input.reason) ?? optionalTrimmedString(input.rationale);
    if (!reason)
        return { error: 'A decision reason is required.' };
    const title = optionalTrimmedString(input.title) ?? `Decision for ${proposalSlugs.length === 1 ? proposalSlugs[0] : `${proposalSlugs.length} proposals`}`;
    const decisionSlug = slugifyContent(input.slug || title);
    if (!decisionSlug)
        return { error: 'A safe decision slug is required.' };
    const decisionTarget = localContentPath('decisions', decisionSlug, 'mdx');
    if (!decisionTarget)
        return { error: 'Unsafe decision path.' };
    if (existsSync(decisionTarget))
        return { error: 'A decision with that slug already exists.' };
    const proposals = [];
    for (const slug of proposalSlugs) {
        const proposal = await readLocalContentRecord('proposals', slug);
        if (proposal.error)
            return { error: `Proposal ${slug} was not found.` };
        proposals.push(proposal);
    }
    const proposalTitles = proposals.map((proposal) => proposal.frontmatter.title ?? proposal.slug);
    const body = optionalTrimmedString(input.body)
        ?? [
            `## Verdict`,
            decisionType.replace(/_/gu, ' '),
            ``,
            `## Reason`,
            reason,
            ``,
            `## Proposals`,
            ...proposalTitles.map((proposalTitle, index) => `- ${proposalTitle} (${proposalSlugs[index]})`),
        ].join('\n');
    const decisionPayload = await writeLocalContentRecord('decisions', {
        ...input,
        slug: decisionSlug,
        title,
        status: 'live',
        decisionType,
        description: optionalTrimmedString(input.description) ?? reason,
        summary: optionalTrimmedString(input.summary) ?? reason,
        rationale: reason,
        relatedProposals: proposalSlugs,
        body,
    });
    if ('error' in decisionPayload && decisionPayload.error)
        return decisionPayload;
    const writtenProposals = [];
    const originalProposals = proposals.map((proposal) => ({
        ...proposal,
        frontmatter: { ...proposal.frontmatter },
        body: proposal.body,
    }));
    try {
        for (const proposal of proposals) {
            proposal.frontmatter.decision = decisionSlug;
            await writeParsedLocalContentRecord(proposal);
            writtenProposals.push(proposal);
        }
    }
    catch (error) {
        await rm(decisionTarget, { force: true }).catch(() => { });
        for (const original of originalProposals.slice(0, writtenProposals.length)) {
            await writeParsedLocalContentRecord(original).catch(() => { });
        }
        return {
            error: 'Decision content was created but proposals could not be linked; changes were rolled back.',
            details: error instanceof Error ? error.message : String(error),
        };
    }
    return {
        decision: decisionPayload,
        proposals: proposalSlugs.map((slug) => ({ collection: 'proposals', slug, href: `/app/work/proposals/${encodeURIComponent(slug)}` })),
        href: 'href' in decisionPayload ? decisionPayload.href : null,
    };
}
export function operationTokenSecret(runtime) {
    return runtime?.resolved?.config?.assertionSecret
        ?? runtime?.resolved?.config?.authSecret
        ?? process.env.TREESEED_MARKET_OPERATION_TOKEN_SECRET
        ?? process.env.TREESEED_AUTH_SECRET
        ?? 'treeseed-local-operation-token-secret';
}
export function signOperationToken(runtime, payload) {
    const body = base64urlJson(payload);
    const signature = createHmac('sha256', operationTokenSecret(runtime)).update(body).digest('base64url');
    return `${body}.${signature}`;
}
export function verifyOperationToken(runtime, token) {
    const [body, signature] = String(token ?? '').split('.');
    if (!body || !signature) {
        throw new Error('Invalid operation token.');
    }
    const expected = createHmac('sha256', operationTokenSecret(runtime)).update(body).digest('base64url');
    const providedBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) {
        throw new Error('Invalid operation token signature.');
    }
    const payload = parseBase64urlJson(body);
    if (!payload.exp || Number(payload.exp) <= Math.floor(Date.now() / 1000)) {
        throw new Error('Operation token expired.');
    }
    return payload;
}
export function normalizeCiEnvironment(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    return normalized === 'prod' || normalized === 'production' ? 'prod' : 'staging';
}
export function ciOperationForAction(actionKind) {
    switch (String(actionKind ?? 'deploy_web')) {
        case 'publish_content':
            return { namespace: 'content', operation: 'publish' };
        case 'monitor':
            return { namespace: 'workflow', operation: 'verify_runtime' };
        case 'deploy_web':
        default:
            return { namespace: 'workflow', operation: 'deploy_runtime' };
    }
}
export function validateCiRefForEnvironment(environment, claims) {
    const ref = String(claims.ref ?? '');
    if (environment === 'prod') {
        return ref === 'refs/heads/main' || ref.startsWith('refs/tags/');
    }
    return ref === 'refs/heads/staging';
}
export function principalHasPermission(principal, permission) {
    return Boolean(principal
        && (principal.permissions?.includes?.('*:*:*')
            || principal.permissions?.includes?.(permission)));
}
export function principalIsSeedAdmin(principal) {
    return Boolean(principal
        && (principal.permissions?.includes?.('*:*:*')
            || principal.permissions?.includes?.('seeds:apply:global')
            || principal.roles?.includes?.('platform_admin')
            || principal.roles?.includes?.('market_admin')));
}
export function isTeamApiPrincipal(principal) {
    return Boolean(principal?.roles?.includes?.('team_api_key'));
}
export function isLocalAcceptanceServicePrincipal(c, principal) {
    return c.get('actorType') === 'service'
        && principal?.metadata?.localAcceptance === true
        && principalHasPermission(principal, '*:*:*');
}
export function decorateJob(baseUrl, job) {
    if (!job)
        return null;
    return {
        ...job,
        pollUrl: `${baseUrl}/v1/jobs/${job.id}`,
        streamUrl: `${baseUrl}/v1/jobs/${job.id}/events`,
    };
}
export function safePlatformOperationOutput(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return value ?? null;
    const output = { ...value };
    if (typeof output.repositoryPath === 'string') {
        output.repositoryPath = output.repositoryPath.includes('/repositories/') ? '/data/repositories/<repository>/repo' : '<runner-workspace>';
    }
    if (typeof output.workspacePath === 'string') {
        output.workspacePath = output.workspacePath.includes('/data') ? '/data' : '<runner-workspace>';
    }
    if (output.repository && typeof output.repository === 'object' && !Array.isArray(output.repository)) {
        output.repository = {
            ...output.repository,
            cloneUrl: typeof output.repository.cloneUrl === 'string' && output.repository.cloneUrl.startsWith('http')
                ? output.repository.cloneUrl.replace(/\/\/[^/@]+@/u, '//<redacted>@')
                : output.repository.cloneUrl,
        };
    }
    return output;
}
export function decoratePlatformOperation(baseUrl, operation) {
    if (!operation)
        return null;
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl ?? '');
    const navigation = derivePlatformOperationNavigation(operation);
    const safeOutput = safePlatformOperationOutput(operation.output);
    return {
        ...operation,
        output: safeOutput,
        pollUrl: `${normalizedBaseUrl}/v1/platform/operations/${operation.id}`,
        streamUrl: `${normalizedBaseUrl}/v1/platform/operations/${operation.id}/events`,
        terminal: isPlatformOperationTerminal(operation),
        navigation,
        href: navigation.href,
        changedPaths: navigation.changedPaths,
        branch: navigation.branch,
        commitSha: navigation.commitSha,
    };
}
export function resolvePlatformRunnerSecret(config) {
    return optionalTrimmedString(config.platformRunnerSecret)
        ?? optionalTrimmedString(config.operationsRunnerSecret)
        ?? optionalTrimmedString(process.env.TREESEED_PLATFORM_RUNNER_SECRET)
        ?? optionalTrimmedString(process.env.TREESEED_MARKET_OPERATIONS_RUNNER_SECRET);
}
export function platformOperationMutationError(c, error) {
    const status = Number(error?.status ?? 500);
    if (![400, 404, 409].includes(status))
        throw error;
    return jsonError(c, status, error instanceof Error ? error.message : String(error), error?.details ?? {});
}
export async function requirePlatformRunner(c, config) {
    const token = bearerTokenFromRequest(c.req.raw);
    const secret = resolvePlatformRunnerSecret(config);
    if (!token || !secret) {
        return {
            response: jsonError(c, 401, 'Platform runner service credential required.'),
        };
    }
    if (!safeTokenEquals(token, secret)) {
        return {
            response: jsonError(c, 401, 'Invalid platform runner service credential.'),
        };
    }
    return {
        principal: {
            id: 'platform-runner',
            roles: ['platform_runner'],
            permissions: [...PLATFORM_OPERATION_SCOPES],
            scopes: [...PLATFORM_OPERATION_SCOPES],
        },
    };
}
export async function ensurePrincipal(c) {
    const principal = c.get('principal');
    if (!principal) {
        return {
            response: jsonError(c, 401, 'Authentication required.'),
        };
    }
    return { principal };
}
export function principalHasGlobalPlatformRole(principal) {
    return Boolean(principal?.roles?.includes?.('platform_admin')
        || principal?.roles?.includes?.('market_admin')
        || principal?.permissions?.includes?.('*:*:*'));
}
export async function requireServiceParticipantAccess(c, store, request, sellerPermission = 'projects:read:team') {
    const auth = await ensurePrincipal(c);
    if (auth.response)
        return auth;
    if (principalIsSeedAdmin(auth.principal))
        return auth;
    if (request?.sellerTeamId) {
        const seller = await requireTeamAccess(c, store, request.sellerTeamId, sellerPermission);
        if (!seller.response)
            return seller;
    }
    if (request?.buyerTeamId) {
        const buyer = await requireTeamAccess(c, store, request.buyerTeamId, 'projects:read:team');
        if (!buyer.response)
            return buyer;
    }
    if (request?.buyerUserId && request.buyerUserId === auth.principal.id)
        return auth;
    return { response: jsonError(c, 403, 'Permission denied.', { requestId: request?.id ?? null }) };
}
export function unwrapOperationPayload(output) {
    if (!output || typeof output !== 'object')
        return null;
    if (output.payload && typeof output.payload === 'object')
        return output.payload;
    return output;
}

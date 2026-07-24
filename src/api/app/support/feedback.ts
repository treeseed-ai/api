import type { Hono } from 'hono';
import { AgentSdk, RemoteClient, RemoteOperationsClient, RemoteSdkClient, signEditorialPreviewToken, OperationsSdk, executeSdkOperation, findDispatchCapability, planKnowledgeHubLaunch, derivePlatformOperationNavigation, deriveProjectHostBindingsView, isPlatformOperationTerminal, normalizeProjectLaunchHostBindings, normalizePlatformContentInput as normalizeRepositoryContentInput, normalizePlatformRelationArray as normalizeRepositoryRelationArray, platformContentRelationPolicy as repositoryContentRelationPolicy, normalizeTemplateLaunchRequirements, normalizeTemplateId, planProjectHostBindingOperation, resolveProjectLaunchHostBindings, slugifyPlatformContent as slugifyRepositoryContent, } from '@treeseed/sdk';
import { runHostingAudit } from '@treeseed/sdk/workflow-support';
import { createApiApp as createSdkApiApp, D1AuthProvider as DatabaseAuthProvider, loadTemplateCatalog, resolveApiConfig, } from '@treeseed/sdk/api';
import { MarketControlPlaneStore, validateProjectSlug } from '../../persistence/store.js';
import { createClientEncryptedEscrowService } from '../../support/client-encrypted-escrow.ts';
import { createGitHubAppAdapter } from '../../reconciliation/github-app-adapter.ts';
import { createGitHubActionsSecretEnclave } from '../../configuration/github-actions-secret-enclave.ts';
import { bearerTokenFromRequest } from '../../accounts/request-auth.ts';
import { createTreeDxCredentialBridge } from '../../treedx/repositories/treedx-credential-bridge.ts';
import { createMarketPostgresDatabase } from '../../support/market-postgres.js';
import { installProjectDeploymentRoutes } from '../../projects/deployments/project-deployment-routes.js';
import { installCapacityRoutes } from '../../capacity/routes/index.ts';
import { createCapacityControlPlane } from '../../capacity/control-plane.ts';
import { deleteTeamCapacityAggregate } from '../../capacity/services/teams/team-deletion-service.ts';
import { readCapacityRequestObject } from '../../capacity/routes/support/request-json.ts';
import { createStripeConnectService, resolveStripeEnvironment, stripeAccountToConnectedAccountPatch } from '../../commerce/commerce-core/stripe-connect.js';
import { applySeedWithStore, exportSeedWithStore, planSeedWithStore } from '../../../market/seeds/apply.js';
import { buildGovernanceApprovalProjection, buildGovernanceProjection } from '../../../market/projects/projects-core/governance-projection.js';
import { buildInfrastructureProjection } from '../../../market/projects/hosting/infrastructure-projection.js';
import { loadInfrastructureSeedState } from '../../../market/seeds/infrastructure-seeds.js';
import { buildKnowledgeArtifactProjection, buildKnowledgeProjection } from '../../../market/projects/knowledge/knowledge-projection.js';
import { buildWorkdayProjection } from '../../../market/capacity/workdays/workday-projection.js';
import { loadKnowledgeContentEntries } from '../../../view-models/knowledge-content.js';
import { listManagedHostsFromConfig, managedCloudflareConfigMissing, resolveManagedCloudflareHostConfigFromConfig, } from '../../../market/hosting/managed-hosts.js';
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
import { contentRelationPolicy } from '../../../market/content/content-relations.js';
import { NOTIFICATION_CONTENT_CAPABILITIES, PERSONAL_THEME_COMPILER_VERSION, isValidPersonalThemeDraft, normalizeNotificationPreferences, } from '@treeseed/sdk/account-contracts';
import { jsonError, jsonThrownError, POSTGRES_AUTH_PROVIDER_ID, availabilityAttempts, AUTH_PROVIDERS, providerJwksCache, availabilityRateLimit, personalThemeFromRow, accountDeletionBlockers, consumeReauthentication, loadNotificationPreferences, providerConfigFor, base64Url, verifyProviderIdToken, exchangeProviderIdentity, resolveLaunchTemplateRequirements, projectHostBindingMetadata, sourceFromProjectDetails, repositoryInventoryWithPlatform, loadProjectHostBindingContext, projectHostResponsePayload, hostBindingRequiresUnlock, hostKindForBinding, createProjectHostCredentialSessions, persistProjectHostBindingOperationMetadata, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, plaintextHostCredentialFieldPaths, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, markdownToPlainProjectSummary, parseBooleanEnvValue, shouldLogApiRequests, shouldExposeNonProductionAuthDiagnostics, SENSITIVE_QUERY_PARAM_PATTERN, redactedRequestTarget, installApiRequestLogger, AGENT_PROMOTION_APPROVAL_DECISIONS, readJsonOrFormBody, normalizeEmail, normalizeUsername, parseJsonObject, trimmedHeaderValue, requestClientIp, requestSessionMetadata, webSessionData, validateMarketPassword, hashMarketPassword, verifyMarketPassword, ensureMarketCredentialSchema, MARKET_EMAIL_CONFIRMATION_PREFIX, marketAuthContext, shouldBypassAcceptanceAuthEmailDelivery, marketEmailTokenHash, exposeAuthTokenForTests, authTokenTimestampSeconds, authTokenTimestampMillis, sanitizedReturnTo, confirmationUrlFor, teamInviteAcceptUrlFor, passwordResetUrlFor, sendTeamInviteEmail, createMarketEmailConfirmation, serializeUserEmailAddress, backfillUserEmailAddresses, listUserEmailAddresses, getUserEmailAddress, verifiedEmailCount, setPrimaryEmailAddress, syncPrimaryEmailCaches, createOrResendUserEmailAddress, createMarketWebSession, webAuthPayload, normalizeAppearancePreference, normalizeBaseUrl, normalizeDomainName, normalizeProjectDomainInput, inferZoneNameForDomain, domainInZone, optionalTrimmedString, enumValue, unknownKeys, LOCAL_CONTENT_COLLECTIONS, LOCAL_WORK_CONTENT_COLLECTIONS, LOCAL_DECISION_TYPE_VALUES, PROPOSAL_VERDICT_DECISION_TYPES, PLATFORM_OPERATION_SCOPES, LOCAL_CONTENT_DEFAULTS, slugifyContent, yamlScalar, yamlLines, serializeFrontmatter, normalizeRelationArray, uniqueRelationArray, addRelationValue, normalizeLocalContentInput, writeLocalContentRecord, localContentRoot, localContentPath, readLocalContentRecord, writeParsedLocalContentRecord, createRelatedLocalContentRecord, createDecisionFromProposals, isLoopbackUrl, resolveAuthApprovalBaseUrl, findById, resolveAgentArtifactBucket, centralMarketProfile, normalizeMarketProfile, encryptedHostPayloadLooksValid, decryptedHostConfigSummary, credentialSessionSecret, credentialSessionKey, encryptCredentialSessionPayload, decryptCredentialSessionPayload, normalizeProviderCredentialConfig, HOST_KIND_SESSION_KEYS, normalizeAuditHostKinds, providerCredentialValuesForAudit, collectHostingAuditCredentialOverlay, nonSecretLaunchJobInput, decryptTeamHostForLaunch, mergeStringConfig, buildLaunchCredentialOverlay, patchLaunchIntentForCredentialOverlay, appendLaunchDeploymentEvent, scheduleBackgroundBootstrap, sanitizeLaunchResultForStorage, cloudflareErrorMessage, cloudflareRequestForLaunchPreflight, resolveCloudflareZoneForLaunchPreflight, verifyCloudflareDnsWriteForLaunch, projectDeletionConfirmationMatches, projectDeletionBlockerRows, cloudflareRequestForProjectDeletion, githubRequestForProjectDeletion, projectDeletionOperation, cloudflareDeletionAuthenticationMessage, hasRecordedCloudflareRuntimeResources, canSkipCloudflareCleanupAfterFailedLaunch, projectDeletionHostname, normalizedCloudflareKvNamespaceReference, uniqueCloudflareKvNamespaceReferences, cloudflareProjectDeletionResourceNames, resolveProjectDeletionCloudflareZone, deleteCloudflareDnsRecordsForProject, listCloudflareNamedResources, deleteCloudflareProjectResources, appendProjectDeletionProgress, cloudflareDnsDomainsForHostValidation, validateTeamHostCredentialPayload, runProjectLaunchApiBootstrap, runProjectDeletionApiDestroy, retryApiLaunchBootstrapFromRequest, GITHUB_ACTIONS_OIDC_ISSUER, githubOidcJwksCache, base64urlJson, parseBase64urlJson, operationTokenSecret, signOperationToken, verifyOperationToken, loadGitHubOidcJwks, verifyGitHubOidcToken, normalizeCiEnvironment, ciOperationForAction, fallbackRemoteCapability, normalizeRepositorySlug, projectAllowedCiRepositories, validateCiRefForEnvironment, marketProfilesForTeams, artifactDownloadPayload, principalHasPermission, principalIsSeedAdmin, isTeamApiPrincipal, isLocalAcceptanceServicePrincipal, localAcceptanceAdminToken, localAcceptanceAuthEnabled, decorateJob, safePlatformOperationOutput, decoratePlatformOperation, safeTokenEquals, resolvePlatformRunnerSecret, platformOperationMutationError, requirePlatformRunner, resolvePlatformRepositoryDescriptor, mergeCapability, canonicalArchitectureTopology, launchPlannerRepositoryTopology, launchCapabilityPreset, resourceRowsFromLaunch, ensurePrincipal, resolveUiProjectionContext, decodeRouteParam, uiRuntimeLocals, requireConfiguredServiceCredential, resolvePublicTreeDxTeam, enqueueTreeDxProvisionOperation, principalHasGlobalPlatformRole, requireTeamAccess, requireProjectAccess, safePrivateKnowledgeSlug, privateKnowledgeAuditPayload, recordPrivateKnowledgeAudit, normalizeSeedEnvironments, seedActor, seedExistingTeamIds, seedCreatesMissingTeams, requireSeedPlanAccess, requireSeedApplyAccess, requireProjectRunner, AGENT_TASK_SIGNATURES, resolveAgentTaskSignature, commerceErrorResponse, stripeConfiguredError, stripeVendorApprovalError, stripeAccountMissingError, stripeCommerceUrl, requireCommerceVendorForStripe, refreshCommerceStripeAccount, STRIPE_PRODUCT_MIRROR_OFFER_MODES, STRIPE_PRICE_MIRROR_OFFER_MODES, stripeMetadataValue, buildCommerceStripeMetadata, commerceStripeProductParams, commerceStripeLookupKey, commerceStripePriceParams, stripePriceTermsDrift, commerceStripeSyncContext, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, CHECKOUT_OFFER_MODES, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, resolveStripePublishableKey, resolveStripeWebhookSecret, commerceCheckoutError, normalizeCheckoutQuantity, stripeClientSecret, paymentGroupStatusFromPaymentIntent, orderStatusFromPaymentGroup, subscriptionStatusFromStripe, entitlementRenewalStateFromSubscription, stripeTimestampToIso, subscriptionClientSecret, publicPaymentGroups, buildCommerceCheckoutMetadata, resolveCommerceCheckoutItem, checkoutGroupKind, checkoutGroupKey, checkoutGroupStatus, grantCommerceEntitlementsForOrder, requireSellerTeamAccess, requireVendorOrderManager, requireServiceBuyerAccess, requireServiceSellerAccess, requireServiceParticipantAccess, redactCommerceServiceRequestForBuyer, requireCommerceCapacityListingAccess, requireCommerceCapacityInquiryAccess, remainingRefundableAmount, stripeRefundStatus, applyCommerceRefundState, resolveOrderItemForRefund, resolveFulfillmentArtifact, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, ensureCommerceStripeCustomer, refreshCommercePaymentGroupState, updateCheckoutCompletionFromGroup, syncCommerceSubscriptionFromStripe, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, handleCommerceInvoiceWebhook, processCommerceStripeWebhook, requireCommerceProductAccess, principalCanManageCommerceProduct, redactCommerceOwnershipWorkflow, requireCommerceOfferAccess, requireCatalogItemAccess, requireConnectedProjectRuntime, projectAppHref, unwrapLaunchOperationOutput, appendLaunchPhaseProjection, updateLaunchDeployments, hubRepositoryPolicies, applyHubLaunchResult, applyHubLaunchFailure, unwrapOperationPayload, applyContentPublishResult, executeInline, projectApiConnection, createProjectInternalClient, executeProjectApi, selectDispatchTarget, defaultConfig, createApiExtension } from './index.ts';
export const FEEDBACK_TYPES = new Set(['bug', 'feature_suggestion', 'question', 'content_issue', 'ux_issue']);
export const FEEDBACK_SCREENSHOT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
export const MAX_FEEDBACK_MESSAGE_LENGTH = 4000;
export const MAX_FEEDBACK_SCREENSHOT_BYTES = 2 * 1024 * 1024;
export function cleanFeedbackString(value, maxLength = 500) {
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : '';
}
export function safeFeedbackContext(context: any = {}) {
    const shell = ['auth', 'public', 'product'].includes(context.shell) ? context.shell : 'public';
    const surface = ['public', 'personal', 'team', 'project', 'market', 'seller', 'admin'].includes(context.context) ? context.context : 'public';
    const privateScoped = Boolean(context.teamId || context.projectId || surface === 'team' || surface === 'project' || surface === 'admin');
    return {
        url: cleanFeedbackString(context.url, 1200),
        canonicalPath: cleanFeedbackString(context.canonicalPath, 600),
        title: cleanFeedbackString(context.title, 300),
        capabilityId: cleanFeedbackString(context.capabilityId, 160),
        shell,
        context: surface,
        teamId: cleanFeedbackString(context.teamId, 160) || null,
        projectId: cleanFeedbackString(context.projectId, 160) || null,
        resourceType: cleanFeedbackString(context.resourceType, 120) || null,
        resourceId: cleanFeedbackString(context.resourceId, 240) || null,
        userId: cleanFeedbackString(context.userId, 160) || null,
        environment: ['local', 'staging', 'production'].includes(context.environment) ? context.environment : null,
        routePattern: cleanFeedbackString(context.routePattern, 300) || null,
        policy: cleanFeedbackString(context.policy, 80) || null,
        privateScoped,
    };
}
export function safeFeedbackClient(client: any = {}) {
    const viewport = client.viewport && typeof client.viewport === 'object' ? client.viewport : {};
    return {
        url: cleanFeedbackString(client.url, 1200),
        userAgent: cleanFeedbackString(client.userAgent, 500),
        viewport: {
            width: Math.max(0, Math.min(10000, Number(viewport.width) || 0)),
            height: Math.max(0, Math.min(10000, Number(viewport.height) || 0)),
            devicePixelRatio: Math.max(0, Math.min(8, Number(viewport.devicePixelRatio) || 1)),
        },
        locale: cleanFeedbackString(client.locale, 80) || null,
        timeZone: cleanFeedbackString(client.timeZone, 120) || null,
        appearance: cleanFeedbackString(client.appearance, 120) || null,
        reducedMotion: client.reducedMotion === true,
    };
}
export function safeFeedbackScreenshot(screenshot, privateScoped) {
    if (!screenshot || typeof screenshot !== 'object')
        return null;
    const type = cleanFeedbackString(screenshot.type, 80);
    const size = Number(screenshot.size) || 0;
    if (!FEEDBACK_SCREENSHOT_TYPES.has(type)) {
        return { ok: false, error: 'Unsupported screenshot type.' };
    }
    if (size <= 0 || size > MAX_FEEDBACK_SCREENSHOT_BYTES) {
        return { ok: false, error: 'Screenshot is too large.' };
    }
    const storagePolicy = privateScoped || screenshot.storagePolicy === 'private' ? 'private' : 'public';
    return {
        ok: true,
        value: {
            name: cleanFeedbackString(screenshot.name, 180) || 'feedback-screenshot.png',
            type,
            size,
            redacted: screenshot.redacted === true,
            storagePolicy,
            stored: true,
        },
    };
}
export async function validateFeedbackAccess(c, store, context) {
    const principal = c.get('principal') ?? null;
    if (!context.privateScoped)
        return { principal, teamId: null, projectId: null };
    if (!principal)
        return { response: jsonError(c, 401, 'Authentication required for private feedback.') };
    if (context.projectId) {
        const details = await store.getProjectDetails(context.projectId);
        if (!details?.project)
            return { response: jsonError(c, 404, 'Feedback context not found.') };
        const teamContext = await store.resolvePrincipalTeamContext(details.project.teamId, principal);
        const allowed = Boolean(teamContext) && (!isTeamApiPrincipal(principal) || principalHasPermission(principal, 'projects:read:team'));
        if (!allowed)
            return { response: jsonError(c, 403, 'Permission denied.') };
        return { principal, teamId: details.project.teamId, projectId: details.project.id };
    }
    if (context.teamId) {
        const teamContext = await store.resolvePrincipalTeamContext(context.teamId, principal);
        const allowed = Boolean(teamContext) && (!isTeamApiPrincipal(principal) || principalHasPermission(principal, 'projects:read:team'));
        if (!allowed)
            return { response: jsonError(c, 403, 'Permission denied.') };
        return { principal, teamId: context.teamId, projectId: null };
    }
    return { response: jsonError(c, 400, 'Private feedback requires a team or project context.') };
}
export async function recordFeedbackSubmission(c, store, body) {
    const type = cleanFeedbackString(body.type, 80);
    if (!FEEDBACK_TYPES.has(type))
        return { response: jsonError(c, 400, 'Unsupported feedback type.') };
    const message = cleanFeedbackString(body.message, MAX_FEEDBACK_MESSAGE_LENGTH);
    if (!message)
        return { response: jsonError(c, 400, 'Feedback details are required.') };
    const context = safeFeedbackContext(body.context);
    if (context.privateScoped && body.context?.allowAnonymous === true) {
        return { response: jsonError(c, 400, 'Private feedback cannot be anonymous.') };
    }
    const access = await validateFeedbackAccess(c, store, context);
    if (access.response)
        return access;
    const screenshot = safeFeedbackScreenshot(body.screenshot, context.privateScoped);
    if (screenshot?.ok === false)
        return { response: jsonError(c, 400, screenshot.error) };
    const id = randomUUID();
    const payload = {
        id,
        type,
        message,
        contactEmail: cleanFeedbackString(body.contactEmail, 320) || null,
        context: {
            ...context,
            teamId: access.teamId,
            projectId: access.projectId ?? context.projectId,
            userId: access.principal?.id ?? null,
        },
        client: safeFeedbackClient(body.client),
        screenshot: screenshot?.value ?? null,
    };
    await store.recordAuditEvent({
        eventType: 'feedback.submitted',
        actorType: access.principal ? (c.get('actorType') === 'service' ? 'service' : 'user') : 'anonymous',
        actorId: access.principal?.id ?? null,
        targetType: payload.context.projectId ? 'project' : payload.context.teamId ? 'team' : 'market',
        targetId: payload.context.projectId ?? payload.context.teamId ?? 'public-feedback',
        data: payload,
    });
    if (payload.context.teamId) {
        await store.upsertTeamInboxItem(payload.context.teamId, {
            id: `feedback:${id}`,
            projectId: payload.context.projectId,
            kind: 'feedback',
            state: 'new',
            title: `${payload.context.title || 'Product'} feedback`,
            summary: `${type.replace(/_/gu, ' ')} feedback received.`,
            href: payload.context.canonicalPath || '/app/',
            itemKey: id,
            metadata: {
                feedbackId: id,
                type,
                shell: payload.context.shell,
                context: payload.context.context,
                hasScreenshot: Boolean(payload.screenshot),
                screenshotStoragePolicy: payload.screenshot?.storagePolicy ?? null,
            },
        });
    }
    return {
        id,
        privateScoped: context.privateScoped,
        hasScreenshot: Boolean(payload.screenshot),
    };
}

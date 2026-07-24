import type { Hono } from 'hono';
import { AgentSdk, RemoteClient, RemoteOperationsClient, RemoteSdkClient, signEditorialPreviewToken, OperationsSdk, executeSdkOperation, findDispatchCapability, planKnowledgeHubLaunch, derivePlatformOperationNavigation, deriveProjectHostBindingsView, isPlatformOperationTerminal, normalizeProjectLaunchHostBindings, normalizePlatformContentInput as normalizeRepositoryContentInput, normalizePlatformRelationArray as normalizeRepositoryRelationArray, platformContentRelationPolicy as repositoryContentRelationPolicy, normalizeTemplateLaunchRequirements, normalizeTemplateId, planProjectHostBindingOperation, resolveProjectLaunchHostBindings, slugifyPlatformContent as slugifyRepositoryContent, } from '@treeseed/sdk';
import { runHostingAudit } from '@treeseed/sdk/workflow-support';
import { createApiApp as createSdkApiApp, D1AuthProvider as DatabaseAuthProvider, loadTemplateCatalog, resolveApiConfig, } from '@treeseed/sdk/api';
import { MarketControlPlaneStore, validateProjectSlug } from '../../../../persistence/store.js';
import { createClientEncryptedEscrowService } from '../../../../support/client-encrypted-escrow.ts';
import { createGitHubAppAdapter } from '../../../../reconciliation/github-app-adapter.ts';
import { createGitHubActionsSecretEnclave } from '../../../../configuration/github-actions-secret-enclave.ts';
import { bearerTokenFromRequest } from '../../../../accounts/request-auth.ts';
import { createTreeDxCredentialBridge } from '../../../../treedx/repositories/treedx-credential-bridge.ts';
import { createMarketPostgresDatabase } from '../../../../support/market-postgres.js';
import { installProjectDeploymentRoutes } from '../../../../projects/deployments/project-deployment-routes.js';
import { installCapacityRoutes } from '../../../../capacity/routes/index.ts';
import { createCapacityControlPlane } from '../../../../capacity/control-plane.ts';
import { deleteTeamCapacityAggregate } from '../../../../capacity/services/teams/team-deletion-service.ts';
import { readCapacityRequestObject } from '../../../../capacity/routes/support/request-json.ts';
import { createStripeConnectService, resolveStripeEnvironment, stripeAccountToConnectedAccountPatch } from '../../../../commerce/commerce-core/stripe-connect.js';
import { applySeedWithStore, exportSeedWithStore, planSeedWithStore } from '../../../../../market/seeds/apply.js';
import { buildGovernanceApprovalProjection, buildGovernanceProjection } from '../../../../../market/projects/projects-core/governance-projection.js';
import { buildInfrastructureProjection } from '../../../../../market/projects/hosting/infrastructure-projection.js';
import { loadInfrastructureSeedState } from '../../../../../market/seeds/infrastructure-seeds.js';
import { buildKnowledgeArtifactProjection, buildKnowledgeProjection } from '../../../../../market/projects/knowledge/knowledge-projection.js';
import { buildWorkdayProjection } from '../../../../../market/capacity/workdays/workday-projection.js';
import { loadKnowledgeContentEntries } from '../../../../../view-models/knowledge-content.js';
import { listManagedHostsFromConfig, managedCloudflareConfigMissing, resolveManagedCloudflareHostConfigFromConfig, } from '../../../../../market/hosting/managed-hosts.js';
import { decryptHostConfig } from '../../../../../crypto/host-crypto.ts';
import { getSiteAuthConfig } from '../../../../../auth/config.ts';
import { accountDeletionConfirmationMatches } from '../../../../../auth/account.ts';
import { validateUsername as validatePublicUsername } from '../../../../../auth/profile-validation.ts';
import { authEmailDeliveryFailureDetail, authEmailDeliveryFailureReason, sendAuthEmail } from '../../../../../auth/email.ts';
import { recordContentNotificationEvent } from '../../../../../notifications/service.ts';
import { sendEmailConfirmation } from '../../../../../auth/email-confirmation.ts';
import { sendWelcomeEmail } from '../../../../../auth/welcome-email.ts';
import { createCipheriv, createDecipheriv, createHash, createHmac, createPublicKey, createVerify, pbkdf2Sync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { contentRelationPolicy } from '../../../../../market/content/content-relations.js';
import { NOTIFICATION_CONTENT_CAPABILITIES, PERSONAL_THEME_COMPILER_VERSION, isValidPersonalThemeDraft, normalizeNotificationPreferences, } from '@treeseed/sdk/account-contracts';
import { jsonError, jsonThrownError, POSTGRES_AUTH_PROVIDER_ID, availabilityAttempts, AUTH_PROVIDERS, providerJwksCache, availabilityRateLimit, personalThemeFromRow, accountDeletionBlockers, consumeReauthentication, loadNotificationPreferences, providerConfigFor, base64Url, verifyProviderIdToken, exchangeProviderIdentity, resolveLaunchTemplateRequirements, projectHostBindingMetadata, loadProjectHostBindingContext, projectHostResponsePayload, hostBindingRequiresUnlock, hostKindForBinding, createProjectHostCredentialSessions, persistProjectHostBindingOperationMetadata, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, plaintextHostCredentialFieldPaths, rejectPlaintextHostCredentialFields, parseBooleanEnvValue, shouldLogApiRequests, shouldExposeNonProductionAuthDiagnostics, SENSITIVE_QUERY_PARAM_PATTERN, redactedRequestTarget, installApiRequestLogger, AGENT_PROMOTION_APPROVAL_DECISIONS, readJsonOrFormBody, normalizeEmail, normalizeUsername, parseJsonObject, trimmedHeaderValue, requestClientIp, requestSessionMetadata, webSessionData, validateMarketPassword, hashMarketPassword, verifyMarketPassword, ensureMarketCredentialSchema, MARKET_EMAIL_CONFIRMATION_PREFIX, marketAuthContext, shouldBypassAcceptanceAuthEmailDelivery, marketEmailTokenHash, exposeAuthTokenForTests, authTokenTimestampSeconds, authTokenTimestampMillis, sanitizedReturnTo, confirmationUrlFor, teamInviteAcceptUrlFor, passwordResetUrlFor, sendTeamInviteEmail, createMarketEmailConfirmation, serializeUserEmailAddress, backfillUserEmailAddresses, listUserEmailAddresses, getUserEmailAddress, verifiedEmailCount, setPrimaryEmailAddress, syncPrimaryEmailCaches, createOrResendUserEmailAddress, createMarketWebSession, webAuthPayload, normalizeAppearancePreference, normalizeBaseUrl, normalizeDomainName, normalizeProjectDomainInput, inferZoneNameForDomain, domainInZone, optionalTrimmedString, enumValue, unknownKeys, LOCAL_CONTENT_COLLECTIONS, LOCAL_WORK_CONTENT_COLLECTIONS, LOCAL_DECISION_TYPE_VALUES, PROPOSAL_VERDICT_DECISION_TYPES, PLATFORM_OPERATION_SCOPES, LOCAL_CONTENT_DEFAULTS, slugifyContent, yamlScalar, yamlLines, serializeFrontmatter, normalizeRelationArray, uniqueRelationArray, addRelationValue, normalizeLocalContentInput, writeLocalContentRecord, localContentRoot, localContentPath, readLocalContentRecord, writeParsedLocalContentRecord, createRelatedLocalContentRecord, createDecisionFromProposals, isLoopbackUrl, resolveAuthApprovalBaseUrl, findById, resolveAgentArtifactBucket, centralMarketProfile, normalizeMarketProfile, encryptedHostPayloadLooksValid, decryptedHostConfigSummary, credentialSessionSecret, credentialSessionKey, encryptCredentialSessionPayload, decryptCredentialSessionPayload, normalizeProviderCredentialConfig, HOST_KIND_SESSION_KEYS, normalizeAuditHostKinds, providerCredentialValuesForAudit, collectHostingAuditCredentialOverlay, nonSecretLaunchJobInput, decryptTeamHostForLaunch, mergeStringConfig, buildLaunchCredentialOverlay, patchLaunchIntentForCredentialOverlay, appendLaunchDeploymentEvent, scheduleBackgroundBootstrap, sanitizeLaunchResultForStorage, cloudflareErrorMessage, cloudflareRequestForLaunchPreflight, resolveCloudflareZoneForLaunchPreflight, verifyCloudflareDnsWriteForLaunch, cloudflareRequestForProjectDeletion, cloudflareDeletionAuthenticationMessage, hasRecordedCloudflareRuntimeResources, canSkipCloudflareCleanupAfterFailedLaunch, projectDeletionHostname, normalizedCloudflareKvNamespaceReference, uniqueCloudflareKvNamespaceReferences, cloudflareProjectDeletionResourceNames, resolveProjectDeletionCloudflareZone, deleteCloudflareDnsRecordsForProject, listCloudflareNamedResources, deleteCloudflareProjectResources, cloudflareDnsDomainsForHostValidation, validateTeamHostCredentialPayload, runProjectLaunchApiBootstrap, retryApiLaunchBootstrapFromRequest, GITHUB_ACTIONS_OIDC_ISSUER, githubOidcJwksCache, base64urlJson, parseBase64urlJson, operationTokenSecret, signOperationToken, verifyOperationToken, loadGitHubOidcJwks, verifyGitHubOidcToken, normalizeCiEnvironment, ciOperationForAction, fallbackRemoteCapability, validateCiRefForEnvironment, marketProfilesForTeams, artifactDownloadPayload, principalHasPermission, principalIsSeedAdmin, isTeamApiPrincipal, isLocalAcceptanceServicePrincipal, localAcceptanceAdminToken, localAcceptanceAuthEnabled, decorateJob, safePlatformOperationOutput, decoratePlatformOperation, safeTokenEquals, resolvePlatformRunnerSecret, platformOperationMutationError, requirePlatformRunner, mergeCapability, canonicalArchitectureTopology, launchPlannerRepositoryTopology, launchCapabilityPreset, resourceRowsFromLaunch, ensurePrincipal, decodeRouteParam, uiRuntimeLocals, requireConfiguredServiceCredential, resolvePublicTreeDxTeam, enqueueTreeDxProvisionOperation, principalHasGlobalPlatformRole, requireTeamAccess, safePrivateKnowledgeSlug, privateKnowledgeAuditPayload, recordPrivateKnowledgeAudit, FEEDBACK_TYPES, FEEDBACK_SCREENSHOT_TYPES, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, cleanFeedbackString, safeFeedbackContext, safeFeedbackClient, safeFeedbackScreenshot, validateFeedbackAccess, recordFeedbackSubmission, normalizeSeedEnvironments, seedActor, seedExistingTeamIds, seedCreatesMissingTeams, requireSeedPlanAccess, requireSeedApplyAccess, AGENT_TASK_SIGNATURES, resolveAgentTaskSignature, commerceErrorResponse, stripeConfiguredError, stripeVendorApprovalError, stripeAccountMissingError, stripeCommerceUrl, requireCommerceVendorForStripe, refreshCommerceStripeAccount, STRIPE_PRODUCT_MIRROR_OFFER_MODES, STRIPE_PRICE_MIRROR_OFFER_MODES, stripeMetadataValue, buildCommerceStripeMetadata, commerceStripeProductParams, commerceStripeLookupKey, commerceStripePriceParams, stripePriceTermsDrift, commerceStripeSyncContext, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, CHECKOUT_OFFER_MODES, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, resolveStripePublishableKey, resolveStripeWebhookSecret, commerceCheckoutError, normalizeCheckoutQuantity, stripeClientSecret, paymentGroupStatusFromPaymentIntent, orderStatusFromPaymentGroup, subscriptionStatusFromStripe, entitlementRenewalStateFromSubscription, stripeTimestampToIso, subscriptionClientSecret, publicPaymentGroups, buildCommerceCheckoutMetadata, resolveCommerceCheckoutItem, checkoutGroupKind, checkoutGroupKey, checkoutGroupStatus, grantCommerceEntitlementsForOrder, requireSellerTeamAccess, requireVendorOrderManager, requireServiceBuyerAccess, requireServiceSellerAccess, requireServiceParticipantAccess, redactCommerceServiceRequestForBuyer, requireCommerceCapacityListingAccess, requireCommerceCapacityInquiryAccess, remainingRefundableAmount, stripeRefundStatus, applyCommerceRefundState, resolveOrderItemForRefund, resolveFulfillmentArtifact, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, ensureCommerceStripeCustomer, refreshCommercePaymentGroupState, updateCheckoutCompletionFromGroup, syncCommerceSubscriptionFromStripe, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, handleCommerceInvoiceWebhook, processCommerceStripeWebhook, requireCommerceProductAccess, principalCanManageCommerceProduct, redactCommerceOwnershipWorkflow, requireCommerceOfferAccess, requireCatalogItemAccess, unwrapLaunchOperationOutput, appendLaunchPhaseProjection, updateLaunchDeployments, applyHubLaunchResult, applyHubLaunchFailure, unwrapOperationPayload, applyContentPublishResult, executeInline, selectDispatchTarget, defaultConfig, createApiExtension, repositoryInventoryWithPlatform, projectDeletionConfirmationMatches, projectDeletionBlockerRows, githubRequestForProjectDeletion, projectDeletionOperation, appendProjectDeletionProgress, runProjectDeletionApiDestroy, normalizeRepositorySlug, resolvePlatformRepositoryDescriptor, hubRepositoryPolicies } from '../../index.ts';
export function sourceFromProjectDetails(details) {
    const projectMetadata = details?.project?.metadata && typeof details.project.metadata === 'object' ? details.project.metadata : {};
    const hostingMetadata = details?.hosting?.metadata && typeof details.hosting.metadata === 'object' ? details.hosting.metadata : {};
    const sourceKind = optionalTrimmedString(projectMetadata.sourceKind)
        ?? optionalTrimmedString(hostingMetadata.sourceKind)
        ?? (optionalTrimmedString(projectMetadata.sourceRef) || optionalTrimmedString(hostingMetadata.sourceRef) ? 'template' : null);
    const rawSourceRef = optionalTrimmedString(projectMetadata.sourceRef)
        ?? optionalTrimmedString(hostingMetadata.sourceRef)
        ?? null;
    const sourceRef = normalizeTemplateId(rawSourceRef);
    return { sourceKind, sourceRef };
}
export function rejectProjectSecretUnlockMaterial(c, body, message = 'Project operations no longer accept passphrases or credential sessions. Re-enter or migrate the secret into an approved target, then retry.') {
    const fields = [];
    if (body && typeof body === 'object') {
        if (typeof body.sensitivePassphrase === 'string' && body.sensitivePassphrase)
            fields.push('sensitivePassphrase');
        if (typeof body.passphrase === 'string' && body.passphrase)
            fields.push('passphrase');
        if (body.credentialSessions && typeof body.credentialSessions === 'object' && Object.keys(body.credentialSessions).length > 0)
            fields.push('credentialSessions');
        if (body.providerCredentialSessions && typeof body.providerCredentialSessions === 'object' && Object.keys(body.providerCredentialSessions).length > 0)
            fields.push('providerCredentialSessions');
    }
    if (fields.length === 0)
        return null;
    return jsonError(c, 400, message, {
        code: 'sensitive_passphrase_rejected',
        fields,
    });
}
export function markdownToPlainProjectSummary(markdown, fallback = null) {
    const text = String(markdown ?? '')
        .replace(/^---[\s\S]*?---/u, ' ')
        .replace(/```[\s\S]*?```/gu, ' ')
        .replace(/`([^`]+)`/gu, '$1')
        .replace(/!\[[^\]]*\]\([^)]+\)/gu, ' ')
        .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
        .replace(/^#{1,6}\s+/gmu, '')
        .replace(/^\s*[-*+]\s+/gmu, '')
        .replace(/^\s*\d+\.\s+/gmu, '')
        .replace(/[*_~>#]/gu, '')
        .replace(/\s+/gu, ' ')
        .trim();
    if (!text)
        return fallback;
    return text.length > 240 ? `${text.slice(0, 237).trimEnd()}...` : text;
}
export function projectAllowedCiRepositories(projectDetails) {
    const slugs = new Set();
    for (const repository of projectDetails.repositories ?? []) {
        if (repository.role !== 'software')
            continue;
        const slug = normalizeRepositorySlug(`${repository.owner}/${repository.name}`);
        if (slug)
            slugs.add(slug);
    }
    const hosting = projectDetails.hosting;
    if (hosting?.sourceRepoOwner && hosting?.sourceRepoName) {
        const slug = normalizeRepositorySlug(`${hosting.sourceRepoOwner}/${hosting.sourceRepoName}`);
        if (slug)
            slugs.add(slug);
    }
    return slugs;
}
export async function resolveUiProjectionContext(c, store) {
    const auth = await ensurePrincipal(c);
    if (auth.response)
        return auth;
    const teams = await store.listTeamsForPrincipal(auth.principal).catch(() => []);
    const activeTeam = teams[0] ?? null;
    const projects = activeTeam ? await store.listTeamProjects(activeTeam.id).catch(() => []) : [];
    return {
        principal: auth.principal,
        teams,
        activeTeam,
        projects,
    };
}
export async function requireProjectAccess(c, store, projectId, permission = null) {
    const auth = await ensurePrincipal(c);
    if (auth.response) {
        return auth;
    }
    const details = await store.getProjectDetails(projectId);
    if (!details) {
        return {
            response: jsonError(c, 404, `Unknown project "${projectId}".`),
        };
    }
    const access = await requireTeamAccess(c, store, details.project.teamId, permission);
    if (access.response) {
        return access;
    }
    return {
        principal: access.principal,
        details,
    };
}
export async function requireProjectRunner(c, store, projectId) {
    const token = bearerTokenFromRequest(c.req.raw);
    if (!token) {
        return {
            response: jsonError(c, 401, 'Authentication required.'),
        };
    }
    const runner = await store.authenticateRunner(projectId, token);
    if (!runner) {
        return {
            response: jsonError(c, 401, 'Invalid project runner token.'),
        };
    }
    return { runner };
}
export async function requireConnectedProjectRuntime(c, store, projectId, principal, path, input: any = {}) {
    const payload = await store.requestProjectRuntime(projectId, principal, path, input);
    if (!payload) {
        return {
            response: jsonError(c, 409, 'Project runtime is not connected or unavailable.', {
                projectId,
                path,
            }),
        };
    }
    return { payload };
}
export async function projectAppHref(_store, _teamId, _projectSlug, section) {
    if (section === 'share')
        return '/app/knowledge/artifacts';
    return _projectSlug ? `/app/projects/${encodeURIComponent(_projectSlug)}` : '/app/projects';
}
export function projectApiConnection(projectDetails) {
    const baseUrl = normalizeBaseUrl(projectDetails.connection?.projectApiBaseUrl);
    return baseUrl ? baseUrl : null;
}
export function createProjectInternalClient(options, projectDetails, fallbackInternalPrefix) {
    const projectApiBaseUrl = projectApiConnection(projectDetails);
    if (!projectApiBaseUrl) {
        throw new Error(`Project "${projectDetails.project.id}" is missing a project API base URL.`);
    }
    const metadata = projectDetails.connection?.metadata ?? {};
    const internalPrefix = normalizeBaseUrl(typeof metadata.internalPrefix === 'string'
        ? metadata.internalPrefix
        : fallbackInternalPrefix);
    const projectApiKey = typeof metadata.projectApiKey === 'string' && metadata.projectApiKey.trim()
        ? metadata.projectApiKey.trim()
        : typeof metadata.bearerToken === 'string' && metadata.bearerToken.trim()
            ? metadata.bearerToken.trim()
            : null;
    if (!projectApiKey) {
        throw new Error(`Project "${projectDetails.project.id}" is missing a project API key for remote dispatch.`);
    }
    return new RemoteClient({
        hosts: [{
                id: projectDetails.project.id,
                baseUrl: `${projectApiBaseUrl}${internalPrefix}`,
            }],
        activeHostId: projectDetails.project.id,
        auth: {
            accessToken: projectApiKey,
        },
    }, {
        fetchImpl: options.fetchImpl,
    });
}
export async function executeProjectApi(options, projectDetails, request, fallbackInternalPrefix) {
    const client = createProjectInternalClient(options, projectDetails, fallbackInternalPrefix);
    if (request.namespace === 'workflow') {
        return new RemoteOperationsClient(client).execute(request.operation, {
            input: request.input ?? {},
        });
    }
    return new RemoteSdkClient(client).execute(request.operation, {
        input: request.input ?? {},
    });
}

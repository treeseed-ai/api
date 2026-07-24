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
import { jsonError, jsonThrownError, POSTGRES_AUTH_PROVIDER_ID, availabilityAttempts, AUTH_PROVIDERS, providerJwksCache, availabilityRateLimit, personalThemeFromRow, accountDeletionBlockers, consumeReauthentication, loadNotificationPreferences, providerConfigFor, base64Url, verifyProviderIdToken, exchangeProviderIdentity, resolveLaunchTemplateRequirements, projectHostBindingMetadata, sourceFromProjectDetails, repositoryInventoryWithPlatform, loadProjectHostBindingContext, projectHostResponsePayload, hostBindingRequiresUnlock, hostKindForBinding, createProjectHostCredentialSessions, persistProjectHostBindingOperationMetadata, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, plaintextHostCredentialFieldPaths, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, markdownToPlainProjectSummary, parseBooleanEnvValue, shouldLogApiRequests, shouldExposeNonProductionAuthDiagnostics, SENSITIVE_QUERY_PARAM_PATTERN, redactedRequestTarget, installApiRequestLogger, AGENT_PROMOTION_APPROVAL_DECISIONS, readJsonOrFormBody, normalizeEmail, normalizeUsername, parseJsonObject, trimmedHeaderValue, requestClientIp, requestSessionMetadata, webSessionData, validateMarketPassword, hashMarketPassword, verifyMarketPassword, ensureMarketCredentialSchema, MARKET_EMAIL_CONFIRMATION_PREFIX, marketAuthContext, shouldBypassAcceptanceAuthEmailDelivery, marketEmailTokenHash, exposeAuthTokenForTests, authTokenTimestampSeconds, authTokenTimestampMillis, sanitizedReturnTo, confirmationUrlFor, teamInviteAcceptUrlFor, passwordResetUrlFor, sendTeamInviteEmail, createMarketEmailConfirmation, serializeUserEmailAddress, backfillUserEmailAddresses, listUserEmailAddresses, getUserEmailAddress, verifiedEmailCount, setPrimaryEmailAddress, syncPrimaryEmailCaches, createOrResendUserEmailAddress, createMarketWebSession, webAuthPayload, normalizeAppearancePreference, normalizeBaseUrl, normalizeDomainName, normalizeProjectDomainInput, inferZoneNameForDomain, domainInZone, optionalTrimmedString, enumValue, unknownKeys, LOCAL_CONTENT_COLLECTIONS, LOCAL_WORK_CONTENT_COLLECTIONS, LOCAL_DECISION_TYPE_VALUES, PROPOSAL_VERDICT_DECISION_TYPES, PLATFORM_OPERATION_SCOPES, LOCAL_CONTENT_DEFAULTS, slugifyContent, yamlScalar, yamlLines, serializeFrontmatter, normalizeRelationArray, uniqueRelationArray, addRelationValue, normalizeLocalContentInput, writeLocalContentRecord, localContentRoot, localContentPath, readLocalContentRecord, writeParsedLocalContentRecord, createRelatedLocalContentRecord, createDecisionFromProposals, isLoopbackUrl, resolveAuthApprovalBaseUrl, findById, resolveAgentArtifactBucket, centralMarketProfile, normalizeMarketProfile, encryptedHostPayloadLooksValid, decryptedHostConfigSummary, credentialSessionSecret, credentialSessionKey, encryptCredentialSessionPayload, decryptCredentialSessionPayload, normalizeProviderCredentialConfig, HOST_KIND_SESSION_KEYS, normalizeAuditHostKinds, providerCredentialValuesForAudit, collectHostingAuditCredentialOverlay, nonSecretLaunchJobInput, decryptTeamHostForLaunch, mergeStringConfig, buildLaunchCredentialOverlay, patchLaunchIntentForCredentialOverlay, appendLaunchDeploymentEvent, scheduleBackgroundBootstrap, sanitizeLaunchResultForStorage, cloudflareErrorMessage, cloudflareRequestForLaunchPreflight, resolveCloudflareZoneForLaunchPreflight, verifyCloudflareDnsWriteForLaunch, projectDeletionConfirmationMatches, projectDeletionBlockerRows, cloudflareRequestForProjectDeletion, githubRequestForProjectDeletion, projectDeletionOperation, cloudflareDeletionAuthenticationMessage, hasRecordedCloudflareRuntimeResources, canSkipCloudflareCleanupAfterFailedLaunch, projectDeletionHostname, normalizedCloudflareKvNamespaceReference, uniqueCloudflareKvNamespaceReferences, cloudflareProjectDeletionResourceNames, resolveProjectDeletionCloudflareZone, deleteCloudflareDnsRecordsForProject, listCloudflareNamedResources, deleteCloudflareProjectResources, appendProjectDeletionProgress, cloudflareDnsDomainsForHostValidation, validateTeamHostCredentialPayload, runProjectLaunchApiBootstrap, runProjectDeletionApiDestroy, retryApiLaunchBootstrapFromRequest, GITHUB_ACTIONS_OIDC_ISSUER, githubOidcJwksCache, base64urlJson, parseBase64urlJson, operationTokenSecret, signOperationToken, verifyOperationToken, loadGitHubOidcJwks, verifyGitHubOidcToken, normalizeCiEnvironment, ciOperationForAction, fallbackRemoteCapability, normalizeRepositorySlug, projectAllowedCiRepositories, validateCiRefForEnvironment, marketProfilesForTeams, artifactDownloadPayload, principalHasPermission, principalIsSeedAdmin, isTeamApiPrincipal, isLocalAcceptanceServicePrincipal, localAcceptanceAdminToken, localAcceptanceAuthEnabled, decorateJob, safePlatformOperationOutput, decoratePlatformOperation, safeTokenEquals, resolvePlatformRunnerSecret, platformOperationMutationError, requirePlatformRunner, resolvePlatformRepositoryDescriptor, mergeCapability, canonicalArchitectureTopology, launchPlannerRepositoryTopology, launchCapabilityPreset, resourceRowsFromLaunch, ensurePrincipal, resolveUiProjectionContext, decodeRouteParam, uiRuntimeLocals, requireConfiguredServiceCredential, resolvePublicTreeDxTeam, enqueueTreeDxProvisionOperation, principalHasGlobalPlatformRole, requireTeamAccess, requireProjectAccess, safePrivateKnowledgeSlug, privateKnowledgeAuditPayload, recordPrivateKnowledgeAudit, FEEDBACK_TYPES, FEEDBACK_SCREENSHOT_TYPES, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, cleanFeedbackString, safeFeedbackContext, safeFeedbackClient, safeFeedbackScreenshot, validateFeedbackAccess, recordFeedbackSubmission, normalizeSeedEnvironments, seedActor, seedExistingTeamIds, seedCreatesMissingTeams, requireSeedPlanAccess, requireSeedApplyAccess, requireProjectRunner, AGENT_TASK_SIGNATURES, resolveAgentTaskSignature, commerceErrorResponse, requireSellerTeamAccess, requireVendorOrderManager, requireServiceBuyerAccess, requireServiceSellerAccess, requireServiceParticipantAccess, redactCommerceServiceRequestForBuyer, requireCommerceCapacityListingAccess, requireCommerceCapacityInquiryAccess, remainingRefundableAmount, applyCommerceRefundState, resolveOrderItemForRefund, resolveFulfillmentArtifact, handleCommerceInvoiceWebhook, requireCommerceProductAccess, principalCanManageCommerceProduct, redactCommerceOwnershipWorkflow, requireCommerceOfferAccess, requireCatalogItemAccess, requireConnectedProjectRuntime, projectAppHref, unwrapLaunchOperationOutput, appendLaunchPhaseProjection, updateLaunchDeployments, hubRepositoryPolicies, applyHubLaunchResult, applyHubLaunchFailure, unwrapOperationPayload, applyContentPublishResult, executeInline, projectApiConnection, createProjectInternalClient, executeProjectApi, selectDispatchTarget, defaultConfig, createApiExtension, CHECKOUT_OFFER_MODES, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, commerceCheckoutError, normalizeCheckoutQuantity, paymentGroupStatusFromPaymentIntent, orderStatusFromPaymentGroup, entitlementRenewalStateFromSubscription, subscriptionClientSecret, publicPaymentGroups, buildCommerceCheckoutMetadata, resolveCommerceCheckoutItem, checkoutGroupKind, checkoutGroupKey, checkoutGroupStatus, grantCommerceEntitlementsForOrder, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, refreshCommercePaymentGroupState, updateCheckoutCompletionFromGroup, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, resolveStripeWebhookSecret, subscriptionStatusFromStripe, ensureCommerceStripeCustomer, syncCommerceSubscriptionFromStripe, processCommerceStripeWebhook } from '../../index.ts';
export function stripeConfiguredError() {
    const error: Error & Record<string, any> = new Error('Stripe Connect is not configured for this market.');
    error.status = 409;
    return error;
}
export function stripeVendorApprovalError() {
    const error: Error & Record<string, any> = new Error('Commerce vendor approval is required before Stripe onboarding.');
    error.status = 409;
    return error;
}
export function stripeAccountMissingError() {
    const error: Error & Record<string, any> = new Error('Stripe connected account is not linked for this vendor.');
    error.status = 409;
    return error;
}
export function stripeCommerceUrl(config, teamId, marker) {
    const base = normalizeBaseUrl(config.siteUrl ?? config.baseUrl ?? 'http://localhost:4321') || 'http://localhost:4321';
    const url = new URL(`/app/teams/${encodeURIComponent(teamId)}/commerce`, `${base}/`);
    url.searchParams.set('stripe', marker);
    return url.toString();
}
export async function requireCommerceVendorForStripe(store, teamId) {
    const vendor = await store.getCommerceVendorForTeam(teamId);
    if (!vendor) {
        const error: Error & Record<string, any> = new Error(`Commerce vendor for team "${teamId}" was not found.`);
        error.status = 404;
        throw error;
    }
    if (vendor.status !== 'approved')
        throw stripeVendorApprovalError();
    return vendor;
}
export async function refreshCommerceStripeAccount({ store, stripeConnectService, account, actorType = 'system', actorId = null }) {
    if (!account)
        return null;
    const configured = await stripeConnectService.isConfigured();
    if (!configured)
        return account;
    const stripeAccount = await stripeConnectService.retrieveAccount(account.stripeAccountId);
    if (!stripeAccount)
        return account;
    return store.recordCommerceStripeAccountStatus(account.id, {
        ...stripeAccountToConnectedAccountPatch(stripeAccount, account.environment),
        actorType,
        actorId,
    });
}
export const STRIPE_PRODUCT_MIRROR_OFFER_MODES = new Set([
    'one_time',
    'one_time_current_version',
    'subscription',
    'subscription_updates',
    'professional_hosting',
    'scoped_contract',
]);
export const STRIPE_PRICE_MIRROR_OFFER_MODES = new Set([
    'one_time',
    'one_time_current_version',
    'subscription',
    'subscription_updates',
    'professional_hosting',
]);
export function stripeMetadataValue(value) {
    if (value === null || value === undefined)
        return '';
    if (typeof value === 'string')
        return value.slice(0, 500);
    return String(value).slice(0, 500);
}
export function buildCommerceStripeMetadata({ environment, vendor, product, ownership, offer, price = null }) {
    return Object.fromEntries(Object.entries({
        treeseed_environment: environment,
        treeseed_vendor_id: vendor?.id,
        treeseed_seller_team_id: product?.sellerTeamId ?? offer?.sellerTeamId,
        treeseed_product_id: product?.id ?? offer?.productId,
        treeseed_product_version_id: offer?.productVersionId,
        treeseed_offer_id: offer?.id,
        treeseed_price_id: price?.id,
        treeseed_price_version: price?.priceVersion,
        treeseed_ownership_model: product?.ownershipModel,
        treeseed_ownership_record_id: product?.ownershipRecordId ?? ownership?.id,
        treeseed_object_authority: 'treeseed',
        treeseed_sync_phase: 'phase_4',
    }).map(([key, value]) => [key, stripeMetadataValue(value)]));
}
export function commerceStripeProductParams({ product, offer, metadata }) {
    return {
        name: optionalTrimmedString(offer?.title) ?? product.title,
        description: optionalTrimmedString(offer?.termsSummary)
            ?? optionalTrimmedString(product.summary)
            ?? optionalTrimmedString(product.description)
            ?? undefined,
        active: product.status === 'approved' && offer.status === 'approved',
        metadata,
    };
}
export function commerceStripeLookupKey(environment, price) {
    return `treeseed_${environment}_${price.id}_v${price.priceVersion}`;
}
export function commerceStripePriceParams({ offer, price, stripeProductId, metadata, environment }) {
    const params: Record<string, unknown> = {
        product: stripeProductId,
        unit_amount: price.amount,
        currency: price.currency,
        lookup_key: price.stripeLookupKey ?? commerceStripeLookupKey(environment, price),
        metadata,
    };
    if (price.taxBehavior && price.taxBehavior !== 'unspecified') {
        params.tax_behavior = price.taxBehavior;
    }
    if (['subscription', 'subscription_updates', 'professional_hosting'].includes(offer.mode)) {
        params.recurring = { interval: price.billingInterval };
    }
    return params;
}
export function stripePriceTermsDrift(stripePrice, price, offer) {
    const recurringInterval = stripePrice?.recurring?.interval ?? 'one_time';
    const expectedInterval = ['subscription', 'subscription_updates', 'professional_hosting'].includes(offer.mode)
        ? price.billingInterval
        : 'one_time';
    return Number(stripePrice?.unit_amount ?? -1) !== price.amount
        || String(stripePrice?.currency ?? '').toLowerCase() !== price.currency
        || recurringInterval !== expectedInterval;
}
export async function commerceStripeSyncContext({ store, stripeConnectService, offer, environment }) {
    const product = await store.getCommerceProduct(offer.productId);
    const vendor = product ? await store.getCommerceVendor(product.vendorId) : null;
    const ownershipRecords = product ? await store.listCommerceOwnershipRecords(product.id).catch(() => []) : [];
    const ownership = ownershipRecords.find((record) => record.id === product?.ownershipRecordId) ?? ownershipRecords[0] ?? null;
    const account = vendor ? await store.getCommerceVendorStripeAccount(vendor.id, environment) : null;
    return { product, vendor, ownership, account };
}
export function resolveStripePublishableKey(config: any = {}) {
    return optionalTrimmedString(config.stripePublishableKey)
        ?? optionalTrimmedString(process.env.TREESEED_STRIPE_PUBLISHABLE_KEY)
        ?? optionalTrimmedString(process.env.STRIPE_PUBLISHABLE_KEY);
}
export function stripeClientSecret(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}
export function stripeTimestampToIso(value) {
    if (!Number.isFinite(Number(value)))
        return null;
    return new Date(Number(value) * 1000).toISOString();
}
export function stripeRefundStatus(value) {
    if (value === 'succeeded' || value === 'failed' || value === 'canceled')
        return value;
    return 'processing';
}

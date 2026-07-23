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
import { jsonError, jsonThrownError, POSTGRES_AUTH_PROVIDER_ID, availabilityAttempts, AUTH_PROVIDERS, providerJwksCache, availabilityRateLimit, personalThemeFromRow, accountDeletionBlockers, consumeReauthentication, loadNotificationPreferences, providerConfigFor, base64Url, verifyProviderIdToken, exchangeProviderIdentity, resolveLaunchTemplateRequirements, projectHostBindingMetadata, sourceFromProjectDetails, repositoryInventoryWithPlatform, loadProjectHostBindingContext, projectHostResponsePayload, hostBindingRequiresUnlock, hostKindForBinding, createProjectHostCredentialSessions, persistProjectHostBindingOperationMetadata, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, plaintextHostCredentialFieldPaths, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, markdownToPlainProjectSummary, parseBooleanEnvValue, shouldLogApiRequests, shouldExposeNonProductionAuthDiagnostics, SENSITIVE_QUERY_PARAM_PATTERN, redactedRequestTarget, installApiRequestLogger, AGENT_PROMOTION_APPROVAL_DECISIONS, readJsonOrFormBody, normalizeEmail, normalizeUsername, parseJsonObject, trimmedHeaderValue, requestClientIp, requestSessionMetadata, webSessionData, validateMarketPassword, hashMarketPassword, verifyMarketPassword, ensureMarketCredentialSchema, MARKET_EMAIL_CONFIRMATION_PREFIX, marketAuthContext, shouldBypassAcceptanceAuthEmailDelivery, marketEmailTokenHash, exposeAuthTokenForTests, authTokenTimestampSeconds, authTokenTimestampMillis, sanitizedReturnTo, confirmationUrlFor, teamInviteAcceptUrlFor, passwordResetUrlFor, sendTeamInviteEmail, createMarketEmailConfirmation, serializeUserEmailAddress, backfillUserEmailAddresses, listUserEmailAddresses, getUserEmailAddress, verifiedEmailCount, setPrimaryEmailAddress, syncPrimaryEmailCaches, createOrResendUserEmailAddress, createMarketWebSession, webAuthPayload, normalizeAppearancePreference, normalizeBaseUrl, normalizeDomainName, normalizeProjectDomainInput, inferZoneNameForDomain, domainInZone, optionalTrimmedString, enumValue, unknownKeys, LOCAL_CONTENT_COLLECTIONS, LOCAL_WORK_CONTENT_COLLECTIONS, LOCAL_DECISION_TYPE_VALUES, PROPOSAL_VERDICT_DECISION_TYPES, PLATFORM_OPERATION_SCOPES, LOCAL_CONTENT_DEFAULTS, slugifyContent, yamlScalar, yamlLines, serializeFrontmatter, normalizeRelationArray, uniqueRelationArray, addRelationValue, normalizeLocalContentInput, writeLocalContentRecord, localContentRoot, localContentPath, readLocalContentRecord, writeParsedLocalContentRecord, createRelatedLocalContentRecord, createDecisionFromProposals, isLoopbackUrl, resolveAuthApprovalBaseUrl, findById, resolveAgentArtifactBucket, centralMarketProfile, normalizeMarketProfile, encryptedHostPayloadLooksValid, decryptedHostConfigSummary, credentialSessionSecret, credentialSessionKey, encryptCredentialSessionPayload, decryptCredentialSessionPayload, normalizeProviderCredentialConfig, HOST_KIND_SESSION_KEYS, normalizeAuditHostKinds, providerCredentialValuesForAudit, collectHostingAuditCredentialOverlay, nonSecretLaunchJobInput, decryptTeamHostForLaunch, mergeStringConfig, buildLaunchCredentialOverlay, patchLaunchIntentForCredentialOverlay, appendLaunchDeploymentEvent, scheduleBackgroundBootstrap, sanitizeLaunchResultForStorage, cloudflareErrorMessage, cloudflareRequestForLaunchPreflight, resolveCloudflareZoneForLaunchPreflight, verifyCloudflareDnsWriteForLaunch, projectDeletionConfirmationMatches, projectDeletionBlockerRows, cloudflareRequestForProjectDeletion, githubRequestForProjectDeletion, projectDeletionOperation, cloudflareDeletionAuthenticationMessage, hasRecordedCloudflareRuntimeResources, canSkipCloudflareCleanupAfterFailedLaunch, projectDeletionHostname, normalizedCloudflareKvNamespaceReference, uniqueCloudflareKvNamespaceReferences, cloudflareProjectDeletionResourceNames, resolveProjectDeletionCloudflareZone, deleteCloudflareDnsRecordsForProject, listCloudflareNamedResources, deleteCloudflareProjectResources, appendProjectDeletionProgress, cloudflareDnsDomainsForHostValidation, validateTeamHostCredentialPayload, runProjectLaunchApiBootstrap, runProjectDeletionApiDestroy, retryApiLaunchBootstrapFromRequest, GITHUB_ACTIONS_OIDC_ISSUER, githubOidcJwksCache, base64urlJson, parseBase64urlJson, operationTokenSecret, signOperationToken, verifyOperationToken, loadGitHubOidcJwks, verifyGitHubOidcToken, normalizeCiEnvironment, ciOperationForAction, fallbackRemoteCapability, normalizeRepositorySlug, projectAllowedCiRepositories, validateCiRefForEnvironment, marketProfilesForTeams, artifactDownloadPayload, principalHasPermission, principalIsSeedAdmin, isTeamApiPrincipal, isLocalAcceptanceServicePrincipal, localAcceptanceAdminToken, localAcceptanceAuthEnabled, decorateJob, safePlatformOperationOutput, decoratePlatformOperation, safeTokenEquals, resolvePlatformRunnerSecret, platformOperationMutationError, requirePlatformRunner, resolvePlatformRepositoryDescriptor, mergeCapability, canonicalArchitectureTopology, launchPlannerRepositoryTopology, launchCapabilityPreset, resourceRowsFromLaunch, ensurePrincipal, resolveUiProjectionContext, decodeRouteParam, uiRuntimeLocals, requireConfiguredServiceCredential, resolvePublicTreeDxTeam, enqueueTreeDxProvisionOperation, principalHasGlobalPlatformRole, requireTeamAccess, requireProjectAccess, safePrivateKnowledgeSlug, privateKnowledgeAuditPayload, recordPrivateKnowledgeAudit, FEEDBACK_TYPES, FEEDBACK_SCREENSHOT_TYPES, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, cleanFeedbackString, safeFeedbackContext, safeFeedbackClient, safeFeedbackScreenshot, validateFeedbackAccess, recordFeedbackSubmission, normalizeSeedEnvironments, seedActor, seedExistingTeamIds, seedCreatesMissingTeams, requireSeedPlanAccess, requireSeedApplyAccess, requireProjectRunner, AGENT_TASK_SIGNATURES, resolveAgentTaskSignature, commerceErrorResponse, requireSellerTeamAccess, requireVendorOrderManager, requireServiceBuyerAccess, requireServiceSellerAccess, requireServiceParticipantAccess, redactCommerceServiceRequestForBuyer, requireCommerceCapacityListingAccess, requireCommerceCapacityInquiryAccess, remainingRefundableAmount, applyCommerceRefundState, resolveOrderItemForRefund, resolveFulfillmentArtifact, handleCommerceInvoiceWebhook, requireCommerceProductAccess, principalCanManageCommerceProduct, redactCommerceOwnershipWorkflow, requireCommerceOfferAccess, requireCatalogItemAccess, requireConnectedProjectRuntime, projectAppHref, unwrapLaunchOperationOutput, appendLaunchPhaseProjection, updateLaunchDeployments, hubRepositoryPolicies, applyHubLaunchResult, applyHubLaunchFailure, unwrapOperationPayload, applyContentPublishResult, executeInline, projectApiConnection, createProjectInternalClient, executeProjectApi, selectDispatchTarget, defaultConfig, createApiExtension, stripeConfiguredError, stripeVendorApprovalError, stripeAccountMissingError, stripeCommerceUrl, requireCommerceVendorForStripe, refreshCommerceStripeAccount, STRIPE_PRODUCT_MIRROR_OFFER_MODES, STRIPE_PRICE_MIRROR_OFFER_MODES, stripeMetadataValue, buildCommerceStripeMetadata, commerceStripeProductParams, commerceStripeLookupKey, commerceStripePriceParams, stripePriceTermsDrift, commerceStripeSyncContext, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, resolveStripePublishableKey, resolveStripeWebhookSecret, stripeClientSecret, subscriptionStatusFromStripe, entitlementRenewalStateFromSubscription, stripeTimestampToIso, subscriptionClientSecret, grantCommerceEntitlementsForOrder, stripeRefundStatus, ensureCommerceStripeCustomer, syncCommerceSubscriptionFromStripe, handleCommerceSubscriptionWebhook, processCommerceStripeWebhook, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, refreshCommercePaymentGroupState, updateCheckoutCompletionFromGroup, handleCommercePaymentIntentWebhook } from './index.ts';
export const CHECKOUT_OFFER_MODES = new Set(['free', 'one_time', 'one_time_current_version', 'subscription', 'subscription_updates']);
export const CHECKOUT_COMMERCIAL_OFFER_MODES = new Set(['one_time', 'one_time_current_version', 'subscription', 'subscription_updates']);
export const CHECKOUT_SUBSCRIPTION_OFFER_MODES = new Set(['subscription', 'subscription_updates']);
export function commerceCheckoutError(message, status = 409, details: any = {}) {
    const error: Error & Record<string, any> = new Error(message);
    error.status = status;
    error.details = details;
    return error;
}
export function normalizeCheckoutQuantity(value) {
    const quantity = Number(value ?? 1);
    return Number.isFinite(quantity) && quantity > 0 ? Math.floor(quantity) : 1;
}
export function paymentGroupStatusFromPaymentIntent(paymentIntent) {
    if (paymentIntent?.status === 'succeeded')
        return 'succeeded';
    if (paymentIntent?.status === 'processing')
        return 'processing';
    if (paymentIntent?.status === 'requires_action')
        return 'requires_action';
    if (paymentIntent?.status === 'canceled')
        return 'canceled';
    if (paymentIntent?.status === 'requires_payment_method')
        return 'requires_confirmation';
    return 'requires_confirmation';
}
export function orderStatusFromPaymentGroup(status) {
    if (status === 'succeeded')
        return 'paid';
    if (status === 'requires_action')
        return 'requires_action';
    if (status === 'processing')
        return 'processing';
    if (status === 'failed')
        return 'failed';
    if (status === 'canceled')
        return 'canceled';
    return 'pending_payment';
}
export function publicPaymentGroups(groups) {
    return groups.map((group) => {
        if (!group)
            return group;
        const { clientSecretLast4: _clientSecretLast4, ...publicGroup } = group;
        return publicGroup;
    });
}
export function buildCommerceCheckoutMetadata({ product, offer, price, vendor, ownership, environment }) {
    return {
        treeseed_environment: environment,
        treeseed_vendor_id: vendor.id,
        treeseed_seller_team_id: product.sellerTeamId,
        treeseed_product_id: product.id,
        treeseed_product_version_id: offer.productVersionId ?? product.currentVersionId ?? null,
        treeseed_offer_id: offer.id,
        treeseed_price_id: price?.id ?? null,
        treeseed_price_version: price?.priceVersion ?? null,
        treeseed_ownership_model: product.ownershipModel,
        treeseed_ownership_record_id: ownership?.id ?? product.ownershipRecordId ?? null,
        treeseed_object_authority: 'treeseed',
        treeseed_checkout_phase: 'phase_5',
    };
}
export async function resolveCommerceCheckoutItem({ store, stripeConnectService, item }) {
    const offerId = optionalTrimmedString(item?.offerId);
    if (!offerId)
        throw commerceCheckoutError('offerId is required for checkout items.', 400);
    const offer = await store.getCommerceOffer(offerId);
    if (!offer)
        throw commerceCheckoutError(`Unknown commerce offer "${offerId}".`, 404);
    if (!CHECKOUT_OFFER_MODES.has(offer.mode)) {
        throw commerceCheckoutError(`Offer mode "${offer.mode}" is not supported by Phase 5 checkout.`, 409, { offerId, mode: offer.mode });
    }
    if (offer.status !== 'approved')
        throw commerceCheckoutError('Checkout requires an approved offer.', 409, { offerId, status: offer.status });
    const product = await store.getCommerceProduct(offer.productId);
    if (!product || product.status !== 'approved') {
        throw commerceCheckoutError('Checkout requires an approved product.', 409, { offerId, productId: offer.productId });
    }
    const vendor = await store.getCommerceVendor(offer.vendorId);
    if (!vendor || vendor.status !== 'approved' || vendor.salesEnabled !== true) {
        throw commerceCheckoutError('Checkout requires an approved sales-enabled vendor.', 409, { vendorId: offer.vendorId });
    }
    const priceId = optionalTrimmedString(item?.priceId) ?? offer.activePriceId;
    const price = priceId ? await store.getCommercePrice(priceId) : null;
    if (CHECKOUT_COMMERCIAL_OFFER_MODES.has(offer.mode)) {
        if (!price || price.offerId !== offer.id || price.status !== 'active') {
            throw commerceCheckoutError('Commercial checkout requires an active TreeSeed price for the offer.', 409, { offerId, priceId });
        }
        if (price.stripeSyncStatus !== 'synced' || !price.stripePriceId) {
            throw commerceCheckoutError('Commercial checkout requires a synced Stripe Price mirror.', 409, { offerId, priceId: price.id, stripeSyncStatus: price.stripeSyncStatus });
        }
    }
    else if (price && price.offerId !== offer.id) {
        throw commerceCheckoutError('Checkout price must belong to the selected offer.', 400, { offerId, priceId: price.id });
    }
    const environment = stripeConnectService.environment ?? 'test';
    const account = CHECKOUT_COMMERCIAL_OFFER_MODES.has(offer.mode)
        ? await store.getCommerceVendorStripeAccount(vendor.id, environment)
        : null;
    if (CHECKOUT_COMMERCIAL_OFFER_MODES.has(offer.mode) && (!account || account.accountStatus !== 'enabled')) {
        throw commerceCheckoutError('Commercial checkout requires an enabled Stripe connected account.', 409, { vendorId: vendor.id });
    }
    const ownershipRecords = await store.listCommerceOwnershipRecords(product.id).catch(() => []);
    const ownership = ownershipRecords.find((record) => record.id === product.ownershipRecordId) ?? ownershipRecords[0] ?? null;
    const stewards = await store.listCommerceStewardshipAssignments(product.id).catch(() => []);
    const ownershipSnapshot = {
        capturedAt: new Date().toISOString(),
        productId: product.id,
        ownershipModel: product.ownershipModel,
        ownershipRecord: ownership,
        stewards: stewards.filter((assignment) => assignment.visibleToBuyers !== false),
        sellerTeamId: product.sellerTeamId,
        vendorId: vendor.id,
    };
    const quantity = normalizeCheckoutQuantity(item?.quantity);
    const unitAmount = Number(price?.amount ?? 0);
    return {
        offer,
        product,
        vendor,
        price,
        account,
        ownership,
        ownershipSnapshot,
        quantity,
        unitAmount,
        totalAmount: unitAmount * quantity,
        currency: (price?.currency ?? 'usd').toLowerCase(),
        productVersionId: offer.mode === 'one_time_current_version'
            ? (offer.productVersionId ?? product.currentVersionId ?? null)
            : (offer.productVersionId ?? product.currentVersionId ?? null),
        metadata: buildCommerceCheckoutMetadata({ product, offer, price, vendor, ownership, environment }),
    };
}
export function checkoutGroupKind(mode) {
    if (mode === 'free')
        return 'free';
    if (CHECKOUT_SUBSCRIPTION_OFFER_MODES.has(mode))
        return 'subscription';
    return 'one_time';
}
export function checkoutGroupKey(item) {
    const kind = checkoutGroupKind(item.offer.mode);
    if (kind === 'subscription')
        return `${kind}:${item.vendor.id}:${item.currency}:${item.price?.billingInterval ?? 'month'}`;
    return `${kind}:${item.vendor.id}:${item.currency}`;
}
export function checkoutGroupStatus(groups) {
    const completed = groups.filter((group) => group.status === 'succeeded').length;
    if (completed === groups.length)
        return { status: 'completed', completed };
    if (completed > 0)
        return { status: 'partially_confirmed', completed };
    return { status: 'requires_confirmation', completed };
}

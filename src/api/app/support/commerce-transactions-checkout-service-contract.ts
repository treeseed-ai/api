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
import { jsonError, jsonThrownError, POSTGRES_AUTH_PROVIDER_ID, availabilityAttempts, AUTH_PROVIDERS, providerJwksCache, availabilityRateLimit, personalThemeFromRow, accountDeletionBlockers, consumeReauthentication, loadNotificationPreferences, providerConfigFor, base64Url, verifyProviderIdToken, exchangeProviderIdentity, resolveLaunchTemplateRequirements, projectHostBindingMetadata, sourceFromProjectDetails, repositoryInventoryWithPlatform, loadProjectHostBindingContext, projectHostResponsePayload, hostBindingRequiresUnlock, hostKindForBinding, createProjectHostCredentialSessions, persistProjectHostBindingOperationMetadata, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, plaintextHostCredentialFieldPaths, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, markdownToPlainProjectSummary, parseBooleanEnvValue, shouldLogApiRequests, shouldExposeNonProductionAuthDiagnostics, SENSITIVE_QUERY_PARAM_PATTERN, redactedRequestTarget, installApiRequestLogger, AGENT_PROMOTION_APPROVAL_DECISIONS, readJsonOrFormBody, normalizeEmail, normalizeUsername, parseJsonObject, trimmedHeaderValue, requestClientIp, requestSessionMetadata, webSessionData, validateMarketPassword, hashMarketPassword, verifyMarketPassword, ensureMarketCredentialSchema, MARKET_EMAIL_CONFIRMATION_PREFIX, marketAuthContext, shouldBypassAcceptanceAuthEmailDelivery, marketEmailTokenHash, exposeAuthTokenForTests, authTokenTimestampSeconds, authTokenTimestampMillis, sanitizedReturnTo, confirmationUrlFor, teamInviteAcceptUrlFor, passwordResetUrlFor, sendTeamInviteEmail, createMarketEmailConfirmation, serializeUserEmailAddress, backfillUserEmailAddresses, listUserEmailAddresses, getUserEmailAddress, verifiedEmailCount, setPrimaryEmailAddress, syncPrimaryEmailCaches, createOrResendUserEmailAddress, createMarketWebSession, webAuthPayload, normalizeAppearancePreference, normalizeBaseUrl, normalizeDomainName, normalizeProjectDomainInput, inferZoneNameForDomain, domainInZone, optionalTrimmedString, enumValue, unknownKeys, LOCAL_CONTENT_COLLECTIONS, LOCAL_WORK_CONTENT_COLLECTIONS, LOCAL_DECISION_TYPE_VALUES, PROPOSAL_VERDICT_DECISION_TYPES, PLATFORM_OPERATION_SCOPES, LOCAL_CONTENT_DEFAULTS, slugifyContent, yamlScalar, yamlLines, serializeFrontmatter, normalizeRelationArray, uniqueRelationArray, addRelationValue, normalizeLocalContentInput, writeLocalContentRecord, localContentRoot, localContentPath, readLocalContentRecord, writeParsedLocalContentRecord, createRelatedLocalContentRecord, createDecisionFromProposals, isLoopbackUrl, resolveAuthApprovalBaseUrl, findById, resolveAgentArtifactBucket, centralMarketProfile, normalizeMarketProfile, encryptedHostPayloadLooksValid, decryptedHostConfigSummary, credentialSessionSecret, credentialSessionKey, encryptCredentialSessionPayload, decryptCredentialSessionPayload, normalizeProviderCredentialConfig, HOST_KIND_SESSION_KEYS, normalizeAuditHostKinds, providerCredentialValuesForAudit, collectHostingAuditCredentialOverlay, nonSecretLaunchJobInput, decryptTeamHostForLaunch, mergeStringConfig, buildLaunchCredentialOverlay, patchLaunchIntentForCredentialOverlay, appendLaunchDeploymentEvent, scheduleBackgroundBootstrap, sanitizeLaunchResultForStorage, cloudflareErrorMessage, cloudflareRequestForLaunchPreflight, resolveCloudflareZoneForLaunchPreflight, verifyCloudflareDnsWriteForLaunch, projectDeletionConfirmationMatches, projectDeletionBlockerRows, cloudflareRequestForProjectDeletion, githubRequestForProjectDeletion, projectDeletionOperation, cloudflareDeletionAuthenticationMessage, hasRecordedCloudflareRuntimeResources, canSkipCloudflareCleanupAfterFailedLaunch, projectDeletionHostname, normalizedCloudflareKvNamespaceReference, uniqueCloudflareKvNamespaceReferences, cloudflareProjectDeletionResourceNames, resolveProjectDeletionCloudflareZone, deleteCloudflareDnsRecordsForProject, listCloudflareNamedResources, deleteCloudflareProjectResources, appendProjectDeletionProgress, cloudflareDnsDomainsForHostValidation, validateTeamHostCredentialPayload, runProjectLaunchApiBootstrap, runProjectDeletionApiDestroy, retryApiLaunchBootstrapFromRequest, GITHUB_ACTIONS_OIDC_ISSUER, githubOidcJwksCache, base64urlJson, parseBase64urlJson, operationTokenSecret, signOperationToken, verifyOperationToken, loadGitHubOidcJwks, verifyGitHubOidcToken, normalizeCiEnvironment, ciOperationForAction, fallbackRemoteCapability, normalizeRepositorySlug, projectAllowedCiRepositories, validateCiRefForEnvironment, marketProfilesForTeams, artifactDownloadPayload, principalHasPermission, principalIsSeedAdmin, isTeamApiPrincipal, isLocalAcceptanceServicePrincipal, localAcceptanceAdminToken, localAcceptanceAuthEnabled, decorateJob, safePlatformOperationOutput, decoratePlatformOperation, safeTokenEquals, resolvePlatformRunnerSecret, platformOperationMutationError, requirePlatformRunner, resolvePlatformRepositoryDescriptor, mergeCapability, canonicalArchitectureTopology, launchPlannerRepositoryTopology, launchCapabilityPreset, resourceRowsFromLaunch, ensurePrincipal, resolveUiProjectionContext, decodeRouteParam, uiRuntimeLocals, requireConfiguredServiceCredential, resolvePublicTreeDxTeam, enqueueTreeDxProvisionOperation, principalHasGlobalPlatformRole, requireTeamAccess, requireProjectAccess, safePrivateKnowledgeSlug, privateKnowledgeAuditPayload, recordPrivateKnowledgeAudit, FEEDBACK_TYPES, FEEDBACK_SCREENSHOT_TYPES, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, cleanFeedbackString, safeFeedbackContext, safeFeedbackClient, safeFeedbackScreenshot, validateFeedbackAccess, recordFeedbackSubmission, normalizeSeedEnvironments, seedActor, seedExistingTeamIds, seedCreatesMissingTeams, requireSeedPlanAccess, requireSeedApplyAccess, requireProjectRunner, AGENT_TASK_SIGNATURES, resolveAgentTaskSignature, commerceErrorResponse, requireSellerTeamAccess, requireVendorOrderManager, requireServiceBuyerAccess, requireServiceSellerAccess, requireServiceParticipantAccess, redactCommerceServiceRequestForBuyer, requireCommerceCapacityListingAccess, requireCommerceCapacityInquiryAccess, remainingRefundableAmount, applyCommerceRefundState, resolveOrderItemForRefund, resolveFulfillmentArtifact, handleCommerceInvoiceWebhook, requireCommerceProductAccess, principalCanManageCommerceProduct, redactCommerceOwnershipWorkflow, requireCommerceOfferAccess, requireCatalogItemAccess, requireConnectedProjectRuntime, projectAppHref, unwrapLaunchOperationOutput, appendLaunchPhaseProjection, updateLaunchDeployments, hubRepositoryPolicies, applyHubLaunchResult, applyHubLaunchFailure, unwrapOperationPayload, applyContentPublishResult, executeInline, projectApiConnection, createProjectInternalClient, executeProjectApi, selectDispatchTarget, defaultConfig, createApiExtension, stripeConfiguredError, stripeVendorApprovalError, stripeAccountMissingError, stripeCommerceUrl, requireCommerceVendorForStripe, refreshCommerceStripeAccount, STRIPE_PRODUCT_MIRROR_OFFER_MODES, STRIPE_PRICE_MIRROR_OFFER_MODES, stripeMetadataValue, buildCommerceStripeMetadata, commerceStripeProductParams, commerceStripeLookupKey, commerceStripePriceParams, stripePriceTermsDrift, commerceStripeSyncContext, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, resolveStripePublishableKey, resolveStripeWebhookSecret, stripeClientSecret, subscriptionStatusFromStripe, entitlementRenewalStateFromSubscription, stripeTimestampToIso, subscriptionClientSecret, grantCommerceEntitlementsForOrder, stripeRefundStatus, ensureCommerceStripeCustomer, syncCommerceSubscriptionFromStripe, handleCommerceSubscriptionWebhook, processCommerceStripeWebhook, CHECKOUT_OFFER_MODES, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, commerceCheckoutError, normalizeCheckoutQuantity, paymentGroupStatusFromPaymentIntent, orderStatusFromPaymentGroup, publicPaymentGroups, buildCommerceCheckoutMetadata, resolveCommerceCheckoutItem, checkoutGroupKind, checkoutGroupKey, checkoutGroupStatus, createCommerceCheckoutRun, refreshCommercePaymentGroupState, updateCheckoutCompletionFromGroup, handleCommercePaymentIntentWebhook } from './index.ts';
export async function createCommerceCheckoutRunForServiceContract({ store, stripeConnectService, principal, contractId, input = {} as Record<string, unknown> }) {
    const contract = await store.getCommerceServiceContract(contractId);
    if (!contract)
        throw commerceCheckoutError(`Unknown commerce service contract "${contractId}".`, 404);
    if (contract.status !== 'pending_checkout') {
        throw commerceCheckoutError('Scoped service contract checkout requires a pending checkout contract.', 409, { contractId, status: contract.status });
    }
    const request = await store.getCommerceServiceRequest(contract.requestId);
    const quote = await store.getCommerceServiceQuote(contract.quoteId);
    if (!request || !quote || quote.status !== 'accepted') {
        throw commerceCheckoutError('Scoped service checkout requires an accepted quote.', 409, { contractId, quoteId: contract.quoteId });
    }
    const offer = await store.getCommerceOffer(contract.offerId);
    const product = await store.getCommerceProduct(contract.productId);
    const vendor = await store.getCommerceVendor(contract.vendorId);
    if (!offer || offer.status !== 'approved' || offer.mode !== 'scoped_contract') {
        throw commerceCheckoutError('Scoped service checkout requires an approved scoped contract offer.', 409, { offerId: contract.offerId });
    }
    if (!product || product.status !== 'approved' || product.kind !== 'scoped_service') {
        throw commerceCheckoutError('Scoped service checkout requires an approved scoped service product.', 409, { productId: contract.productId });
    }
    if (!vendor || vendor.status !== 'approved' || vendor.serviceSalesEnabled !== true) {
        throw commerceCheckoutError('Scoped service checkout requires an approved service-enabled vendor.', 409, { vendorId: contract.vendorId });
    }
    const environment = stripeConnectService.environment ?? 'test';
    const account = await store.getCommerceVendorStripeAccount(vendor.id, environment);
    if (!account || account.accountStatus !== 'enabled') {
        throw commerceCheckoutError('Scoped service checkout requires an enabled Stripe connected account.', 409, { vendorId: vendor.id });
    }
    if (!await stripeConnectService.isConfigured())
        throw stripeConfiguredError();
    const buyerTeamId = request.buyerTeamId ?? input.buyerTeamId ?? null;
    const buyerUserId = request.buyerUserId ?? principal?.id ?? null;
    const cart = await store.createCommerceCart(principal, {
        buyerTeamId,
        buyerUserId,
        currency: quote.currency,
        metadata: { serviceRequestId: request.id, serviceContractId: contract.id },
    });
    const checkout = await store.createCommerceCheckout({
        cartId: cart.id,
        buyerTeamId,
        buyerUserId,
        status: 'requires_confirmation',
        groupCount: 1,
        actorId: principal?.id ?? null,
        metadata: { checkoutMode: 'stripe_elements_grouped_vendor', serviceRequestId: request.id, serviceContractId: contract.id },
    });
    const order = await store.createCommerceOrder({
        checkoutId: checkout.id,
        cartId: cart.id,
        buyerTeamId,
        buyerUserId,
        vendorId: vendor.id,
        sellerTeamId: vendor.teamId,
        status: 'pending_payment',
        currency: quote.currency,
        subtotalAmount: quote.amount,
        totalAmount: quote.amount,
        stripeConnectedAccountId: account.stripeAccountId,
        ownershipSnapshot: contract.ownershipSnapshot ?? request.ownershipSnapshot ?? {},
        actorId: principal?.id ?? null,
        metadata: {
            checkoutId: checkout.id,
            groupKind: 'one_time',
            serviceRequestId: request.id,
            serviceQuoteId: quote.id,
            serviceContractId: contract.id,
        },
    });
    const orderItem = await store.createCommerceOrderItem(order.id, {
        vendorId: vendor.id,
        sellerTeamId: vendor.teamId,
        productId: product.id,
        productVersionId: offer.productVersionId ?? product.currentVersionId ?? null,
        offerId: offer.id,
        priceId: null,
        mode: 'scoped_contract',
        quantity: 1,
        unitAmount: quote.amount,
        totalAmount: quote.amount,
        currency: quote.currency,
        status: 'pending',
        ownershipSnapshot: contract.ownershipSnapshot ?? request.ownershipSnapshot ?? {},
        accessScope: {
            ...(offer.accessScope ?? {}),
            serviceRequestId: request.id,
            serviceQuoteId: quote.id,
            serviceContractId: contract.id,
            scopeSummary: quote.scopeSummary,
            accessRequirements: quote.accessRequirements,
        },
        supportScope: offer.supportScope ?? {},
        metadata: {
            catalogItemId: product.catalogItemId,
            serviceRequestId: request.id,
            serviceQuoteId: quote.id,
            serviceContractId: contract.id,
            quoteVersion: quote.quoteVersion,
        },
    });
    const paymentIntent = await stripeConnectService.createPaymentIntent({
        connectedAccountId: account.stripeAccountId,
        params: {
            amount: quote.amount,
            currency: quote.currency,
            automatic_payment_methods: { enabled: true },
            metadata: {
                treeseed_checkout_id: checkout.id,
                treeseed_order_id: order.id,
                treeseed_order_item_id: orderItem.id,
                treeseed_vendor_id: vendor.id,
                treeseed_seller_team_id: vendor.teamId,
                treeseed_product_id: product.id,
                treeseed_offer_id: offer.id,
                treeseed_service_request_id: request.id,
                treeseed_service_quote_id: quote.id,
                treeseed_service_contract_id: contract.id,
                treeseed_object_authority: 'treeseed',
                treeseed_checkout_phase: 'phase_8_scoped_service',
            },
        },
    });
    const paymentGroup = await store.createCommercePaymentGroup({
        checkoutId: checkout.id,
        orderId: order.id,
        vendorId: vendor.id,
        sellerTeamId: vendor.teamId,
        connectedAccountId: account.stripeAccountId,
        groupKind: 'one_time',
        status: paymentGroupStatusFromPaymentIntent(paymentIntent),
        currency: quote.currency,
        subtotalAmount: quote.amount,
        totalAmount: quote.amount,
        stripePaymentIntentId: paymentIntent?.id ?? null,
        clientSecret: stripeClientSecret(paymentIntent?.client_secret),
        metadata: { serviceRequestId: request.id, serviceQuoteId: quote.id, serviceContractId: contract.id },
        actorId: principal?.id ?? null,
    });
    await store.updateCommerceOrderStatus(order.id, {
        status: orderStatusFromPaymentGroup(paymentGroup.status),
        stripePaymentIntentId: paymentIntent?.id ?? null,
        stripeConnectedAccountId: account.stripeAccountId,
    });
    await store.attachCommerceServiceOrder(contract.id, {
        orderId: order.id,
        orderItemId: orderItem.id,
        paymentGroupId: paymentGroup.id,
        actorType: 'user',
        actorId: principal?.id ?? null,
    });
    await store.markCommerceCartConverted(cart.id, checkout.id);
    return {
        checkout: await store.getCommerceCheckout(checkout.id),
        orders: [await store.getCommerceOrder(order.id)],
        paymentGroups: publicPaymentGroups([paymentGroup]),
        entitlements: [],
    };
}

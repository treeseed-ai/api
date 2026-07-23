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
import { jsonError, jsonThrownError, POSTGRES_AUTH_PROVIDER_ID, availabilityAttempts, AUTH_PROVIDERS, providerJwksCache, availabilityRateLimit, personalThemeFromRow, accountDeletionBlockers, consumeReauthentication, loadNotificationPreferences, providerConfigFor, base64Url, verifyProviderIdToken, exchangeProviderIdentity, resolveLaunchTemplateRequirements, projectHostBindingMetadata, sourceFromProjectDetails, repositoryInventoryWithPlatform, loadProjectHostBindingContext, projectHostResponsePayload, hostBindingRequiresUnlock, hostKindForBinding, createProjectHostCredentialSessions, persistProjectHostBindingOperationMetadata, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, plaintextHostCredentialFieldPaths, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, markdownToPlainProjectSummary, parseBooleanEnvValue, shouldLogApiRequests, shouldExposeNonProductionAuthDiagnostics, SENSITIVE_QUERY_PARAM_PATTERN, redactedRequestTarget, installApiRequestLogger, AGENT_PROMOTION_APPROVAL_DECISIONS, readJsonOrFormBody, normalizeEmail, normalizeUsername, parseJsonObject, trimmedHeaderValue, requestClientIp, requestSessionMetadata, webSessionData, validateMarketPassword, hashMarketPassword, verifyMarketPassword, ensureMarketCredentialSchema, MARKET_EMAIL_CONFIRMATION_PREFIX, marketAuthContext, shouldBypassAcceptanceAuthEmailDelivery, marketEmailTokenHash, exposeAuthTokenForTests, authTokenTimestampSeconds, authTokenTimestampMillis, sanitizedReturnTo, confirmationUrlFor, teamInviteAcceptUrlFor, passwordResetUrlFor, sendTeamInviteEmail, createMarketEmailConfirmation, serializeUserEmailAddress, backfillUserEmailAddresses, listUserEmailAddresses, getUserEmailAddress, verifiedEmailCount, setPrimaryEmailAddress, syncPrimaryEmailCaches, createOrResendUserEmailAddress, createMarketWebSession, webAuthPayload, normalizeAppearancePreference, normalizeBaseUrl, normalizeDomainName, normalizeProjectDomainInput, inferZoneNameForDomain, domainInZone, optionalTrimmedString, enumValue, unknownKeys, LOCAL_CONTENT_COLLECTIONS, LOCAL_WORK_CONTENT_COLLECTIONS, LOCAL_DECISION_TYPE_VALUES, PROPOSAL_VERDICT_DECISION_TYPES, PLATFORM_OPERATION_SCOPES, LOCAL_CONTENT_DEFAULTS, slugifyContent, yamlScalar, yamlLines, serializeFrontmatter, normalizeRelationArray, uniqueRelationArray, addRelationValue, normalizeLocalContentInput, writeLocalContentRecord, localContentRoot, localContentPath, readLocalContentRecord, writeParsedLocalContentRecord, createRelatedLocalContentRecord, createDecisionFromProposals, isLoopbackUrl, resolveAuthApprovalBaseUrl, findById, resolveAgentArtifactBucket, centralMarketProfile, normalizeMarketProfile, encryptedHostPayloadLooksValid, decryptedHostConfigSummary, credentialSessionSecret, credentialSessionKey, encryptCredentialSessionPayload, decryptCredentialSessionPayload, normalizeProviderCredentialConfig, HOST_KIND_SESSION_KEYS, normalizeAuditHostKinds, providerCredentialValuesForAudit, collectHostingAuditCredentialOverlay, nonSecretLaunchJobInput, decryptTeamHostForLaunch, mergeStringConfig, buildLaunchCredentialOverlay, patchLaunchIntentForCredentialOverlay, appendLaunchDeploymentEvent, scheduleBackgroundBootstrap, sanitizeLaunchResultForStorage, cloudflareErrorMessage, cloudflareRequestForLaunchPreflight, resolveCloudflareZoneForLaunchPreflight, verifyCloudflareDnsWriteForLaunch, projectDeletionConfirmationMatches, projectDeletionBlockerRows, cloudflareRequestForProjectDeletion, githubRequestForProjectDeletion, projectDeletionOperation, cloudflareDeletionAuthenticationMessage, hasRecordedCloudflareRuntimeResources, canSkipCloudflareCleanupAfterFailedLaunch, projectDeletionHostname, normalizedCloudflareKvNamespaceReference, uniqueCloudflareKvNamespaceReferences, cloudflareProjectDeletionResourceNames, resolveProjectDeletionCloudflareZone, deleteCloudflareDnsRecordsForProject, listCloudflareNamedResources, deleteCloudflareProjectResources, appendProjectDeletionProgress, cloudflareDnsDomainsForHostValidation, validateTeamHostCredentialPayload, runProjectLaunchApiBootstrap, runProjectDeletionApiDestroy, retryApiLaunchBootstrapFromRequest, GITHUB_ACTIONS_OIDC_ISSUER, githubOidcJwksCache, base64urlJson, parseBase64urlJson, operationTokenSecret, signOperationToken, verifyOperationToken, loadGitHubOidcJwks, verifyGitHubOidcToken, normalizeCiEnvironment, ciOperationForAction, fallbackRemoteCapability, normalizeRepositorySlug, projectAllowedCiRepositories, validateCiRefForEnvironment, marketProfilesForTeams, artifactDownloadPayload, principalHasPermission, principalIsSeedAdmin, isTeamApiPrincipal, isLocalAcceptanceServicePrincipal, localAcceptanceAdminToken, localAcceptanceAuthEnabled, decorateJob, safePlatformOperationOutput, decoratePlatformOperation, safeTokenEquals, resolvePlatformRunnerSecret, platformOperationMutationError, requirePlatformRunner, resolvePlatformRepositoryDescriptor, mergeCapability, canonicalArchitectureTopology, launchPlannerRepositoryTopology, launchCapabilityPreset, resourceRowsFromLaunch, ensurePrincipal, resolveUiProjectionContext, decodeRouteParam, uiRuntimeLocals, requireConfiguredServiceCredential, resolvePublicTreeDxTeam, enqueueTreeDxProvisionOperation, principalHasGlobalPlatformRole, requireTeamAccess, requireProjectAccess, safePrivateKnowledgeSlug, privateKnowledgeAuditPayload, recordPrivateKnowledgeAudit, FEEDBACK_TYPES, FEEDBACK_SCREENSHOT_TYPES, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, cleanFeedbackString, safeFeedbackContext, safeFeedbackClient, safeFeedbackScreenshot, validateFeedbackAccess, recordFeedbackSubmission, normalizeSeedEnvironments, seedActor, seedExistingTeamIds, seedCreatesMissingTeams, requireSeedPlanAccess, requireSeedApplyAccess, requireProjectRunner, AGENT_TASK_SIGNATURES, resolveAgentTaskSignature, commerceErrorResponse, requireSellerTeamAccess, requireVendorOrderManager, requireServiceBuyerAccess, requireServiceSellerAccess, requireServiceParticipantAccess, redactCommerceServiceRequestForBuyer, requireCommerceCapacityListingAccess, requireCommerceCapacityInquiryAccess, remainingRefundableAmount, applyCommerceRefundState, resolveOrderItemForRefund, resolveFulfillmentArtifact, handleCommerceInvoiceWebhook, requireCommerceProductAccess, principalCanManageCommerceProduct, redactCommerceOwnershipWorkflow, requireCommerceOfferAccess, requireCatalogItemAccess, requireConnectedProjectRuntime, projectAppHref, unwrapLaunchOperationOutput, appendLaunchPhaseProjection, updateLaunchDeployments, hubRepositoryPolicies, applyHubLaunchResult, applyHubLaunchFailure, unwrapOperationPayload, applyContentPublishResult, executeInline, projectApiConnection, createProjectInternalClient, executeProjectApi, selectDispatchTarget, defaultConfig, createApiExtension, stripeConfiguredError, stripeVendorApprovalError, stripeAccountMissingError, stripeCommerceUrl, requireCommerceVendorForStripe, refreshCommerceStripeAccount, STRIPE_PRODUCT_MIRROR_OFFER_MODES, STRIPE_PRICE_MIRROR_OFFER_MODES, stripeMetadataValue, buildCommerceStripeMetadata, commerceStripeProductParams, commerceStripeLookupKey, commerceStripePriceParams, stripePriceTermsDrift, commerceStripeSyncContext, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, resolveStripePublishableKey, resolveStripeWebhookSecret, stripeClientSecret, subscriptionStatusFromStripe, entitlementRenewalStateFromSubscription, stripeTimestampToIso, subscriptionClientSecret, grantCommerceEntitlementsForOrder, stripeRefundStatus, ensureCommerceStripeCustomer, syncCommerceSubscriptionFromStripe, handleCommerceSubscriptionWebhook, processCommerceStripeWebhook, CHECKOUT_OFFER_MODES, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, commerceCheckoutError, normalizeCheckoutQuantity, paymentGroupStatusFromPaymentIntent, orderStatusFromPaymentGroup, publicPaymentGroups, buildCommerceCheckoutMetadata, resolveCommerceCheckoutItem, checkoutGroupKind, checkoutGroupKey, checkoutGroupStatus, createCommerceCheckoutRunForServiceContract, refreshCommercePaymentGroupState, updateCheckoutCompletionFromGroup, handleCommercePaymentIntentWebhook } from './index.ts';
export async function createCommerceCheckoutRun({ store, stripeConnectService, principal, input = {} as Record<string, unknown> }) {
    const buyerTeamId = optionalTrimmedString(input.buyerTeamId) ?? null;
    const buyerUserId = principal?.id ?? null;
    let cart = null;
    let rawItems = Array.isArray(input.items) ? input.items : [];
    if (input.cartId) {
        cart = await store.getCommerceCart(optionalTrimmedString(input.cartId));
        if (!cart)
            throw commerceCheckoutError(`Unknown commerce cart "${input.cartId}".`, 404);
        rawItems = (await store.listCommerceCartItems(cart.id)).filter((item) => item.status === 'active');
    }
    if (!rawItems.length)
        throw commerceCheckoutError('Checkout requires at least one item.', 400);
    if (!cart) {
        cart = await store.createCommerceCart(principal, { buyerTeamId, buyerUserId });
        for (const item of rawItems) {
            await store.addCommerceCartItem(cart.id, {
                offerId: item.offerId,
                priceId: item.priceId,
                quantity: item.quantity,
                actorId: buyerUserId,
            });
        }
        rawItems = (await store.listCommerceCartItems(cart.id)).filter((item) => item.status === 'active');
    }
    const resolvedItems = [];
    for (const item of rawItems) {
        resolvedItems.push(await resolveCommerceCheckoutItem({ store, stripeConnectService, item }));
    }
    const groupMap = new Map();
    for (const item of resolvedItems) {
        const key = checkoutGroupKey(item);
        if (!groupMap.has(key)) {
            groupMap.set(key, {
                key,
                kind: checkoutGroupKind(item.offer.mode),
                vendor: item.vendor,
                account: item.account,
                currency: item.currency,
                billingInterval: CHECKOUT_SUBSCRIPTION_OFFER_MODES.has(item.offer.mode) ? item.price?.billingInterval ?? 'month' : null,
                items: [],
            });
        }
        groupMap.get(key).items.push(item);
    }
    const checkout = await store.createCommerceCheckout({
        cartId: cart.id,
        buyerTeamId: cart.buyerTeamId ?? buyerTeamId,
        buyerUserId: cart.buyerUserId ?? buyerUserId,
        status: 'requires_confirmation',
        groupCount: groupMap.size,
        actorId: buyerUserId,
        metadata: { checkoutMode: 'stripe_elements_grouped_vendor' },
    });
    const orders = [];
    const paymentGroups = [];
    const entitlements = [];
    for (const group of groupMap.values()) {
        const subtotal = group.items.reduce((sum, item) => sum + item.totalAmount, 0);
        const order = await store.createCommerceOrder({
            checkoutId: checkout.id,
            cartId: cart.id,
            buyerTeamId: cart.buyerTeamId ?? buyerTeamId,
            buyerUserId: cart.buyerUserId ?? buyerUserId,
            vendorId: group.vendor.id,
            sellerTeamId: group.vendor.teamId,
            status: group.kind === 'free' ? 'paid' : 'pending_payment',
            currency: group.currency,
            subtotalAmount: subtotal,
            totalAmount: subtotal,
            stripeConnectedAccountId: group.account?.stripeAccountId ?? null,
            ownershipSnapshot: {
                capturedAt: new Date().toISOString(),
                items: group.items.map((item) => item.ownershipSnapshot),
            },
            actorId: buyerUserId,
            metadata: { checkoutId: checkout.id, groupKind: group.kind },
        });
        for (const item of group.items) {
            await store.createCommerceOrderItem(order.id, {
                vendorId: item.vendor.id,
                sellerTeamId: item.product.sellerTeamId,
                productId: item.product.id,
                productVersionId: item.productVersionId,
                offerId: item.offer.id,
                priceId: item.price?.id ?? null,
                mode: item.offer.mode,
                quantity: item.quantity,
                unitAmount: item.unitAmount,
                totalAmount: item.totalAmount,
                currency: item.currency,
                status: group.kind === 'free' ? 'paid' : 'pending',
                ownershipSnapshot: item.ownershipSnapshot,
                accessScope: item.offer.accessScope ?? {},
                supportScope: item.offer.supportScope ?? {},
                metadata: {
                    catalogItemId: item.product.catalogItemId,
                    artifactRefs: item.productVersionId ? [{ productVersionId: item.productVersionId }] : [],
                    priceVersion: item.price?.priceVersion ?? null,
                },
            });
        }
        let paymentGroup = null;
        if (group.kind === 'free') {
            paymentGroup = await store.createCommercePaymentGroup({
                checkoutId: checkout.id,
                orderId: order.id,
                vendorId: group.vendor.id,
                sellerTeamId: group.vendor.teamId,
                groupKind: 'free',
                status: 'succeeded',
                currency: group.currency,
                subtotalAmount: 0,
                totalAmount: 0,
                actorId: buyerUserId,
            });
            entitlements.push(...await grantCommerceEntitlementsForOrder({ store, order, status: 'active', renewalState: 'none' }));
        }
        else if (group.kind === 'one_time') {
            if (!await stripeConnectService.isConfigured())
                throw stripeConfiguredError();
            const paymentIntent = await stripeConnectService.createPaymentIntent({
                connectedAccountId: group.account.stripeAccountId,
                params: {
                    amount: subtotal,
                    currency: group.currency,
                    automatic_payment_methods: { enabled: true },
                    metadata: {
                        treeseed_checkout_id: checkout.id,
                        treeseed_order_id: order.id,
                        treeseed_vendor_id: group.vendor.id,
                        treeseed_seller_team_id: group.vendor.teamId,
                        treeseed_object_authority: 'treeseed',
                        treeseed_checkout_phase: 'phase_5',
                    },
                },
            });
            await store.updateCommerceOrderStatus(order.id, {
                status: orderStatusFromPaymentGroup(paymentGroupStatusFromPaymentIntent(paymentIntent)),
                stripePaymentIntentId: paymentIntent?.id ?? null,
                stripeConnectedAccountId: group.account.stripeAccountId,
            });
            paymentGroup = await store.createCommercePaymentGroup({
                checkoutId: checkout.id,
                orderId: order.id,
                vendorId: group.vendor.id,
                sellerTeamId: group.vendor.teamId,
                connectedAccountId: group.account.stripeAccountId,
                groupKind: 'one_time',
                status: paymentGroupStatusFromPaymentIntent(paymentIntent),
                currency: group.currency,
                subtotalAmount: subtotal,
                totalAmount: subtotal,
                stripePaymentIntentId: paymentIntent?.id ?? null,
                clientSecret: stripeClientSecret(paymentIntent?.client_secret),
                actorId: buyerUserId,
            });
        }
        else {
            if (!await stripeConnectService.isConfigured())
                throw stripeConfiguredError();
            const customer = await ensureCommerceStripeCustomer({
                store,
                stripeConnectService,
                group,
                buyerTeamId: cart.buyerTeamId ?? buyerTeamId,
                buyerUserId: cart.buyerUserId ?? buyerUserId,
            });
            const subscription = await stripeConnectService.createSubscription({
                connectedAccountId: group.account.stripeAccountId,
                params: {
                    customer: customer.stripeCustomerId,
                    items: group.items.map((item) => ({ price: item.price.stripePriceId, quantity: item.quantity })),
                    payment_behavior: 'default_incomplete',
                    payment_settings: { save_default_payment_method: 'on_subscription' },
                    expand: ['latest_invoice.payment_intent'],
                    metadata: {
                        treeseed_checkout_id: checkout.id,
                        treeseed_order_id: order.id,
                        treeseed_vendor_id: group.vendor.id,
                        treeseed_seller_team_id: group.vendor.teamId,
                        treeseed_object_authority: 'treeseed',
                        treeseed_checkout_phase: 'phase_5',
                    },
                },
            });
            const firstItem = group.items[0];
            const localSubscription = await store.createCommerceSubscription({
                orderId: order.id,
                vendorId: group.vendor.id,
                sellerTeamId: group.vendor.teamId,
                buyerTeamId: cart.buyerTeamId ?? buyerTeamId,
                buyerUserId: cart.buyerUserId ?? buyerUserId,
                offerId: firstItem.offer.id,
                priceId: firstItem.price.id,
                status: subscriptionStatusFromStripe(subscription),
                renewalState: entitlementRenewalStateFromSubscription(subscriptionStatusFromStripe(subscription)),
                stripeSubscriptionId: subscription.id,
                stripeCustomerId: customer.stripeCustomerId,
                stripeConnectedAccountId: group.account.stripeAccountId,
                currentPeriodStart: stripeTimestampToIso(subscription.current_period_start),
                currentPeriodEnd: stripeTimestampToIso(subscription.current_period_end),
                cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
                canceledAt: stripeTimestampToIso(subscription.canceled_at),
                actorId: buyerUserId,
            });
            await store.updateCommerceOrderStatus(order.id, {
                status: ['active', 'trialing'].includes(localSubscription.status) ? 'paid' : 'pending_payment',
                stripeSubscriptionId: subscription.id,
                stripeCustomerId: customer.stripeCustomerId,
                stripeConnectedAccountId: group.account.stripeAccountId,
            });
            paymentGroup = await store.createCommercePaymentGroup({
                checkoutId: checkout.id,
                orderId: order.id,
                vendorId: group.vendor.id,
                sellerTeamId: group.vendor.teamId,
                connectedAccountId: group.account.stripeAccountId,
                groupKind: 'subscription',
                billingInterval: group.billingInterval,
                status: ['active', 'trialing'].includes(localSubscription.status) ? 'succeeded' : 'requires_confirmation',
                currency: group.currency,
                subtotalAmount: subtotal,
                totalAmount: subtotal,
                stripeSubscriptionId: subscription.id,
                stripeCustomerId: customer.stripeCustomerId,
                clientSecret: subscriptionClientSecret(subscription),
                actorId: buyerUserId,
            });
            if (['active', 'trialing'].includes(localSubscription.status)) {
                entitlements.push(...await grantCommerceEntitlementsForOrder({
                    store,
                    order: await store.getCommerceOrder(order.id),
                    subscription: localSubscription,
                    status: 'active',
                    renewalState: localSubscription.renewalState,
                }));
            }
        }
        orders.push(await store.getCommerceOrder(order.id));
        paymentGroups.push(paymentGroup);
    }
    await store.markCommerceCartConverted(cart.id, checkout.id);
    const status = checkoutGroupStatus(paymentGroups);
    const finalCheckout = await store.updateCommerceCheckoutStatus(checkout.id, {
        status: status.status,
        completedGroupCount: status.completed,
    });
    return {
        checkout: finalCheckout,
        orders,
        paymentGroups: publicPaymentGroups(paymentGroups),
        entitlements,
    };
}

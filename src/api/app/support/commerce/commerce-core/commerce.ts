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
import { jsonError, jsonThrownError, POSTGRES_AUTH_PROVIDER_ID, availabilityAttempts, AUTH_PROVIDERS, providerJwksCache, availabilityRateLimit, personalThemeFromRow, accountDeletionBlockers, consumeReauthentication, loadNotificationPreferences, providerConfigFor, base64Url, verifyProviderIdToken, exchangeProviderIdentity, resolveLaunchTemplateRequirements, projectHostBindingMetadata, sourceFromProjectDetails, repositoryInventoryWithPlatform, loadProjectHostBindingContext, projectHostResponsePayload, hostBindingRequiresUnlock, hostKindForBinding, createProjectHostCredentialSessions, persistProjectHostBindingOperationMetadata, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, plaintextHostCredentialFieldPaths, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, markdownToPlainProjectSummary, parseBooleanEnvValue, shouldLogApiRequests, shouldExposeNonProductionAuthDiagnostics, SENSITIVE_QUERY_PARAM_PATTERN, redactedRequestTarget, installApiRequestLogger, AGENT_PROMOTION_APPROVAL_DECISIONS, readJsonOrFormBody, normalizeEmail, normalizeUsername, parseJsonObject, trimmedHeaderValue, requestClientIp, requestSessionMetadata, webSessionData, validateMarketPassword, hashMarketPassword, verifyMarketPassword, ensureMarketCredentialSchema, MARKET_EMAIL_CONFIRMATION_PREFIX, marketAuthContext, shouldBypassAcceptanceAuthEmailDelivery, marketEmailTokenHash, exposeAuthTokenForTests, authTokenTimestampSeconds, authTokenTimestampMillis, sanitizedReturnTo, confirmationUrlFor, teamInviteAcceptUrlFor, passwordResetUrlFor, sendTeamInviteEmail, createMarketEmailConfirmation, serializeUserEmailAddress, backfillUserEmailAddresses, listUserEmailAddresses, getUserEmailAddress, verifiedEmailCount, setPrimaryEmailAddress, syncPrimaryEmailCaches, createOrResendUserEmailAddress, createMarketWebSession, webAuthPayload, normalizeAppearancePreference, normalizeBaseUrl, normalizeDomainName, normalizeProjectDomainInput, inferZoneNameForDomain, domainInZone, optionalTrimmedString, enumValue, unknownKeys, LOCAL_CONTENT_COLLECTIONS, LOCAL_WORK_CONTENT_COLLECTIONS, LOCAL_DECISION_TYPE_VALUES, PROPOSAL_VERDICT_DECISION_TYPES, PLATFORM_OPERATION_SCOPES, LOCAL_CONTENT_DEFAULTS, slugifyContent, yamlScalar, yamlLines, serializeFrontmatter, normalizeRelationArray, uniqueRelationArray, addRelationValue, normalizeLocalContentInput, writeLocalContentRecord, localContentRoot, localContentPath, readLocalContentRecord, writeParsedLocalContentRecord, createRelatedLocalContentRecord, createDecisionFromProposals, isLoopbackUrl, resolveAuthApprovalBaseUrl, findById, resolveAgentArtifactBucket, centralMarketProfile, normalizeMarketProfile, encryptedHostPayloadLooksValid, decryptedHostConfigSummary, credentialSessionSecret, credentialSessionKey, encryptCredentialSessionPayload, decryptCredentialSessionPayload, normalizeProviderCredentialConfig, HOST_KIND_SESSION_KEYS, normalizeAuditHostKinds, providerCredentialValuesForAudit, collectHostingAuditCredentialOverlay, nonSecretLaunchJobInput, decryptTeamHostForLaunch, mergeStringConfig, buildLaunchCredentialOverlay, patchLaunchIntentForCredentialOverlay, appendLaunchDeploymentEvent, scheduleBackgroundBootstrap, sanitizeLaunchResultForStorage, cloudflareErrorMessage, cloudflareRequestForLaunchPreflight, resolveCloudflareZoneForLaunchPreflight, verifyCloudflareDnsWriteForLaunch, projectDeletionConfirmationMatches, projectDeletionBlockerRows, cloudflareRequestForProjectDeletion, githubRequestForProjectDeletion, projectDeletionOperation, cloudflareDeletionAuthenticationMessage, hasRecordedCloudflareRuntimeResources, canSkipCloudflareCleanupAfterFailedLaunch, projectDeletionHostname, normalizedCloudflareKvNamespaceReference, uniqueCloudflareKvNamespaceReferences, cloudflareProjectDeletionResourceNames, resolveProjectDeletionCloudflareZone, deleteCloudflareDnsRecordsForProject, listCloudflareNamedResources, deleteCloudflareProjectResources, appendProjectDeletionProgress, cloudflareDnsDomainsForHostValidation, validateTeamHostCredentialPayload, runProjectLaunchApiBootstrap, runProjectDeletionApiDestroy, retryApiLaunchBootstrapFromRequest, GITHUB_ACTIONS_OIDC_ISSUER, githubOidcJwksCache, base64urlJson, parseBase64urlJson, operationTokenSecret, signOperationToken, verifyOperationToken, loadGitHubOidcJwks, verifyGitHubOidcToken, normalizeCiEnvironment, ciOperationForAction, fallbackRemoteCapability, normalizeRepositorySlug, projectAllowedCiRepositories, validateCiRefForEnvironment, marketProfilesForTeams, artifactDownloadPayload, principalHasPermission, principalIsSeedAdmin, isTeamApiPrincipal, isLocalAcceptanceServicePrincipal, localAcceptanceAdminToken, localAcceptanceAuthEnabled, decorateJob, safePlatformOperationOutput, decoratePlatformOperation, safeTokenEquals, resolvePlatformRunnerSecret, platformOperationMutationError, requirePlatformRunner, resolvePlatformRepositoryDescriptor, mergeCapability, canonicalArchitectureTopology, launchPlannerRepositoryTopology, launchCapabilityPreset, resourceRowsFromLaunch, ensurePrincipal, resolveUiProjectionContext, decodeRouteParam, uiRuntimeLocals, requireConfiguredServiceCredential, resolvePublicTreeDxTeam, enqueueTreeDxProvisionOperation, principalHasGlobalPlatformRole, requireTeamAccess, requireProjectAccess, safePrivateKnowledgeSlug, privateKnowledgeAuditPayload, recordPrivateKnowledgeAudit, FEEDBACK_TYPES, FEEDBACK_SCREENSHOT_TYPES, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, cleanFeedbackString, safeFeedbackContext, safeFeedbackClient, safeFeedbackScreenshot, validateFeedbackAccess, recordFeedbackSubmission, normalizeSeedEnvironments, seedActor, seedExistingTeamIds, seedCreatesMissingTeams, requireSeedPlanAccess, requireSeedApplyAccess, requireProjectRunner, AGENT_TASK_SIGNATURES, resolveAgentTaskSignature, stripeConfiguredError, stripeVendorApprovalError, stripeAccountMissingError, stripeCommerceUrl, requireCommerceVendorForStripe, refreshCommerceStripeAccount, STRIPE_PRODUCT_MIRROR_OFFER_MODES, STRIPE_PRICE_MIRROR_OFFER_MODES, stripeMetadataValue, buildCommerceStripeMetadata, commerceStripeProductParams, commerceStripeLookupKey, commerceStripePriceParams, stripePriceTermsDrift, commerceStripeSyncContext, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, CHECKOUT_OFFER_MODES, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, resolveStripePublishableKey, resolveStripeWebhookSecret, commerceCheckoutError, normalizeCheckoutQuantity, stripeClientSecret, paymentGroupStatusFromPaymentIntent, orderStatusFromPaymentGroup, subscriptionStatusFromStripe, entitlementRenewalStateFromSubscription, stripeTimestampToIso, subscriptionClientSecret, publicPaymentGroups, buildCommerceCheckoutMetadata, resolveCommerceCheckoutItem, checkoutGroupKind, checkoutGroupKey, checkoutGroupStatus, grantCommerceEntitlementsForOrder, requireSellerTeamAccess, requireVendorOrderManager, requireServiceBuyerAccess, requireServiceSellerAccess, requireServiceParticipantAccess, remainingRefundableAmount, stripeRefundStatus, resolveOrderItemForRefund, resolveFulfillmentArtifact, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, ensureCommerceStripeCustomer, refreshCommercePaymentGroupState, updateCheckoutCompletionFromGroup, syncCommerceSubscriptionFromStripe, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, processCommerceStripeWebhook, requireCatalogItemAccess, requireConnectedProjectRuntime, projectAppHref, unwrapLaunchOperationOutput, appendLaunchPhaseProjection, updateLaunchDeployments, hubRepositoryPolicies, applyHubLaunchResult, applyHubLaunchFailure, unwrapOperationPayload, applyContentPublishResult, executeInline, projectApiConnection, createProjectInternalClient, executeProjectApi, selectDispatchTarget, defaultConfig, createApiExtension } from '../../index.ts';
export function commerceErrorResponse(c, error) {
    const status = Number(error?.status ?? 500);
    if (![400, 401, 403, 404, 409, 502].includes(status))
        throw error;
    return jsonError(c, status, error instanceof Error ? error.message : String(error), error?.details ?? {});
}
export function redactCommerceServiceRequestForBuyer(request) {
    if (!request)
        return null;
    const { vendorPrivateNotes: _vendorPrivateNotes, ...publicRequest } = request;
    return publicRequest;
}
export async function requireCommerceCapacityListingAccess(c, store, listingId, permission = 'projects:read:team') {
    const listing = await store.getCommerceCapacityListing(listingId);
    if (!listing)
        return { response: jsonError(c, 404, `Unknown commerce capacity listing "${listingId}".`) };
    const auth = await ensurePrincipal(c);
    if (auth.response) {
        if (!permission && listing.status === 'approved' && listing.accessLevel === 'public_summary') {
            return { principal: null, listing: await store.getCommerceCapacityListing(listingId, { publicSafe: true }) };
        }
        if (!permission) {
            return { response: jsonError(c, 404, `Unknown commerce capacity listing "${listingId}".`) };
        }
        return auth;
    }
    if (principalIsSeedAdmin(auth.principal))
        return { principal: auth.principal, listing };
    const access = await requireTeamAccess(c, store, listing.sellerTeamId, permission);
    if (!access.response)
        return { principal: auth.principal, listing };
    if (!permission && listing.status === 'approved' && listing.accessLevel === 'public_summary') {
        return { principal: auth.principal, listing: await store.getCommerceCapacityListing(listingId, { publicSafe: true }) };
    }
    return access;
}
export async function requireCommerceCapacityInquiryAccess(c, store, inquiryId, permission = 'projects:read:team') {
    const inquiry = await store.getCommerceCapacityListingInquiry(inquiryId);
    if (!inquiry)
        return { response: jsonError(c, 404, `Unknown commerce capacity inquiry "${inquiryId}".`) };
    const auth = await ensurePrincipal(c);
    if (auth.response)
        return auth;
    if (principalIsSeedAdmin(auth.principal))
        return { principal: auth.principal, inquiry };
    const sellerAccess = await requireTeamAccess(c, store, inquiry.sellerTeamId, permission);
    if (!sellerAccess.response)
        return { principal: auth.principal, inquiry };
    if (inquiry.buyerTeamId) {
        const buyerAccess = await requireTeamAccess(c, store, inquiry.buyerTeamId, 'projects:read:team');
        if (!buyerAccess.response)
            return { principal: auth.principal, inquiry: { ...inquiry, governanceEvidence: {}, metadata: {} } };
    }
    if (inquiry.buyerUserId && inquiry.buyerUserId === auth.principal.id) {
        return { principal: auth.principal, inquiry: { ...inquiry, governanceEvidence: {}, metadata: {} } };
    }
    return sellerAccess;
}
export async function applyCommerceRefundState({ store, order, orderItem = null, amount, fullRefund }) {
    const nextOrderRefunded = Number(order.refundedAmount ?? 0) + Number(amount ?? 0);
    const orderFullyRefunded = nextOrderRefunded >= Number(order.totalAmount ?? 0);
    const updatedOrder = await store.markCommerceOrderRefundState(order.id, {
        status: orderFullyRefunded ? 'refunded' : 'partially_refunded',
        refundedAmount: nextOrderRefunded,
        refundStatus: orderFullyRefunded ? 'full' : 'partial',
        metadata: order.metadata,
    });
    const updatedItems = [];
    if (orderItem) {
        const nextItemRefunded = Number(orderItem.refundedAmount ?? 0) + Number(amount ?? 0);
        const itemFullyRefunded = nextItemRefunded >= Number(orderItem.totalAmount ?? 0);
        updatedItems.push(await store.markCommerceOrderItemRefundState(orderItem.id, {
            status: itemFullyRefunded ? 'refunded' : orderItem.status,
            refundedAmount: nextItemRefunded,
            refundStatus: itemFullyRefunded ? 'full' : 'partial',
            metadata: orderItem.metadata,
        }));
        if (itemFullyRefunded && orderItem.entitlementId) {
            await store.revokeCommerceEntitlement(orderItem.entitlementId, {
                action: 'commerce_entitlement.revoked',
                renewalState: 'canceled',
            });
        }
    }
    else if (fullRefund) {
        for (const item of await store.listCommerceOrderItems(order.id)) {
            updatedItems.push(await store.markCommerceOrderItemRefundState(item.id, {
                status: 'refunded',
                refundedAmount: item.totalAmount,
                refundStatus: 'full',
                metadata: item.metadata,
            }));
            if (item.entitlementId) {
                await store.revokeCommerceEntitlement(item.entitlementId, {
                    action: 'commerce_entitlement.revoked',
                    renewalState: 'canceled',
                });
            }
        }
    }
    return { order: updatedOrder, items: updatedItems };
}
export async function handleCommerceInvoiceWebhook({ store, stripeConnectService, event, object, connectedAccountId }) {
    const stripeSubscriptionId = optionalTrimmedString(object.subscription);
    if (!stripeSubscriptionId)
        return { ignored: true, reason: 'Invoice is not linked to a subscription.' };
    let subscriptionObject = null;
    if (await stripeConnectService.isConfigured()) {
        subscriptionObject = await stripeConnectService.retrieveSubscription({ connectedAccountId, subscriptionId: stripeSubscriptionId });
    }
    const subscription = await store.getCommerceSubscriptionByStripeId(stripeSubscriptionId, connectedAccountId);
    if (!subscription)
        return { ignored: true, reason: 'No local subscription found for invoice.' };
    if (subscriptionObject) {
        const order = await store.getCommerceOrder(subscription.orderId);
        const synced = await syncCommerceSubscriptionFromStripe({ store, order, group: null, subscription: subscriptionObject, connectedAccountId });
        if (event.type === 'invoice.payment_succeeded') {
            await store.updateEntitlementsForSubscription(synced.id, { status: 'active', renewalState: 'active' });
        }
        if (event.type === 'invoice.payment_failed') {
            await store.updateEntitlementsForSubscription(synced.id, { status: 'past_due', renewalState: 'past_due' });
        }
        return { relatedOrderId: synced.orderId, relatedSubscriptionId: synced.id };
    }
    await store.updateEntitlementsForSubscription(subscription.id, {
        status: event.type === 'invoice.payment_succeeded' ? 'active' : 'past_due',
        renewalState: event.type === 'invoice.payment_succeeded' ? 'active' : 'past_due',
    });
    return { relatedOrderId: subscription.orderId, relatedSubscriptionId: subscription.id };
}
export async function requireCommerceProductAccess(c, store, productId, permission = null) {
    const product = await store.getCommerceProduct(productId);
    if (!product) {
        return {
            response: jsonError(c, 404, `Unknown commerce product "${productId}".`),
        };
    }
    if (!permission && product.visibility === 'public' && product.status === 'approved') {
        return {
            principal: c.get('principal') ?? null,
            product,
        };
    }
    const auth = await ensurePrincipal(c);
    if (auth.response)
        return auth;
    if (permission) {
        const access = await requireTeamAccess(c, store, product.sellerTeamId, permission);
        if (access.response)
            return access;
        return {
            principal: access.principal,
            product,
        };
    }
    const teamIds = await store.teamIdsForPrincipal(auth.principal).catch(() => []);
    if (product.visibility === 'public' && product.status === 'approved') {
        return {
            principal: auth.principal,
            product,
        };
    }
    if (principalIsSeedAdmin(auth.principal) || teamIds.includes(product.sellerTeamId)) {
        return {
            principal: auth.principal,
            product,
        };
    }
    return {
        response: jsonError(c, 404, `Unknown commerce product "${productId}".`),
    };
}
export async function principalCanManageCommerceProduct(store, principal, product) {
    if (!principal)
        return false;
    if (principalIsSeedAdmin(principal))
        return true;
    const teamIds = await store.teamIdsForPrincipal(principal).catch(() => []);
    return teamIds.includes(product.sellerTeamId);
}
export function redactCommerceOwnershipWorkflow(workflow) {
    if (!workflow)
        return null;
    return {
        productId: workflow.productId,
        currentOwnershipRecord: workflow.currentOwnershipRecord?.buyerVisible ? workflow.currentOwnershipRecord : null,
        buyerVisibleOwnershipRecords: workflow.buyerVisibleOwnershipRecords ?? [],
        stewardshipAssignments: (workflow.stewardshipAssignments ?? []).filter((assignment) => assignment.visibleToBuyers),
        contributions: (workflow.contributions ?? []).filter((contribution) => ['public', 'buyer'].includes(contribution.attributionVisibility)),
        governancePolicies: (workflow.governancePolicies ?? []).map((policy) => ({
            id: policy.id,
            productId: policy.productId,
            teamId: policy.teamId,
            policyKind: policy.policyKind,
            title: policy.title,
            buyerVisibleSummary: policy.buyerVisibleSummary,
            status: policy.status,
            createdAt: policy.createdAt,
            updatedAt: policy.updatedAt,
        })),
        pendingTransfers: [],
        successionEvents: [],
    };
}
export async function requireCommerceOfferAccess(c, store, offerId, permission = null) {
    const auth = await ensurePrincipal(c);
    if (auth.response)
        return auth;
    const offer = await store.getCommerceOffer(offerId);
    if (!offer) {
        return {
            response: jsonError(c, 404, `Unknown commerce offer "${offerId}".`),
        };
    }
    if (permission) {
        const access = await requireTeamAccess(c, store, offer.sellerTeamId, permission);
        if (access.response)
            return access;
        return {
            principal: access.principal,
            offer,
        };
    }
    return {
        principal: auth.principal,
        offer,
    };
}

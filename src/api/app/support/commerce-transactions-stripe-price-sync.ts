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
import { jsonError, jsonThrownError, POSTGRES_AUTH_PROVIDER_ID, availabilityAttempts, AUTH_PROVIDERS, providerJwksCache, availabilityRateLimit, personalThemeFromRow, accountDeletionBlockers, consumeReauthentication, loadNotificationPreferences, providerConfigFor, base64Url, verifyProviderIdToken, exchangeProviderIdentity, resolveLaunchTemplateRequirements, projectHostBindingMetadata, sourceFromProjectDetails, repositoryInventoryWithPlatform, loadProjectHostBindingContext, projectHostResponsePayload, hostBindingRequiresUnlock, hostKindForBinding, createProjectHostCredentialSessions, persistProjectHostBindingOperationMetadata, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, plaintextHostCredentialFieldPaths, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, markdownToPlainProjectSummary, parseBooleanEnvValue, shouldLogApiRequests, shouldExposeNonProductionAuthDiagnostics, SENSITIVE_QUERY_PARAM_PATTERN, redactedRequestTarget, installApiRequestLogger, AGENT_PROMOTION_APPROVAL_DECISIONS, readJsonOrFormBody, normalizeEmail, normalizeUsername, parseJsonObject, trimmedHeaderValue, requestClientIp, requestSessionMetadata, webSessionData, validateMarketPassword, hashMarketPassword, verifyMarketPassword, ensureMarketCredentialSchema, MARKET_EMAIL_CONFIRMATION_PREFIX, marketAuthContext, shouldBypassAcceptanceAuthEmailDelivery, marketEmailTokenHash, exposeAuthTokenForTests, authTokenTimestampSeconds, authTokenTimestampMillis, sanitizedReturnTo, confirmationUrlFor, teamInviteAcceptUrlFor, passwordResetUrlFor, sendTeamInviteEmail, createMarketEmailConfirmation, serializeUserEmailAddress, backfillUserEmailAddresses, listUserEmailAddresses, getUserEmailAddress, verifiedEmailCount, setPrimaryEmailAddress, syncPrimaryEmailCaches, createOrResendUserEmailAddress, createMarketWebSession, webAuthPayload, normalizeAppearancePreference, normalizeBaseUrl, normalizeDomainName, normalizeProjectDomainInput, inferZoneNameForDomain, domainInZone, optionalTrimmedString, enumValue, unknownKeys, LOCAL_CONTENT_COLLECTIONS, LOCAL_WORK_CONTENT_COLLECTIONS, LOCAL_DECISION_TYPE_VALUES, PROPOSAL_VERDICT_DECISION_TYPES, PLATFORM_OPERATION_SCOPES, LOCAL_CONTENT_DEFAULTS, slugifyContent, yamlScalar, yamlLines, serializeFrontmatter, normalizeRelationArray, uniqueRelationArray, addRelationValue, normalizeLocalContentInput, writeLocalContentRecord, localContentRoot, localContentPath, readLocalContentRecord, writeParsedLocalContentRecord, createRelatedLocalContentRecord, createDecisionFromProposals, isLoopbackUrl, resolveAuthApprovalBaseUrl, findById, resolveAgentArtifactBucket, centralMarketProfile, normalizeMarketProfile, encryptedHostPayloadLooksValid, decryptedHostConfigSummary, credentialSessionSecret, credentialSessionKey, encryptCredentialSessionPayload, decryptCredentialSessionPayload, normalizeProviderCredentialConfig, HOST_KIND_SESSION_KEYS, normalizeAuditHostKinds, providerCredentialValuesForAudit, collectHostingAuditCredentialOverlay, nonSecretLaunchJobInput, decryptTeamHostForLaunch, mergeStringConfig, buildLaunchCredentialOverlay, patchLaunchIntentForCredentialOverlay, appendLaunchDeploymentEvent, scheduleBackgroundBootstrap, sanitizeLaunchResultForStorage, cloudflareErrorMessage, cloudflareRequestForLaunchPreflight, resolveCloudflareZoneForLaunchPreflight, verifyCloudflareDnsWriteForLaunch, projectDeletionConfirmationMatches, projectDeletionBlockerRows, cloudflareRequestForProjectDeletion, githubRequestForProjectDeletion, projectDeletionOperation, cloudflareDeletionAuthenticationMessage, hasRecordedCloudflareRuntimeResources, canSkipCloudflareCleanupAfterFailedLaunch, projectDeletionHostname, normalizedCloudflareKvNamespaceReference, uniqueCloudflareKvNamespaceReferences, cloudflareProjectDeletionResourceNames, resolveProjectDeletionCloudflareZone, deleteCloudflareDnsRecordsForProject, listCloudflareNamedResources, deleteCloudflareProjectResources, appendProjectDeletionProgress, cloudflareDnsDomainsForHostValidation, validateTeamHostCredentialPayload, runProjectLaunchApiBootstrap, runProjectDeletionApiDestroy, retryApiLaunchBootstrapFromRequest, GITHUB_ACTIONS_OIDC_ISSUER, githubOidcJwksCache, base64urlJson, parseBase64urlJson, operationTokenSecret, signOperationToken, verifyOperationToken, loadGitHubOidcJwks, verifyGitHubOidcToken, normalizeCiEnvironment, ciOperationForAction, fallbackRemoteCapability, normalizeRepositorySlug, projectAllowedCiRepositories, validateCiRefForEnvironment, marketProfilesForTeams, artifactDownloadPayload, principalHasPermission, principalIsSeedAdmin, isTeamApiPrincipal, isLocalAcceptanceServicePrincipal, localAcceptanceAdminToken, localAcceptanceAuthEnabled, decorateJob, safePlatformOperationOutput, decoratePlatformOperation, safeTokenEquals, resolvePlatformRunnerSecret, platformOperationMutationError, requirePlatformRunner, resolvePlatformRepositoryDescriptor, mergeCapability, canonicalArchitectureTopology, launchPlannerRepositoryTopology, launchCapabilityPreset, resourceRowsFromLaunch, ensurePrincipal, resolveUiProjectionContext, decodeRouteParam, uiRuntimeLocals, requireConfiguredServiceCredential, resolvePublicTreeDxTeam, enqueueTreeDxProvisionOperation, principalHasGlobalPlatformRole, requireTeamAccess, requireProjectAccess, safePrivateKnowledgeSlug, privateKnowledgeAuditPayload, recordPrivateKnowledgeAudit, FEEDBACK_TYPES, FEEDBACK_SCREENSHOT_TYPES, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, cleanFeedbackString, safeFeedbackContext, safeFeedbackClient, safeFeedbackScreenshot, validateFeedbackAccess, recordFeedbackSubmission, normalizeSeedEnvironments, seedActor, seedExistingTeamIds, seedCreatesMissingTeams, requireSeedPlanAccess, requireSeedApplyAccess, requireProjectRunner, AGENT_TASK_SIGNATURES, resolveAgentTaskSignature, commerceErrorResponse, requireSellerTeamAccess, requireVendorOrderManager, requireServiceBuyerAccess, requireServiceSellerAccess, requireServiceParticipantAccess, redactCommerceServiceRequestForBuyer, requireCommerceCapacityListingAccess, requireCommerceCapacityInquiryAccess, remainingRefundableAmount, applyCommerceRefundState, resolveOrderItemForRefund, resolveFulfillmentArtifact, handleCommerceInvoiceWebhook, requireCommerceProductAccess, principalCanManageCommerceProduct, redactCommerceOwnershipWorkflow, requireCommerceOfferAccess, requireCatalogItemAccess, requireConnectedProjectRuntime, projectAppHref, unwrapLaunchOperationOutput, appendLaunchPhaseProjection, updateLaunchDeployments, hubRepositoryPolicies, applyHubLaunchResult, applyHubLaunchFailure, unwrapOperationPayload, applyContentPublishResult, executeInline, projectApiConnection, createProjectInternalClient, executeProjectApi, selectDispatchTarget, defaultConfig, createApiExtension, CHECKOUT_OFFER_MODES, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, commerceCheckoutError, normalizeCheckoutQuantity, paymentGroupStatusFromPaymentIntent, orderStatusFromPaymentGroup, entitlementRenewalStateFromSubscription, subscriptionClientSecret, publicPaymentGroups, buildCommerceCheckoutMetadata, resolveCommerceCheckoutItem, checkoutGroupKind, checkoutGroupKey, checkoutGroupStatus, grantCommerceEntitlementsForOrder, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, refreshCommercePaymentGroupState, updateCheckoutCompletionFromGroup, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, stripeConfiguredError, stripeVendorApprovalError, stripeAccountMissingError, stripeCommerceUrl, requireCommerceVendorForStripe, refreshCommerceStripeAccount, STRIPE_PRODUCT_MIRROR_OFFER_MODES, STRIPE_PRICE_MIRROR_OFFER_MODES, stripeMetadataValue, buildCommerceStripeMetadata, commerceStripeProductParams, commerceStripeLookupKey, commerceStripePriceParams, stripePriceTermsDrift, commerceStripeSyncContext, syncCommerceOfferStripeProduct, resolveStripePublishableKey, resolveStripeWebhookSecret, stripeClientSecret, subscriptionStatusFromStripe, stripeTimestampToIso, stripeRefundStatus, ensureCommerceStripeCustomer, syncCommerceSubscriptionFromStripe, processCommerceStripeWebhook } from './index.ts';
export async function syncCommercePriceStripePrice({ store, stripeConnectService, price, actorType = 'system', actorId = null, reconcile = false, throwOnBlocked = false, }) {
    const offer = await store.getCommerceOffer(price.offerId);
    const environment = stripeConnectService.environment ?? 'test';
    const block = async (reason) => {
        const updated = await store.markCommercePriceStripeSyncBlocked(price.id, {
            reason,
            actorType,
            actorId,
            evidence: { environment, offerId: offer?.id ?? null },
        });
        if (throwOnBlocked) {
            const error: Error & Record<string, any> = new Error(reason);
            error.status = 409;
            throw error;
        }
        return { price: updated, blocked: true, reason };
    };
    if (!offer)
        return block('Commerce offer was not found for Stripe Price sync.');
    if (!STRIPE_PRICE_MIRROR_OFFER_MODES.has(offer.mode)) {
        if (offer.mode === 'scoped_contract')
            return block('Scoped contract Stripe Price sync is deferred until scoped service checkout.');
        return { price, skipped: true, reason: 'Offer mode does not require a Stripe Price mirror.' };
    }
    if (price.billingInterval === 'custom')
        return block('Custom billing intervals are not supported by Phase 4 Stripe Price sync.');
    if (['subscription', 'subscription_updates', 'professional_hosting'].includes(offer.mode) && !['month', 'year'].includes(price.billingInterval)) {
        return block('Recurring Stripe Price sync requires month or year billing intervals.');
    }
    if (['one_time', 'one_time_current_version'].includes(offer.mode) && price.billingInterval !== 'one_time') {
        return block('One-time Stripe Price sync requires one_time billing interval.');
    }
    const productSync = await syncCommerceOfferStripeProduct({
        store,
        stripeConnectService,
        offer,
        actorType,
        actorId,
        reconcile,
        throwOnBlocked,
    });
    const syncedOffer = productSync.offer ?? offer;
    if (!syncedOffer?.stripeProductId || syncedOffer.stripeProductStatus !== 'synced') {
        return block(productSync.reason ?? 'Stripe Product must be synced before Stripe Price sync.');
    }
    const context = await commerceStripeSyncContext({ store, stripeConnectService, offer: syncedOffer, environment });
    if (!context.account || context.account.accountStatus !== 'enabled')
        return block('Stripe connected account must be enabled before Price sync.');
    const metadata = buildCommerceStripeMetadata({ environment, ...context, offer: syncedOffer, price });
    const lookupKey = price.stripeLookupKey ?? commerceStripeLookupKey(environment, price);
    const params = commerceStripePriceParams({
        offer: syncedOffer,
        price: { ...price, stripeLookupKey: lookupKey },
        stripeProductId: syncedOffer.stripeProductId,
        metadata,
        environment,
    });
    try {
        let stripePrice = null;
        if (price.stripePriceId) {
            stripePrice = await stripeConnectService.retrievePriceMirror({
                connectedAccountId: context.account.stripeAccountId,
                stripePriceId: price.stripePriceId,
            });
            if (stripePriceTermsDrift(stripePrice, price, syncedOffer)) {
                const updated = await store.updateCommercePriceStripeSync(price.id, {
                    stripeProductId: syncedOffer.stripeProductId,
                    stripePriceId: price.stripePriceId,
                    stripeLookupKey: lookupKey,
                    stripeSyncStatus: 'drifted',
                    stripeSyncError: 'Stripe Price immutable terms differ from TreeSeed price terms.',
                    stripeMetadata: metadata,
                    actorType,
                    actorId,
                    action: 'commerce_price.stripe_price.drifted',
                    reason: 'Stripe Price immutable terms differ from TreeSeed price terms.',
                    evidence: { environment, stripeAccountId: context.account.stripeAccountId, stripePriceId: price.stripePriceId },
                });
                return { offer: syncedOffer, price: updated, connectedAccount: context.account, stripeProductId: syncedOffer.stripeProductId, stripePriceId: price.stripePriceId, stripeLookupKey: lookupKey, status: 'drifted', reconciled: reconcile };
            }
            stripePrice = await stripeConnectService.updatePriceMirror({
                connectedAccountId: context.account.stripeAccountId,
                stripePriceId: price.stripePriceId,
                params: { metadata, lookup_key: lookupKey, active: price.status === 'active' },
            });
        }
        else {
            stripePrice = await stripeConnectService.createPriceMirror({
                connectedAccountId: context.account.stripeAccountId,
                params,
            });
        }
        if (!stripePrice?.id)
            return block('Stripe Price sync did not return a Price ID.');
        const updated = await store.updateCommercePriceStripeSync(price.id, {
            stripeProductId: syncedOffer.stripeProductId,
            stripePriceId: stripePrice.id,
            stripeLookupKey: lookupKey,
            stripeSyncStatus: 'synced',
            stripeMetadata: metadata,
            actorType,
            actorId,
            action: reconcile ? 'commerce_price.stripe_price.reconciled' : 'commerce_price.stripe_price.synced',
            evidence: {
                environment,
                stripeAccountId: context.account.stripeAccountId,
                stripeProductId: syncedOffer.stripeProductId,
                stripePriceId: stripePrice.id,
            },
        });
        return {
            offer: syncedOffer,
            price: updated,
            connectedAccount: context.account,
            stripeProductId: syncedOffer.stripeProductId,
            stripePriceId: stripePrice.id,
            stripeLookupKey: lookupKey,
            status: 'synced',
            reconciled: reconcile,
        };
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'Stripe Price sync failed.');
        await store.updateCommercePriceStripeSync(price.id, {
            stripeSyncStatus: 'failed',
            stripeSyncError: reason,
            actorType,
            actorId,
            action: 'commerce_price.stripe_price.failed',
            reason,
            evidence: { environment, stripeAccountId: context.account.stripeAccountId },
        });
        if (throwOnBlocked)
            throw error;
        return { offer: syncedOffer, price: await store.getCommercePrice(price.id), failed: true, reason };
    }
}

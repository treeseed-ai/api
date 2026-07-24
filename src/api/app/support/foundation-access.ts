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
import { POSTGRES_AUTH_PROVIDER_ID, AUTH_PROVIDERS, consumeReauthentication, loadNotificationPreferences, verifyProviderIdToken, resolveLaunchTemplateRequirements, projectHostBindingMetadata, sourceFromProjectDetails, repositoryInventoryWithPlatform, loadProjectHostBindingContext, projectHostResponsePayload, hostBindingRequiresUnlock, hostKindForBinding, createProjectHostCredentialSessions, persistProjectHostBindingOperationMetadata, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, plaintextHostCredentialFieldPaths, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, markdownToPlainProjectSummary, shouldExposeNonProductionAuthDiagnostics, AGENT_PROMOTION_APPROVAL_DECISIONS, normalizeEmail, requestSessionMetadata, webSessionData, validateMarketPassword, hashMarketPassword, verifyMarketPassword, MARKET_EMAIL_CONFIRMATION_PREFIX, marketAuthContext, shouldBypassAcceptanceAuthEmailDelivery, marketEmailTokenHash, exposeAuthTokenForTests, authTokenTimestampSeconds, authTokenTimestampMillis, passwordResetUrlFor, sendTeamInviteEmail, createMarketEmailConfirmation, serializeUserEmailAddress, backfillUserEmailAddresses, listUserEmailAddresses, getUserEmailAddress, verifiedEmailCount, setPrimaryEmailAddress, syncPrimaryEmailCaches, createOrResendUserEmailAddress, createMarketWebSession, webAuthPayload, normalizeAppearancePreference, normalizeDomainName, normalizeProjectDomainInput, inferZoneNameForDomain, domainInZone, LOCAL_CONTENT_COLLECTIONS, LOCAL_WORK_CONTENT_COLLECTIONS, LOCAL_DECISION_TYPE_VALUES, PROPOSAL_VERDICT_DECISION_TYPES, PLATFORM_OPERATION_SCOPES, LOCAL_CONTENT_DEFAULTS, slugifyContent, serializeFrontmatter, normalizeRelationArray, uniqueRelationArray, addRelationValue, normalizeLocalContentInput, writeLocalContentRecord, localContentRoot, localContentPath, readLocalContentRecord, writeParsedLocalContentRecord, createRelatedLocalContentRecord, createDecisionFromProposals, resolveAuthApprovalBaseUrl, encryptedHostPayloadLooksValid, decryptedHostConfigSummary, credentialSessionSecret, credentialSessionKey, encryptCredentialSessionPayload, decryptCredentialSessionPayload, HOST_KIND_SESSION_KEYS, normalizeAuditHostKinds, collectHostingAuditCredentialOverlay, nonSecretLaunchJobInput, decryptTeamHostForLaunch, buildLaunchCredentialOverlay, patchLaunchIntentForCredentialOverlay, appendLaunchDeploymentEvent, sanitizeLaunchResultForStorage, cloudflareErrorMessage, cloudflareRequestForLaunchPreflight, resolveCloudflareZoneForLaunchPreflight, verifyCloudflareDnsWriteForLaunch, projectDeletionConfirmationMatches, projectDeletionBlockerRows, cloudflareRequestForProjectDeletion, githubRequestForProjectDeletion, projectDeletionOperation, cloudflareDeletionAuthenticationMessage, hasRecordedCloudflareRuntimeResources, canSkipCloudflareCleanupAfterFailedLaunch, projectDeletionHostname, normalizedCloudflareKvNamespaceReference, uniqueCloudflareKvNamespaceReferences, cloudflareProjectDeletionResourceNames, resolveProjectDeletionCloudflareZone, deleteCloudflareDnsRecordsForProject, listCloudflareNamedResources, deleteCloudflareProjectResources, appendProjectDeletionProgress, cloudflareDnsDomainsForHostValidation, validateTeamHostCredentialPayload, runProjectLaunchApiBootstrap, runProjectDeletionApiDestroy, retryApiLaunchBootstrapFromRequest, operationTokenSecret, signOperationToken, verifyOperationToken, normalizeCiEnvironment, ciOperationForAction, normalizeRepositorySlug, projectAllowedCiRepositories, validateCiRefForEnvironment, principalHasPermission, principalIsSeedAdmin, isTeamApiPrincipal, isLocalAcceptanceServicePrincipal, localAcceptanceAuthEnabled, decorateJob, safePlatformOperationOutput, decoratePlatformOperation, resolvePlatformRunnerSecret, platformOperationMutationError, requirePlatformRunner, resolvePlatformRepositoryDescriptor, launchPlannerRepositoryTopology, launchCapabilityPreset, resourceRowsFromLaunch, ensurePrincipal, resolveUiProjectionContext, resolvePublicTreeDxTeam, enqueueTreeDxProvisionOperation, principalHasGlobalPlatformRole, requireTeamAccess, requireProjectAccess, FEEDBACK_TYPES, FEEDBACK_SCREENSHOT_TYPES, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, cleanFeedbackString, safeFeedbackContext, safeFeedbackClient, safeFeedbackScreenshot, validateFeedbackAccess, recordFeedbackSubmission, normalizeSeedEnvironments, seedActor, seedExistingTeamIds, seedCreatesMissingTeams, requireSeedPlanAccess, requireSeedApplyAccess, requireProjectRunner, commerceErrorResponse, stripeConfiguredError, stripeVendorApprovalError, stripeAccountMissingError, stripeCommerceUrl, requireCommerceVendorForStripe, refreshCommerceStripeAccount, STRIPE_PRODUCT_MIRROR_OFFER_MODES, STRIPE_PRICE_MIRROR_OFFER_MODES, stripeMetadataValue, buildCommerceStripeMetadata, commerceStripeProductParams, commerceStripeLookupKey, commerceStripePriceParams, stripePriceTermsDrift, commerceStripeSyncContext, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, CHECKOUT_OFFER_MODES, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, resolveStripePublishableKey, resolveStripeWebhookSecret, commerceCheckoutError, normalizeCheckoutQuantity, stripeClientSecret, paymentGroupStatusFromPaymentIntent, orderStatusFromPaymentGroup, subscriptionStatusFromStripe, entitlementRenewalStateFromSubscription, stripeTimestampToIso, subscriptionClientSecret, publicPaymentGroups, buildCommerceCheckoutMetadata, resolveCommerceCheckoutItem, checkoutGroupKind, checkoutGroupKey, checkoutGroupStatus, grantCommerceEntitlementsForOrder, requireSellerTeamAccess, requireServiceParticipantAccess, redactCommerceServiceRequestForBuyer, requireCommerceCapacityListingAccess, requireCommerceCapacityInquiryAccess, stripeRefundStatus, applyCommerceRefundState, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, ensureCommerceStripeCustomer, refreshCommercePaymentGroupState, updateCheckoutCompletionFromGroup, syncCommerceSubscriptionFromStripe, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, handleCommerceInvoiceWebhook, processCommerceStripeWebhook, requireCommerceProductAccess, principalCanManageCommerceProduct, redactCommerceOwnershipWorkflow, requireCommerceOfferAccess, requireConnectedProjectRuntime, projectAppHref, unwrapLaunchOperationOutput, appendLaunchPhaseProjection, updateLaunchDeployments, hubRepositoryPolicies, applyHubLaunchResult, applyHubLaunchFailure, unwrapOperationPayload, applyContentPublishResult, projectApiConnection, createProjectInternalClient, executeProjectApi, jsonError, jsonThrownError, availabilityAttempts, providerJwksCache, availabilityRateLimit, personalThemeFromRow, accountDeletionBlockers, providerConfigFor, base64Url, exchangeProviderIdentity, parseBooleanEnvValue, shouldLogApiRequests, SENSITIVE_QUERY_PARAM_PATTERN, redactedRequestTarget, installApiRequestLogger, readJsonOrFormBody, normalizeUsername, parseJsonObject, trimmedHeaderValue, requestClientIp, ensureMarketCredentialSchema, sanitizedReturnTo, confirmationUrlFor, teamInviteAcceptUrlFor, normalizeBaseUrl, optionalTrimmedString, enumValue, unknownKeys, yamlScalar, yamlLines, isLoopbackUrl, findById, resolveAgentArtifactBucket, centralMarketProfile, normalizeMarketProfile, normalizeProviderCredentialConfig, providerCredentialValuesForAudit, mergeStringConfig, scheduleBackgroundBootstrap, GITHUB_ACTIONS_OIDC_ISSUER, githubOidcJwksCache, base64urlJson, parseBase64urlJson, loadGitHubOidcJwks, verifyGitHubOidcToken, fallbackRemoteCapability, marketProfilesForTeams, artifactDownloadPayload, localAcceptanceAdminToken, safeTokenEquals, mergeCapability, canonicalArchitectureTopology, decodeRouteParam, uiRuntimeLocals, requireConfiguredServiceCredential, safePrivateKnowledgeSlug, privateKnowledgeAuditPayload, recordPrivateKnowledgeAudit, AGENT_TASK_SIGNATURES, resolveAgentTaskSignature, requireVendorOrderManager, remainingRefundableAmount, resolveOrderItemForRefund, resolveFulfillmentArtifact, executeInline, selectDispatchTarget, defaultConfig, createApiExtension } from './index.ts';
export async function requireServiceBuyerAccess(c, store, request) {
    const auth = await ensurePrincipal(c);
    if (auth.response)
        return auth;
    if (principalIsSeedAdmin(auth.principal))
        return auth;
    if (request?.buyerTeamId) {
        const access = await requireTeamAccess(c, store, request.buyerTeamId, 'projects:read:team');
        if (!access.response)
            return access;
    }
    if (request?.buyerUserId && request.buyerUserId === auth.principal.id)
        return auth;
    return { response: jsonError(c, 403, 'Permission denied.', { requestId: request?.id ?? null }) };
}
export async function requireServiceSellerAccess(c, store, request, permission = 'teams:manage:team') {
    const auth = await ensurePrincipal(c);
    if (auth.response)
        return auth;
    if (principalIsSeedAdmin(auth.principal))
        return auth;
    if (!request?.sellerTeamId)
        return { response: jsonError(c, 404, 'Commerce service request does not have a seller team.') };
    return requireTeamAccess(c, store, request.sellerTeamId, permission);
}
export async function requireCatalogItemAccess(c, store, itemId, permission = null) {
    const auth = await ensurePrincipal(c);
    if (auth.response) {
        return auth;
    }
    const item = await store.getCatalogItem(itemId);
    if (!item) {
        return {
            response: jsonError(c, 404, `Unknown catalog item "${itemId}".`),
        };
    }
    const access = await requireTeamAccess(c, store, item.teamId, permission);
    if (access.response) {
        return access;
    }
    return {
        principal: access.principal,
        item,
    };
}

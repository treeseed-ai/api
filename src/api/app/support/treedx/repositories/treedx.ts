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
import { jsonError, jsonThrownError, POSTGRES_AUTH_PROVIDER_ID, availabilityAttempts, AUTH_PROVIDERS, providerJwksCache, availabilityRateLimit, personalThemeFromRow, accountDeletionBlockers, consumeReauthentication, loadNotificationPreferences, providerConfigFor, base64Url, verifyProviderIdToken, exchangeProviderIdentity, resolveLaunchTemplateRequirements, projectHostBindingMetadata, sourceFromProjectDetails, repositoryInventoryWithPlatform, loadProjectHostBindingContext, projectHostResponsePayload, hostBindingRequiresUnlock, hostKindForBinding, createProjectHostCredentialSessions, persistProjectHostBindingOperationMetadata, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, plaintextHostCredentialFieldPaths, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, markdownToPlainProjectSummary, parseBooleanEnvValue, shouldLogApiRequests, shouldExposeNonProductionAuthDiagnostics, SENSITIVE_QUERY_PARAM_PATTERN, redactedRequestTarget, installApiRequestLogger, AGENT_PROMOTION_APPROVAL_DECISIONS, readJsonOrFormBody, normalizeEmail, normalizeUsername, parseJsonObject, trimmedHeaderValue, requestClientIp, requestSessionMetadata, webSessionData, validateMarketPassword, hashMarketPassword, verifyMarketPassword, ensureMarketCredentialSchema, MARKET_EMAIL_CONFIRMATION_PREFIX, marketAuthContext, shouldBypassAcceptanceAuthEmailDelivery, marketEmailTokenHash, exposeAuthTokenForTests, authTokenTimestampSeconds, authTokenTimestampMillis, sanitizedReturnTo, confirmationUrlFor, teamInviteAcceptUrlFor, passwordResetUrlFor, sendTeamInviteEmail, createMarketEmailConfirmation, serializeUserEmailAddress, backfillUserEmailAddresses, listUserEmailAddresses, getUserEmailAddress, verifiedEmailCount, setPrimaryEmailAddress, syncPrimaryEmailCaches, createOrResendUserEmailAddress, createMarketWebSession, webAuthPayload, normalizeAppearancePreference, normalizeBaseUrl, normalizeDomainName, normalizeProjectDomainInput, inferZoneNameForDomain, domainInZone, optionalTrimmedString, enumValue, unknownKeys, LOCAL_CONTENT_COLLECTIONS, LOCAL_WORK_CONTENT_COLLECTIONS, LOCAL_DECISION_TYPE_VALUES, PROPOSAL_VERDICT_DECISION_TYPES, PLATFORM_OPERATION_SCOPES, LOCAL_CONTENT_DEFAULTS, slugifyContent, yamlScalar, yamlLines, serializeFrontmatter, normalizeRelationArray, uniqueRelationArray, addRelationValue, normalizeLocalContentInput, writeLocalContentRecord, localContentRoot, localContentPath, readLocalContentRecord, writeParsedLocalContentRecord, createRelatedLocalContentRecord, createDecisionFromProposals, isLoopbackUrl, resolveAuthApprovalBaseUrl, findById, resolveAgentArtifactBucket, centralMarketProfile, normalizeMarketProfile, encryptedHostPayloadLooksValid, decryptedHostConfigSummary, credentialSessionSecret, credentialSessionKey, encryptCredentialSessionPayload, decryptCredentialSessionPayload, normalizeProviderCredentialConfig, HOST_KIND_SESSION_KEYS, normalizeAuditHostKinds, providerCredentialValuesForAudit, collectHostingAuditCredentialOverlay, nonSecretLaunchJobInput, decryptTeamHostForLaunch, mergeStringConfig, buildLaunchCredentialOverlay, patchLaunchIntentForCredentialOverlay, appendLaunchDeploymentEvent, scheduleBackgroundBootstrap, sanitizeLaunchResultForStorage, cloudflareErrorMessage, cloudflareRequestForLaunchPreflight, resolveCloudflareZoneForLaunchPreflight, verifyCloudflareDnsWriteForLaunch, projectDeletionConfirmationMatches, projectDeletionBlockerRows, cloudflareRequestForProjectDeletion, githubRequestForProjectDeletion, projectDeletionOperation, cloudflareDeletionAuthenticationMessage, hasRecordedCloudflareRuntimeResources, canSkipCloudflareCleanupAfterFailedLaunch, projectDeletionHostname, normalizedCloudflareKvNamespaceReference, uniqueCloudflareKvNamespaceReferences, cloudflareProjectDeletionResourceNames, resolveProjectDeletionCloudflareZone, deleteCloudflareDnsRecordsForProject, listCloudflareNamedResources, deleteCloudflareProjectResources, appendProjectDeletionProgress, cloudflareDnsDomainsForHostValidation, validateTeamHostCredentialPayload, runProjectLaunchApiBootstrap, runProjectDeletionApiDestroy, retryApiLaunchBootstrapFromRequest, GITHUB_ACTIONS_OIDC_ISSUER, githubOidcJwksCache, base64urlJson, parseBase64urlJson, operationTokenSecret, signOperationToken, verifyOperationToken, loadGitHubOidcJwks, verifyGitHubOidcToken, normalizeCiEnvironment, ciOperationForAction, fallbackRemoteCapability, normalizeRepositorySlug, projectAllowedCiRepositories, validateCiRefForEnvironment, marketProfilesForTeams, artifactDownloadPayload, principalHasPermission, principalIsSeedAdmin, isTeamApiPrincipal, isLocalAcceptanceServicePrincipal, localAcceptanceAdminToken, localAcceptanceAuthEnabled, decorateJob, safePlatformOperationOutput, decoratePlatformOperation, safeTokenEquals, resolvePlatformRunnerSecret, platformOperationMutationError, requirePlatformRunner, resolvePlatformRepositoryDescriptor, mergeCapability, canonicalArchitectureTopology, launchPlannerRepositoryTopology, launchCapabilityPreset, resourceRowsFromLaunch, ensurePrincipal, resolveUiProjectionContext, decodeRouteParam, uiRuntimeLocals, requireConfiguredServiceCredential, principalHasGlobalPlatformRole, requireTeamAccess, requireProjectAccess, safePrivateKnowledgeSlug, privateKnowledgeAuditPayload, recordPrivateKnowledgeAudit, FEEDBACK_TYPES, FEEDBACK_SCREENSHOT_TYPES, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, cleanFeedbackString, safeFeedbackContext, safeFeedbackClient, safeFeedbackScreenshot, validateFeedbackAccess, recordFeedbackSubmission, normalizeSeedEnvironments, seedActor, seedExistingTeamIds, seedCreatesMissingTeams, requireSeedPlanAccess, requireSeedApplyAccess, requireProjectRunner, AGENT_TASK_SIGNATURES, resolveAgentTaskSignature, commerceErrorResponse, stripeConfiguredError, stripeVendorApprovalError, stripeAccountMissingError, stripeCommerceUrl, requireCommerceVendorForStripe, refreshCommerceStripeAccount, STRIPE_PRODUCT_MIRROR_OFFER_MODES, STRIPE_PRICE_MIRROR_OFFER_MODES, stripeMetadataValue, buildCommerceStripeMetadata, commerceStripeProductParams, commerceStripeLookupKey, commerceStripePriceParams, stripePriceTermsDrift, commerceStripeSyncContext, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, CHECKOUT_OFFER_MODES, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, resolveStripePublishableKey, resolveStripeWebhookSecret, commerceCheckoutError, normalizeCheckoutQuantity, stripeClientSecret, paymentGroupStatusFromPaymentIntent, orderStatusFromPaymentGroup, subscriptionStatusFromStripe, entitlementRenewalStateFromSubscription, stripeTimestampToIso, subscriptionClientSecret, publicPaymentGroups, buildCommerceCheckoutMetadata, resolveCommerceCheckoutItem, checkoutGroupKind, checkoutGroupKey, checkoutGroupStatus, grantCommerceEntitlementsForOrder, requireSellerTeamAccess, requireVendorOrderManager, requireServiceBuyerAccess, requireServiceSellerAccess, requireServiceParticipantAccess, redactCommerceServiceRequestForBuyer, requireCommerceCapacityListingAccess, requireCommerceCapacityInquiryAccess, remainingRefundableAmount, stripeRefundStatus, applyCommerceRefundState, resolveOrderItemForRefund, resolveFulfillmentArtifact, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, ensureCommerceStripeCustomer, refreshCommercePaymentGroupState, updateCheckoutCompletionFromGroup, syncCommerceSubscriptionFromStripe, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, handleCommerceInvoiceWebhook, processCommerceStripeWebhook, requireCommerceProductAccess, principalCanManageCommerceProduct, redactCommerceOwnershipWorkflow, requireCommerceOfferAccess, requireCatalogItemAccess, requireConnectedProjectRuntime, projectAppHref, unwrapLaunchOperationOutput, appendLaunchPhaseProjection, updateLaunchDeployments, hubRepositoryPolicies, applyHubLaunchResult, applyHubLaunchFailure, unwrapOperationPayload, applyContentPublishResult, executeInline, projectApiConnection, createProjectInternalClient, executeProjectApi, selectDispatchTarget, defaultConfig, createApiExtension } from '../../index.ts';
export async function resolvePublicTreeDxTeam(store, input: any = {}) {
    const requested = optionalTrimmedString(input.teamId)
        ?? optionalTrimmedString(input.teamSlug)
        ?? optionalTrimmedString(input.slug)
        ?? 'treeseed-public';
    const existing = await store.getTeam(requested).catch(() => null)
        ?? await store.getTeamBySlug(requested).catch(() => null);
    if (existing)
        return existing;
    return store.createTeam({
        id: requested === 'treeseed-public' ? 'team-treeseed-public' : undefined,
        name: requested,
        displayName: optionalTrimmedString(input.displayName) ?? 'TreeSeed Public Knowledge',
        metadata: {
            kind: 'system_public_treedx_federation',
            publicKnowledge: true,
        },
    });
}
export async function enqueueTreeDxProvisionOperation(store, teamId, payload, body: any = {}, requestedBy: any = {}) {
    const deployment = Array.isArray(payload.deployments) ? payload.deployments[0] : null;
    if (!deployment || deployment.status === 'succeeded') {
        return { operation: null, deployment };
    }
    const idempotencyKey = typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()
        ? body.idempotencyKey.trim()
        : `team:${teamId}:treedx:provision:${deployment.id}`;
    const operation = await store.createPlatformOperation({
        namespace: 'treedx',
        operation: 'provision',
        target: 'market_operations_runner',
        idempotencyKey,
        input: {
            teamId,
            instanceId: payload.instance?.id ?? null,
            deploymentId: deployment.id,
            imageRef: payload.instance?.imageRef ?? body.imageRef ?? 'treeseed/treedx:latest',
            volumeMountPath: payload.instance?.volumeMountPath ?? '/data',
            dataDirEnv: '/data',
            publicRead: payload.instance?.publicRead === true,
            planOnly: body.planOnly === true,
        },
        requestedByType: requestedBy.type ?? 'user',
        requestedById: requestedBy.id ?? 'unknown',
    });
    await store.updateTreeDxDeployment?.(deployment.id, {
        result: {
            operationId: operation.id,
            operationStatus: operation.status,
        },
    });
    return { operation, deployment };
}

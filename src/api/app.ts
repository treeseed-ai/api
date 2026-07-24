import { AgentSdk, RemoteTreeseedClient, RemoteTreeseedOperationsClient, RemoteTreeseedSdkClient, signEditorialPreviewToken, TreeseedOperationsSdk, executeSdkOperation, findDispatchCapability, planKnowledgeHubLaunch, derivePlatformOperationNavigation, deriveProjectHostBindingsView, isPlatformOperationTerminal, normalizeProjectLaunchHostBindings, normalizePlatformContentInput as normalizeRepositoryContentInput, normalizePlatformRelationArray as normalizeRepositoryRelationArray, platformContentRelationPolicy as repositoryContentRelationPolicy, normalizeTemplateLaunchRequirements, normalizeTreeseedTemplateId, planProjectHostBindingOperation, resolveProjectLaunchHostBindings, slugifyPlatformContent as slugifyRepositoryContent, } from '@treeseed/sdk';
import { runTreeseedHostingAudit } from '@treeseed/sdk/workflow-support';
import { createTreeseedApiApp, D1AuthProvider as DatabaseAuthProvider, loadTemplateCatalog, resolveApiConfig, } from '@treeseed/sdk/api';
import { MarketControlPlaneStore, validateProjectSlug } from './store.js';
import { createClientEncryptedEscrowService } from './client-encrypted-escrow.ts';
import { createGitHubAppAdapter } from './github-app-adapter.ts';
import { createGitHubActionsSecretEnclave } from './github-actions-secret-enclave.ts';
import { bearerTokenFromRequest } from './request-auth.ts';
import { createTreeDxCredentialBridge } from './treedx-credential-bridge.ts';
import { createMarketPostgresDatabase } from './market-postgres.js';
import { installProjectDeploymentRoutes } from './project-deployment-routes.js';
import { installCapacityRoutes } from './capacity/routes/index.ts';
import { createCapacityControlPlane } from './capacity/control-plane.ts';
import { deleteTeamCapacityAggregate } from './capacity/services/team-deletion-service.ts';
import { readCapacityRequestObject } from './capacity/routes/request-json.ts';
import { createStripeConnectService, resolveStripeEnvironment, stripeAccountToConnectedAccountPatch } from './stripe-connect.js';
import { applySeedWithStore, exportSeedWithStore, planSeedWithStore } from '../market/seeds/apply.js';
import { buildGovernanceApprovalProjection, buildGovernanceProjection } from '../market/governance-projection.js';
import { buildInfrastructureProjection } from '../market/infrastructure-projection.js';
import { loadInfrastructureSeedState } from '../market/infrastructure-seeds.js';
import { buildKnowledgeArtifactProjection, buildKnowledgeProjection } from '../market/knowledge-projection.js';
import { buildWorkdayProjection } from '../market/workday-projection.js';
import { loadKnowledgeContentEntries } from '../view-models/knowledge-content.js';
import { listTreeseedManagedHostsFromConfig, managedCloudflareConfigMissing, resolveTreeseedManagedCloudflareHostConfigFromConfig, } from '../market/managed-hosts.js';
import { decryptHostConfig } from '../crypto/host-crypto.ts';
import { getSiteAuthConfig } from '../auth/config.ts';
import { accountDeletionConfirmationMatches } from '../auth/account.ts';
import { validateUsername as validatePublicUsername } from '../auth/profile-validation.ts';
import { authEmailDeliveryFailureDetail, authEmailDeliveryFailureReason, sendAuthEmail } from '../auth/email.ts';
import { recordContentNotificationEvent } from '../notifications/service.ts';
import { sendEmailConfirmation } from '../auth/email-confirmation.ts';
import { sendWelcomeEmail } from '../auth/welcome-email.ts';
import { createCipheriv, createDecipheriv, createHash, createHmac, createPublicKey, createVerify, pbkdf2Sync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { contentRelationPolicy } from '../market/content-relations.js';
import { NOTIFICATION_CONTENT_CAPABILITIES, PERSONAL_THEME_COMPILER_VERSION, isValidPersonalThemeDraft, normalizeNotificationPreferences, } from '@treeseed/sdk/account-contracts';
import { installFoundationHealthMarketAndFeedbackRoutes } from './routes/foundation-health-market-and-feedback.ts';
import { installFoundationAcceptanceSeedRoutes } from './routes/foundation-acceptance-seed.ts';
import { installOperationsPlatformRunnersAndJobsRoutes } from './routes/operations-platform-runners-and-jobs.ts';
import { installAuthenticationDeviceSignupAndOauthRoutes } from './routes/authentication-device-signup-and-oauth.ts';
import { installAuthenticationAccountProfileAndNotificationsRoutes } from './routes/authentication-account-profile-and-notifications.ts';
import { installAuthenticationPasswordAndAccountSecurityRoutes } from './routes/authentication-password-and-account-security.ts';
import { installFoundationCurrentUserMarketsRoutes } from './routes/foundation-current-user-markets.ts';
import { installGovernanceProjectionRoutes } from './routes/governance-projection.ts';
import { installProjectionsInfrastructureKnowledgeAndWorkdaysRoutes } from './routes/projections-infrastructure-knowledge-and-workdays.ts';
import { installTeamsDirectoryRoutes } from './routes/teams-directory.ts';
import { installFoundationUsersByUsernameItemProfileRoutes } from './routes/foundation-users-by-username-item-profile.ts';
import { installCatalogSeedRunLifecycleRoutes } from './routes/catalog-seed-run-lifecycle.ts';
import { installTeamsInvitationsMembershipAndApiKeysRoutes } from './routes/teams-invitations-membership-and-api-keys.ts';
import { installTreedxTeamServiceAndPublicFederationRoutes } from './routes/treedx-team-service-and-public-federation.ts';
import { installFoundationInternalGithubAppWebhookRoutes } from './routes/foundation-internal-github-app-webhook.ts';
import { installTreedxInternalTreedxPublicFederationStatusRoutes } from './routes/treedx-internal-treedx-public-federation-status.ts';
import { installFoundationIssueTreeDxGitHubCredentialRoutes } from './routes/foundation-issueTreeDxGitHubCredential.ts';
import { installTreedxCredentialsMirrorsAndSharesRoutes } from './routes/treedx-credentials-mirrors-and-shares.ts';
import { installTeamsRepositoryAndWebHostsRoutes } from './routes/teams-repository-and-web-hosts.ts';
import { installProjectsSecretsWorkflowsAndCollectionRoutes } from './routes/projects-secrets-workflows-and-collection.ts';
import { installProjectsTeamsItemProjectsLaunchRoutes } from './routes/projects-teams-item-projects-launch.ts';
import { installProjectsHostsAndRepositoryTopologyRoutes } from './routes/projects-hosts-and-repository-topology.ts';
import { installFoundationQueueProjectHostOperationRoutes } from './routes/foundation-queueProjectHostOperation.ts';
import { installProjectsHostLifecycleAndSummaryRoutes } from './routes/projects-host-lifecycle-and-summary.ts';
import { installProjectsWorkstreamsAndReleasesRoutes } from './routes/projects-workstreams-and-releases.ts';
import { installGovernanceTeamProjectPolicyRoutes } from './routes/governance-team-project-policy.ts';
import { installProjectsProposalsAndDecisionsRoutes } from './routes/projects-proposals-and-decisions.ts';
import { installGovernanceTeamProjectDelegationsAndApprovalsRoutes } from './routes/governance-team-project-delegations-and-approvals.ts';
import { installProjectsOperationGrantsAndPlanningRoutes } from './routes/projects-operation-grants-and-planning.ts';
import { installGovernanceProjectsItemApprovalsItemDecisionRoutes } from './routes/governance-projects-item-approvals-item-decision.ts';
import { installProjectsSharingHostingAndResourcesRoutes } from './routes/projects-sharing-hosting-and-resources.ts';
import { installFoundationRoutesRoutes } from './routes/foundation-routes.ts';
import { installProjectsCapabilitiesContentAndCiRoutes } from './routes/projects-capabilities-content-and-ci.ts';
import { installOperationsProjectsItemCiJobsItemRoutes } from './routes/operations-projects-item-ci-jobs-item.ts';
import { installProjectsProjectsItemDispatchRoutes } from './routes/projects-projects-item-dispatch.ts';
import { installOperationsProjectJobsAndCredentialSessionsRoutes } from './routes/operations-project-jobs-and-credential-sessions.ts';
import { installFoundationApprovalDecisionsRoutes } from './routes/foundation-approval-decisions.ts';
import { installGovernanceCommonsProposalsQuestionsAndVotesRoutes } from './routes/governance-commons-proposals-questions-and-votes.ts';
import { installFoundationStewardTransitionCommonsProposalRoutes } from './routes/foundation-stewardTransitionCommonsProposal.ts';
import { installGovernanceCommonsReviewsDecisionsAndDelegationsRoutes } from './routes/governance-commons-reviews-decisions-and-delegations.ts';
import { installOperationsProjectRunnerEventsAndCompletionRoutes } from './routes/operations-project-runner-events-and-completion.ts';
import { installCommerceVendorOnboardingStripeAndCheckoutRoutes } from './routes/commerce-vendor-onboarding-stripe-and-checkout.ts';
import { installCommerceServiceRequestsContractsAndOrdersRoutes } from './routes/commerce-service-requests-contracts-and-orders.ts';
import { installCommerceSalesFulfillmentAndProductCatalogRoutes } from './routes/commerce-sales-fulfillment-and-product-catalog.ts';
import { installCommerceProductGovernanceAndCapacityListingsRoutes } from './routes/commerce-product-governance-and-capacity-listings.ts';
import { installCommerceCapacityInquiriesProductVersionsAndOffersRoutes } from './routes/commerce-capacity-inquiries-product-versions-and-offers.ts';
import { installCommerceStripePriceReconciliationAndGovernanceEventsRoutes } from './routes/commerce-stripe-price-reconciliation-and-governance-events.ts';
import { installCatalogItemsAndArtifactsRoutes } from './routes/catalog-items-and-artifacts.ts';
import { installTeamsTeamsItemCatalogItemsRoutes } from './routes/teams-teams-item-catalog-items.ts';
import { installCatalogCatalogItemArtifactsRoutes } from './routes/catalog-catalog-item-artifacts.ts';
import { installTeamsStorageAndContentPreviewsRoutes } from './routes/teams-storage-and-content-previews.ts';
import { installCatalogTemplatesAndKnowledgePacksRoutes } from './routes/catalog-templates-and-knowledge-packs.ts';
import { jsonError, jsonThrownError, POSTGRES_AUTH_PROVIDER_ID, availabilityAttempts, AUTH_PROVIDERS, providerJwksCache, availabilityRateLimit, personalThemeFromRow, accountDeletionBlockers, consumeReauthentication, loadNotificationPreferences, providerConfigFor, base64Url, verifyProviderIdToken, exchangeProviderIdentity, resolveLaunchTemplateRequirements, projectHostBindingMetadata, sourceFromProjectDetails, repositoryInventoryWithPlatform, loadProjectHostBindingContext, projectHostResponsePayload, hostBindingRequiresUnlock, hostKindForBinding, createProjectHostCredentialSessions, persistProjectHostBindingOperationMetadata, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, plaintextHostCredentialFieldPaths, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, markdownToPlainProjectSummary, parseBooleanEnvValue, shouldLogApiRequests, shouldExposeNonProductionAuthDiagnostics, SENSITIVE_QUERY_PARAM_PATTERN, redactedRequestTarget, installApiRequestLogger, AGENT_PROMOTION_APPROVAL_DECISIONS, readJsonOrFormBody, normalizeEmail, normalizeUsername, parseJsonObject, trimmedHeaderValue, requestClientIp, requestSessionMetadata, webSessionData, validateMarketPassword, hashMarketPassword, verifyMarketPassword, ensureMarketCredentialSchema, MARKET_EMAIL_CONFIRMATION_PREFIX, marketAuthContext, shouldBypassAcceptanceAuthEmailDelivery, marketEmailTokenHash, exposeAuthTokenForTests, authTokenTimestampSeconds, authTokenTimestampMillis, sanitizedReturnTo, confirmationUrlFor, teamInviteAcceptUrlFor, passwordResetUrlFor, sendTeamInviteEmail, createMarketEmailConfirmation, serializeUserEmailAddress, backfillUserEmailAddresses, listUserEmailAddresses, getUserEmailAddress, verifiedEmailCount, setPrimaryEmailAddress, syncPrimaryEmailCaches, createOrResendUserEmailAddress, createMarketWebSession, webAuthPayload, normalizeAppearancePreference, normalizeBaseUrl, normalizeDomainName, normalizeProjectDomainInput, inferZoneNameForDomain, domainInZone, optionalTrimmedString, enumValue, unknownKeys, LOCAL_CONTENT_COLLECTIONS, LOCAL_WORK_CONTENT_COLLECTIONS, LOCAL_DECISION_TYPE_VALUES, PROPOSAL_VERDICT_DECISION_TYPES, PLATFORM_OPERATION_SCOPES, LOCAL_CONTENT_DEFAULTS, slugifyContent, yamlScalar, yamlLines, serializeFrontmatter, normalizeRelationArray, uniqueRelationArray, addRelationValue, normalizeLocalContentInput, writeLocalContentRecord, localContentRoot, localContentPath, readLocalContentRecord, writeParsedLocalContentRecord, createRelatedLocalContentRecord, createDecisionFromProposals, isLoopbackUrl, resolveAuthApprovalBaseUrl, findById, resolveAgentArtifactBucket, centralMarketProfile, normalizeMarketProfile, encryptedHostPayloadLooksValid, decryptedHostConfigSummary, credentialSessionSecret, credentialSessionKey, encryptCredentialSessionPayload, decryptCredentialSessionPayload, normalizeProviderCredentialConfig, HOST_KIND_SESSION_KEYS, normalizeAuditHostKinds, providerCredentialValuesForAudit, collectHostingAuditCredentialOverlay, nonSecretLaunchJobInput, decryptTeamHostForLaunch, mergeStringConfig, buildLaunchCredentialOverlay, patchLaunchIntentForCredentialOverlay, appendLaunchDeploymentEvent, scheduleBackgroundBootstrap, sanitizeLaunchResultForStorage, cloudflareErrorMessage, cloudflareRequestForLaunchPreflight, resolveCloudflareZoneForLaunchPreflight, verifyCloudflareDnsWriteForLaunch, projectDeletionConfirmationMatches, projectDeletionBlockerRows, cloudflareRequestForProjectDeletion, githubRequestForProjectDeletion, projectDeletionOperation, cloudflareDeletionAuthenticationMessage, hasRecordedCloudflareRuntimeResources, canSkipCloudflareCleanupAfterFailedLaunch, projectDeletionHostname, normalizedCloudflareKvNamespaceReference, uniqueCloudflareKvNamespaceReferences, cloudflareProjectDeletionResourceNames, resolveProjectDeletionCloudflareZone, deleteCloudflareDnsRecordsForProject, listCloudflareNamedResources, deleteCloudflareProjectResources, appendProjectDeletionProgress, cloudflareDnsDomainsForHostValidation, validateTeamHostCredentialPayload, runProjectLaunchApiBootstrap, runProjectDeletionApiDestroy, retryApiLaunchBootstrapFromRequest, GITHUB_ACTIONS_OIDC_ISSUER, githubOidcJwksCache, base64urlJson, parseBase64urlJson, operationTokenSecret, signOperationToken, verifyOperationToken, loadGitHubOidcJwks, verifyGitHubOidcToken, normalizeCiEnvironment, ciOperationForAction, fallbackRemoteCapability, normalizeRepositorySlug, projectAllowedCiRepositories, validateCiRefForEnvironment, marketProfilesForTeams, artifactDownloadPayload, principalHasPermission, principalIsSeedAdmin, isTeamApiPrincipal, isLocalAcceptanceServicePrincipal, localAcceptanceAdminToken, localAcceptanceAuthEnabled, decorateJob, safePlatformOperationOutput, decoratePlatformOperation, safeTokenEquals, resolvePlatformRunnerSecret, platformOperationMutationError, requirePlatformRunner, resolvePlatformRepositoryDescriptor, mergeCapability, canonicalArchitectureTopology, launchPlannerRepositoryTopology, launchCapabilityPreset, resourceRowsFromLaunch, ensurePrincipal, resolveUiProjectionContext, decodeRouteParam, uiRuntimeLocals, requireConfiguredServiceCredential, resolvePublicTreeDxTeam, enqueueTreeDxProvisionOperation, principalHasGlobalPlatformRole, requireTeamAccess, requireProjectAccess, safePrivateKnowledgeSlug, privateKnowledgeAuditPayload, recordPrivateKnowledgeAudit, FEEDBACK_TYPES, FEEDBACK_SCREENSHOT_TYPES, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, cleanFeedbackString, safeFeedbackContext, safeFeedbackClient, safeFeedbackScreenshot, validateFeedbackAccess, recordFeedbackSubmission, normalizeSeedEnvironments, seedActor, seedExistingTeamIds, seedCreatesMissingTeams, requireSeedPlanAccess, requireSeedApplyAccess, requireProjectRunner, AGENT_TASK_SIGNATURES, resolveAgentTaskSignature, commerceErrorResponse, stripeConfiguredError, stripeVendorApprovalError, stripeAccountMissingError, stripeCommerceUrl, requireCommerceVendorForStripe, refreshCommerceStripeAccount, STRIPE_PRODUCT_MIRROR_OFFER_MODES, STRIPE_PRICE_MIRROR_OFFER_MODES, stripeMetadataValue, buildCommerceStripeMetadata, commerceStripeProductParams, commerceStripeLookupKey, commerceStripePriceParams, stripePriceTermsDrift, commerceStripeSyncContext, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, CHECKOUT_OFFER_MODES, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, resolveStripePublishableKey, resolveStripeWebhookSecret, commerceCheckoutError, normalizeCheckoutQuantity, stripeClientSecret, paymentGroupStatusFromPaymentIntent, orderStatusFromPaymentGroup, subscriptionStatusFromStripe, entitlementRenewalStateFromSubscription, stripeTimestampToIso, subscriptionClientSecret, publicPaymentGroups, buildCommerceCheckoutMetadata, resolveCommerceCheckoutItem, checkoutGroupKind, checkoutGroupKey, checkoutGroupStatus, grantCommerceEntitlementsForOrder, requireSellerTeamAccess, requireVendorOrderManager, requireServiceBuyerAccess, requireServiceSellerAccess, requireServiceParticipantAccess, redactCommerceServiceRequestForBuyer, requireCommerceCapacityListingAccess, requireCommerceCapacityInquiryAccess, remainingRefundableAmount, stripeRefundStatus, applyCommerceRefundState, resolveOrderItemForRefund, resolveFulfillmentArtifact, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, ensureCommerceStripeCustomer, refreshCommercePaymentGroupState, updateCheckoutCompletionFromGroup, syncCommerceSubscriptionFromStripe, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, handleCommerceInvoiceWebhook, processCommerceStripeWebhook, requireCommerceProductAccess, principalCanManageCommerceProduct, redactCommerceOwnershipWorkflow, requireCommerceOfferAccess, requireCatalogItemAccess, requireConnectedProjectRuntime, projectAppHref, unwrapLaunchOperationOutput, appendLaunchPhaseProjection, updateLaunchDeployments, hubRepositoryPolicies, applyHubLaunchResult, applyHubLaunchFailure, unwrapOperationPayload, applyContentPublishResult, executeInline, projectApiConnection, createProjectInternalClient, executeProjectApi, selectDispatchTarget, defaultConfig, createApiExtension } from './app/support/index.ts';
export * from './app/support/index.ts';

export function createApiApp(options: any = {}): ReturnType<typeof createTreeseedApiApp> {
    const config = defaultConfig(options.config ?? {});
    const apiDatabaseUrl = config.apiDatabaseUrl ?? process.env.TREESEED_DATABASE_URL ?? null;
    if (!options.db && !apiDatabaseUrl) {
        throw new Error('TREESEED_DATABASE_URL is required for the Treeseed PostgreSQL control-plane database.');
    }
    const db = options.db ?? createMarketPostgresDatabase(apiDatabaseUrl);
    const store = options.store ?? new MarketControlPlaneStore({
        ...config,
        assertionSecret: config.webAssertionSecret,
        serviceId: config.webServiceId,
        serviceSecret: config.webServiceSecret,
        fetchImpl: options.fetchImpl ?? fetch,
    }, db);
    const capacity = createCapacityControlPlane(store);
    const configuredAuthProviderId = config.providers?.auth ?? POSTGRES_AUTH_PROVIDER_ID;
    const authProviderId = configuredAuthProviderId === 'd1' ? POSTGRES_AUTH_PROVIDER_ID : configuredAuthProviderId;
    const authConfig = {
        ...config,
        baseUrl: resolveAuthApprovalBaseUrl(config),
    };
    const sharedSdk = options.sdk ?? AgentSdk.createLocal({
        repoRoot: config.repoRoot,
    });
    const runtimeProviders = authProviderId === POSTGRES_AUTH_PROVIDER_ID
        ? {
            ...(options.runtimeProviders ?? {}),
            auth: {
                ...(options.runtimeProviders?.auth ?? {}),
                [POSTGRES_AUTH_PROVIDER_ID]: ({ config: runtimeConfig }) => new DatabaseAuthProvider({
                    ...runtimeConfig,
                    baseUrl: resolveAuthApprovalBaseUrl({
                        ...config,
                        ...runtimeConfig,
                    }),
                }, { db }),
            },
        }
        : {
            ...(options.runtimeProviders ?? {}),
        };
    const logRequests = shouldLogApiRequests(config, options);
    const stripeConnectService = options.stripeConnectService ?? createStripeConnectService({
        config,
        environment: resolveStripeEnvironment(config),
    });
    return createTreeseedApiApp({
        ...options,
        config: {
            ...config,
            providers: {
                ...(config.providers ?? {}),
                auth: authProviderId,
            },
        },
        runtimeProviders,
        sdk: sharedSdk,
        internalPrefix: options.internalPrefix ?? '/internal/core',
        surfaces: {
            templates: false,
            ...(options.surfaces ?? {}),
        },
        extensions: [
            createApiExtension({
                mount(app, runtime) {
                    if (logRequests) {
                        installApiRequestLogger(app);
                    }
                    const runtimeMarketAuthProvider = new DatabaseAuthProvider({
                        ...authConfig,
                        ...runtime.resolved.config,
                        baseUrl: resolveAuthApprovalBaseUrl({
                            ...config,
                            ...runtime.resolved.config,
                        }),
                    }, { db });
                    store.setArtifactBucket(resolveAgentArtifactBucket(runtime));
                    const routeContext = { AGENT_PROMOTION_APPROVAL_DECISIONS, AGENT_TASK_SIGNATURES, AUTH_PROVIDERS, AgentSdk, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, DatabaseAuthProvider, FEEDBACK_SCREENSHOT_TYPES, FEEDBACK_TYPES, GITHUB_ACTIONS_OIDC_ISSUER, HOST_KIND_SESSION_KEYS, LOCAL_CONTENT_COLLECTIONS, LOCAL_CONTENT_DEFAULTS, LOCAL_DECISION_TYPE_VALUES, LOCAL_WORK_CONTENT_COLLECTIONS, MARKET_EMAIL_CONFIRMATION_PREFIX, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, MarketControlPlaneStore, NOTIFICATION_CONTENT_CAPABILITIES, PERSONAL_THEME_COMPILER_VERSION, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, PLATFORM_OPERATION_SCOPES, POSTGRES_AUTH_PROVIDER_ID, PROPOSAL_VERDICT_DECISION_TYPES, RemoteTreeseedClient, RemoteTreeseedOperationsClient, RemoteTreeseedSdkClient, SENSITIVE_QUERY_PARAM_PATTERN, STRIPE_PRICE_MIRROR_OFFER_MODES, STRIPE_PRODUCT_MIRROR_OFFER_MODES, TreeseedOperationsSdk, accountDeletionBlockers, accountDeletionConfirmationMatches, addRelationValue, apiDatabaseUrl, app, appendLaunchDeploymentEvent, appendLaunchPhaseProjection, appendProjectDeletionProgress, applyCommerceRefundState, applyContentPublishResult, applyHubLaunchFailure, applyHubLaunchResult, applySeedWithStore, artifactDownloadPayload, authConfig, authEmailDeliveryFailureDetail, authEmailDeliveryFailureReason, authProviderId, authTokenTimestampMillis, authTokenTimestampSeconds, availabilityAttempts, availabilityRateLimit, backfillUserEmailAddresses, base64Url, base64urlJson, bearerTokenFromRequest, buildCommerceCheckoutMetadata, buildCommerceStripeMetadata, buildGovernanceApprovalProjection, buildGovernanceProjection, buildInfrastructureProjection, buildKnowledgeArtifactProjection, buildKnowledgeProjection, buildLaunchCredentialOverlay, buildWorkdayProjection, canSkipCloudflareCleanupAfterFailedLaunch, canonicalArchitectureTopology, capacity, centralMarketProfile, checkoutGroupKey, checkoutGroupKind, checkoutGroupStatus, ciOperationForAction, cleanFeedbackString, cloudflareDeletionAuthenticationMessage, cloudflareDnsDomainsForHostValidation, cloudflareErrorMessage, cloudflareProjectDeletionResourceNames, cloudflareRequestForLaunchPreflight, cloudflareRequestForProjectDeletion, collectHostingAuditCredentialOverlay, commerceCheckoutError, commerceErrorResponse, commerceStripeLookupKey, commerceStripePriceParams, commerceStripeProductParams, commerceStripeSyncContext, config, configuredAuthProviderId, confirmationUrlFor, consumeReauthentication, contentRelationPolicy, createApiApp, createApiExtension, createCapacityControlPlane, createCipheriv, createClientEncryptedEscrowService, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, createDecipheriv, createDecisionFromProposals, createGitHubActionsSecretEnclave, createGitHubAppAdapter, createHash, createHmac, createMarketEmailConfirmation, createMarketPostgresDatabase, createMarketWebSession, createOrResendUserEmailAddress, createProjectHostCredentialSessions, createProjectInternalClient, createPublicKey, createRelatedLocalContentRecord, createStripeConnectService, createTreeDxCredentialBridge, createTreeseedApiApp, createVerify, credentialSessionKey, credentialSessionSecret, db, decodeRouteParam, decorateJob, decoratePlatformOperation, decryptCredentialSessionPayload, decryptHostConfig, decryptTeamHostForLaunch, decryptedHostConfigSummary, defaultConfig, deleteCloudflareDnsRecordsForProject, deleteCloudflareProjectResources, deleteTeamCapacityAggregate, derivePlatformOperationNavigation, deriveProjectHostBindingsView, domainInZone, encryptCredentialSessionPayload, encryptedHostPayloadLooksValid, enqueueTreeDxProvisionOperation, ensureCommerceStripeCustomer, ensureMarketCredentialSchema, ensurePrincipal, entitlementRenewalStateFromSubscription, enumValue, exchangeProviderIdentity, executeInline, executeProjectApi, executeSdkOperation, existsSync, exportSeedWithStore, exposeAuthTokenForTests, fallbackRemoteCapability, findById, findDispatchCapability, getSiteAuthConfig, getUserEmailAddress, githubOidcJwksCache, githubRequestForProjectDeletion, grantCommerceEntitlementsForOrder, handleCommerceInvoiceWebhook, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, hasRecordedCloudflareRuntimeResources, hashMarketPassword, hostBindingRequiresUnlock, hostKindForBinding, hubRepositoryPolicies, inferZoneNameForDomain, installApiRequestLogger, installCapacityRoutes, installProjectDeploymentRoutes, isLocalAcceptanceServicePrincipal, isLoopbackUrl, isPlatformOperationTerminal, isTeamApiPrincipal, isValidPersonalThemeDraft, jsonError, jsonThrownError, launchCapabilityPreset, launchPlannerRepositoryTopology, listCloudflareNamedResources, listTreeseedManagedHostsFromConfig, listUserEmailAddresses, loadGitHubOidcJwks, loadInfrastructureSeedState, loadKnowledgeContentEntries, loadNotificationPreferences, loadProjectHostBindingContext, loadTemplateCatalog, localAcceptanceAdminToken, localAcceptanceAuthEnabled, localContentPath, localContentRoot, logRequests, managedCloudflareConfigMissing, markdownToPlainProjectSummary, marketAuthContext, marketEmailTokenHash, marketProfilesForTeams, mergeCapability, mergeStringConfig, mkdir, nonSecretLaunchJobInput, normalizeAppearancePreference, normalizeAuditHostKinds, normalizeBaseUrl, normalizeCheckoutQuantity, normalizeCiEnvironment, normalizeDomainName, normalizeEmail, normalizeLocalContentInput, normalizeMarketProfile, normalizeNotificationPreferences, normalizeProjectDomainInput, normalizeProjectLaunchHostBindings, normalizeProviderCredentialConfig, normalizeRelationArray, normalizeRepositoryContentInput, normalizeRepositoryRelationArray, normalizeRepositorySlug, normalizeSeedEnvironments, normalizeTemplateLaunchRequirements, normalizeTreeseedTemplateId, normalizeUsername, normalizedCloudflareKvNamespaceReference, operationTokenSecret, optionalTrimmedString, orderStatusFromPaymentGroup, parseBase64urlJson, parseBooleanEnvValue, parseJsonObject, parseYaml, passwordResetUrlFor, patchLaunchIntentForCredentialOverlay, paymentGroupStatusFromPaymentIntent, pbkdf2Sync, persistProjectHostBindingOperationMetadata, personalThemeFromRow, plaintextHostCredentialFieldPaths, planKnowledgeHubLaunch, planProjectHostBindingOperation, planSeedWithStore, platformOperationMutationError, principalCanManageCommerceProduct, principalHasGlobalPlatformRole, principalHasPermission, principalIsSeedAdmin, privateKnowledgeAuditPayload, processCommerceStripeWebhook, projectAllowedCiRepositories, projectApiConnection, projectAppHref, projectDeletionBlockerRows, projectDeletionConfirmationMatches, projectDeletionHostname, projectDeletionOperation, projectHostBindingMetadata, projectHostResponsePayload, providerConfigFor, providerCredentialValuesForAudit, providerJwksCache, publicPaymentGroups, randomBytes, randomUUID, readCapacityRequestObject, readFile, readJsonOrFormBody, readLocalContentRecord, recordContentNotificationEvent, recordFeedbackSubmission, recordPrivateKnowledgeAudit, redactCommerceOwnershipWorkflow, redactCommerceServiceRequestForBuyer, redactedRequestTarget, refreshCommercePaymentGroupState, refreshCommerceStripeAccount, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, relative, remainingRefundableAmount, repositoryContentRelationPolicy, repositoryInventoryWithPlatform, requestClientIp, requestSessionMetadata, requireCatalogItemAccess, requireCommerceCapacityInquiryAccess, requireCommerceCapacityListingAccess, requireCommerceOfferAccess, requireCommerceProductAccess, requireCommerceVendorForStripe, requireConfiguredServiceCredential, requireConnectedProjectRuntime, requirePlatformRunner, requireProjectAccess, requireProjectRunner, requireSeedApplyAccess, requireSeedPlanAccess, requireSellerTeamAccess, requireServiceBuyerAccess, requireServiceParticipantAccess, requireServiceSellerAccess, requireTeamAccess, requireVendorOrderManager, resolve, resolveAgentArtifactBucket, resolveAgentTaskSignature, resolveApiConfig, resolveAuthApprovalBaseUrl, resolveCloudflareZoneForLaunchPreflight, resolveCommerceCheckoutItem, resolveFulfillmentArtifact, resolveLaunchTemplateRequirements, resolveOrderItemForRefund, resolvePlatformRepositoryDescriptor, resolvePlatformRunnerSecret, resolveProjectDeletionCloudflareZone, resolveProjectLaunchHostBindings, resolvePublicTreeDxTeam, resolveStripeEnvironment, resolveStripePublishableKey, resolveStripeWebhookSecret, resolveTreeseedManagedCloudflareHostConfigFromConfig, resolveUiProjectionContext, resourceRowsFromLaunch, retryApiLaunchBootstrapFromRequest, rm, runProjectDeletionApiDestroy, runProjectLaunchApiBootstrap, runTreeseedHostingAudit, runtime, runtimeMarketAuthProvider, runtimeProviders, safeFeedbackClient, safeFeedbackContext, safeFeedbackScreenshot, safePlatformOperationOutput, safePrivateKnowledgeSlug, safeTokenEquals, sanitizeLaunchResultForStorage, sanitizedReturnTo, scheduleBackgroundBootstrap, seedActor, seedCreatesMissingTeams, seedExistingTeamIds, selectDispatchTarget, sendAuthEmail, sendEmailConfirmation, sendTeamInviteEmail, sendWelcomeEmail, serializeFrontmatter, serializeUserEmailAddress, setPrimaryEmailAddress, sharedSdk, shouldBypassAcceptanceAuthEmailDelivery, shouldExposeNonProductionAuthDiagnostics, shouldLogApiRequests, signEditorialPreviewToken, signOperationToken, slugifyContent, slugifyRepositoryContent, sourceFromProjectDetails, store, stripeAccountMissingError, stripeAccountToConnectedAccountPatch, stripeClientSecret, stripeCommerceUrl, stripeConfiguredError, stripeConnectService, stripeMetadataValue, stripePriceTermsDrift, stripeRefundStatus, stripeTimestampToIso, stripeVendorApprovalError, subscriptionClientSecret, subscriptionStatusFromStripe, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, syncCommerceSubscriptionFromStripe, syncPrimaryEmailCaches, teamInviteAcceptUrlFor, timingSafeEqual, trimmedHeaderValue, uiRuntimeLocals, uniqueCloudflareKvNamespaceReferences, uniqueRelationArray, unknownKeys, unwrapLaunchOperationOutput, unwrapOperationPayload, updateCheckoutCompletionFromGroup, updateLaunchDeployments, validateCiRefForEnvironment, validateFeedbackAccess, validateMarketPassword, validateProjectSlug, validatePublicUsername, validateTeamHostCredentialPayload, verifiedEmailCount, verifyCloudflareDnsWriteForLaunch, verifyGitHubOidcToken, verifyMarketPassword, verifyOperationToken, verifyProviderIdToken, webAuthPayload, webSessionData, writeFile, writeLocalContentRecord, writeParsedLocalContentRecord, yamlLines, yamlScalar, options };
                    installFoundationHealthMarketAndFeedbackRoutes(routeContext);
                    installFoundationAcceptanceSeedRoutes(routeContext);
                    installOperationsPlatformRunnersAndJobsRoutes(routeContext);
                    installAuthenticationDeviceSignupAndOauthRoutes(routeContext);
                    installAuthenticationAccountProfileAndNotificationsRoutes(routeContext);
                    installAuthenticationPasswordAndAccountSecurityRoutes(routeContext);
                    installFoundationCurrentUserMarketsRoutes(routeContext);
                    installGovernanceProjectionRoutes(routeContext);
                    installProjectionsInfrastructureKnowledgeAndWorkdaysRoutes(routeContext);
                    installTeamsDirectoryRoutes(routeContext);
                    installFoundationUsersByUsernameItemProfileRoutes(routeContext);
                    installCatalogSeedRunLifecycleRoutes(routeContext);
                    installTeamsInvitationsMembershipAndApiKeysRoutes(routeContext);
                    installTreedxTeamServiceAndPublicFederationRoutes(routeContext);
                    installFoundationInternalGithubAppWebhookRoutes(routeContext);
                    installTreedxInternalTreedxPublicFederationStatusRoutes(routeContext);
                    installFoundationIssueTreeDxGitHubCredentialRoutes(routeContext);
                    installTreedxCredentialsMirrorsAndSharesRoutes(routeContext);
                    installTeamsRepositoryAndWebHostsRoutes(routeContext);
                    installProjectsSecretsWorkflowsAndCollectionRoutes(routeContext);
                    installProjectsTeamsItemProjectsLaunchRoutes(routeContext);
                    installProjectsHostsAndRepositoryTopologyRoutes(routeContext);
                    installFoundationQueueProjectHostOperationRoutes(routeContext);
                    installProjectsHostLifecycleAndSummaryRoutes(routeContext);
                    installProjectsWorkstreamsAndReleasesRoutes(routeContext);
                    installGovernanceTeamProjectPolicyRoutes(routeContext);
                    installProjectsProposalsAndDecisionsRoutes(routeContext);
                    installGovernanceTeamProjectDelegationsAndApprovalsRoutes(routeContext);
                    installProjectsOperationGrantsAndPlanningRoutes(routeContext);
                    installGovernanceProjectsItemApprovalsItemDecisionRoutes(routeContext);
                    installProjectsSharingHostingAndResourcesRoutes(routeContext);
                    installFoundationRoutesRoutes(routeContext);
                    installProjectsCapabilitiesContentAndCiRoutes(routeContext);
                    installOperationsProjectsItemCiJobsItemRoutes(routeContext);
                    installProjectsProjectsItemDispatchRoutes(routeContext);
                    installOperationsProjectJobsAndCredentialSessionsRoutes(routeContext);
                    installFoundationApprovalDecisionsRoutes(routeContext);
                    installGovernanceCommonsProposalsQuestionsAndVotesRoutes(routeContext);
                    installFoundationStewardTransitionCommonsProposalRoutes(routeContext);
                    installGovernanceCommonsReviewsDecisionsAndDelegationsRoutes(routeContext);
                    installOperationsProjectRunnerEventsAndCompletionRoutes(routeContext);
                    installCommerceVendorOnboardingStripeAndCheckoutRoutes(routeContext);
                    installCommerceServiceRequestsContractsAndOrdersRoutes(routeContext);
                    installCommerceSalesFulfillmentAndProductCatalogRoutes(routeContext);
                    installCommerceProductGovernanceAndCapacityListingsRoutes(routeContext);
                    installCommerceCapacityInquiriesProductVersionsAndOffersRoutes(routeContext);
                    installCommerceStripePriceReconciliationAndGovernanceEventsRoutes(routeContext);
                    installCatalogItemsAndArtifactsRoutes(routeContext);
                    installTeamsTeamsItemCatalogItemsRoutes(routeContext);
                    installCatalogCatalogItemArtifactsRoutes(routeContext);
                    installTeamsStorageAndContentPreviewsRoutes(routeContext);
                    installCatalogTemplatesAndKnowledgePacksRoutes(routeContext);
                    options.extendApp?.(app, runtime);
                },
            }),
            ...(options.extensions ?? []),
        ],
    });
}

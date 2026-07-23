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
import { installFoundationHealthzDeepThroughFeedbackRoutes } from './routes/foundation-healthz-deep-through-feedback.ts';
import { installFoundationAcceptanceSeedRoutes } from './routes/foundation-acceptance-seed.ts';
import { installOperationsPlatformOperationsThroughPlatformRunnersJobsItemFailRoutes } from './routes/operations-platform-operations-through-platform-runners-jobs-item-fail.ts';
import { installAuthenticationAuthDeviceStartThroughAuthOauthItemCallbackRoutes } from './routes/authentication-auth-device-start-through-auth-oauth-item-callback.ts';
import { installAuthenticationAuthAvailabilityUsernameThroughAuthWebNotificationsItemReadRoutes } from './routes/authentication-auth-availability-username-through-auth-web-notifications-item-read.ts';
import { installAuthenticationAuthWebPasswordThroughAuthLogoutRoutes } from './routes/authentication-auth-web-password-through-auth-logout.ts';
import { installFoundationMeThroughMeMarketsRoutes } from './routes/foundation-me-through-me-markets.ts';
import { installGovernanceUiGovernanceThroughUiGovernanceItemDecisionRoutes } from './routes/governance-ui-governance-through-ui-governance-item-decision.ts';
import { installProjectionsUiInfrastructureThroughUiWorkdaysItemRoutes } from './routes/projections-ui-infrastructure-through-ui-workdays-item.ts';
import { installTeamsTeamsThroughTeamsByNameItemProfileRoutes } from './routes/teams-teams-through-teams-by-name-item-profile.ts';
import { installFoundationUsersByUsernameItemProfileRoutes } from './routes/foundation-users-by-username-item-profile.ts';
import { installCatalogSeedsRunsThroughSeedsItemApplyRoutes } from './routes/catalog-seeds-runs-through-seeds-item-apply.ts';
import { installTeamsTeamInvitesItemAcceptThroughTeamsItemApiKeysRoutes } from './routes/teams-team-invites-item-accept-through-teams-item-api-keys.ts';
import { installTreedxTeamsItemTreedxThroughInternalTreedxPublicFederationProvisionRoutes } from './routes/treedx-teams-item-treedx-through-internal-treedx-public-federation-provision.ts';
import { installFoundationInternalGithubAppWebhookRoutes } from './routes/foundation-internal-github-app-webhook.ts';
import { installTreedxInternalTreedxPublicFederationStatusRoutes } from './routes/treedx-internal-treedx-public-federation-status.ts';
import { installFoundationIssueTreeDxGitHubCredentialRoutes } from './routes/foundation-issueTreeDxGitHubCredential.ts';
import { installTreedxInternalTreedxCredentialsGithubThroughTeamsItemTreedxSharesRoutes } from './routes/treedx-internal-treedx-credentials-github-through-teams-item-treedx-shares.ts';
import { installTeamsTeamsItemWebHostsThroughTeamsItemHostsItemValidateRoutes } from './routes/teams-teams-item-web-hosts-through-teams-item-hosts-item-validate.ts';
import { installProjectsProjectsItemSecretsGithubActionsPublicKeyThroughTeamsItemProjectsRoutes } from './routes/projects-projects-item-secrets-github-actions-public-key-through-teams-item-projects.ts';
import { installProjectsTeamsItemProjectsLaunchRoutes } from './routes/projects-teams-item-projects-launch.ts';
import { installProjectsProjectsItemThroughProjectsItemRepositoryTopologyRoutes } from './routes/projects-projects-item-through-projects-item-repository-topology.ts';
import { installFoundationQueueProjectHostOperationRoutes } from './routes/foundation-queueProjectHostOperation.ts';
import { installProjectsProjectsItemHostsAuditThroughProjectsItemShareRoutes } from './routes/projects-projects-item-hosts-audit-through-projects-item-share.ts';
import { installProjectsProjectsItemWorkstreamsThroughProjectsItemReleasesItemPublishRoutes } from './routes/projects-projects-item-workstreams-through-projects-item-releases-item-publish.ts';
import { installGovernanceTeamsItemGovernancePolicyThroughProjectsItemGovernancePolicyRoutes } from './routes/governance-teams-item-governance-policy-through-projects-item-governance-policy.ts';
import { installProjectsProjectsItemProposalsThroughProjectsItemDecisionsItemEventsRoutes } from './routes/projects-projects-item-proposals-through-projects-item-decisions-item-events.ts';
import { installGovernanceTeamsItemGovernanceDelegationsThroughProjectsItemApprovalsItemRoutes } from './routes/governance-teams-item-governance-delegations-through-projects-item-approvals-item.ts';
import { installProjectsProjectsItemOperationsGrantsThroughProjectsItemOperationsItemPlanRoutes } from './routes/projects-projects-item-operations-grants-through-projects-item-operations-item-plan.ts';
import { installGovernanceProjectsItemApprovalsItemDecisionRoutes } from './routes/governance-projects-item-approvals-item-decision.ts';
import { installProjectsProjectsItemProvidersCodexReadinessThroughProjectsItemResourcesRoutes } from './routes/projects-projects-item-providers-codex-readiness-through-projects-item-resources.ts';
import { installFoundationRoutesRoutes } from './routes/foundation-routes.ts';
import { installProjectsProjectsItemCapabilitiesThroughProjectsItemCiOidcExchangeRoutes } from './routes/projects-projects-item-capabilities-through-projects-item-ci-oidc-exchange.ts';
import { installOperationsProjectsItemCiJobsItemRoutes } from './routes/operations-projects-item-ci-jobs-item.ts';
import { installProjectsProjectsItemDispatchRoutes } from './routes/projects-projects-item-dispatch.ts';
import { installOperationsJobsItemThroughJobsItemProviderCredentialSessionsItemConsumeRoutes } from './routes/operations-jobs-item-through-jobs-item-provider-credential-sessions-item-consume.ts';
import { installFoundationApprovalRequestsItemDecideThroughCommonsErrorResponseRoutes } from './routes/foundation-approval-requests-item-decide-through-commonsErrorResponse.ts';
import { installGovernanceCommonsSummaryThroughCommonsProposalsItemVoteRoutes } from './routes/governance-commons-summary-through-commons-proposals-item-vote.ts';
import { installFoundationStewardTransitionCommonsProposalRoutes } from './routes/foundation-stewardTransitionCommonsProposal.ts';
import { installGovernanceCommonsProposalsItemReviewThroughCommonsDelegationsItemRevokeRoutes } from './routes/governance-commons-proposals-item-review-through-commons-delegations-item-revoke.ts';
import { installOperationsJobsItemEventsThroughJobsItemFailRoutes } from './routes/operations-jobs-item-events-through-jobs-item-fail.ts';
import { installCommerceCommerceVendorsItemThroughCommerceServicesRequestsRoutes } from './routes/commerce-commerce-vendors-item-through-commerce-services-requests.ts';
import { installCommerceCommerceServicesRequestsThroughCommerceVendorsItemSalesOrdersRoutes } from './routes/commerce-commerce-services-requests-through-commerce-vendors-item-sales-orders.ts';
import { installCommerceCommerceVendorsItemSalesSubscriptionsThroughCommerceProductsItemOwnershipRoutes } from './routes/commerce-commerce-vendors-item-sales-subscriptions-through-commerce-products-item-ownership.ts';
import { installCommerceCommerceProductsItemOwnershipThroughCommerceCapacityListingsItemRejectRoutes } from './routes/commerce-commerce-products-item-ownership-through-commerce-capacity-listings-item-reject.ts';
import { installCommerceCommerceCapacityListingsItemSuspendThroughCommercePricesItemActivateRoutes } from './routes/commerce-commerce-capacity-listings-item-suspend-through-commerce-prices-item-activate.ts';
import { installCommerceCommercePricesItemStripeReconcileThroughCommerceGovernanceEventsRoutes } from './routes/commerce-commerce-prices-item-stripe-reconcile-through-commerce-governance-events.ts';
import { installCatalogCatalogThroughCatalogItemArtifactsItemDownloadRoutes } from './routes/catalog-catalog-through-catalog-item-artifacts-item-download.ts';
import { installTeamsTeamsItemCatalogItemsRoutes } from './routes/teams-teams-item-catalog-items.ts';
import { installCatalogCatalogItemArtifactsRoutes } from './routes/catalog-catalog-item-artifacts.ts';
import { installTeamsTeamsItemStorageThroughTeamsItemContentPreviewsRoutes } from './routes/teams-teams-item-storage-through-teams-item-content-previews.ts';
import { installCatalogTemplatesThroughKnowledgePacksRoutes } from './routes/catalog-templates-through-knowledge-packs.ts';
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
                    installFoundationHealthzDeepThroughFeedbackRoutes(routeContext);
                    installFoundationAcceptanceSeedRoutes(routeContext);
                    installOperationsPlatformOperationsThroughPlatformRunnersJobsItemFailRoutes(routeContext);
                    installAuthenticationAuthDeviceStartThroughAuthOauthItemCallbackRoutes(routeContext);
                    installAuthenticationAuthAvailabilityUsernameThroughAuthWebNotificationsItemReadRoutes(routeContext);
                    installAuthenticationAuthWebPasswordThroughAuthLogoutRoutes(routeContext);
                    installFoundationMeThroughMeMarketsRoutes(routeContext);
                    installGovernanceUiGovernanceThroughUiGovernanceItemDecisionRoutes(routeContext);
                    installProjectionsUiInfrastructureThroughUiWorkdaysItemRoutes(routeContext);
                    installTeamsTeamsThroughTeamsByNameItemProfileRoutes(routeContext);
                    installFoundationUsersByUsernameItemProfileRoutes(routeContext);
                    installCatalogSeedsRunsThroughSeedsItemApplyRoutes(routeContext);
                    installTeamsTeamInvitesItemAcceptThroughTeamsItemApiKeysRoutes(routeContext);
                    installTreedxTeamsItemTreedxThroughInternalTreedxPublicFederationProvisionRoutes(routeContext);
                    installFoundationInternalGithubAppWebhookRoutes(routeContext);
                    installTreedxInternalTreedxPublicFederationStatusRoutes(routeContext);
                    installFoundationIssueTreeDxGitHubCredentialRoutes(routeContext);
                    installTreedxInternalTreedxCredentialsGithubThroughTeamsItemTreedxSharesRoutes(routeContext);
                    installTeamsTeamsItemWebHostsThroughTeamsItemHostsItemValidateRoutes(routeContext);
                    installProjectsProjectsItemSecretsGithubActionsPublicKeyThroughTeamsItemProjectsRoutes(routeContext);
                    installProjectsTeamsItemProjectsLaunchRoutes(routeContext);
                    installProjectsProjectsItemThroughProjectsItemRepositoryTopologyRoutes(routeContext);
                    installFoundationQueueProjectHostOperationRoutes(routeContext);
                    installProjectsProjectsItemHostsAuditThroughProjectsItemShareRoutes(routeContext);
                    installProjectsProjectsItemWorkstreamsThroughProjectsItemReleasesItemPublishRoutes(routeContext);
                    installGovernanceTeamsItemGovernancePolicyThroughProjectsItemGovernancePolicyRoutes(routeContext);
                    installProjectsProjectsItemProposalsThroughProjectsItemDecisionsItemEventsRoutes(routeContext);
                    installGovernanceTeamsItemGovernanceDelegationsThroughProjectsItemApprovalsItemRoutes(routeContext);
                    installProjectsProjectsItemOperationsGrantsThroughProjectsItemOperationsItemPlanRoutes(routeContext);
                    installGovernanceProjectsItemApprovalsItemDecisionRoutes(routeContext);
                    installProjectsProjectsItemProvidersCodexReadinessThroughProjectsItemResourcesRoutes(routeContext);
                    installFoundationRoutesRoutes(routeContext);
                    installProjectsProjectsItemCapabilitiesThroughProjectsItemCiOidcExchangeRoutes(routeContext);
                    installOperationsProjectsItemCiJobsItemRoutes(routeContext);
                    installProjectsProjectsItemDispatchRoutes(routeContext);
                    installOperationsJobsItemThroughJobsItemProviderCredentialSessionsItemConsumeRoutes(routeContext);
                    installFoundationApprovalRequestsItemDecideThroughCommonsErrorResponseRoutes(routeContext);
                    installGovernanceCommonsSummaryThroughCommonsProposalsItemVoteRoutes(routeContext);
                    installFoundationStewardTransitionCommonsProposalRoutes(routeContext);
                    installGovernanceCommonsProposalsItemReviewThroughCommonsDelegationsItemRevokeRoutes(routeContext);
                    installOperationsJobsItemEventsThroughJobsItemFailRoutes(routeContext);
                    installCommerceCommerceVendorsItemThroughCommerceServicesRequestsRoutes(routeContext);
                    installCommerceCommerceServicesRequestsThroughCommerceVendorsItemSalesOrdersRoutes(routeContext);
                    installCommerceCommerceVendorsItemSalesSubscriptionsThroughCommerceProductsItemOwnershipRoutes(routeContext);
                    installCommerceCommerceProductsItemOwnershipThroughCommerceCapacityListingsItemRejectRoutes(routeContext);
                    installCommerceCommerceCapacityListingsItemSuspendThroughCommercePricesItemActivateRoutes(routeContext);
                    installCommerceCommercePricesItemStripeReconcileThroughCommerceGovernanceEventsRoutes(routeContext);
                    installCatalogCatalogThroughCatalogItemArtifactsItemDownloadRoutes(routeContext);
                    installTeamsTeamsItemCatalogItemsRoutes(routeContext);
                    installCatalogCatalogItemArtifactsRoutes(routeContext);
                    installTeamsTeamsItemStorageThroughTeamsItemContentPreviewsRoutes(routeContext);
                    installCatalogTemplatesThroughKnowledgePacksRoutes(routeContext);
                    options.extendApp?.(app, runtime);
                },
            }),
            ...(options.extensions ?? []),
        ],
    });
}

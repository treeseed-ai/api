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
import { jsonError, jsonThrownError, POSTGRES_AUTH_PROVIDER_ID, availabilityAttempts, AUTH_PROVIDERS, providerJwksCache, availabilityRateLimit, personalThemeFromRow, accountDeletionBlockers, consumeReauthentication, loadNotificationPreferences, providerConfigFor, base64Url, verifyProviderIdToken, exchangeProviderIdentity, resolveLaunchTemplateRequirements, projectHostBindingMetadata, loadProjectHostBindingContext, projectHostResponsePayload, hostBindingRequiresUnlock, hostKindForBinding, createProjectHostCredentialSessions, persistProjectHostBindingOperationMetadata, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, plaintextHostCredentialFieldPaths, rejectPlaintextHostCredentialFields, parseBooleanEnvValue, shouldLogApiRequests, shouldExposeNonProductionAuthDiagnostics, SENSITIVE_QUERY_PARAM_PATTERN, redactedRequestTarget, installApiRequestLogger, AGENT_PROMOTION_APPROVAL_DECISIONS, readJsonOrFormBody, normalizeEmail, normalizeUsername, parseJsonObject, trimmedHeaderValue, requestClientIp, requestSessionMetadata, webSessionData, validateMarketPassword, hashMarketPassword, verifyMarketPassword, ensureMarketCredentialSchema, MARKET_EMAIL_CONFIRMATION_PREFIX, marketAuthContext, shouldBypassAcceptanceAuthEmailDelivery, marketEmailTokenHash, exposeAuthTokenForTests, authTokenTimestampSeconds, authTokenTimestampMillis, sanitizedReturnTo, confirmationUrlFor, teamInviteAcceptUrlFor, passwordResetUrlFor, sendTeamInviteEmail, createMarketEmailConfirmation, serializeUserEmailAddress, backfillUserEmailAddresses, listUserEmailAddresses, getUserEmailAddress, verifiedEmailCount, setPrimaryEmailAddress, syncPrimaryEmailCaches, createOrResendUserEmailAddress, createMarketWebSession, webAuthPayload, normalizeAppearancePreference, normalizeBaseUrl, normalizeDomainName, normalizeProjectDomainInput, inferZoneNameForDomain, domainInZone, optionalTrimmedString, enumValue, unknownKeys, LOCAL_CONTENT_COLLECTIONS, LOCAL_WORK_CONTENT_COLLECTIONS, LOCAL_DECISION_TYPE_VALUES, PROPOSAL_VERDICT_DECISION_TYPES, PLATFORM_OPERATION_SCOPES, LOCAL_CONTENT_DEFAULTS, slugifyContent, yamlScalar, yamlLines, serializeFrontmatter, normalizeRelationArray, uniqueRelationArray, addRelationValue, normalizeLocalContentInput, writeLocalContentRecord, localContentRoot, localContentPath, readLocalContentRecord, writeParsedLocalContentRecord, createRelatedLocalContentRecord, createDecisionFromProposals, isLoopbackUrl, resolveAuthApprovalBaseUrl, findById, resolveAgentArtifactBucket, centralMarketProfile, normalizeMarketProfile, encryptedHostPayloadLooksValid, decryptedHostConfigSummary, credentialSessionSecret, credentialSessionKey, encryptCredentialSessionPayload, decryptCredentialSessionPayload, normalizeProviderCredentialConfig, HOST_KIND_SESSION_KEYS, normalizeAuditHostKinds, providerCredentialValuesForAudit, collectHostingAuditCredentialOverlay, nonSecretLaunchJobInput, decryptTeamHostForLaunch, mergeStringConfig, buildLaunchCredentialOverlay, patchLaunchIntentForCredentialOverlay, appendLaunchDeploymentEvent, scheduleBackgroundBootstrap, sanitizeLaunchResultForStorage, cloudflareErrorMessage, cloudflareRequestForLaunchPreflight, resolveCloudflareZoneForLaunchPreflight, verifyCloudflareDnsWriteForLaunch, cloudflareRequestForProjectDeletion, cloudflareDeletionAuthenticationMessage, hasRecordedCloudflareRuntimeResources, canSkipCloudflareCleanupAfterFailedLaunch, projectDeletionHostname, normalizedCloudflareKvNamespaceReference, uniqueCloudflareKvNamespaceReferences, cloudflareProjectDeletionResourceNames, resolveProjectDeletionCloudflareZone, deleteCloudflareDnsRecordsForProject, listCloudflareNamedResources, deleteCloudflareProjectResources, cloudflareDnsDomainsForHostValidation, validateTeamHostCredentialPayload, runProjectLaunchApiBootstrap, retryApiLaunchBootstrapFromRequest, GITHUB_ACTIONS_OIDC_ISSUER, githubOidcJwksCache, base64urlJson, parseBase64urlJson, operationTokenSecret, signOperationToken, verifyOperationToken, loadGitHubOidcJwks, verifyGitHubOidcToken, normalizeCiEnvironment, ciOperationForAction, fallbackRemoteCapability, validateCiRefForEnvironment, marketProfilesForTeams, artifactDownloadPayload, principalHasPermission, principalIsSeedAdmin, isTeamApiPrincipal, isLocalAcceptanceServicePrincipal, localAcceptanceAdminToken, localAcceptanceAuthEnabled, decorateJob, safePlatformOperationOutput, decoratePlatformOperation, safeTokenEquals, resolvePlatformRunnerSecret, platformOperationMutationError, requirePlatformRunner, mergeCapability, canonicalArchitectureTopology, launchPlannerRepositoryTopology, launchCapabilityPreset, resourceRowsFromLaunch, ensurePrincipal, decodeRouteParam, uiRuntimeLocals, requireConfiguredServiceCredential, resolvePublicTreeDxTeam, enqueueTreeDxProvisionOperation, principalHasGlobalPlatformRole, requireTeamAccess, safePrivateKnowledgeSlug, privateKnowledgeAuditPayload, recordPrivateKnowledgeAudit, FEEDBACK_TYPES, FEEDBACK_SCREENSHOT_TYPES, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, cleanFeedbackString, safeFeedbackContext, safeFeedbackClient, safeFeedbackScreenshot, validateFeedbackAccess, recordFeedbackSubmission, normalizeSeedEnvironments, seedActor, seedExistingTeamIds, seedCreatesMissingTeams, requireSeedPlanAccess, requireSeedApplyAccess, AGENT_TASK_SIGNATURES, resolveAgentTaskSignature, commerceErrorResponse, stripeConfiguredError, stripeVendorApprovalError, stripeAccountMissingError, stripeCommerceUrl, requireCommerceVendorForStripe, refreshCommerceStripeAccount, STRIPE_PRODUCT_MIRROR_OFFER_MODES, STRIPE_PRICE_MIRROR_OFFER_MODES, stripeMetadataValue, buildCommerceStripeMetadata, commerceStripeProductParams, commerceStripeLookupKey, commerceStripePriceParams, stripePriceTermsDrift, commerceStripeSyncContext, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, CHECKOUT_OFFER_MODES, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, resolveStripePublishableKey, resolveStripeWebhookSecret, commerceCheckoutError, normalizeCheckoutQuantity, stripeClientSecret, paymentGroupStatusFromPaymentIntent, orderStatusFromPaymentGroup, subscriptionStatusFromStripe, entitlementRenewalStateFromSubscription, stripeTimestampToIso, subscriptionClientSecret, publicPaymentGroups, buildCommerceCheckoutMetadata, resolveCommerceCheckoutItem, checkoutGroupKind, checkoutGroupKey, checkoutGroupStatus, grantCommerceEntitlementsForOrder, requireSellerTeamAccess, requireVendorOrderManager, requireServiceBuyerAccess, requireServiceSellerAccess, requireServiceParticipantAccess, redactCommerceServiceRequestForBuyer, requireCommerceCapacityListingAccess, requireCommerceCapacityInquiryAccess, remainingRefundableAmount, stripeRefundStatus, applyCommerceRefundState, resolveOrderItemForRefund, resolveFulfillmentArtifact, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, ensureCommerceStripeCustomer, refreshCommercePaymentGroupState, updateCheckoutCompletionFromGroup, syncCommerceSubscriptionFromStripe, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, handleCommerceInvoiceWebhook, processCommerceStripeWebhook, requireCommerceProductAccess, principalCanManageCommerceProduct, redactCommerceOwnershipWorkflow, requireCommerceOfferAccess, requireCatalogItemAccess, unwrapLaunchOperationOutput, appendLaunchPhaseProjection, updateLaunchDeployments, applyHubLaunchResult, applyHubLaunchFailure, unwrapOperationPayload, applyContentPublishResult, executeInline, selectDispatchTarget, defaultConfig, createApiExtension, sourceFromProjectDetails, rejectProjectSecretUnlockMaterial, markdownToPlainProjectSummary, projectDeletionConfirmationMatches, projectDeletionBlockerRows, githubRequestForProjectDeletion, projectDeletionOperation, appendProjectDeletionProgress, runProjectDeletionApiDestroy, projectAllowedCiRepositories, resolveUiProjectionContext, requireProjectAccess, requireProjectRunner, requireConnectedProjectRuntime, projectAppHref, projectApiConnection, createProjectInternalClient, executeProjectApi } from '../../index.ts';
export function repositoryInventoryWithPlatform(repositoryHosts, requestedOwner = null) {
    if ((repositoryHosts ?? []).some((host) => host.id === 'platform:github:hosted-hubs'))
        return repositoryHosts;
    return [
        ...(repositoryHosts ?? []),
        {
            id: 'platform:github:hosted-hubs',
            type: 'repository',
            provider: 'github',
            ownership: 'treeseed_managed',
            name: 'TreeSeed Hosted Hubs',
            accountLabel: process.env.TREESEED_HOSTED_HUBS_GITHUB_OWNER ?? null,
            organizationOrOwner: process.env.TREESEED_HOSTED_HUBS_GITHUB_OWNER ?? requestedOwner ?? 'treeseed-sites',
            allowedEnvironments: ['staging', 'prod'],
            status: 'active',
            metadata: { hostType: 'repository', managed: true },
        },
    ];
}
export function normalizeRepositorySlug(value) {
    const text = String(value ?? '').trim().toLowerCase();
    return text.includes('/') ? text : null;
}
export function resolvePlatformRepositoryDescriptor(config, details, body: any = {}) {
    const repositories = Array.isArray(details.repositories) ? details.repositories : [];
    const configured = body.repository && typeof body.repository === 'object' && !Array.isArray(body.repository) ? body.repository : {};
    const requestedRole = optionalTrimmedString(configured.role) ?? optionalTrimmedString(body.repositoryRole);
    const canonicalRepository = (requestedRole ? repositories.find((entry) => entry.role === requestedRole) : null)
        ?? repositories.find((entry) => ['primary', 'package', 'software', 'content'].includes(entry.role))
        ?? repositories[0]
        ?? null;
    const metadata = details.project?.metadata && typeof details.project.metadata === 'object' ? details.project.metadata : {};
    const metadataRepository = metadata.repository && typeof metadata.repository === 'object' ? metadata.repository : {};
    const cloneUrl = optionalTrimmedString(configured.cloneUrl)
        ?? optionalTrimmedString(canonicalRepository?.url)
        ?? optionalTrimmedString(metadataRepository.cloneUrl)
        ?? optionalTrimmedString(metadata.cloneUrl)
        ?? optionalTrimmedString(metadata.repositoryUrl)
        ?? optionalTrimmedString(config.repoRoot);
    return {
        provider: optionalTrimmedString(configured.provider)
            ?? optionalTrimmedString(canonicalRepository?.provider)
            ?? optionalTrimmedString(metadataRepository.provider)
            ?? 'local',
        owner: optionalTrimmedString(configured.owner)
            ?? optionalTrimmedString(canonicalRepository?.owner)
            ?? optionalTrimmedString(metadataRepository.owner)
            ?? optionalTrimmedString(metadata.repositoryOwner)
            ?? details.project.teamId,
        name: optionalTrimmedString(configured.name)
            ?? optionalTrimmedString(canonicalRepository?.name)
            ?? optionalTrimmedString(metadataRepository.name)
            ?? optionalTrimmedString(metadata.repositoryName)
            ?? details.project.slug,
        defaultBranch: optionalTrimmedString(configured.defaultBranch)
            ?? optionalTrimmedString(canonicalRepository?.defaultBranch)
            ?? optionalTrimmedString(metadataRepository.defaultBranch)
            ?? optionalTrimmedString(metadata.defaultBranch)
            ?? 'staging',
        cloneUrl,
        writeMode: ['workspace', 'branch', 'direct', 'pull_request'].includes(configured.writeMode)
            ? configured.writeMode
            : 'workspace',
        branchName: optionalTrimmedString(configured.branchName),
        push: configured.push === true,
        pathPolicies: Array.isArray(configured.pathPolicies)
            ? configured.pathPolicies
            : [{ allow: 'src/content/**' }],
    };
}
export function hubRepositoryPolicies(role) {
    if (role === 'content') {
        return {
            releasePolicy: {
                track: 'content_publish',
                softwareReleaseRequired: false,
                approvalRule: 'content_policy_approver',
            },
            publishPolicy: {
                track: 'content_publish',
                target: 'r2_published_artifacts',
                approvalRule: 'content_policy_approver',
            },
        };
    }
    if (role === 'parent_workspace') {
        return {
            releasePolicy: {
                track: 'parent_workspace_pointer',
                approvalRule: 'technical_steward',
            },
            publishPolicy: {
                disabled: true,
                reason: 'Parent workspace repositories are updated through workspace pointer jobs.',
            },
        };
    }
    return {
        releasePolicy: {
            track: 'software_release',
            approvalRule: 'technical_steward_or_release_approver',
        },
        publishPolicy: {
            disabled: true,
            reason: 'Software repositories do not publish content artifacts.',
        },
    };
}

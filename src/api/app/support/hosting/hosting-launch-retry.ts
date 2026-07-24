import type { Hono } from 'hono';
import { AgentSdk, RemoteClient, RemoteOperationsClient, RemoteSdkClient, signEditorialPreviewToken, OperationsSdk, executeSdkOperation, findDispatchCapability, planKnowledgeHubLaunch, derivePlatformOperationNavigation, deriveProjectHostBindingsView, isPlatformOperationTerminal, normalizeProjectLaunchHostBindings, normalizePlatformContentInput as normalizeRepositoryContentInput, normalizePlatformRelationArray as normalizeRepositoryRelationArray, platformContentRelationPolicy as repositoryContentRelationPolicy, normalizeTemplateLaunchRequirements, normalizeTemplateId, planProjectHostBindingOperation, resolveProjectLaunchHostBindings, slugifyPlatformContent as slugifyRepositoryContent, } from '@treeseed/sdk';
import { runHostingAudit } from '@treeseed/sdk/workflow-support';
import { createApiApp as createSdkApiApp, D1AuthProvider as DatabaseAuthProvider, loadTemplateCatalog, resolveApiConfig, } from '@treeseed/sdk/api';
import { MarketControlPlaneStore, validateProjectSlug } from '../../../persistence/store.js';
import { createClientEncryptedEscrowService } from '../../../support/client-encrypted-escrow.ts';
import { createGitHubAppAdapter } from '../../../reconciliation/github-app-adapter.ts';
import { createGitHubActionsSecretEnclave } from '../../../configuration/github-actions-secret-enclave.ts';
import { bearerTokenFromRequest } from '../../../accounts/request-auth.ts';
import { createTreeDxCredentialBridge } from '../../../treedx/repositories/treedx-credential-bridge.ts';
import { createMarketPostgresDatabase } from '../../../support/market-postgres.js';
import { installProjectDeploymentRoutes } from '../../../projects/deployments/project-deployment-routes.js';
import { installCapacityRoutes } from '../../../capacity/routes/index.ts';
import { createCapacityControlPlane } from '../../../capacity/control-plane.ts';
import { deleteTeamCapacityAggregate } from '../../../capacity/services/teams/team-deletion-service.ts';
import { readCapacityRequestObject } from '../../../capacity/routes/support/request-json.ts';
import { createStripeConnectService, resolveStripeEnvironment, stripeAccountToConnectedAccountPatch } from '../../../commerce/commerce-core/stripe-connect.js';
import { applySeedWithStore, exportSeedWithStore, planSeedWithStore } from '../../../../market/seeds/apply.js';
import { buildGovernanceApprovalProjection, buildGovernanceProjection } from '../../../../market/projects/projects-core/governance-projection.js';
import { buildInfrastructureProjection } from '../../../../market/projects/hosting/infrastructure-projection.js';
import { loadInfrastructureSeedState } from '../../../../market/seeds/infrastructure-seeds.js';
import { buildKnowledgeArtifactProjection, buildKnowledgeProjection } from '../../../../market/projects/knowledge/knowledge-projection.js';
import { buildWorkdayProjection } from '../../../../market/capacity/workdays/workday-projection.js';
import { loadKnowledgeContentEntries } from '../../../../view-models/knowledge-content.js';
import { listManagedHostsFromConfig, managedCloudflareConfigMissing, resolveManagedCloudflareHostConfigFromConfig, } from '../../../../market/hosting/managed-hosts.js';
import { decryptHostConfig } from '../../../../crypto/host-crypto.ts';
import { getSiteAuthConfig } from '../../../../auth/config.ts';
import { accountDeletionConfirmationMatches } from '../../../../auth/account.ts';
import { validateUsername as validatePublicUsername } from '../../../../auth/profile-validation.ts';
import { authEmailDeliveryFailureDetail, authEmailDeliveryFailureReason, sendAuthEmail } from '../../../../auth/email.ts';
import { recordContentNotificationEvent } from '../../../../notifications/service.ts';
import { sendEmailConfirmation } from '../../../../auth/email-confirmation.ts';
import { sendWelcomeEmail } from '../../../../auth/welcome-email.ts';
import { createCipheriv, createDecipheriv, createHash, createHmac, createPublicKey, createVerify, pbkdf2Sync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { contentRelationPolicy } from '../../../../market/content/content-relations.js';
import { NOTIFICATION_CONTENT_CAPABILITIES, PERSONAL_THEME_COMPILER_VERSION, isValidPersonalThemeDraft, normalizeNotificationPreferences, } from '@treeseed/sdk/account-contracts';
import { jsonError, jsonThrownError, POSTGRES_AUTH_PROVIDER_ID, availabilityAttempts, AUTH_PROVIDERS, providerJwksCache, availabilityRateLimit, personalThemeFromRow, accountDeletionBlockers, consumeReauthentication, loadNotificationPreferences, providerConfigFor, base64Url, verifyProviderIdToken, exchangeProviderIdentity, sourceFromProjectDetails, repositoryInventoryWithPlatform, createProjectHostCredentialSessions, rejectProjectSecretUnlockMaterial, markdownToPlainProjectSummary, parseBooleanEnvValue, shouldLogApiRequests, shouldExposeNonProductionAuthDiagnostics, SENSITIVE_QUERY_PARAM_PATTERN, redactedRequestTarget, installApiRequestLogger, AGENT_PROMOTION_APPROVAL_DECISIONS, readJsonOrFormBody, normalizeEmail, normalizeUsername, parseJsonObject, trimmedHeaderValue, requestClientIp, requestSessionMetadata, webSessionData, validateMarketPassword, hashMarketPassword, verifyMarketPassword, ensureMarketCredentialSchema, MARKET_EMAIL_CONFIRMATION_PREFIX, marketAuthContext, shouldBypassAcceptanceAuthEmailDelivery, marketEmailTokenHash, exposeAuthTokenForTests, authTokenTimestampSeconds, authTokenTimestampMillis, sanitizedReturnTo, confirmationUrlFor, teamInviteAcceptUrlFor, passwordResetUrlFor, sendTeamInviteEmail, createMarketEmailConfirmation, serializeUserEmailAddress, backfillUserEmailAddresses, listUserEmailAddresses, getUserEmailAddress, verifiedEmailCount, setPrimaryEmailAddress, syncPrimaryEmailCaches, createOrResendUserEmailAddress, createMarketWebSession, webAuthPayload, normalizeAppearancePreference, normalizeBaseUrl, optionalTrimmedString, enumValue, unknownKeys, LOCAL_CONTENT_COLLECTIONS, LOCAL_WORK_CONTENT_COLLECTIONS, LOCAL_DECISION_TYPE_VALUES, PROPOSAL_VERDICT_DECISION_TYPES, PLATFORM_OPERATION_SCOPES, LOCAL_CONTENT_DEFAULTS, slugifyContent, yamlScalar, yamlLines, serializeFrontmatter, normalizeRelationArray, uniqueRelationArray, addRelationValue, normalizeLocalContentInput, writeLocalContentRecord, localContentRoot, localContentPath, readLocalContentRecord, writeParsedLocalContentRecord, createRelatedLocalContentRecord, createDecisionFromProposals, isLoopbackUrl, resolveAuthApprovalBaseUrl, findById, resolveAgentArtifactBucket, centralMarketProfile, normalizeMarketProfile, credentialSessionSecret, credentialSessionKey, encryptCredentialSessionPayload, decryptCredentialSessionPayload, normalizeProviderCredentialConfig, HOST_KIND_SESSION_KEYS, providerCredentialValuesForAudit, mergeStringConfig, scheduleBackgroundBootstrap, projectDeletionConfirmationMatches, projectDeletionBlockerRows, githubRequestForProjectDeletion, projectDeletionOperation, cloudflareDeletionAuthenticationMessage, appendProjectDeletionProgress, runProjectDeletionApiDestroy, GITHUB_ACTIONS_OIDC_ISSUER, githubOidcJwksCache, base64urlJson, parseBase64urlJson, operationTokenSecret, signOperationToken, verifyOperationToken, loadGitHubOidcJwks, verifyGitHubOidcToken, normalizeCiEnvironment, ciOperationForAction, fallbackRemoteCapability, normalizeRepositorySlug, projectAllowedCiRepositories, validateCiRefForEnvironment, marketProfilesForTeams, artifactDownloadPayload, principalHasPermission, principalIsSeedAdmin, isTeamApiPrincipal, isLocalAcceptanceServicePrincipal, localAcceptanceAdminToken, localAcceptanceAuthEnabled, decorateJob, safePlatformOperationOutput, decoratePlatformOperation, safeTokenEquals, resolvePlatformRunnerSecret, platformOperationMutationError, requirePlatformRunner, resolvePlatformRepositoryDescriptor, mergeCapability, canonicalArchitectureTopology, ensurePrincipal, resolveUiProjectionContext, decodeRouteParam, uiRuntimeLocals, requireConfiguredServiceCredential, resolvePublicTreeDxTeam, enqueueTreeDxProvisionOperation, principalHasGlobalPlatformRole, requireTeamAccess, requireProjectAccess, safePrivateKnowledgeSlug, privateKnowledgeAuditPayload, recordPrivateKnowledgeAudit, FEEDBACK_TYPES, FEEDBACK_SCREENSHOT_TYPES, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, cleanFeedbackString, safeFeedbackContext, safeFeedbackClient, safeFeedbackScreenshot, validateFeedbackAccess, recordFeedbackSubmission, normalizeSeedEnvironments, seedActor, seedExistingTeamIds, seedCreatesMissingTeams, requireSeedPlanAccess, requireSeedApplyAccess, requireProjectRunner, AGENT_TASK_SIGNATURES, resolveAgentTaskSignature, commerceErrorResponse, stripeConfiguredError, stripeVendorApprovalError, stripeAccountMissingError, stripeCommerceUrl, requireCommerceVendorForStripe, refreshCommerceStripeAccount, STRIPE_PRODUCT_MIRROR_OFFER_MODES, STRIPE_PRICE_MIRROR_OFFER_MODES, stripeMetadataValue, buildCommerceStripeMetadata, commerceStripeProductParams, commerceStripeLookupKey, commerceStripePriceParams, stripePriceTermsDrift, commerceStripeSyncContext, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, CHECKOUT_OFFER_MODES, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, resolveStripePublishableKey, resolveStripeWebhookSecret, commerceCheckoutError, normalizeCheckoutQuantity, stripeClientSecret, paymentGroupStatusFromPaymentIntent, orderStatusFromPaymentGroup, subscriptionStatusFromStripe, entitlementRenewalStateFromSubscription, stripeTimestampToIso, subscriptionClientSecret, publicPaymentGroups, buildCommerceCheckoutMetadata, resolveCommerceCheckoutItem, checkoutGroupKind, checkoutGroupKey, checkoutGroupStatus, grantCommerceEntitlementsForOrder, requireSellerTeamAccess, requireVendorOrderManager, requireServiceBuyerAccess, requireServiceSellerAccess, requireServiceParticipantAccess, redactCommerceServiceRequestForBuyer, requireCommerceCapacityListingAccess, requireCommerceCapacityInquiryAccess, remainingRefundableAmount, stripeRefundStatus, applyCommerceRefundState, resolveOrderItemForRefund, resolveFulfillmentArtifact, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, ensureCommerceStripeCustomer, refreshCommercePaymentGroupState, updateCheckoutCompletionFromGroup, syncCommerceSubscriptionFromStripe, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, handleCommerceInvoiceWebhook, processCommerceStripeWebhook, requireCommerceProductAccess, principalCanManageCommerceProduct, redactCommerceOwnershipWorkflow, requireCommerceOfferAccess, requireCatalogItemAccess, requireConnectedProjectRuntime, projectAppHref, hubRepositoryPolicies, unwrapOperationPayload, applyContentPublishResult, executeInline, projectApiConnection, createProjectInternalClient, executeProjectApi, selectDispatchTarget, defaultConfig, createApiExtension, projectHostBindingMetadata, loadProjectHostBindingContext, projectHostResponsePayload, hostBindingRequiresUnlock, hostKindForBinding, persistProjectHostBindingOperationMetadata, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, plaintextHostCredentialFieldPaths, rejectPlaintextHostCredentialFields, normalizeDomainName, normalizeProjectDomainInput, inferZoneNameForDomain, domainInZone, encryptedHostPayloadLooksValid, decryptedHostConfigSummary, normalizeAuditHostKinds, collectHostingAuditCredentialOverlay, cloudflareErrorMessage, cloudflareRequestForLaunchPreflight, resolveCloudflareZoneForLaunchPreflight, verifyCloudflareDnsWriteForLaunch, cloudflareRequestForProjectDeletion, hasRecordedCloudflareRuntimeResources, canSkipCloudflareCleanupAfterFailedLaunch, projectDeletionHostname, normalizedCloudflareKvNamespaceReference, uniqueCloudflareKvNamespaceReferences, cloudflareProjectDeletionResourceNames, resolveProjectDeletionCloudflareZone, deleteCloudflareDnsRecordsForProject, listCloudflareNamedResources, deleteCloudflareProjectResources, cloudflareDnsDomainsForHostValidation, validateTeamHostCredentialPayload, resolveLaunchTemplateRequirements, nonSecretLaunchJobInput, decryptTeamHostForLaunch, buildLaunchCredentialOverlay, patchLaunchIntentForCredentialOverlay, appendLaunchDeploymentEvent, sanitizeLaunchResultForStorage, runProjectLaunchApiBootstrap, launchPlannerRepositoryTopology, launchCapabilityPreset, resourceRowsFromLaunch, unwrapLaunchOperationOutput, appendLaunchPhaseProjection, updateLaunchDeployments, applyHubLaunchResult, applyHubLaunchFailure } from '../index.ts';
export async function retryApiLaunchBootstrapFromRequest({ c, store, runtime, job, access, body, resume = false, }) {
    const rejectedUnlock = rejectProjectSecretUnlockMaterial(c, body, 'Launch recovery no longer accepts passphrases or credential sessions. Re-enter or migrate team-owned secrets into approved targets, then retry.');
    if (rejectedUnlock)
        return { response: rejectedUnlock };
    const launchIntent = job.input?.launchIntent && typeof job.input.launchIntent === 'object' ? job.input.launchIntent : null;
    if (!launchIntent) {
        return { response: jsonError(c, 400, 'Launch retry cannot run because the original launch intent is missing.', { code: 'missing_launch_intent' }) };
    }
    if (job.input?.bootstrap?.requiresPassphrase) {
        return {
            response: jsonError(c, 400, 'Launch retry cannot unlock team-owned secrets in the API. Re-enter or migrate the selected host secrets through CLI/Admin client-side flows, then retry.', {
                code: 'sensitive_passphrase_rejected',
            }),
        };
    }
    const teamId = typeof job.input?.teamId === 'string' ? job.input.teamId : access.details.project.teamId;
    const repositoryHostId = typeof job.input?.repositoryHostId === 'string'
        ? job.input.repositoryHostId
        : typeof launchIntent.repository?.hostId === 'string'
            ? launchIntent.repository.hostId
            : null;
    const repositoryHost = repositoryHostId ? await store.getRepositoryHost(teamId, repositoryHostId) : null;
    if (!repositoryHost) {
        return { response: jsonError(c, 400, 'Launch retry cannot run because the selected Repository Host is no longer available.', { code: 'repository_host_unavailable' }) };
    }
    const cloudflareHostMode = launchIntent.hosting?.webHost?.mode === 'team_owned'
        ? 'team_owned'
        : launchIntent.hosting?.webHost?.mode === 'treeseed_managed'
            ? 'treeseed_managed'
            : null;
    const cloudflareHostId = typeof launchIntent.hosting?.webHost?.hostId === 'string' ? launchIntent.hosting.webHost.hostId : null;
    const cloudflareHost = cloudflareHostMode === 'team_owned' && cloudflareHostId
        ? await store.getTeamWebHost(teamId, cloudflareHostId)
        : null;
    if (cloudflareHostMode === 'team_owned' && !cloudflareHost) {
        return { response: jsonError(c, 400, 'Launch retry cannot run because the selected Web Host is no longer available.', { code: 'web_host_unavailable' }) };
    }
    const emailHostMode = launchIntent.hosting?.emailHost?.mode === 'team_owned'
        ? 'team_owned'
        : launchIntent.hosting?.emailHost?.mode === 'treeseed_managed'
            ? 'treeseed_managed'
            : null;
    const emailHostId = typeof launchIntent.hosting?.emailHost?.hostId === 'string' ? launchIntent.hosting.emailHost.hostId : null;
    const emailHost = emailHostMode === 'team_owned' && emailHostId
        ? await store.getTeamWebHost(teamId, emailHostId)
        : null;
    if (emailHostMode === 'team_owned' && !emailHost) {
        return { response: jsonError(c, 400, 'Launch retry cannot run because the selected Email Host is no longer available.', { code: 'email_host_unavailable' }) };
    }
    const cloudflareLaunchConfig = cloudflareHostMode === 'treeseed_managed'
        ? await resolveManagedCloudflareHostConfigFromConfig(runtime)
        : null;
    const repositories = await store.listHubRepositories(job.projectId);
    const softwareRepository = repositories.find((repository) => repository.role === 'software') ?? null;
    const contentRepository = repositories.find((repository) => repository.role === 'content') ?? null;
    const retryLaunchIntent = resume
        ? {
            ...launchIntent,
            repository: {
                ...(launchIntent.repository ?? {}),
                softwareRepository: softwareRepository
                    ? {
                        owner: softwareRepository.owner,
                        name: softwareRepository.name,
                        url: softwareRepository.url,
                        defaultBranch: softwareRepository.defaultBranch,
                    }
                    : launchIntent.repository?.softwareRepository ?? null,
                contentRepository: contentRepository
                    ? {
                        owner: contentRepository.owner,
                        name: contentRepository.name,
                        url: contentRepository.url,
                        defaultBranch: contentRepository.defaultBranch,
                    }
                    : launchIntent.repository?.contentRepository ?? null,
            },
        }
        : launchIntent;
    const retried = await store.retryJob(job.id, {
        status: 'running',
        inputPatch: {
            resume,
            launchIntent: retryLaunchIntent,
        },
        eventType: resume ? 'resume_queued' : 'retry_queued',
    });
    const launch = await store.getHubLaunchByJobId(job.id);
    if (launch) {
        await store.updateHubLaunch(launch.id, {
            state: 'running',
            currentPhase: 'credential_bootstrap',
            error: null,
        });
        await store.appendHubLaunchEvent(launch.id, {
            phase: resume ? 'launch_resume_queued' : 'launch_retry_queued',
            status: 'running',
            title: resume ? 'Launch resume queued' : 'Launch retry queued',
            summary: resume
                ? 'TreeSeed will rerun API-owned credential bootstrap and resume provider setup without API-side secret unlock material.'
                : 'TreeSeed will rerun API-owned credential bootstrap without API-side secret unlock material.',
            data: { jobId: job.id },
        });
    }
    await updateLaunchDeployments(store, retried, {
        status: 'running',
        summary: resume ? 'Launch resume is running credential bootstrap again.' : 'Launch retry is running credential bootstrap again.',
        metadata: {
            launchPhase: 'credential_bootstrap',
            launchRecovery: resume ? 'resume_launch' : 'retry_launch',
        },
    });
    scheduleBackgroundBootstrap(c, () => runProjectLaunchApiBootstrap({
        store,
        runtime,
        jobId: job.id,
        launchIntent: retryLaunchIntent,
        passphrase: null,
        repositoryHost,
        cloudflareHost,
        emailHost,
        cloudflareHostMode,
        emailHostMode,
        cloudflareLaunchConfig,
        auditHostKinds: ['repository', 'web', 'email'],
        principal: { id: access.principal.id, type: c.get('actorType') === 'service' ? 'service' : 'user' },
    }));
    return {
        response: c.json({
            ok: true,
            payload: decorateJob(normalizeBaseUrl(runtime.resolved.config.baseUrl ?? ''), retried),
        }, { status: 202 }),
    };
}

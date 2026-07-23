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
import { jsonError, jsonThrownError, POSTGRES_AUTH_PROVIDER_ID, availabilityAttempts, AUTH_PROVIDERS, providerJwksCache, availabilityRateLimit, personalThemeFromRow, accountDeletionBlockers, consumeReauthentication, loadNotificationPreferences, providerConfigFor, base64Url, verifyProviderIdToken, exchangeProviderIdentity, resolveLaunchTemplateRequirements, projectHostBindingMetadata, loadProjectHostBindingContext, projectHostResponsePayload, hostBindingRequiresUnlock, hostKindForBinding, createProjectHostCredentialSessions, persistProjectHostBindingOperationMetadata, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, plaintextHostCredentialFieldPaths, rejectPlaintextHostCredentialFields, parseBooleanEnvValue, shouldLogApiRequests, shouldExposeNonProductionAuthDiagnostics, SENSITIVE_QUERY_PARAM_PATTERN, redactedRequestTarget, installApiRequestLogger, AGENT_PROMOTION_APPROVAL_DECISIONS, readJsonOrFormBody, normalizeEmail, normalizeUsername, parseJsonObject, trimmedHeaderValue, requestClientIp, requestSessionMetadata, webSessionData, validateMarketPassword, hashMarketPassword, verifyMarketPassword, ensureMarketCredentialSchema, MARKET_EMAIL_CONFIRMATION_PREFIX, marketAuthContext, shouldBypassAcceptanceAuthEmailDelivery, marketEmailTokenHash, exposeAuthTokenForTests, authTokenTimestampSeconds, authTokenTimestampMillis, sanitizedReturnTo, confirmationUrlFor, teamInviteAcceptUrlFor, passwordResetUrlFor, sendTeamInviteEmail, createMarketEmailConfirmation, serializeUserEmailAddress, backfillUserEmailAddresses, listUserEmailAddresses, getUserEmailAddress, verifiedEmailCount, setPrimaryEmailAddress, syncPrimaryEmailCaches, createOrResendUserEmailAddress, createMarketWebSession, webAuthPayload, normalizeAppearancePreference, normalizeBaseUrl, normalizeDomainName, normalizeProjectDomainInput, inferZoneNameForDomain, domainInZone, optionalTrimmedString, enumValue, unknownKeys, LOCAL_CONTENT_COLLECTIONS, LOCAL_WORK_CONTENT_COLLECTIONS, LOCAL_DECISION_TYPE_VALUES, PROPOSAL_VERDICT_DECISION_TYPES, PLATFORM_OPERATION_SCOPES, LOCAL_CONTENT_DEFAULTS, slugifyContent, yamlScalar, yamlLines, serializeFrontmatter, normalizeRelationArray, uniqueRelationArray, addRelationValue, normalizeLocalContentInput, writeLocalContentRecord, localContentRoot, localContentPath, readLocalContentRecord, writeParsedLocalContentRecord, createRelatedLocalContentRecord, createDecisionFromProposals, isLoopbackUrl, resolveAuthApprovalBaseUrl, findById, resolveAgentArtifactBucket, centralMarketProfile, normalizeMarketProfile, encryptedHostPayloadLooksValid, decryptedHostConfigSummary, credentialSessionSecret, credentialSessionKey, encryptCredentialSessionPayload, decryptCredentialSessionPayload, normalizeProviderCredentialConfig, HOST_KIND_SESSION_KEYS, normalizeAuditHostKinds, providerCredentialValuesForAudit, collectHostingAuditCredentialOverlay, nonSecretLaunchJobInput, decryptTeamHostForLaunch, mergeStringConfig, buildLaunchCredentialOverlay, patchLaunchIntentForCredentialOverlay, appendLaunchDeploymentEvent, scheduleBackgroundBootstrap, sanitizeLaunchResultForStorage, cloudflareErrorMessage, cloudflareRequestForLaunchPreflight, resolveCloudflareZoneForLaunchPreflight, verifyCloudflareDnsWriteForLaunch, cloudflareRequestForProjectDeletion, cloudflareDeletionAuthenticationMessage, hasRecordedCloudflareRuntimeResources, canSkipCloudflareCleanupAfterFailedLaunch, projectDeletionHostname, normalizedCloudflareKvNamespaceReference, uniqueCloudflareKvNamespaceReferences, cloudflareProjectDeletionResourceNames, resolveProjectDeletionCloudflareZone, deleteCloudflareDnsRecordsForProject, listCloudflareNamedResources, deleteCloudflareProjectResources, cloudflareDnsDomainsForHostValidation, validateTeamHostCredentialPayload, runProjectLaunchApiBootstrap, retryApiLaunchBootstrapFromRequest, GITHUB_ACTIONS_OIDC_ISSUER, githubOidcJwksCache, base64urlJson, parseBase64urlJson, operationTokenSecret, signOperationToken, verifyOperationToken, loadGitHubOidcJwks, verifyGitHubOidcToken, normalizeCiEnvironment, ciOperationForAction, fallbackRemoteCapability, validateCiRefForEnvironment, marketProfilesForTeams, artifactDownloadPayload, principalHasPermission, principalIsSeedAdmin, isTeamApiPrincipal, isLocalAcceptanceServicePrincipal, localAcceptanceAdminToken, localAcceptanceAuthEnabled, decorateJob, safePlatformOperationOutput, decoratePlatformOperation, safeTokenEquals, resolvePlatformRunnerSecret, platformOperationMutationError, requirePlatformRunner, mergeCapability, canonicalArchitectureTopology, launchPlannerRepositoryTopology, launchCapabilityPreset, resourceRowsFromLaunch, ensurePrincipal, decodeRouteParam, uiRuntimeLocals, requireConfiguredServiceCredential, resolvePublicTreeDxTeam, enqueueTreeDxProvisionOperation, principalHasGlobalPlatformRole, requireTeamAccess, safePrivateKnowledgeSlug, privateKnowledgeAuditPayload, recordPrivateKnowledgeAudit, FEEDBACK_TYPES, FEEDBACK_SCREENSHOT_TYPES, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, cleanFeedbackString, safeFeedbackContext, safeFeedbackClient, safeFeedbackScreenshot, validateFeedbackAccess, recordFeedbackSubmission, normalizeSeedEnvironments, seedActor, seedExistingTeamIds, seedCreatesMissingTeams, requireSeedPlanAccess, requireSeedApplyAccess, AGENT_TASK_SIGNATURES, resolveAgentTaskSignature, commerceErrorResponse, stripeConfiguredError, stripeVendorApprovalError, stripeAccountMissingError, stripeCommerceUrl, requireCommerceVendorForStripe, refreshCommerceStripeAccount, STRIPE_PRODUCT_MIRROR_OFFER_MODES, STRIPE_PRICE_MIRROR_OFFER_MODES, stripeMetadataValue, buildCommerceStripeMetadata, commerceStripeProductParams, commerceStripeLookupKey, commerceStripePriceParams, stripePriceTermsDrift, commerceStripeSyncContext, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, CHECKOUT_OFFER_MODES, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, resolveStripePublishableKey, resolveStripeWebhookSecret, commerceCheckoutError, normalizeCheckoutQuantity, stripeClientSecret, paymentGroupStatusFromPaymentIntent, orderStatusFromPaymentGroup, subscriptionStatusFromStripe, entitlementRenewalStateFromSubscription, stripeTimestampToIso, subscriptionClientSecret, publicPaymentGroups, buildCommerceCheckoutMetadata, resolveCommerceCheckoutItem, checkoutGroupKind, checkoutGroupKey, checkoutGroupStatus, grantCommerceEntitlementsForOrder, requireSellerTeamAccess, requireVendorOrderManager, requireServiceBuyerAccess, requireServiceSellerAccess, requireServiceParticipantAccess, redactCommerceServiceRequestForBuyer, requireCommerceCapacityListingAccess, requireCommerceCapacityInquiryAccess, remainingRefundableAmount, stripeRefundStatus, applyCommerceRefundState, resolveOrderItemForRefund, resolveFulfillmentArtifact, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, ensureCommerceStripeCustomer, refreshCommercePaymentGroupState, updateCheckoutCompletionFromGroup, syncCommerceSubscriptionFromStripe, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, handleCommerceInvoiceWebhook, processCommerceStripeWebhook, requireCommerceProductAccess, principalCanManageCommerceProduct, redactCommerceOwnershipWorkflow, requireCommerceOfferAccess, requireCatalogItemAccess, unwrapLaunchOperationOutput, appendLaunchPhaseProjection, updateLaunchDeployments, applyHubLaunchResult, applyHubLaunchFailure, unwrapOperationPayload, applyContentPublishResult, executeInline, selectDispatchTarget, defaultConfig, createApiExtension, sourceFromProjectDetails, repositoryInventoryWithPlatform, rejectProjectSecretUnlockMaterial, markdownToPlainProjectSummary, normalizeRepositorySlug, projectAllowedCiRepositories, resolvePlatformRepositoryDescriptor, resolveUiProjectionContext, requireProjectAccess, requireProjectRunner, requireConnectedProjectRuntime, projectAppHref, hubRepositoryPolicies, projectApiConnection, createProjectInternalClient, executeProjectApi } from './index.ts';
export function projectDeletionConfirmationMatches(confirmation, project) {
    return String(confirmation ?? '').trim() === `DELETE ${project?.slug ?? ''}`;
}
export function projectDeletionBlockerRows(blockers) {
    if (!blockers)
        return [];
    if (Array.isArray(blockers))
        return blockers;
    return Object.entries(blockers)
        .flatMap(([key, value]) => {
        if (Array.isArray(value))
            return value.map((entry) => ({ code: key, ...entry }));
        const count = Number(value);
        return Number.isFinite(count) && count > 0 ? [{ code: key, count }] : [];
    });
}
export async function githubRequestForProjectDeletion({ token, path, method = 'GET' }) {
    const response = await fetch(`https://api.github.com${path}`, {
        method,
        headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/vnd.github+json',
            'user-agent': 'treeseed-api',
            'X-GitHub-Api-Version': '2022-11-28',
        },
    });
    if (response.status === 404)
        return { status: 'missing' };
    if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.message ?? `${method} ${path} failed with HTTP ${response.status}.`);
    }
    return { status: method === 'DELETE' ? 'deleted' : 'ok' };
}
export function projectDeletionOperation(provider, type, name, status, extra: any = {}) {
    return {
        provider,
        type,
        name: name ?? null,
        status,
        ...extra,
    };
}
export async function appendProjectDeletionProgress(store, job, input) {
    await store.recordJobProgress(job.id, {
        summary: input.message,
        data: {
            phase: input.phase,
            status: input.status ?? 'running',
            title: input.title,
            operations: input.operations ?? undefined,
        },
    }).catch(() => null);
    await appendLaunchDeploymentEvent(store, job, {
        kind: input.kind,
        message: input.message,
        status: input.status === 'failed' ? 'failed' : input.status === 'succeeded' ? 'succeeded' : 'running',
        severity: input.status === 'failed' ? 'error' : input.severity ?? 'info',
        payload: {
            phase: input.phase,
            status: input.status ?? 'running',
            operations: input.operations ?? undefined,
        },
    });
}
export async function runProjectDeletionApiDestroy({ store, projectId, jobId, passphrase, }) {
    let job = await store.findJobById(jobId);
    if (!job)
        return null;
    let phase = 'credential_unlock';
    try {
        const project = await store.getProject(projectId);
        if (!project)
            throw new Error('Project no longer exists.');
        const details = await store.getProjectDetails(projectId);
        const repositories = Array.isArray(details?.repositories) ? details.repositories : [];
        const softwareRepository = repositories.find((repository) => repository.role === 'software') ?? repositories[0] ?? null;
        const repositoryHost = softwareRepository?.repositoryHostId
            ? await store.getRepositoryHost(project.teamId, softwareRepository.repositoryHostId)
            : null;
        const webHostRef = project.metadata?.cloudflareHost ?? details?.hosting?.metadata?.cloudflareHost ?? {};
        const webHost = webHostRef?.mode === 'team_owned' && webHostRef?.hostId
            ? await store.getTeamWebHost(project.teamId, webHostRef.hostId)
            : null;
        const overlay: Record<string, string> = {};
        await appendProjectDeletionProgress(store, job, {
            kind: 'project_delete.credentials_started',
            phase,
            title: 'Unlocking host credentials',
            message: 'Unlocking selected host credentials in API memory.',
        });
        if (repositoryHost?.ownership === 'team_owned') {
            if (!passphrase)
                throw new Error('Sensitive data passphrase is required to delete project repositories.');
            const config = await decryptTeamHostForLaunch('repository_host', repositoryHost, passphrase) as Record<string, string | undefined>;
            const token = config.GH_TOKEN ?? config.GITHUB_TOKEN;
            if (token) {
                overlay.GH_TOKEN = token;
                overlay.GITHUB_TOKEN = config.GITHUB_TOKEN ?? token;
            }
        }
        if (webHost) {
            if (!passphrase)
                throw new Error('Sensitive data passphrase is required to delete project web host resources.');
            const config = await decryptTeamHostForLaunch('web_host', webHost, passphrase);
            mergeStringConfig(overlay, config);
        }
        await appendProjectDeletionProgress(store, job, {
            kind: 'project_delete.credentials_unlocked',
            phase,
            title: 'Host credentials unlocked',
            message: 'Sensitive host credentials were unlocked for this deletion run.',
        });
        phase = 'repository_cleanup';
        await appendProjectDeletionProgress(store, job, {
            kind: 'project_delete.repositories_started',
            phase,
            title: 'Deleting repositories',
            message: 'Deleting repositories created for this project.',
        });
        const repositoryOperations = [];
        const githubToken = overlay.GITHUB_TOKEN ?? overlay.GH_TOKEN;
        for (const repository of repositories.filter((entry) => entry.provider === 'github' && entry.owner && entry.name)) {
            const shouldDelete = repository.metadata?.create === true || repository.status === 'queued';
            if (!shouldDelete) {
                repositoryOperations.push(projectDeletionOperation('github', 'repository', `${repository.owner}/${repository.name}`, 'skipped', { reason: 'not_created_by_project_launch' }));
                continue;
            }
            if (!githubToken)
                throw new Error('GitHub token is required to delete project repositories.');
            const result = await githubRequestForProjectDeletion({
                token: githubToken,
                method: 'DELETE',
                path: `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`,
            });
            repositoryOperations.push(projectDeletionOperation('github', 'repository', `${repository.owner}/${repository.name}`, result.status));
        }
        await appendProjectDeletionProgress(store, job, {
            kind: 'project_delete.repositories_completed',
            phase,
            title: 'Repositories cleaned up',
            message: 'Repository cleanup finished.',
            operations: repositoryOperations,
        });
        phase = 'web_host_cleanup';
        await appendProjectDeletionProgress(store, job, {
            kind: 'project_delete.web_host_started',
            phase,
            title: 'Deleting web host resources',
            message: 'Deleting Cloudflare resources and DNS records for this project.',
        });
        const names = cloudflareProjectDeletionResourceNames(project, details);
        let cloudflareOperations = [];
        if (webHost) {
            const cloudflareToken = overlay.CLOUDFLARE_API_TOKEN;
            if (!cloudflareToken)
                throw new Error('Cloudflare API token is required to delete project web host resources.');
            const accountId = overlay.CLOUDFLARE_ACCOUNT_ID ?? names.accountId;
            try {
                const zoneId = await resolveProjectDeletionCloudflareZone({ token: cloudflareToken, names });
                cloudflareOperations = await deleteCloudflareProjectResources({
                    token: cloudflareToken,
                    accountId,
                    zoneId,
                    names,
                });
            }
            catch (cloudflareError) {
                const cloudflareMessage = cloudflareError instanceof Error ? cloudflareError.message : String(cloudflareError);
                if (!canSkipCloudflareCleanupAfterFailedLaunch(project, names, cloudflareMessage))
                    throw cloudflareError;
                cloudflareOperations = [
                    projectDeletionOperation('cloudflare', 'web-host', null, 'skipped', {
                        reason: 'launch_failed_before_cloudflare_resources',
                        message: 'Cloudflare cleanup was skipped because this project launch failed during DNS authentication before any Cloudflare runtime resources were recorded.',
                        authenticationError: cloudflareMessage,
                    }),
                    ...names.domains.map((name) => projectDeletionOperation('cloudflare', 'dns-record', name, 'skipped', {
                        reason: 'launch_dns_write_failed_before_record_creation',
                    })),
                ];
            }
        }
        else {
            cloudflareOperations = [projectDeletionOperation('cloudflare', 'web-host', null, 'skipped', { reason: 'project_has_no_team_owned_cloudflare_host' })];
        }
        await appendProjectDeletionProgress(store, job, {
            kind: 'project_delete.web_host_completed',
            phase,
            title: 'Web host resources cleaned up',
            message: 'Web host cleanup finished.',
            operations: cloudflareOperations,
        });
        const output = {
            repositories: repositoryOperations,
            cloudflare: cloudflareOperations,
        };
        await store.updateProject(project.id, {
            metadata: {
                ...(project.metadata ?? {}),
                deletion: {
                    status: 'succeeded',
                    jobId: job.id,
                    completedAt: new Date().toISOString(),
                    output,
                },
            },
        });
        await appendProjectDeletionProgress(store, job, {
            kind: 'project_delete.succeeded',
            phase: 'completed',
            title: 'Project deleted',
            message: 'Project infrastructure deletion completed.',
            status: 'succeeded',
        });
        await store.completeJob(job.id, { output });
        await updateLaunchDeployments(store, job, {
            eventKindPrefix: 'project_delete',
            status: 'succeeded',
            summary: 'Project infrastructure deletion completed.',
            finishedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            metadata: { deletionPhase: 'completed' },
        });
        return await store.findJobById(job.id);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        job = await store.findJobById(jobId);
        if (!job)
            return null;
        await store.failJob(job.id, {
            code: 'project_delete_failed',
            message,
        }).catch(() => null);
        await updateLaunchDeployments(store, job, {
            eventKindPrefix: 'project_delete',
            status: 'failed',
            summary: message,
            error: {
                code: 'project_delete_failed',
                message,
            },
            finishedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            metadata: { deletionPhase: phase },
        }).catch(() => null);
        await appendProjectDeletionProgress(store, job, {
            kind: 'project_delete.failed',
            phase,
            title: 'Project deletion failed',
            message,
            status: 'failed',
        }).catch(() => null);
        const project = await store.getProject(projectId).catch(() => null);
        if (project) {
            await store.updateProject(project.id, {
                metadata: {
                    ...(project.metadata ?? {}),
                    deletion: {
                        status: 'failed',
                        jobId: job.id,
                        phase,
                        error: { code: 'project_delete_failed', message },
                        updatedAt: new Date().toISOString(),
                    },
                },
            }).catch(() => null);
        }
        return null;
    }
}

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
import { jsonError, jsonThrownError, POSTGRES_AUTH_PROVIDER_ID, availabilityAttempts, AUTH_PROVIDERS, providerJwksCache, availabilityRateLimit, personalThemeFromRow, accountDeletionBlockers, consumeReauthentication, loadNotificationPreferences, providerConfigFor, base64Url, verifyProviderIdToken, exchangeProviderIdentity, sourceFromProjectDetails, repositoryInventoryWithPlatform, createProjectHostCredentialSessions, rejectProjectSecretUnlockMaterial, markdownToPlainProjectSummary, parseBooleanEnvValue, shouldLogApiRequests, shouldExposeNonProductionAuthDiagnostics, SENSITIVE_QUERY_PARAM_PATTERN, redactedRequestTarget, installApiRequestLogger, AGENT_PROMOTION_APPROVAL_DECISIONS, readJsonOrFormBody, normalizeEmail, normalizeUsername, parseJsonObject, trimmedHeaderValue, requestClientIp, requestSessionMetadata, webSessionData, validateMarketPassword, hashMarketPassword, verifyMarketPassword, ensureMarketCredentialSchema, MARKET_EMAIL_CONFIRMATION_PREFIX, marketAuthContext, shouldBypassAcceptanceAuthEmailDelivery, marketEmailTokenHash, exposeAuthTokenForTests, authTokenTimestampSeconds, authTokenTimestampMillis, sanitizedReturnTo, confirmationUrlFor, teamInviteAcceptUrlFor, passwordResetUrlFor, sendTeamInviteEmail, createMarketEmailConfirmation, serializeUserEmailAddress, backfillUserEmailAddresses, listUserEmailAddresses, getUserEmailAddress, verifiedEmailCount, setPrimaryEmailAddress, syncPrimaryEmailCaches, createOrResendUserEmailAddress, createMarketWebSession, webAuthPayload, normalizeAppearancePreference, normalizeBaseUrl, optionalTrimmedString, enumValue, unknownKeys, LOCAL_CONTENT_COLLECTIONS, LOCAL_WORK_CONTENT_COLLECTIONS, LOCAL_DECISION_TYPE_VALUES, PROPOSAL_VERDICT_DECISION_TYPES, PLATFORM_OPERATION_SCOPES, LOCAL_CONTENT_DEFAULTS, slugifyContent, yamlScalar, yamlLines, serializeFrontmatter, normalizeRelationArray, uniqueRelationArray, addRelationValue, normalizeLocalContentInput, writeLocalContentRecord, localContentRoot, localContentPath, readLocalContentRecord, writeParsedLocalContentRecord, createRelatedLocalContentRecord, createDecisionFromProposals, isLoopbackUrl, resolveAuthApprovalBaseUrl, findById, resolveAgentArtifactBucket, centralMarketProfile, normalizeMarketProfile, credentialSessionSecret, credentialSessionKey, encryptCredentialSessionPayload, decryptCredentialSessionPayload, normalizeProviderCredentialConfig, HOST_KIND_SESSION_KEYS, providerCredentialValuesForAudit, mergeStringConfig, scheduleBackgroundBootstrap, projectDeletionConfirmationMatches, projectDeletionBlockerRows, githubRequestForProjectDeletion, projectDeletionOperation, cloudflareDeletionAuthenticationMessage, appendProjectDeletionProgress, runProjectDeletionApiDestroy, GITHUB_ACTIONS_OIDC_ISSUER, githubOidcJwksCache, base64urlJson, parseBase64urlJson, operationTokenSecret, signOperationToken, verifyOperationToken, loadGitHubOidcJwks, verifyGitHubOidcToken, normalizeCiEnvironment, ciOperationForAction, fallbackRemoteCapability, normalizeRepositorySlug, projectAllowedCiRepositories, validateCiRefForEnvironment, marketProfilesForTeams, artifactDownloadPayload, principalHasPermission, principalIsSeedAdmin, isTeamApiPrincipal, isLocalAcceptanceServicePrincipal, localAcceptanceAdminToken, localAcceptanceAuthEnabled, decorateJob, safePlatformOperationOutput, decoratePlatformOperation, safeTokenEquals, resolvePlatformRunnerSecret, platformOperationMutationError, requirePlatformRunner, resolvePlatformRepositoryDescriptor, mergeCapability, canonicalArchitectureTopology, ensurePrincipal, resolveUiProjectionContext, decodeRouteParam, uiRuntimeLocals, requireConfiguredServiceCredential, resolvePublicTreeDxTeam, enqueueTreeDxProvisionOperation, principalHasGlobalPlatformRole, requireTeamAccess, requireProjectAccess, safePrivateKnowledgeSlug, privateKnowledgeAuditPayload, recordPrivateKnowledgeAudit, FEEDBACK_TYPES, FEEDBACK_SCREENSHOT_TYPES, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, cleanFeedbackString, safeFeedbackContext, safeFeedbackClient, safeFeedbackScreenshot, validateFeedbackAccess, recordFeedbackSubmission, normalizeSeedEnvironments, seedActor, seedExistingTeamIds, seedCreatesMissingTeams, requireSeedPlanAccess, requireSeedApplyAccess, requireProjectRunner, AGENT_TASK_SIGNATURES, resolveAgentTaskSignature, commerceErrorResponse, stripeConfiguredError, stripeVendorApprovalError, stripeAccountMissingError, stripeCommerceUrl, requireCommerceVendorForStripe, refreshCommerceStripeAccount, STRIPE_PRODUCT_MIRROR_OFFER_MODES, STRIPE_PRICE_MIRROR_OFFER_MODES, stripeMetadataValue, buildCommerceStripeMetadata, commerceStripeProductParams, commerceStripeLookupKey, commerceStripePriceParams, stripePriceTermsDrift, commerceStripeSyncContext, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, CHECKOUT_OFFER_MODES, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, resolveStripePublishableKey, resolveStripeWebhookSecret, commerceCheckoutError, normalizeCheckoutQuantity, stripeClientSecret, paymentGroupStatusFromPaymentIntent, orderStatusFromPaymentGroup, subscriptionStatusFromStripe, entitlementRenewalStateFromSubscription, stripeTimestampToIso, subscriptionClientSecret, publicPaymentGroups, buildCommerceCheckoutMetadata, resolveCommerceCheckoutItem, checkoutGroupKind, checkoutGroupKey, checkoutGroupStatus, grantCommerceEntitlementsForOrder, requireSellerTeamAccess, requireVendorOrderManager, requireServiceBuyerAccess, requireServiceSellerAccess, requireServiceParticipantAccess, redactCommerceServiceRequestForBuyer, requireCommerceCapacityListingAccess, requireCommerceCapacityInquiryAccess, remainingRefundableAmount, stripeRefundStatus, applyCommerceRefundState, resolveOrderItemForRefund, resolveFulfillmentArtifact, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, ensureCommerceStripeCustomer, refreshCommercePaymentGroupState, updateCheckoutCompletionFromGroup, syncCommerceSubscriptionFromStripe, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, handleCommerceInvoiceWebhook, processCommerceStripeWebhook, requireCommerceProductAccess, principalCanManageCommerceProduct, redactCommerceOwnershipWorkflow, requireCommerceOfferAccess, requireCatalogItemAccess, requireConnectedProjectRuntime, projectAppHref, hubRepositoryPolicies, unwrapOperationPayload, applyContentPublishResult, executeInline, projectApiConnection, createProjectInternalClient, executeProjectApi, selectDispatchTarget, defaultConfig, createApiExtension, projectHostBindingMetadata, loadProjectHostBindingContext, projectHostResponsePayload, hostBindingRequiresUnlock, hostKindForBinding, persistProjectHostBindingOperationMetadata, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, plaintextHostCredentialFieldPaths, rejectPlaintextHostCredentialFields, normalizeDomainName, normalizeProjectDomainInput, inferZoneNameForDomain, domainInZone, encryptedHostPayloadLooksValid, decryptedHostConfigSummary, normalizeAuditHostKinds, collectHostingAuditCredentialOverlay, cloudflareErrorMessage, cloudflareRequestForLaunchPreflight, resolveCloudflareZoneForLaunchPreflight, verifyCloudflareDnsWriteForLaunch, cloudflareRequestForProjectDeletion, hasRecordedCloudflareRuntimeResources, canSkipCloudflareCleanupAfterFailedLaunch, projectDeletionHostname, normalizedCloudflareKvNamespaceReference, uniqueCloudflareKvNamespaceReferences, cloudflareProjectDeletionResourceNames, resolveProjectDeletionCloudflareZone, deleteCloudflareDnsRecordsForProject, listCloudflareNamedResources, deleteCloudflareProjectResources, cloudflareDnsDomainsForHostValidation, validateTeamHostCredentialPayload, resolveLaunchTemplateRequirements, nonSecretLaunchJobInput, decryptTeamHostForLaunch, buildLaunchCredentialOverlay, patchLaunchIntentForCredentialOverlay, appendLaunchDeploymentEvent, sanitizeLaunchResultForStorage, runProjectLaunchApiBootstrap, retryApiLaunchBootstrapFromRequest, launchPlannerRepositoryTopology, launchCapabilityPreset, updateLaunchDeployments } from './index.ts';
export function resourceRowsFromLaunch(projectId, launch) {
    const rows = [];
    for (const [environment, summary] of [['staging', launch.cloudflare?.staging], ['prod', launch.cloudflare?.prod]]) {
        if (!summary)
            continue;
        rows.push({
            projectId,
            environment,
            provider: 'cloudflare',
            resourceKind: 'pages',
            logicalName: 'site',
            locator: summary.pages?.url ?? summary.siteUrl ?? null,
            metadata: summary.pages ?? {},
        }, {
            projectId,
            environment,
            provider: 'cloudflare',
            resourceKind: 'worker',
            logicalName: 'worker',
            locator: summary.workerName ?? null,
            metadata: { workerName: summary.workerName ?? null },
        }, {
            projectId,
            environment,
            provider: 'cloudflare',
            resourceKind: 'kv',
            logicalName: 'form_guard',
            locator: summary.formGuardKv?.id ?? summary.formGuardKv?.name ?? null,
            metadata: summary.formGuardKv ?? {},
        }, {
            projectId,
            environment,
            provider: 'cloudflare',
            resourceKind: 'turnstile-widget',
            logicalName: 'form_guard_turnstile',
            locator: summary.turnstileWidget?.sitekey ?? null,
            metadata: summary.turnstileWidget ?? {},
        }, {
            projectId,
            environment,
            provider: 'cloudflare',
            resourceKind: 'r2',
            logicalName: 'content',
            locator: summary.content?.bucketName ?? null,
            metadata: summary.content ?? {},
        }, {
            projectId,
            environment,
            provider: 'cloudflare',
            resourceKind: 'd1',
            logicalName: 'site_data',
            locator: summary.siteDataDb?.databaseId ?? summary.siteDataDb?.databaseName ?? null,
            metadata: summary.siteDataDb ?? {},
        });
    }
    for (const service of launch.railway?.services ?? []) {
        rows.push({
            projectId,
            environment: service.scope ?? 'prod',
            provider: 'railway',
            resourceKind: 'railway_service',
            logicalName: service.key,
            locator: service.publicBaseUrl ?? service.serviceName ?? service.serviceId ?? null,
            metadata: service,
        });
        if (service.projectName || service.projectId) {
            rows.push({
                projectId,
                environment: service.scope ?? 'prod',
                provider: 'railway',
                resourceKind: 'railway_project',
                logicalName: service.key,
                locator: service.projectId ?? service.projectName ?? null,
                metadata: {
                    projectId: service.projectId ?? null,
                    projectName: service.projectName ?? null,
                },
            });
        }
    }
    for (const schedule of launch.railway?.schedules ?? []) {
        rows.push({
            projectId,
            environment: 'prod',
            provider: 'railway',
            resourceKind: 'railway_schedule',
            logicalName: schedule.logicalName ?? schedule.service ?? 'schedule',
            locator: schedule.id ?? null,
            metadata: schedule,
        });
    }
    return rows.filter((row) => row.locator || row.metadata);
}
export function unwrapLaunchOperationOutput(output) {
    if (output?.operation === 'hub.execute_launch' && output.payload)
        return output.payload;
    if (output?.plan?.repository && output?.repository && output?.cloudflare)
        return output;
    return null;
}
export async function appendLaunchPhaseProjection(store, launchId, jobId, phase) {
    const event = {
        phase: phase.phase,
        status: phase.status,
        title: phase.title ?? String(phase.phase ?? '').replace(/_/gu, ' '),
        summary: phase.summary ?? phase.detail ?? null,
        startedAt: phase.startedAt ?? (phase.status === 'running' ? new Date().toISOString() : null),
        finishedAt: phase.finishedAt ?? (phase.status === 'completed' || phase.status === 'failed' ? new Date().toISOString() : null),
        error: phase.error ?? (phase.status === 'failed' ? { message: phase.summary ?? phase.detail ?? 'Launch phase failed.' } : null),
        data: phase.data ?? {},
    };
    const existingEvents = await store.listHubLaunchEvents(launchId);
    const duplicate = existingEvents.some((existing) => (existing.phase === event.phase
        && existing.status === event.status
        && (existing.summary ?? null) === (event.summary ?? null)));
    if (duplicate)
        return null;
    await store.appendHubLaunchEvent(launchId, event);
    await store.appendJobEvent(jobId, 'phase', event);
    if (phase.status === 'completed' || phase.status === 'failed' || phase.status === 'running') {
        await store.updateHubLaunch(launchId, {
            state: phase.status === 'failed' ? 'failed' : phase.status === 'completed' ? 'running' : 'running',
            currentPhase: phase.phase,
            lastSuccessfulPhase: phase.status === 'completed' ? phase.phase : undefined,
        });
    }
}
export async function applyHubLaunchResult(store, runtime, job, output, principal = null) {
    const launchResult = unwrapLaunchOperationOutput(output);
    if (!launchResult)
        return null;
    const hubLaunch = await store.getHubLaunchByJobId(job.id);
    const project = await store.getProject(job.projectId);
    if (!project || !hubLaunch)
        return null;
    for (const phase of launchResult.phases ?? []) {
        await appendLaunchPhaseProjection(store, hubLaunch.id, job.id, phase);
    }
    for (const repository of launchResult.repositories ?? []) {
        await store.upsertHubRepository(project.id, {
            teamId: project.teamId,
            role: repository.role,
            repositoryHostId: launchResult.plan?.repository?.hostId ?? null,
            provider: 'github',
            owner: repository.owner,
            name: repository.name,
            url: repository.url ?? null,
            defaultBranch: repository.defaultBranch ?? 'main',
            currentBranch: repository.defaultBranch ?? 'main',
            status: repository.url ? 'active' : 'queued',
            ...hubRepositoryPolicies(repository.role),
            metadata: {
                architectureTopology: canonicalArchitectureTopology(launchResult.plan?.repository?.topology),
                create: repository.create === true,
            },
        });
    }
    const contentRepository = (await store.listHubRepositories(project.id)).find((repository) => repository.role === 'content') ?? null;
    await store.upsertHubContentSource(project.id, {
        teamId: project.teamId,
        contentRepositoryId: contentRepository?.id ?? null,
        productionSource: 'r2_published_artifacts',
        overlayPolicy: 'src_content_when_present',
        r2BucketName: launchResult.cloudflare?.prod?.content?.bucketName ?? null,
        r2ManifestKey: launchResult.cloudflare?.prod?.content?.manifestKey ?? null,
        r2PublicBaseUrl: launchResult.cloudflare?.prod?.content?.publicBaseUrl ?? null,
        metadata: launchResult.plan?.contentResolution ?? {},
    });
    const mergedMetadata = {
        ...(project.metadata ?? {}),
        ...(launchResult.projectMetadata ?? {}),
        launchJobId: job.id,
        launchPhase: 'completed',
        lastSuccessfulPhase: 'runtime_connection',
        architecture: {
            ...(project.metadata?.architecture ?? {}),
            topology: canonicalArchitectureTopology(launchResult.plan?.repository?.topology),
            rootPath: project.metadata?.architecture?.rootPath ?? '.',
            sitePath: project.metadata?.architecture?.sitePath ?? '.',
            contentPath: project.metadata?.architecture?.contentPath ?? 'src/content',
            contentRuntimeSource: project.metadata?.architecture?.contentRuntimeSource ?? 'r2_published_manifest',
            localContentMaterialization: project.metadata?.architecture?.localContentMaterialization ?? 'none',
        },
        repositories: launchResult.repositories ?? [],
        repository: launchResult.repository,
        contentRepository: launchResult.contentRepository ?? null,
        workflows: launchResult.workflows,
        cloudflare: launchResult.cloudflare,
        railway: launchResult.railway,
        hostBindingSecretSync: launchResult.workflows?.hostBindingSecretSync ?? null,
        contentResolution: launchResult.plan?.contentResolution ?? null,
    };
    await store.updateProject(project.id, {
        description: project.description ?? null,
        metadata: mergedMetadata,
    });
    await store.upsertCatalogItem(project.teamId, {
        id: project.id,
        kind: 'project',
        slug: project.slug,
        title: project.name,
        summary: project.description ?? null,
        visibility: 'team',
        listingEnabled: false,
        offerMode: mergedMetadata.offerMode ?? 'free',
        searchText: [project.name, project.description].filter(Boolean).join(' ').trim() || null,
        metadata: mergedMetadata,
    });
    if (launchResult.repository) {
        await store.upsertProjectHosting(project.id, {
            kind: 'hosted_project',
            registration: 'none',
            marketBaseUrl: runtime.resolved.config.baseUrl ?? null,
            sourceRepoOwner: launchResult.repository.owner,
            sourceRepoName: launchResult.repository.name,
            sourceRepoUrl: launchResult.repository.url,
            sourceRepoWorkflowPath: '.github/workflows/deploy-web.yml',
            projectApiBaseUrl: launchResult.projectApiBaseUrl,
            executionOwner: 'project_runner',
            metadata: {
                launchPhase: 'completed',
                lastSuccessfulPhase: 'runtime_connection',
                repository: launchResult.repository,
                repositories: launchResult.repositories ?? [],
                hostBindings: project.metadata?.hostBindings ?? null,
                hostBindingPlans: project.metadata?.hostBindingPlans ?? null,
                hostBindingSecretSync: launchResult.workflows?.hostBindingSecretSync ?? null,
                contentResolution: launchResult.plan?.contentResolution ?? null,
            },
        });
    }
    await store.upsertProjectConnection(project.id, {
        mode: 'hosted',
        projectApiBaseUrl: launchResult.projectApiBaseUrl ?? null,
        executionOwner: 'project_runner',
        metadata: {
            internalPrefix: '/internal/core',
            launchPhase: 'completed',
            lastSuccessfulPhase: 'runtime_connection',
            repository: launchResult.repository ?? null,
            repositories: launchResult.repositories ?? [],
            hostBindings: project.metadata?.hostBindings ?? null,
            hostBindingPlans: project.metadata?.hostBindingPlans ?? null,
            hostBindingSecretSync: launchResult.workflows?.hostBindingSecretSync ?? null,
        },
    });
    const railwayApiService = (launchResult.railway?.services ?? []).find((service) => service.key === 'api') ?? null;
    await store.upsertProjectEnvironment(project.id, {
        environment: 'local',
        deploymentProfile: 'hosted_project',
        baseUrl: 'http://127.0.0.1:4321',
        railwayProjectName: railwayApiService?.projectName ?? null,
        metadata: {
            launchPhase: 'completed',
            projectApiBaseUrl: 'http://127.0.0.1:3000',
        },
    });
    for (const [environment, summary] of [['staging', launchResult.cloudflare?.staging], ['prod', launchResult.cloudflare?.prod]]) {
        await store.upsertProjectEnvironment(project.id, {
            environment,
            deploymentProfile: 'hosted_project',
            baseUrl: environment === 'prod' ? launchResult.projectSiteUrl : summary?.pages?.url ?? summary?.siteUrl ?? null,
            cloudflareAccountId: summary?.accountId ?? null,
            pagesProjectName: summary?.pages?.projectName ?? null,
            workerName: summary?.workerName ?? null,
            r2BucketName: summary?.content?.bucketName ?? null,
            d1DatabaseName: summary?.siteDataDb?.databaseName ?? null,
            railwayProjectName: environment === 'prod' ? railwayApiService?.projectName ?? null : null,
            metadata: {
                launchPhase: 'completed',
                projectApiBaseUrl: launchResult.projectApiBaseUrl ?? null,
                siteUrl: summary?.siteUrl ?? null,
            },
        });
    }
    for (const resource of resourceRowsFromLaunch(project.id, launchResult)) {
        await store.upsertProjectInfrastructureResource(project.id, resource);
    }
    await store.updateHubLaunch(hubLaunch.id, {
        state: 'completed',
        currentPhase: 'launch_completed',
        lastSuccessfulPhase: 'launch_completed',
        result: launchResult,
        error: null,
        completedAt: new Date().toISOString(),
    });
    await store.appendHubLaunchEvent(hubLaunch.id, {
        phase: 'launch_completed',
        status: 'completed',
        title: 'Launch completed',
        summary: 'The Knowledge Hub is ready.',
        data: {
            projectApiBaseUrl: launchResult.projectApiBaseUrl ?? null,
            projectSiteUrl: launchResult.projectSiteUrl ?? null,
        },
    });
    await updateLaunchDeployments(store, job, {
        status: 'succeeded',
        finishedAt: new Date().toISOString(),
        summary: 'Initial project launch completed.',
        metadata: {
            launchPhase: 'completed',
            projectApiBaseUrl: launchResult.projectApiBaseUrl ?? null,
            projectSiteUrl: launchResult.projectSiteUrl ?? null,
            hostBindings: project.metadata?.hostBindings ?? null,
            hostBindingPlans: project.metadata?.hostBindingPlans ?? null,
            hostBindingSecretSync: launchResult.workflows?.hostBindingSecretSync ?? null,
        },
    });
    await store.deleteTeamInboxItemsByItemKey(project.teamId, `launch:${project.id}`);
    const projectSummary = await store.getProjectSummary(project.id, principal);
    if (projectSummary) {
        await store.upsertProjectSummarySnapshot(project.id, project.teamId, projectSummary);
    }
    return launchResult;
}
export async function applyHubLaunchFailure(store, job, input) {
    const hubLaunch = await store.getHubLaunchByJobId(job.id);
    const project = await store.getProject(job.projectId);
    if (!hubLaunch || !project)
        return null;
    const error = {
        code: input.code ?? 'launch_failed',
        message: input.message,
    };
    await store.updateHubLaunch(hubLaunch.id, {
        state: 'failed',
        currentPhase: input.phase ?? hubLaunch.currentPhase ?? 'launch_failed',
        error,
    });
    await store.appendHubLaunchEvent(hubLaunch.id, {
        phase: input.phase ?? 'launch_failed',
        status: 'failed',
        title: 'Launch failed',
        summary: input.message,
        data: { code: error.code },
    });
    await store.updateProject(project.id, {
        metadata: {
            ...(project.metadata ?? {}),
            launchJobId: job.id,
            launchPhase: 'failed',
            launchFailure: error,
        },
    });
    await updateLaunchDeployments(store, job, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        summary: input.message,
        error,
        metadata: {
            launchPhase: 'failed',
            launchFailure: error,
        },
    });
    await store.upsertTeamInboxItem(project.teamId, {
        id: `launch-failure:${project.id}`,
        projectId: project.id,
        kind: 'launch_failure',
        state: 'open',
        title: `${project.name}: launch failed`,
        summary: input.message,
        severity: 'high',
        actionHref: await projectAppHref(store, project.teamId, project.slug, 'overview'),
        itemKey: `launch:${project.id}`,
        metadata: error,
    });
    return error;
}

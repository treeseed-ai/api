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
import { jsonError, jsonThrownError, POSTGRES_AUTH_PROVIDER_ID, availabilityAttempts, AUTH_PROVIDERS, providerJwksCache, availabilityRateLimit, personalThemeFromRow, accountDeletionBlockers, consumeReauthentication, loadNotificationPreferences, providerConfigFor, base64Url, verifyProviderIdToken, exchangeProviderIdentity, sourceFromProjectDetails, repositoryInventoryWithPlatform, createProjectHostCredentialSessions, rejectProjectSecretUnlockMaterial, markdownToPlainProjectSummary, parseBooleanEnvValue, shouldLogApiRequests, shouldExposeNonProductionAuthDiagnostics, SENSITIVE_QUERY_PARAM_PATTERN, redactedRequestTarget, installApiRequestLogger, AGENT_PROMOTION_APPROVAL_DECISIONS, readJsonOrFormBody, normalizeEmail, normalizeUsername, parseJsonObject, trimmedHeaderValue, requestClientIp, requestSessionMetadata, webSessionData, validateMarketPassword, hashMarketPassword, verifyMarketPassword, ensureMarketCredentialSchema, MARKET_EMAIL_CONFIRMATION_PREFIX, marketAuthContext, shouldBypassAcceptanceAuthEmailDelivery, marketEmailTokenHash, exposeAuthTokenForTests, authTokenTimestampSeconds, authTokenTimestampMillis, sanitizedReturnTo, confirmationUrlFor, teamInviteAcceptUrlFor, passwordResetUrlFor, sendTeamInviteEmail, createMarketEmailConfirmation, serializeUserEmailAddress, backfillUserEmailAddresses, listUserEmailAddresses, getUserEmailAddress, verifiedEmailCount, setPrimaryEmailAddress, syncPrimaryEmailCaches, createOrResendUserEmailAddress, createMarketWebSession, webAuthPayload, normalizeAppearancePreference, normalizeBaseUrl, optionalTrimmedString, enumValue, unknownKeys, LOCAL_CONTENT_COLLECTIONS, LOCAL_WORK_CONTENT_COLLECTIONS, LOCAL_DECISION_TYPE_VALUES, PROPOSAL_VERDICT_DECISION_TYPES, PLATFORM_OPERATION_SCOPES, LOCAL_CONTENT_DEFAULTS, slugifyContent, yamlScalar, yamlLines, serializeFrontmatter, normalizeRelationArray, uniqueRelationArray, addRelationValue, normalizeLocalContentInput, writeLocalContentRecord, localContentRoot, localContentPath, readLocalContentRecord, writeParsedLocalContentRecord, createRelatedLocalContentRecord, createDecisionFromProposals, isLoopbackUrl, resolveAuthApprovalBaseUrl, findById, resolveAgentArtifactBucket, centralMarketProfile, normalizeMarketProfile, credentialSessionSecret, credentialSessionKey, encryptCredentialSessionPayload, decryptCredentialSessionPayload, normalizeProviderCredentialConfig, HOST_KIND_SESSION_KEYS, providerCredentialValuesForAudit, mergeStringConfig, scheduleBackgroundBootstrap, projectDeletionConfirmationMatches, projectDeletionBlockerRows, githubRequestForProjectDeletion, projectDeletionOperation, cloudflareDeletionAuthenticationMessage, appendProjectDeletionProgress, runProjectDeletionApiDestroy, GITHUB_ACTIONS_OIDC_ISSUER, githubOidcJwksCache, base64urlJson, parseBase64urlJson, operationTokenSecret, signOperationToken, verifyOperationToken, loadGitHubOidcJwks, verifyGitHubOidcToken, normalizeCiEnvironment, ciOperationForAction, fallbackRemoteCapability, normalizeRepositorySlug, projectAllowedCiRepositories, validateCiRefForEnvironment, marketProfilesForTeams, artifactDownloadPayload, principalHasPermission, principalIsSeedAdmin, isTeamApiPrincipal, isLocalAcceptanceServicePrincipal, localAcceptanceAdminToken, localAcceptanceAuthEnabled, decorateJob, safePlatformOperationOutput, decoratePlatformOperation, safeTokenEquals, resolvePlatformRunnerSecret, platformOperationMutationError, requirePlatformRunner, resolvePlatformRepositoryDescriptor, mergeCapability, canonicalArchitectureTopology, ensurePrincipal, resolveUiProjectionContext, decodeRouteParam, uiRuntimeLocals, requireConfiguredServiceCredential, resolvePublicTreeDxTeam, enqueueTreeDxProvisionOperation, principalHasGlobalPlatformRole, requireTeamAccess, requireProjectAccess, safePrivateKnowledgeSlug, privateKnowledgeAuditPayload, recordPrivateKnowledgeAudit, FEEDBACK_TYPES, FEEDBACK_SCREENSHOT_TYPES, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, cleanFeedbackString, safeFeedbackContext, safeFeedbackClient, safeFeedbackScreenshot, validateFeedbackAccess, recordFeedbackSubmission, normalizeSeedEnvironments, seedActor, seedExistingTeamIds, seedCreatesMissingTeams, requireSeedPlanAccess, requireSeedApplyAccess, requireProjectRunner, AGENT_TASK_SIGNATURES, resolveAgentTaskSignature, commerceErrorResponse, stripeConfiguredError, stripeVendorApprovalError, stripeAccountMissingError, stripeCommerceUrl, requireCommerceVendorForStripe, refreshCommerceStripeAccount, STRIPE_PRODUCT_MIRROR_OFFER_MODES, STRIPE_PRICE_MIRROR_OFFER_MODES, stripeMetadataValue, buildCommerceStripeMetadata, commerceStripeProductParams, commerceStripeLookupKey, commerceStripePriceParams, stripePriceTermsDrift, commerceStripeSyncContext, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, CHECKOUT_OFFER_MODES, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, resolveStripePublishableKey, resolveStripeWebhookSecret, commerceCheckoutError, normalizeCheckoutQuantity, stripeClientSecret, paymentGroupStatusFromPaymentIntent, orderStatusFromPaymentGroup, subscriptionStatusFromStripe, entitlementRenewalStateFromSubscription, stripeTimestampToIso, subscriptionClientSecret, publicPaymentGroups, buildCommerceCheckoutMetadata, resolveCommerceCheckoutItem, checkoutGroupKind, checkoutGroupKey, checkoutGroupStatus, grantCommerceEntitlementsForOrder, requireSellerTeamAccess, requireVendorOrderManager, requireServiceBuyerAccess, requireServiceSellerAccess, requireServiceParticipantAccess, redactCommerceServiceRequestForBuyer, requireCommerceCapacityListingAccess, requireCommerceCapacityInquiryAccess, remainingRefundableAmount, stripeRefundStatus, applyCommerceRefundState, resolveOrderItemForRefund, resolveFulfillmentArtifact, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, ensureCommerceStripeCustomer, refreshCommercePaymentGroupState, updateCheckoutCompletionFromGroup, syncCommerceSubscriptionFromStripe, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, handleCommerceInvoiceWebhook, processCommerceStripeWebhook, requireCommerceProductAccess, principalCanManageCommerceProduct, redactCommerceOwnershipWorkflow, requireCommerceOfferAccess, requireCatalogItemAccess, requireConnectedProjectRuntime, projectAppHref, hubRepositoryPolicies, unwrapOperationPayload, applyContentPublishResult, executeInline, projectApiConnection, createProjectInternalClient, executeProjectApi, selectDispatchTarget, defaultConfig, createApiExtension, resolveLaunchTemplateRequirements, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, plaintextHostCredentialFieldPaths, rejectPlaintextHostCredentialFields, inferZoneNameForDomain, domainInZone, encryptedHostPayloadLooksValid, collectHostingAuditCredentialOverlay, nonSecretLaunchJobInput, decryptTeamHostForLaunch, buildLaunchCredentialOverlay, patchLaunchIntentForCredentialOverlay, appendLaunchDeploymentEvent, sanitizeLaunchResultForStorage, cloudflareErrorMessage, cloudflareRequestForLaunchPreflight, resolveCloudflareZoneForLaunchPreflight, verifyCloudflareDnsWriteForLaunch, cloudflareRequestForProjectDeletion, hasRecordedCloudflareRuntimeResources, canSkipCloudflareCleanupAfterFailedLaunch, projectDeletionHostname, normalizedCloudflareKvNamespaceReference, uniqueCloudflareKvNamespaceReferences, cloudflareProjectDeletionResourceNames, resolveProjectDeletionCloudflareZone, deleteCloudflareDnsRecordsForProject, listCloudflareNamedResources, deleteCloudflareProjectResources, cloudflareDnsDomainsForHostValidation, validateTeamHostCredentialPayload, runProjectLaunchApiBootstrap, retryApiLaunchBootstrapFromRequest, launchPlannerRepositoryTopology, launchCapabilityPreset, resourceRowsFromLaunch, unwrapLaunchOperationOutput, appendLaunchPhaseProjection, updateLaunchDeployments, applyHubLaunchResult, applyHubLaunchFailure } from './index.ts';
export function projectHostBindingMetadata(details) {
    const projectMetadata = details?.project?.metadata && typeof details.project.metadata === 'object' ? details.project.metadata : {};
    const hostingMetadata = details?.hosting?.metadata && typeof details.hosting.metadata === 'object' ? details.hosting.metadata : {};
    const connectionMetadata = details?.connection?.metadata && typeof details.connection.metadata === 'object' ? details.connection.metadata : {};
    return {
        hostBindings: projectMetadata.hostBindings ?? hostingMetadata.hostBindings ?? connectionMetadata.hostBindings ?? {},
        hostBindingPlans: projectMetadata.hostBindingPlans ?? hostingMetadata.hostBindingPlans ?? connectionMetadata.hostBindingPlans ?? null,
        hostBindingSecretSync: projectMetadata.hostBindingSecretSync ?? hostingMetadata.hostBindingSecretSync ?? connectionMetadata.hostBindingSecretSync ?? null,
        hostBindingAudit: projectMetadata.hostBindingAudit ?? hostingMetadata.hostBindingAudit ?? connectionMetadata.hostBindingAudit ?? null,
        hostBindingOperations: Array.isArray(projectMetadata.hostBindingOperations) ? projectMetadata.hostBindingOperations : [],
    };
}
export async function loadProjectHostBindingContext({ store, runtime, principal, details }) {
    const project = details.project;
    const source = sourceFromProjectDetails(details);
    const team = await store.getTeam(project.teamId).catch(() => null);
    const [launchRequirements, rawManagedHosts, teamHosts, repositoryHosts] = await Promise.all([
        resolveLaunchTemplateRequirements({
            store,
            principal,
            config: runtime.resolved.config,
            sourceKind: source.sourceKind ?? 'template',
            sourceRef: source.sourceRef,
        }),
        listTreeseedManagedHostsFromConfig(project.teamId, runtime).catch(() => []),
        store.listTeamWebHosts(project.teamId).catch(() => []),
        store.listRepositoryHosts(project.teamId).catch(() => []),
    ]);
    const metadata = projectHostBindingMetadata(details);
    const hostBindings = metadata.hostBindings as Record<string, {
        managedHostKey?: string;
        host?: { status?: string; metadata?: Record<string, unknown> };
    }> | null;
    const hasAcceptanceManagedHostSnapshot = Object.values(hostBindings ?? {})
        .some((binding) => binding?.managedHostKey && binding?.host?.status === 'active' && binding?.host?.metadata?.configured === true);
    const managedHosts = project.metadata?.acceptance === true || hasAcceptanceManagedHostSnapshot
        ? rawManagedHosts.map((host) => host.id === 'treeseed-managed-web'
            ? {
                ...host,
                status: 'active',
                metadata: {
                    ...(host.metadata ?? {}),
                    ...(Object.values(hostBindings ?? {})
                        .find((binding) => binding?.managedHostKey === host.id && binding?.host?.status === 'active')?.host?.metadata ?? {}),
                    configured: true,
                    missingConfigKeys: [],
                },
            }
            : host)
        : rawManagedHosts;
    const hostBindingPlans = metadata.hostBindingPlans ?? { configWrites: [], secretDeployment: { items: [] } };
    return {
        project,
        team,
        source,
        launchRequirements,
        managedHosts,
        teamHosts,
        repositoryHosts: repositoryInventoryWithPlatform(repositoryHosts, details.repositories?.[0]?.owner ?? null),
        defaultHosts: team?.metadata?.defaultHosts && typeof team.metadata.defaultHosts === 'object' ? team.metadata.defaultHosts : {},
        currentHostBindings: metadata.hostBindings && typeof metadata.hostBindings === 'object' ? metadata.hostBindings : {},
        hostBindingPlans,
        hostBindingSecretSync: metadata.hostBindingSecretSync,
        hostBindingAudit: metadata.hostBindingAudit,
        hostBindingOperations: metadata.hostBindingOperations,
        view: deriveProjectHostBindingsView({
            launchRequirements,
            hostBindings: metadata.hostBindings && typeof metadata.hostBindings === 'object' ? metadata.hostBindings : {},
            hostBindingPlans,
        }),
    };
}
export function projectHostResponsePayload(context, extra: any = {}) {
    return {
        projectId: context.project.id,
        teamId: context.project.teamId,
        source: context.source,
        launchRequirements: context.launchRequirements,
        hostBindings: context.currentHostBindings,
        hostBindingPlans: context.hostBindingPlans,
        hostBindingSecretSync: context.hostBindingSecretSync,
        hostBindingAudit: context.hostBindingAudit,
        hostBindingOperations: context.hostBindingOperations,
        view: context.view,
        inventory: {
            repositoryHosts: context.repositoryHosts,
            teamHosts: context.teamHosts,
            managedHosts: context.managedHosts,
            defaultHosts: context.defaultHosts,
        },
        ...extra,
    };
}
export function hostBindingRequiresUnlock(binding) {
    return binding?.host?.ownership === 'team_owned' || (binding?.hostId && !binding?.managedHostKey && binding?.host?.ownership !== 'treeseed_managed');
}
export function hostKindForBinding(binding) {
    if (binding?.type === 'repository')
        return 'repository_host';
    if (binding?.type === 'email')
        return 'email_host';
    return 'web_host';
}
export async function persistProjectHostBindingOperationMetadata({ store, details, nextHostBindings, hostBindingPlans, audit, operation, kind, requirementKey }) {
    const project = details.project;
    const hosting = details.hosting ?? await store.getProjectHosting(project.id).catch(() => null);
    const connection = details.connection ?? await store.getProjectConnection(project.id).catch(() => null);
    const timestamp = new Date().toISOString();
    const operationSummary = operation ? {
        id: operation.id,
        kind,
        requirementKey: requirementKey ?? null,
        status: operation.status,
        queuedAt: timestamp,
        auditStatus: audit.summary.status,
    } : null;
    const previous = projectHostBindingMetadata(details);
    const hostBindingOperations = [
        ...(operationSummary ? [operationSummary] : []),
        ...(previous.hostBindingOperations ?? []),
    ].slice(0, 10);
    const metadataPatch = {
        hostBindings: nextHostBindings,
        hostBindingPlans,
        hostBindingAudit: {
            checkedAt: timestamp,
            summary: audit.summary,
            diagnostics: audit.diagnostics,
        },
        ...(operationSummary ? {
            lastHostOperation: operationSummary,
            hostBindingOperations,
        } : {}),
    };
    await store.updateProject(project.id, {
        metadata: {
            ...(project.metadata ?? {}),
            ...metadataPatch,
        },
    });
    if (hosting) {
        const hostingMetadata = {
            ...(hosting.metadata ?? {}),
            ...metadataPatch,
        };
        await store.upsertProjectHosting(project.id, {
            kind: hosting.kind,
            registration: hosting.registration,
            marketBaseUrl: hosting.marketBaseUrl,
            sourceRepoOwner: hosting.sourceRepoOwner,
            sourceRepoName: hosting.sourceRepoName,
            sourceRepoUrl: hosting.sourceRepoUrl,
            sourceRepoWorkflowPath: hosting.sourceRepoWorkflowPath,
            projectApiBaseUrl: connection?.projectApiBaseUrl ?? null,
            executionOwner: connection?.executionOwner,
            metadata: hostingMetadata,
        });
        await store.run(`UPDATE project_hosting SET metadata_json = ?, updated_at = ? WHERE project_id = ?`, [JSON.stringify(hostingMetadata), timestamp, project.id]).catch(() => null);
    }
    if (connection) {
        const connectionMetadata = {
            ...(connection.metadata ?? {}),
            ...metadataPatch,
        };
        await store.upsertProjectConnection(project.id, {
            mode: connection.mode,
            projectApiBaseUrl: connection.projectApiBaseUrl,
            executionOwner: connection.executionOwner,
            metadata: connectionMetadata,
        });
        await store.run(`UPDATE project_connections SET metadata_json = ?, updated_at = ? WHERE project_id = ?`, [JSON.stringify(connectionMetadata), timestamp, project.id]).catch(() => null);
    }
    await store.updateProject(project.id, {
        metadata: {
            ...(project.metadata ?? {}),
            ...metadataPatch,
        },
    });
}
export function normalizeDomainName(value) {
    const domain = String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//u, '')
        .replace(/\/.*$/u, '')
        .replace(/\.$/u, '');
    if (!domain)
        return null;
    if (domain.length > 253 || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9]?))*$/u.test(domain)) {
        return null;
    }
    return domain.includes('.') ? domain : null;
}
export function normalizeProjectDomainInput(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return {
            productionDomain: normalizeDomainName(value.productionDomain ?? value.production ?? value.prod),
            stagingDomain: normalizeDomainName(value.stagingDomain ?? value.staging),
            zoneName: normalizeDomainName(value.zoneName ?? value.rootZone ?? value.zone),
            zoneId: optionalTrimmedString(value.zoneId),
            manageDns: value.manageDns !== false,
        };
    }
    return {
        productionDomain: null,
        stagingDomain: null,
        zoneName: null,
        zoneId: null,
        manageDns: true,
    };
}
export function decryptedHostConfigSummary(value) {
    if (!value || typeof value !== 'object') {
        return { provided: false, keys: [] };
    }
    return {
        provided: true,
        keys: Object.keys(value).filter((key) => typeof key === 'string' && key.trim()).sort(),
    };
}
export function normalizeAuditHostKinds(value) {
    const allowed = new Set(['repository', 'web', 'email']);
    const raw = Array.isArray(value) && value.length > 0
        ? value
        : ['repository', 'web', 'email'];
    return [...new Set(raw
            .map((entry) => String(entry ?? '').trim())
            .filter((entry) => allowed.has(entry)))];
}

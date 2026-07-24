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
import { jsonError, jsonThrownError, POSTGRES_AUTH_PROVIDER_ID, availabilityAttempts, AUTH_PROVIDERS, providerJwksCache, availabilityRateLimit, personalThemeFromRow, accountDeletionBlockers, consumeReauthentication, loadNotificationPreferences, providerConfigFor, base64Url, verifyProviderIdToken, exchangeProviderIdentity, sourceFromProjectDetails, repositoryInventoryWithPlatform, createProjectHostCredentialSessions, rejectProjectSecretUnlockMaterial, markdownToPlainProjectSummary, parseBooleanEnvValue, shouldLogApiRequests, shouldExposeNonProductionAuthDiagnostics, SENSITIVE_QUERY_PARAM_PATTERN, redactedRequestTarget, installApiRequestLogger, AGENT_PROMOTION_APPROVAL_DECISIONS, readJsonOrFormBody, normalizeEmail, normalizeUsername, parseJsonObject, trimmedHeaderValue, requestClientIp, requestSessionMetadata, webSessionData, validateMarketPassword, hashMarketPassword, verifyMarketPassword, ensureMarketCredentialSchema, MARKET_EMAIL_CONFIRMATION_PREFIX, marketAuthContext, shouldBypassAcceptanceAuthEmailDelivery, marketEmailTokenHash, exposeAuthTokenForTests, authTokenTimestampSeconds, authTokenTimestampMillis, sanitizedReturnTo, confirmationUrlFor, teamInviteAcceptUrlFor, passwordResetUrlFor, sendTeamInviteEmail, createMarketEmailConfirmation, serializeUserEmailAddress, backfillUserEmailAddresses, listUserEmailAddresses, getUserEmailAddress, verifiedEmailCount, setPrimaryEmailAddress, syncPrimaryEmailCaches, createOrResendUserEmailAddress, createMarketWebSession, webAuthPayload, normalizeAppearancePreference, normalizeBaseUrl, optionalTrimmedString, enumValue, unknownKeys, LOCAL_CONTENT_COLLECTIONS, LOCAL_WORK_CONTENT_COLLECTIONS, LOCAL_DECISION_TYPE_VALUES, PROPOSAL_VERDICT_DECISION_TYPES, PLATFORM_OPERATION_SCOPES, LOCAL_CONTENT_DEFAULTS, slugifyContent, yamlScalar, yamlLines, serializeFrontmatter, normalizeRelationArray, uniqueRelationArray, addRelationValue, normalizeLocalContentInput, writeLocalContentRecord, localContentRoot, localContentPath, readLocalContentRecord, writeParsedLocalContentRecord, createRelatedLocalContentRecord, createDecisionFromProposals, isLoopbackUrl, resolveAuthApprovalBaseUrl, findById, resolveAgentArtifactBucket, centralMarketProfile, normalizeMarketProfile, credentialSessionSecret, credentialSessionKey, encryptCredentialSessionPayload, decryptCredentialSessionPayload, normalizeProviderCredentialConfig, HOST_KIND_SESSION_KEYS, providerCredentialValuesForAudit, mergeStringConfig, scheduleBackgroundBootstrap, projectDeletionConfirmationMatches, projectDeletionBlockerRows, githubRequestForProjectDeletion, projectDeletionOperation, cloudflareDeletionAuthenticationMessage, appendProjectDeletionProgress, runProjectDeletionApiDestroy, GITHUB_ACTIONS_OIDC_ISSUER, githubOidcJwksCache, base64urlJson, parseBase64urlJson, operationTokenSecret, signOperationToken, verifyOperationToken, loadGitHubOidcJwks, verifyGitHubOidcToken, normalizeCiEnvironment, ciOperationForAction, fallbackRemoteCapability, normalizeRepositorySlug, projectAllowedCiRepositories, validateCiRefForEnvironment, marketProfilesForTeams, artifactDownloadPayload, principalHasPermission, principalIsSeedAdmin, isTeamApiPrincipal, isLocalAcceptanceServicePrincipal, localAcceptanceAdminToken, localAcceptanceAuthEnabled, decorateJob, safePlatformOperationOutput, decoratePlatformOperation, safeTokenEquals, resolvePlatformRunnerSecret, platformOperationMutationError, requirePlatformRunner, resolvePlatformRepositoryDescriptor, mergeCapability, canonicalArchitectureTopology, ensurePrincipal, resolveUiProjectionContext, decodeRouteParam, uiRuntimeLocals, requireConfiguredServiceCredential, resolvePublicTreeDxTeam, enqueueTreeDxProvisionOperation, principalHasGlobalPlatformRole, requireTeamAccess, requireProjectAccess, safePrivateKnowledgeSlug, privateKnowledgeAuditPayload, recordPrivateKnowledgeAudit, FEEDBACK_TYPES, FEEDBACK_SCREENSHOT_TYPES, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, cleanFeedbackString, safeFeedbackContext, safeFeedbackClient, safeFeedbackScreenshot, validateFeedbackAccess, recordFeedbackSubmission, normalizeSeedEnvironments, seedActor, seedExistingTeamIds, seedCreatesMissingTeams, requireSeedPlanAccess, requireSeedApplyAccess, requireProjectRunner, AGENT_TASK_SIGNATURES, resolveAgentTaskSignature, commerceErrorResponse, stripeConfiguredError, stripeVendorApprovalError, stripeAccountMissingError, stripeCommerceUrl, requireCommerceVendorForStripe, refreshCommerceStripeAccount, STRIPE_PRODUCT_MIRROR_OFFER_MODES, STRIPE_PRICE_MIRROR_OFFER_MODES, stripeMetadataValue, buildCommerceStripeMetadata, commerceStripeProductParams, commerceStripeLookupKey, commerceStripePriceParams, stripePriceTermsDrift, commerceStripeSyncContext, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, CHECKOUT_OFFER_MODES, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, resolveStripePublishableKey, resolveStripeWebhookSecret, commerceCheckoutError, normalizeCheckoutQuantity, stripeClientSecret, paymentGroupStatusFromPaymentIntent, orderStatusFromPaymentGroup, subscriptionStatusFromStripe, entitlementRenewalStateFromSubscription, stripeTimestampToIso, subscriptionClientSecret, publicPaymentGroups, buildCommerceCheckoutMetadata, resolveCommerceCheckoutItem, checkoutGroupKind, checkoutGroupKey, checkoutGroupStatus, grantCommerceEntitlementsForOrder, requireSellerTeamAccess, requireVendorOrderManager, requireServiceBuyerAccess, requireServiceSellerAccess, requireServiceParticipantAccess, redactCommerceServiceRequestForBuyer, requireCommerceCapacityListingAccess, requireCommerceCapacityInquiryAccess, remainingRefundableAmount, stripeRefundStatus, applyCommerceRefundState, resolveOrderItemForRefund, resolveFulfillmentArtifact, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, ensureCommerceStripeCustomer, refreshCommercePaymentGroupState, updateCheckoutCompletionFromGroup, syncCommerceSubscriptionFromStripe, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, handleCommerceInvoiceWebhook, processCommerceStripeWebhook, requireCommerceProductAccess, principalCanManageCommerceProduct, redactCommerceOwnershipWorkflow, requireCommerceOfferAccess, requireCatalogItemAccess, requireConnectedProjectRuntime, projectAppHref, hubRepositoryPolicies, unwrapOperationPayload, applyContentPublishResult, executeInline, projectApiConnection, createProjectInternalClient, executeProjectApi, selectDispatchTarget, defaultConfig, createApiExtension, projectHostBindingMetadata, loadProjectHostBindingContext, projectHostResponsePayload, hostBindingRequiresUnlock, hostKindForBinding, persistProjectHostBindingOperationMetadata, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, plaintextHostCredentialFieldPaths, rejectPlaintextHostCredentialFields, normalizeDomainName, normalizeProjectDomainInput, inferZoneNameForDomain, domainInZone, encryptedHostPayloadLooksValid, decryptedHostConfigSummary, normalizeAuditHostKinds, collectHostingAuditCredentialOverlay, cloudflareErrorMessage, cloudflareRequestForLaunchPreflight, resolveCloudflareZoneForLaunchPreflight, verifyCloudflareDnsWriteForLaunch, cloudflareRequestForProjectDeletion, hasRecordedCloudflareRuntimeResources, canSkipCloudflareCleanupAfterFailedLaunch, projectDeletionHostname, normalizedCloudflareKvNamespaceReference, uniqueCloudflareKvNamespaceReferences, cloudflareProjectDeletionResourceNames, resolveProjectDeletionCloudflareZone, deleteCloudflareDnsRecordsForProject, listCloudflareNamedResources, deleteCloudflareProjectResources, cloudflareDnsDomainsForHostValidation, validateTeamHostCredentialPayload, resolveLaunchTemplateRequirements, nonSecretLaunchJobInput, decryptTeamHostForLaunch, retryApiLaunchBootstrapFromRequest, launchPlannerRepositoryTopology, launchCapabilityPreset, resourceRowsFromLaunch, unwrapLaunchOperationOutput, appendLaunchPhaseProjection, applyHubLaunchResult, applyHubLaunchFailure } from '../index.ts';
export async function buildLaunchCredentialOverlay({ repositoryHost, cloudflareHost, emailHost, cloudflareHostMode, emailHostMode, cloudflareLaunchConfig, passphrase, }) {
    const overlay: Record<string, string> = {};
    const nextIntentPatch = {
        repositoryOwner: null,
        cloudflareHostConfig: null,
        emailHostConfig: null,
    };
    if (repositoryHost?.ownership === 'team_owned') {
        if (!passphrase)
            throw new Error('Sensitive data passphrase is required for the selected Repository Host.');
        const config = await decryptTeamHostForLaunch('repository_host', repositoryHost, passphrase) as Record<string, string | undefined>;
        const token = config.GH_TOKEN ?? config.GITHUB_TOKEN;
        if (token) {
            overlay.GH_TOKEN = token;
            overlay.GITHUB_TOKEN = config.GITHUB_TOKEN ?? token;
            overlay.TREESEED_HOSTED_HUBS_GITHUB_TOKEN = token;
        }
        const owner = config.organizationOrOwner ?? config.owner ?? repositoryHost.organizationOrOwner;
        if (owner) {
            overlay.TREESEED_GITHUB_IDENTITY_MODE = 'account';
            overlay.TREESEED_HOSTED_HUBS_GITHUB_OWNER = owner;
            nextIntentPatch.repositoryOwner = owner;
        }
    }
    if (cloudflareHostMode === 'team_owned') {
        if (!passphrase)
            throw new Error('Sensitive data passphrase is required for the selected Web Host.');
        const config = await decryptTeamHostForLaunch('web_host', cloudflareHost, passphrase);
        mergeStringConfig(overlay, config);
        Object.assign(overlay, providerCredentialValuesForAudit('web_host', { config }));
        nextIntentPatch.cloudflareHostConfig = config;
    }
    else if (cloudflareHostMode === 'treeseed_managed') {
        mergeStringConfig(overlay, cloudflareLaunchConfig ?? {});
    }
    if (emailHostMode === 'team_owned') {
        if (!passphrase)
            throw new Error('Sensitive data passphrase is required for the selected Email Host.');
        const config = await decryptTeamHostForLaunch('email_host', emailHost, passphrase);
        Object.assign(overlay, providerCredentialValuesForAudit('email_host', { config }));
        nextIntentPatch.emailHostConfig = config;
    }
    return { overlay, nextIntentPatch };
}
export function patchLaunchIntentForCredentialOverlay(launchIntent, patch) {
    const nextIntent = JSON.parse(JSON.stringify(launchIntent));
    const providerLaunchInput = {
        ...(nextIntent.execution?.providerLaunchInput ?? {}),
    };
    if (patch.repositoryOwner) {
        nextIntent.repository = {
            ...(nextIntent.repository ?? {}),
            owner: patch.repositoryOwner,
        };
        providerLaunchInput.repoOwner = patch.repositoryOwner;
    }
    if (patch.cloudflareHostConfig) {
        providerLaunchInput.cloudflareHost = {
            ...(providerLaunchInput.cloudflareHost ?? {}),
            config: patch.cloudflareHostConfig,
        };
    }
    if (patch.emailHostConfig) {
        providerLaunchInput.emailHost = {
            ...(providerLaunchInput.emailHost ?? {}),
            config: patch.emailHostConfig,
        };
    }
    nextIntent.execution = {
        ...(nextIntent.execution ?? {}),
        providerLaunchInput,
    };
    return nextIntent;
}
export async function appendLaunchDeploymentEvent(store, job, event) {
    const deployments = await store.listProjectDeployments(job.projectId, { limit: 100 }).catch(() => []);
    for (const deployment of deployments.filter((entry) => entry.platformOperationId === job.id)) {
        await store.appendProjectDeploymentEvent(deployment.id, {
            ...event,
            operationId: job.id,
        }).catch(() => null);
    }
}
export function sanitizeLaunchResultForStorage(value) {
    if (Array.isArray(value))
        return value.map(sanitizeLaunchResultForStorage);
    if (typeof value === 'string') {
        return /(?:github_pat_|ghp_|secret-token|sk-[a-z0-9_-]{8,})/iu.test(value) ? '[redacted]' : value;
    }
    if (!value || typeof value !== 'object')
        return value;
    return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !/(?:secret|token|password|credential|passphrase|apiKey|privateKey|ciphertext)/iu.test(key))
        .filter(([key]) => key !== 'config')
        .map(([key, entry]) => [key, sanitizeLaunchResultForStorage(entry)]));
}
export async function runProjectLaunchApiBootstrap({ store, runtime, jobId, launchIntent, passphrase, repositoryHost, cloudflareHost, emailHost, cloudflareHostMode, emailHostMode, cloudflareLaunchConfig, auditHostKinds, principal, }) {
    let job = await store.findJobById(jobId);
    let bootstrapPhase = 'credential_bootstrap';
    if (!job)
        return null;
    try {
        await appendLaunchDeploymentEvent(store, job, {
            kind: 'launch.bootstrap_started',
            message: 'Credential bootstrap started in the API.',
            status: 'running',
            severity: 'info',
            payload: { phase: 'credential_bootstrap' },
        });
        await store.recordJobProgress(job.id, {
            summary: 'Unlocking selected host credentials in API memory.',
            data: {
                phase: 'credential_bootstrap',
                status: 'running',
                title: 'Credential bootstrap',
            },
        });
        await updateLaunchDeployments(store, job, {
            status: 'running',
            summary: 'Credential bootstrap is running.',
            metadata: { launchPhase: 'credential_bootstrap' },
        });
        const { overlay, nextIntentPatch } = await buildLaunchCredentialOverlay({
            repositoryHost,
            cloudflareHost,
            emailHost,
            cloudflareHostMode,
            emailHostMode,
            cloudflareLaunchConfig,
            passphrase,
        });
        const bootstrappedIntent = patchLaunchIntentForCredentialOverlay(launchIntent, nextIntentPatch);
        const projectDomains = bootstrappedIntent.execution?.providerLaunchInput?.domains ?? bootstrappedIntent.hosting?.domains ?? null;
        bootstrapPhase = 'hosting_readiness_audit';
        await store.recordJobProgress(job.id, {
            summary: 'Running hosting readiness audit before provider bootstrap.',
            data: {
                phase: 'hosting_readiness_audit',
                status: 'running',
                title: 'Hosting readiness audit',
            },
        });
        if (cloudflareHostMode && projectDomains?.manageDns) {
            await appendLaunchDeploymentEvent(store, job, {
                kind: 'launch.dns_preflight_started',
                message: 'Checking Cloudflare DNS write access before creating project resources.',
                status: 'running',
                severity: 'info',
                payload: { phase: 'hosting_readiness_audit', zoneName: projectDomains.zoneName ?? null },
            });
            const dnsPreflight = await verifyCloudflareDnsWriteForLaunch({ overlay, domains: projectDomains });
            await appendLaunchDeploymentEvent(store, job, {
                kind: 'launch.dns_preflight_passed',
                message: `Cloudflare DNS write access verified for ${dnsPreflight?.zoneName ?? 'the selected zone'}.`,
                status: 'running',
                severity: 'info',
                payload: { phase: 'hosting_readiness_audit', zoneName: dnsPreflight?.zoneName ?? null },
            });
        }
        const hostingAudit = await runHostingAudit({
            tenantRoot: runtime?.resolved?.config?.repoRoot ?? process.cwd(),
            environment: 'current',
            repair: false,
            hostKinds: auditHostKinds,
            resourceChecks: false,
            env: process.env,
            valuesOverlay: overlay,
        });
        if (!hostingAudit.ok) {
            const message = 'Hosting readiness audit failed. Fix the listed blockers or run hosting repair before launching.';
            await appendLaunchDeploymentEvent(store, job, {
                kind: 'launch.audit_failed',
                message,
                status: 'failed',
                severity: 'error',
                payload: { audit: hostingAudit },
            });
            await applyHubLaunchFailure(store, job, {
                code: 'hosting_readiness_audit_failed',
                message,
            });
            await store.failJob(job.id, {
                code: 'hosting_readiness_audit_failed',
                message,
            });
            return null;
        }
        await appendLaunchDeploymentEvent(store, job, {
            kind: 'launch.audit_passed',
            message: 'Hosting readiness audit passed.',
            status: 'running',
            severity: 'info',
            payload: { checkedHostKinds: auditHostKinds },
        });
        bootstrapPhase = 'provider_bootstrap';
        await store.recordJobProgress(job.id, {
            summary: 'Executing provider bootstrap with in-memory credentials.',
            data: {
                phase: 'provider_bootstrap',
                status: 'running',
                title: 'Provider bootstrap',
            },
        });
        const result = await new OperationsSdk().execute({
            operationName: 'hub.execute_launch',
            input: bootstrappedIntent,
        }, {
            cwd: runtime?.resolved?.config?.repoRoot ?? process.cwd(),
            env: {
                ...process.env,
                ...overlay,
            },
            transport: 'sdk',
            onProgress: async (event) => {
                if (event.kind !== 'hub_launch_phase')
                    return;
                await store.recordJobProgress(job.id, {
                    summary: typeof event.summary === 'string' ? event.summary : null,
                    data: event,
                });
                await appendLaunchDeploymentEvent(store, job, {
                    kind: 'launch.provider_progress',
                    message: typeof event.summary === 'string' ? event.summary : String(event.phase ?? 'Provider bootstrap progress'),
                    status: event.status === 'failed' ? 'failed' : 'running',
                    severity: event.status === 'failed' ? 'error' : 'info',
                    payload: {
                        phase: event.phase ?? null,
                        status: event.status ?? null,
                    },
                });
            },
        });
        const output = sanitizeLaunchResultForStorage(result.mode === 'inline' ? result.payload : result);
        job = await store.findJobById(job.id);
        await applyHubLaunchResult(store, runtime, job, output, principal);
        await store.completeJob(job.id, {
            output,
        });
        return await store.findJobById(job.id);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        job = await store.findJobById(jobId);
        if (!job)
            return null;
        await appendLaunchDeploymentEvent(store, job, {
            kind: 'launch.bootstrap_failed',
            message,
            status: 'failed',
            severity: 'error',
            payload: { code: 'api_bootstrap_failed', phase: bootstrapPhase },
        });
        await applyHubLaunchFailure(store, job, {
            code: 'api_bootstrap_failed',
            message,
            phase: bootstrapPhase,
        }).catch(() => null);
        await store.failJob(job.id, {
            code: 'api_bootstrap_failed',
            message,
        }).catch(() => null);
        return null;
    }
}
export async function updateLaunchDeployments(store, job, patch) {
    const deployments = await store.listProjectDeployments(job.projectId, { limit: 100 }).catch(() => []);
    for (const deployment of deployments.filter((entry) => entry.platformOperationId === job.id)) {
        const { eventKindPrefix = 'launch', ...deploymentPatch } = patch;
        const updated = await store.updateProjectDeployment(deployment.id, {
            ...deploymentPatch,
            metadata: {
                ...(deployment.metadata ?? {}),
                ...(patch.metadata ?? {}),
            },
        });
        const eventKind = patch.status === 'succeeded'
            ? `${eventKindPrefix}.succeeded`
            : patch.status === 'failed'
                ? `${eventKindPrefix}.failed`
                : `${eventKindPrefix}.updated`;
        await store.appendProjectDeploymentEvent(deployment.id, {
            kind: eventKind,
            message: patch.summary ?? (patch.status === 'succeeded' ? 'Initial project launch completed.' : patch.status === 'failed' ? 'Initial project launch failed.' : 'Initial project launch updated.'),
            status: updated?.status ?? patch.status ?? deployment.status,
            severity: patch.status === 'failed' ? 'error' : 'info',
            operationId: job.id,
            payload: {
                jobId: job.id,
                ...(eventKindPrefix === 'launch' ? { launchJobId: job.id } : {}),
                error: patch.error ?? null,
            },
        }).catch(() => null);
    }
}

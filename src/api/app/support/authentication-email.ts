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
import { jsonError, jsonThrownError, availabilityAttempts, providerJwksCache, availabilityRateLimit, personalThemeFromRow, accountDeletionBlockers, providerConfigFor, base64Url, exchangeProviderIdentity, resolveLaunchTemplateRequirements, projectHostBindingMetadata, sourceFromProjectDetails, repositoryInventoryWithPlatform, loadProjectHostBindingContext, projectHostResponsePayload, hostBindingRequiresUnlock, hostKindForBinding, persistProjectHostBindingOperationMetadata, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, plaintextHostCredentialFieldPaths, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, markdownToPlainProjectSummary, parseBooleanEnvValue, shouldLogApiRequests, SENSITIVE_QUERY_PARAM_PATTERN, redactedRequestTarget, installApiRequestLogger, AGENT_PROMOTION_APPROVAL_DECISIONS, readJsonOrFormBody, normalizeUsername, parseJsonObject, trimmedHeaderValue, requestClientIp, ensureMarketCredentialSchema, sanitizedReturnTo, confirmationUrlFor, teamInviteAcceptUrlFor, normalizeBaseUrl, normalizeDomainName, normalizeProjectDomainInput, inferZoneNameForDomain, domainInZone, optionalTrimmedString, enumValue, unknownKeys, LOCAL_CONTENT_COLLECTIONS, LOCAL_WORK_CONTENT_COLLECTIONS, LOCAL_DECISION_TYPE_VALUES, PROPOSAL_VERDICT_DECISION_TYPES, PLATFORM_OPERATION_SCOPES, LOCAL_CONTENT_DEFAULTS, slugifyContent, yamlScalar, yamlLines, serializeFrontmatter, normalizeRelationArray, uniqueRelationArray, addRelationValue, normalizeLocalContentInput, writeLocalContentRecord, localContentRoot, localContentPath, readLocalContentRecord, writeParsedLocalContentRecord, createRelatedLocalContentRecord, createDecisionFromProposals, isLoopbackUrl, findById, resolveAgentArtifactBucket, centralMarketProfile, normalizeMarketProfile, encryptedHostPayloadLooksValid, decryptedHostConfigSummary, normalizeProviderCredentialConfig, normalizeAuditHostKinds, providerCredentialValuesForAudit, collectHostingAuditCredentialOverlay, nonSecretLaunchJobInput, decryptTeamHostForLaunch, mergeStringConfig, buildLaunchCredentialOverlay, patchLaunchIntentForCredentialOverlay, appendLaunchDeploymentEvent, scheduleBackgroundBootstrap, sanitizeLaunchResultForStorage, cloudflareErrorMessage, cloudflareRequestForLaunchPreflight, resolveCloudflareZoneForLaunchPreflight, verifyCloudflareDnsWriteForLaunch, projectDeletionConfirmationMatches, projectDeletionBlockerRows, cloudflareRequestForProjectDeletion, githubRequestForProjectDeletion, projectDeletionOperation, hasRecordedCloudflareRuntimeResources, canSkipCloudflareCleanupAfterFailedLaunch, projectDeletionHostname, normalizedCloudflareKvNamespaceReference, uniqueCloudflareKvNamespaceReferences, cloudflareProjectDeletionResourceNames, resolveProjectDeletionCloudflareZone, deleteCloudflareDnsRecordsForProject, listCloudflareNamedResources, deleteCloudflareProjectResources, appendProjectDeletionProgress, cloudflareDnsDomainsForHostValidation, validateTeamHostCredentialPayload, runProjectLaunchApiBootstrap, runProjectDeletionApiDestroy, retryApiLaunchBootstrapFromRequest, GITHUB_ACTIONS_OIDC_ISSUER, githubOidcJwksCache, base64urlJson, parseBase64urlJson, operationTokenSecret, signOperationToken, verifyOperationToken, loadGitHubOidcJwks, verifyGitHubOidcToken, normalizeCiEnvironment, ciOperationForAction, fallbackRemoteCapability, normalizeRepositorySlug, projectAllowedCiRepositories, validateCiRefForEnvironment, marketProfilesForTeams, artifactDownloadPayload, principalHasPermission, principalIsSeedAdmin, isTeamApiPrincipal, isLocalAcceptanceServicePrincipal, localAcceptanceAdminToken, decorateJob, safePlatformOperationOutput, decoratePlatformOperation, safeTokenEquals, resolvePlatformRunnerSecret, platformOperationMutationError, requirePlatformRunner, resolvePlatformRepositoryDescriptor, mergeCapability, canonicalArchitectureTopology, launchPlannerRepositoryTopology, launchCapabilityPreset, resourceRowsFromLaunch, ensurePrincipal, resolveUiProjectionContext, decodeRouteParam, uiRuntimeLocals, requireConfiguredServiceCredential, resolvePublicTreeDxTeam, enqueueTreeDxProvisionOperation, principalHasGlobalPlatformRole, requireTeamAccess, requireProjectAccess, safePrivateKnowledgeSlug, privateKnowledgeAuditPayload, recordPrivateKnowledgeAudit, FEEDBACK_TYPES, FEEDBACK_SCREENSHOT_TYPES, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, cleanFeedbackString, safeFeedbackContext, safeFeedbackClient, safeFeedbackScreenshot, validateFeedbackAccess, recordFeedbackSubmission, normalizeSeedEnvironments, seedActor, seedExistingTeamIds, seedCreatesMissingTeams, requireSeedPlanAccess, requireSeedApplyAccess, requireProjectRunner, AGENT_TASK_SIGNATURES, resolveAgentTaskSignature, commerceErrorResponse, stripeConfiguredError, stripeVendorApprovalError, stripeAccountMissingError, stripeCommerceUrl, requireCommerceVendorForStripe, refreshCommerceStripeAccount, STRIPE_PRODUCT_MIRROR_OFFER_MODES, STRIPE_PRICE_MIRROR_OFFER_MODES, stripeMetadataValue, buildCommerceStripeMetadata, commerceStripeProductParams, commerceStripeLookupKey, commerceStripePriceParams, stripePriceTermsDrift, commerceStripeSyncContext, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, CHECKOUT_OFFER_MODES, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, resolveStripePublishableKey, resolveStripeWebhookSecret, commerceCheckoutError, normalizeCheckoutQuantity, stripeClientSecret, paymentGroupStatusFromPaymentIntent, orderStatusFromPaymentGroup, subscriptionStatusFromStripe, entitlementRenewalStateFromSubscription, stripeTimestampToIso, subscriptionClientSecret, publicPaymentGroups, buildCommerceCheckoutMetadata, resolveCommerceCheckoutItem, checkoutGroupKind, checkoutGroupKey, checkoutGroupStatus, grantCommerceEntitlementsForOrder, requireSellerTeamAccess, requireVendorOrderManager, requireServiceBuyerAccess, requireServiceSellerAccess, requireServiceParticipantAccess, redactCommerceServiceRequestForBuyer, requireCommerceCapacityListingAccess, requireCommerceCapacityInquiryAccess, remainingRefundableAmount, stripeRefundStatus, applyCommerceRefundState, resolveOrderItemForRefund, resolveFulfillmentArtifact, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, ensureCommerceStripeCustomer, refreshCommercePaymentGroupState, updateCheckoutCompletionFromGroup, syncCommerceSubscriptionFromStripe, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, handleCommerceInvoiceWebhook, processCommerceStripeWebhook, requireCommerceProductAccess, principalCanManageCommerceProduct, redactCommerceOwnershipWorkflow, requireCommerceOfferAccess, requireCatalogItemAccess, requireConnectedProjectRuntime, projectAppHref, unwrapLaunchOperationOutput, appendLaunchPhaseProjection, updateLaunchDeployments, hubRepositoryPolicies, applyHubLaunchResult, applyHubLaunchFailure, unwrapOperationPayload, applyContentPublishResult, executeInline, projectApiConnection, createProjectInternalClient, executeProjectApi, selectDispatchTarget, defaultConfig, createApiExtension, POSTGRES_AUTH_PROVIDER_ID, AUTH_PROVIDERS, consumeReauthentication, loadNotificationPreferences, verifyProviderIdToken, createProjectHostCredentialSessions, shouldExposeNonProductionAuthDiagnostics, requestSessionMetadata, webSessionData, validateMarketPassword, hashMarketPassword, verifyMarketPassword, marketAuthContext, exposeAuthTokenForTests, authTokenTimestampSeconds, authTokenTimestampMillis, passwordResetUrlFor, createMarketWebSession, webAuthPayload, normalizeAppearancePreference, resolveAuthApprovalBaseUrl, credentialSessionSecret, credentialSessionKey, encryptCredentialSessionPayload, decryptCredentialSessionPayload, HOST_KIND_SESSION_KEYS, cloudflareDeletionAuthenticationMessage, localAcceptanceAuthEnabled } from './index.ts';
export function normalizeEmail(value) {
    return String(value ?? '').trim().toLowerCase();
}
export const MARKET_EMAIL_CONFIRMATION_PREFIX = 'market_email_confirmation:';
export function shouldBypassAcceptanceAuthEmailDelivery(c, config) {
    const serviceId = c.req.header('x-treeseed-service-id') ?? '';
    const serviceSecret = c.req.header('x-treeseed-service-secret') ?? '';
    return c.req.header('x-treeseed-acceptance-email-bypass') === '1'
        && Boolean(config.webServiceId && config.webServiceSecret)
        && serviceId === config.webServiceId
        && serviceSecret === config.webServiceSecret;
}
export function marketEmailTokenHash(token) {
    return createHash('sha256').update(String(token)).digest('hex');
}
export async function sendTeamInviteEmail(context, input) {
    const teamName = String(input.team?.displayName ?? input.team?.name ?? 'TreeSeed').trim() || 'TreeSeed';
    const role = String(input.invite?.roleKey ?? input.invite?.role ?? 'member').replace(/_/gu, ' ');
    const acceptUrl = teamInviteAcceptUrlFor(context, input.token);
    const text = [
        `You were invited to join ${teamName} on TreeSeed as ${role}.`,
        '',
        'Accept this team invite:',
        acceptUrl,
        '',
        'If you do not recognize this invite, you can ignore this email.',
    ].join('\n');
    const html = [
        '<div style="font-family:Inter,Arial,sans-serif;line-height:1.5;color:#17211b">',
        `<h1 style="font-size:24px">Join ${teamName} on TreeSeed</h1>`,
        `<p>You were invited as <strong>${role}</strong>.</p>`,
        `<p><a href="${acceptUrl}" style="display:inline-block;background:#2f6f4e;color:white;padding:12px 18px;border-radius:6px;text-decoration:none;font-weight:700">Accept invite</a></p>`,
        `<p style="word-break:break-all;color:#526052">${acceptUrl}</p>`,
        '</div>',
    ].join('');
    await sendAuthEmail(context, {
        to: input.invite.email,
        subject: `You're invited to join ${teamName}`,
        text,
        html,
    });
}
export async function createMarketEmailConfirmation(store, context, input) {
    const authConfig = getSiteAuthConfig(context);
    const token = `confirm_${randomBytes(24).toString('base64url')}`;
    const now = Date.now();
    const expiresInSeconds = authConfig.emailVerificationTtlSeconds;
    const expiresAt = now + expiresInSeconds * 1000;
    const createdAt = authTokenTimestampSeconds(now);
    const storedExpiresAt = authTokenTimestampSeconds(expiresAt);
    const identifier = `${MARKET_EMAIL_CONFIRMATION_PREFIX}${input.emailAddressId ?? input.email}`;
    await store.run(`DELETE FROM better_auth_verification WHERE identifier = ?`, [identifier]).catch(() => null);
    const verificationId = randomUUID();
    const verificationValues = [verificationId, identifier, marketEmailTokenHash(token), storedExpiresAt, createdAt, createdAt];
    try {
        await store.run(`INSERT INTO better_auth_verification (id, identifier, value, "expiresAt", "createdAt", "updatedAt")
			 VALUES (?, ?, ?, ?, ?, ?)`, verificationValues);
    }
    catch (error) {
        await store.run(`INSERT INTO better_auth_verification (id, identifier, value, expiresat, createdat, updatedat)
			 VALUES (?, ?, ?, ?, ?, ?)`, verificationValues).catch(() => {
            throw error;
        });
    }
    if (input.emailAddressId) {
        await store.run(`UPDATE user_email_addresses SET verification_requested_at = ?, updated_at = ? WHERE id = ?`, [new Date(now).toISOString(), new Date(now).toISOString(), input.emailAddressId]).catch(() => null);
    }
    if (!input.skipDelivery) {
        await sendEmailConfirmation(context, {
            email: input.email,
            displayName: input.displayName,
            confirmationUrl: confirmationUrlFor(context, token, input.returnTo),
            expiresInSeconds,
        });
    }
    return {
        email: input.email,
        expiresInSeconds,
        token,
    };
}
export function serializeUserEmailAddress(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        userId: row.user_id,
        email: row.email,
        status: row.status,
        verified: row.status === 'verified',
        isPrimary: Number(row.is_primary ?? 0) === 1,
        verificationRequestedAt: row.verification_requested_at ?? null,
        verifiedAt: row.verified_at ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
export async function backfillUserEmailAddresses(store) {
    const now = new Date().toISOString();
    await store.run(`INSERT INTO user_email_addresses (
			id, user_id, email, normalized_email, status, is_primary, verification_requested_at, verified_at, created_at, updated_at
		)
		SELECT 'email_' || md5(user_id || ':' || LOWER(email)), user_id, email, LOWER(email), 'verified', 1, created_at, COALESCE(updated_at, created_at), created_at, updated_at
		  FROM market_auth_credentials
		 WHERE email IS NOT NULL
		   AND email != ''
		   AND status = 'active'
		ON CONFLICT (normalized_email) DO NOTHING`).catch(() => null);
    await store.run(`UPDATE user_email_addresses
		    SET updated_at = ?
		  WHERE is_primary = 1
		    AND status != 'verified'`, [now]).catch(() => null);
}
export async function listUserEmailAddresses(store, userId) {
    await backfillUserEmailAddresses(store);
    const rows = await store.all(`SELECT * FROM user_email_addresses
		 WHERE user_id = ?
		 ORDER BY is_primary DESC, status DESC, verified_at ASC, created_at ASC`, [userId]).catch(() => []);
    return rows.map(serializeUserEmailAddress);
}
export async function getUserEmailAddress(store, userId, emailId) {
    await backfillUserEmailAddresses(store);
    const row = await store.first(`SELECT * FROM user_email_addresses WHERE id = ? AND user_id = ? LIMIT 1`, [emailId, userId]);
    return row ?? null;
}
export async function verifiedEmailCount(store, userId) {
    const row = await store.first(`SELECT COUNT(*) AS count FROM user_email_addresses WHERE user_id = ? AND status = 'verified'`, [userId]);
    return Number(row?.count ?? 0);
}
export async function setPrimaryEmailAddress(store, userId, emailId) {
    const email = await getUserEmailAddress(store, userId, emailId);
    if (!email)
        return { ok: false, status: 404, error: 'Email address was not found.' };
    if (email.status !== 'verified')
        return { ok: false, status: 409, error: 'Email must be verified before it can be primary.' };
    const now = new Date().toISOString();
    await store.run(`UPDATE user_email_addresses SET is_primary = 0, updated_at = ? WHERE user_id = ?`, [now, userId]);
    await store.run(`UPDATE user_email_addresses SET is_primary = 1, updated_at = ? WHERE id = ? AND user_id = ?`, [now, emailId, userId]);
    await syncPrimaryEmailCaches(store, userId);
    return { ok: true, emailAddress: serializeUserEmailAddress(await getUserEmailAddress(store, userId, emailId)) };
}
export async function syncPrimaryEmailCaches(store, userId) {
    const primary = await store.first(`SELECT * FROM user_email_addresses
		 WHERE user_id = ? AND status = 'verified'
		 ORDER BY is_primary DESC, verified_at ASC, created_at ASC
		 LIMIT 1`, [userId]);
    if (!primary?.id)
        return null;
    const now = new Date().toISOString();
    await store.run(`UPDATE user_email_addresses SET is_primary = CASE WHEN id = ? THEN 1 ELSE 0 END, updated_at = ? WHERE user_id = ?`, [
        primary.id,
        now,
        userId,
    ]);
    await store.run(`UPDATE users SET email = ?, updated_at = ? WHERE id = ?`, [primary.email, now, userId]);
    await store.run(`UPDATE market_auth_credentials SET email = ?, updated_at = ? WHERE user_id = ?`, [primary.email, now, userId]).catch(() => null);
    return serializeUserEmailAddress(await getUserEmailAddress(store, userId, primary.id));
}
export async function createOrResendUserEmailAddress(store, context, userId, input) {
    const email = normalizeEmail(input.email);
    if (!email || !email.includes('@'))
        return { ok: false, status: 400, error: 'A valid email is required.' };
    const now = new Date().toISOString();
    const existing = await store.first(`SELECT * FROM user_email_addresses WHERE normalized_email = ? LIMIT 1`, [email]);
    if (existing?.id && existing.user_id !== userId) {
        return { ok: false, status: 409, error: 'Email is already in use.' };
    }
    let row = existing;
    if (!row?.id) {
        const id = randomUUID();
        const primary = (await verifiedEmailCount(store, userId)) === 0 ? 1 : 0;
        await store.run(`INSERT INTO user_email_addresses (
				id, user_id, email, normalized_email, status, is_primary, verification_requested_at, verified_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, ?)`, [id, userId, email, email, primary, now, now]);
        row = await getUserEmailAddress(store, userId, id);
    }
    let confirmation = null;
    if (row?.status !== 'verified') {
        confirmation = await createMarketEmailConfirmation(store, context, {
            email: row.email,
            emailAddressId: row.id,
            displayName: input.displayName,
            returnTo: input.returnTo ?? '/app/account',
            skipDelivery: input.skipDelivery,
        });
        row = await getUserEmailAddress(store, userId, row.id);
    }
    return {
        ok: true,
        emailAddress: serializeUserEmailAddress(row),
        verificationSent: Boolean(confirmation),
        confirmationToken: exposeAuthTokenForTests() ? confirmation?.token : undefined,
    };
}

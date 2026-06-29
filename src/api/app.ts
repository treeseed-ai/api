// @ts-nocheck
import type { Hono } from 'hono';
import {
	AgentSdk,
	RemoteTreeseedClient,
	RemoteTreeseedOperationsClient,
	RemoteTreeseedSdkClient,
	signEditorialPreviewToken,
	TreeseedOperationsSdk,
	executeSdkOperation,
	findDispatchCapability,
	planKnowledgeHubLaunch,
	reserveCreditsForEstimate,
	routeAndReserveCapacity,
	settleCapacityActuals,
	renderCapacityProviderSelfHostInstructions,
	resolveCapacityProviderEnvironment,
	redactCapacityProviderEnv,
	deployCapacityProviderToManagedMarketHost,
	deployCapacityProviderToRailway,
	derivePlatformOperationNavigation,
	calculateActualCredits,
	deriveProjectHostBindingsView,
	isPlatformOperationTerminal,
	normalizeProjectLaunchHostBindings,
	normalizePlatformContentInput as normalizeRepositoryContentInput,
	normalizePlatformRelationArray as normalizeRepositoryRelationArray,
	platformContentRelationPolicy as repositoryContentRelationPolicy,
	normalizeTemplateLaunchRequirements,
	normalizeTreeseedTemplateId,
	planProjectHostBindingOperation,
	resolveProjectLaunchHostBindings,
	slugifyPlatformContent as slugifyRepositoryContent,
} from '@treeseed/sdk';
import { runTreeseedHostingAudit } from '@treeseed/sdk/workflow-support';
import {
	createTreeseedApiApp,
	D1AuthProvider as DatabaseAuthProvider,
	loadTemplateCatalog,
	resolveApiConfig,
} from '@treeseed/sdk/api';
import { MarketControlPlaneStore, validateProjectSlug } from './store.js';
import { createClientEncryptedEscrowService } from './client-encrypted-escrow.ts';
import { createGitHubAppAdapter } from './github-app-adapter.ts';
import { createGitHubActionsSecretEnclave } from './github-actions-secret-enclave.ts';
import { createTreeDxCredentialBridge } from './treedx-credential-bridge.ts';
import { createMarketPostgresDatabase } from './market-postgres.js';
import { installProjectDeploymentRoutes } from './project-deployment-routes.js';
import { createStripeConnectService, resolveStripeEnvironment, stripeAccountToConnectedAccountPatch } from './stripe-connect.js';
import { applySeedWithStore, exportSeedWithStore, planSeedWithStore } from '../market/seeds/apply.js';
import { buildGovernanceApprovalProjection, buildGovernanceProjection } from '../market/governance-projection.js';
import { buildInfrastructureProjection } from '../market/infrastructure-projection.js';
import { loadInfrastructureSeedState } from '../market/infrastructure-seeds.js';
import { buildKnowledgeArtifactProjection, buildKnowledgeProjection } from '../market/knowledge-projection.js';
import { buildWorkdayProjection } from '../market/workday-projection.js';
import { loadKnowledgeContentEntries } from '../view-models/knowledge-content.js';
import {
	listTreeseedManagedHostsFromConfig,
	managedCloudflareConfigMissing,
	resolveTreeseedManagedCloudflareHostConfigFromConfig,
} from '../market/managed-hosts.js';
import { decryptHostConfig } from '../crypto/host-crypto.ts';
import { getSiteAuthConfig } from '../auth/config.ts';
import { accountDeletionConfirmationMatches } from '../auth/account.ts';
import { validateUsername as validatePublicUsername } from '../auth/profile-validation.ts';
import { authEmailDeliveryFailureDetail, authEmailDeliveryFailureReason, sendAuthEmail } from '../auth/email.ts';
import { sendEmailConfirmation } from '../auth/email-confirmation.ts';
import { sendWelcomeEmail } from '../auth/welcome-email.ts';
import { createCipheriv, createDecipheriv, createHash, createHmac, createPublicKey, createVerify, pbkdf2Sync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { contentRelationPolicy } from '../market/content-relations.js';

function jsonError(c, status, error, details = {}) {
	return c.json({
		ok: false,
		error,
		...details,
	}, { status });
}

function jsonThrownError(c, error, fallbackStatus = 500) {
	const status = Number(error?.status ?? fallbackStatus);
	const message = error instanceof Error ? error.message : String(error ?? 'Request failed.');
	return jsonError(c, status >= 400 && status < 600 ? status : fallbackStatus, message, {
		code: error?.code ?? 'request_failed',
		details: error?.details,
	});
}

const POSTGRES_AUTH_PROVIDER_ID = 'market-postgres';

async function resolveLaunchTemplateRequirements({ store, principal, config, sourceKind, sourceRef, requireKnownTemplate = false }) {
	if (!['template', 'market_listing'].includes(sourceKind) || typeof sourceRef !== 'string' || !sourceRef.trim()) {
		return null;
	}
	const ref = normalizeTreeseedTemplateId(sourceRef);
	try {
		const catalog = loadTemplateCatalog(config);
		const catalogEntry = catalog.items.find((item) => item.id === ref);
		if (catalogEntry?.launchRequirements) return catalogEntry.launchRequirements;
		if (catalogEntry) return null;
	} catch {
		// Catalog lookup is best-effort here; custom catalog metadata can still provide requirements.
	}
	const item = await store.getCatalogItem(ref).catch(() => null)
		?? await store.getCatalogItemBySlug('template', ref).catch(() => null);
	if (!item) {
		if (requireKnownTemplate) throw new Error(`Unknown template "${ref}".`);
		return null;
	}
	const canAccess = await store.principalCanAccessCatalogItem(principal, item).catch(() => false);
	if (!canAccess) return null;
	return normalizeTemplateLaunchRequirements(item.metadata?.launchRequirements, `catalog item ${ref} launchRequirements`) ?? null;
}

function projectHostBindingMetadata(details) {
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

function sourceFromProjectDetails(details) {
	const projectMetadata = details?.project?.metadata && typeof details.project.metadata === 'object' ? details.project.metadata : {};
	const hostingMetadata = details?.hosting?.metadata && typeof details.hosting.metadata === 'object' ? details.hosting.metadata : {};
	const sourceKind = optionalTrimmedString(projectMetadata.sourceKind)
		?? optionalTrimmedString(hostingMetadata.sourceKind)
		?? (optionalTrimmedString(projectMetadata.sourceRef) || optionalTrimmedString(hostingMetadata.sourceRef) ? 'template' : null);
	const rawSourceRef = optionalTrimmedString(projectMetadata.sourceRef)
		?? optionalTrimmedString(hostingMetadata.sourceRef)
		?? null;
	const sourceRef = normalizeTreeseedTemplateId(rawSourceRef);
	return { sourceKind, sourceRef };
}

function repositoryInventoryWithPlatform(repositoryHosts, requestedOwner = null) {
	if ((repositoryHosts ?? []).some((host) => host.id === 'platform:github:hosted-hubs')) return repositoryHosts;
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

async function loadProjectHostBindingContext({ store, runtime, principal, details }) {
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
	const hasAcceptanceManagedHostSnapshot = Object.values(metadata.hostBindings ?? {})
		.some((binding) => binding?.managedHostKey && binding?.host?.status === 'active' && binding?.host?.metadata?.configured === true);
	const managedHosts = project.metadata?.acceptance === true || hasAcceptanceManagedHostSnapshot
		? rawManagedHosts.map((host) => host.id === 'treeseed-managed-web'
			? {
				...host,
				status: 'active',
				metadata: {
					...(host.metadata ?? {}),
					...(Object.values(metadata.hostBindings ?? {})
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

function projectHostResponsePayload(context, extra = {}) {
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

function hostBindingRequiresUnlock(binding) {
	return binding?.host?.ownership === 'team_owned' || (binding?.hostId && !binding?.managedHostKey && binding?.host?.ownership !== 'treeseed_managed');
}

function hostKindForBinding(binding) {
	if (binding?.type === 'repository') return 'repository_host';
	if (binding?.type === 'email') return 'email_host';
	return 'web_host';
}

async function createProjectHostCredentialSessions({ store, runtime, teamId, principalId, hostBindings, requirementKeys, passphrase }) {
	if (!passphrase) return {};
	const sessions = {};
	for (const [requirementKey, binding] of Object.entries(hostBindings ?? {})) {
		if (requirementKeys?.length && !requirementKeys.includes(requirementKey)) continue;
		if (!hostBindingRequiresUnlock(binding)) continue;
		const hostKind = hostKindForBinding(binding);
		const hostId = binding.hostId ?? binding.host?.id ?? null;
		if (!hostId) continue;
		const host = hostKind === 'repository_host'
			? await store.getRepositoryHost(teamId, hostId)
			: await store.getTeamWebHost(teamId, hostId);
		if (!host || host.ownership !== 'team_owned') continue;
		const normalizedConfig = await decryptTeamHostForLaunch(hostKind, host, passphrase);
		const session = await store.createProviderCredentialSession(teamId, {
			hostKind,
			hostId,
			purpose: 'project_host_operation',
			expiresAt: new Date(Date.now() + 900_000).toISOString(),
			createdById: principalId,
			encryptedPayload: encryptCredentialSessionPayload(runtime, {
				provider: host.provider ?? binding.provider,
				ownership: host.ownership,
				config: normalizedConfig,
			}),
			metadata: {
				requirementKey,
				hostName: host.name ?? null,
				provider: host.provider ?? binding.provider ?? null,
				configSummary: decryptedHostConfigSummary(normalizedConfig),
			},
		});
		sessions[requirementKey] = {
			id: session.id,
			hostKind: session.hostKind,
			hostId: session.hostId,
			purpose: session.purpose,
			expiresAt: session.expiresAt,
		};
	}
	return sessions;
}

async function persistProjectHostBindingOperationMetadata({ store, details, nextHostBindings, hostBindingPlans, audit, operation, kind, requirementKey }) {
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
		await store.run(
			`UPDATE project_hosting SET metadata_json = ?, updated_at = ? WHERE project_id = ?`,
			[JSON.stringify(hostingMetadata), timestamp, project.id],
		).catch(() => null);
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
		await store.run(
			`UPDATE project_connections SET metadata_json = ?, updated_at = ? WHERE project_id = ?`,
			[JSON.stringify(connectionMetadata), timestamp, project.id],
		).catch(() => null);
	}
	await store.updateProject(project.id, {
		metadata: {
			...(project.metadata ?? {}),
			...metadataPatch,
		},
	});
}

const PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES = new Set([
	'githubToken',
	'TREESEED_GITHUB_TOKEN',
	'GH_TOKEN',
	'GITHUB_TOKEN',
	'cloudflareAccountId',
	'cloudflareApiToken',
	'TREESEED_CLOUDFLARE_ACCOUNT_ID',
	'TREESEED_CLOUDFLARE_API_TOKEN',
	'CLOUDFLARE_ACCOUNT_ID',
	'CLOUDFLARE_API_TOKEN',
	'railwayApiToken',
	'TREESEED_RAILWAY_API_TOKEN',
	'railwayWorkspace',
	'RAILWAY_API_TOKEN',
	'TREESEED_RAILWAY_WORKSPACE',
	'smtpUsername',
	'smtpPassword',
	'SMTP_USERNAME',
	'SMTP_PASSWORD',
	'aiApiKey',
	'aiBaseUrl',
	'aiDefaultModel',
	'AI_API_KEY',
	'AI_BASE_URL',
	'AI_DEFAULT_MODEL',
]);

function plaintextHostCredentialFieldPaths(value, path = '') {
	if (!value || typeof value !== 'object') return [];
	if (Array.isArray(value)) {
		return value.flatMap((entry, index) => plaintextHostCredentialFieldPaths(entry, `${path}[${index}]`));
	}
	const paths = [];
	for (const [key, entry] of Object.entries(value)) {
		if (key === 'encryptedPayload') continue;
		const nextPath = path ? `${path}.${key}` : key;
		if (PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES.has(key)) {
			paths.push(nextPath);
			continue;
		}
		paths.push(...plaintextHostCredentialFieldPaths(entry, nextPath));
	}
	return paths;
}

function rejectPlaintextHostCredentialFields(c, body) {
	const fields = plaintextHostCredentialFieldPaths(body);
	if (fields.length === 0) return null;
	return jsonError(c, 400, 'Host credential values must be encrypted in encryptedPayload before submission.', {
		fields,
	});
}

function rejectProjectSecretUnlockMaterial(c, body, message = 'Project operations no longer accept passphrases or credential sessions. Re-enter or migrate the secret into an approved target, then retry.') {
	const fields = [];
	if (body && typeof body === 'object') {
		if (typeof body.sensitivePassphrase === 'string' && body.sensitivePassphrase) fields.push('sensitivePassphrase');
		if (typeof body.passphrase === 'string' && body.passphrase) fields.push('passphrase');
		if (body.credentialSessions && typeof body.credentialSessions === 'object' && Object.keys(body.credentialSessions).length > 0) fields.push('credentialSessions');
		if (body.providerCredentialSessions && typeof body.providerCredentialSessions === 'object' && Object.keys(body.providerCredentialSessions).length > 0) fields.push('providerCredentialSessions');
	}
	if (fields.length === 0) return null;
	return jsonError(c, 400, message, {
		code: 'sensitive_passphrase_rejected',
		fields,
	});
}

function markdownToPlainProjectSummary(markdown, fallback = null) {
	const text = String(markdown ?? '')
		.replace(/^---[\s\S]*?---/u, ' ')
		.replace(/```[\s\S]*?```/gu, ' ')
		.replace(/`([^`]+)`/gu, '$1')
		.replace(/!\[[^\]]*\]\([^)]+\)/gu, ' ')
		.replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
		.replace(/^#{1,6}\s+/gmu, '')
		.replace(/^\s*[-*+]\s+/gmu, '')
		.replace(/^\s*\d+\.\s+/gmu, '')
		.replace(/[*_~>#]/gu, '')
		.replace(/\s+/gu, ' ')
		.trim();
	if (!text) return fallback;
	return text.length > 240 ? `${text.slice(0, 237).trimEnd()}...` : text;
}

function parseBooleanEnvValue(value) {
	const normalized = String(value ?? '').trim().toLowerCase();
	if (!normalized) return null;
	if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
	if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
	return null;
}

function shouldLogApiRequests(config, options = {}) {
	if (typeof options.logRequests === 'boolean') return options.logRequests;
	const explicit = parseBooleanEnvValue(process.env.TREESEED_MARKET_API_REQUEST_LOGS ?? process.env.TREESEED_API_REQUEST_LOGS);
	if (explicit != null) return explicit;
	if (process.env.NODE_ENV === 'test') return false;
	const environment = String(config?.environment ?? process.env.TREESEED_API_ENVIRONMENT ?? process.env.TREESEED_ENVIRONMENT ?? '').trim();
	return environment === 'local';
}

function shouldExposeNonProductionAuthDiagnostics(c, runtime) {
	const environment = String(runtime?.resolved?.config?.environment ?? process.env.TREESEED_API_ENVIRONMENT ?? process.env.TREESEED_ENVIRONMENT ?? '').trim().toLowerCase();
	if (environment && !['prod', 'production'].includes(environment)) return true;
	try {
		const host = new URL(c.req.url).hostname.toLowerCase();
		return host.includes('staging') || host.endsWith('.localhost') || host === 'localhost' || host === '127.0.0.1' || host === '::1';
	} catch {
		return false;
	}
}

const SENSITIVE_QUERY_PARAM_PATTERN = /(?:token|secret|password|credential|assertion|signature|api[_-]?key|access[_-]?key|private[_-]?key|code)/iu;

function redactedRequestTarget(requestUrl) {
	const url = new URL(requestUrl);
	const query = [...url.searchParams.entries()]
		.map(([key, value]) => {
			const safeValue = SENSITIVE_QUERY_PARAM_PATTERN.test(key) ? '[redacted]' : encodeURIComponent(value);
			return `${encodeURIComponent(key)}=${safeValue}`;
		})
		.join('&');
	return `${url.pathname}${query ? `?${query}` : ''}`;
}

function installApiRequestLogger(app) {
	app.use('*', async (c, next) => {
		const startedAt = Date.now();
		const method = c.req.method;
		const target = redactedRequestTarget(c.req.url);
		try {
			await next();
		} finally {
			const elapsedMs = Date.now() - startedAt;
			const status = c.res?.status ?? 500;
			process.stdout.write(`[api] ${method} ${target} -> ${status} ${elapsedMs}ms\n`);
		}
	});
}

const AGENT_PROMOTION_APPROVAL_DECISIONS = new Set([
	'approve',
	'approve_as_book_content',
	'request_changes',
	'request_more_research',
	'defer',
	'reject',
	'approve_release',
	'reject_release',
]);

async function readJsonOrFormBody(c) {
	const contentType = c.req.header('content-type') ?? '';
	if (contentType.includes('application/json')) {
		const json = await c.req.json().catch(() => null);
		if (json && typeof json === 'object' && !Array.isArray(json)) {
			return json;
		}
	}
	const form = await c.req.parseBody?.().catch(() => ({}));
	if (!form || typeof form !== 'object') {
		return {};
	}
	return Object.fromEntries(
		Object.entries(form).map(([key, value]) => [key, typeof value === 'string' ? value : String(value ?? '')]),
	);
}

function normalizeEmail(value) {
	return String(value ?? '').trim().toLowerCase();
}

function normalizeUsername(value) {
	return String(value ?? '').trim().toLowerCase();
}

function parseJsonObject(value, fallback = {}) {
	if (!value) return fallback;
	try {
		const parsed = JSON.parse(String(value));
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
	} catch {
		return fallback;
	}
}

function trimmedHeaderValue(c, name) {
	const value = c.req.header(name);
	return typeof value === 'string' ? value.trim() : '';
}

function requestClientIp(c) {
	const forwardedFor = trimmedHeaderValue(c, 'x-forwarded-for')
		.split(',')
		.map((part) => part.trim())
		.find(Boolean);
	return (
		trimmedHeaderValue(c, 'cf-connecting-ip')
		|| trimmedHeaderValue(c, 'true-client-ip')
		|| trimmedHeaderValue(c, 'x-real-ip')
		|| trimmedHeaderValue(c, 'x-treeseed-client-ip')
		|| forwardedFor
		|| null
	);
}

function requestSessionMetadata(c) {
	const userAgent = trimmedHeaderValue(c, 'user-agent');
	const ipAddress = requestClientIp(c);
	return {
		ipAddress: ipAddress ? ipAddress.slice(0, 128) : null,
		userAgent: userAgent ? userAgent.slice(0, 512) : null,
	};
}

function webSessionData(c, source) {
	return {
		source,
		...requestSessionMetadata(c),
	};
}

function validateMarketPassword(value) {
	return typeof value === 'string' && value.length >= 12;
}

function hashMarketPassword(password) {
	const salt = randomBytes(16).toString('base64url');
	const iterations = 210000;
	const digest = pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('base64url');
	return `pbkdf2-sha256$${iterations}$${salt}$${digest}`;
}

function verifyMarketPassword(password, envelope) {
	const [algorithm, iterationsValue, salt, expected] = String(envelope ?? '').split('$');
	if (algorithm !== 'pbkdf2-sha256' || !iterationsValue || !salt || !expected) return false;
	const iterations = Number(iterationsValue);
	if (!Number.isFinite(iterations) || iterations <= 0) return false;
	const actual = pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('base64url');
	const left = Buffer.from(actual);
	const right = Buffer.from(expected);
	return left.length === right.length && timingSafeEqual(left, right);
}

async function ensureMarketCredentialSchema(store) {
	await store.ensureInitialized();
	await backfillUserEmailAddresses(store);
}

const MARKET_EMAIL_CONFIRMATION_PREFIX = 'market_email_confirmation:';

function marketAuthContext(c) {
	return {
		locals: {
			runtime: {
				env: {
					...process.env,
					...(c.env ?? {}),
				},
			},
		},
		url: new URL(c.req.url),
	};
}

function shouldBypassAcceptanceAuthEmailDelivery(c, config) {
	const serviceId = c.req.header('x-treeseed-service-id') ?? '';
	const serviceSecret = c.req.header('x-treeseed-service-secret') ?? '';
	return c.req.header('x-treeseed-acceptance-email-bypass') === '1'
		&& Boolean(config.webServiceId && config.webServiceSecret)
		&& serviceId === config.webServiceId
		&& serviceSecret === config.webServiceSecret;
}

function marketEmailTokenHash(token) {
	return createHash('sha256').update(String(token)).digest('hex');
}

function exposeAuthTokenForTests(c = null, config = {}) {
	return process.env.NODE_ENV === 'test'
		|| process.env.TREESEED_ACCEPTANCE_EXPOSE_AUTH_TOKENS === '1'
		|| (c ? shouldBypassAcceptanceAuthEmailDelivery(c, config) : false);
}

function authTokenTimestampSeconds(value = Date.now()) {
	return Math.floor(Number(value) / 1000);
}

function authTokenTimestampMillis(value) {
	const number = Number(value ?? 0);
	if (!Number.isFinite(number) || number <= 0) return 0;
	return number < 10_000_000_000 ? number * 1000 : number;
}

function sanitizedReturnTo(value) {
	const target = String(value ?? '/app/');
	return target.startsWith('/') && !target.startsWith('//') ? target : '/app/';
}

function confirmationUrlFor(context, token, returnTo) {
	const authConfig = getSiteAuthConfig(context);
	const target = new URL('/auth/confirm-email', `${authConfig.siteBaseUrl.replace(/\/+$/u, '')}/`);
	target.searchParams.set('token', token);
	target.searchParams.set('returnTo', sanitizedReturnTo(returnTo));
	return target.toString();
}

function teamInviteAcceptUrlFor(context, token) {
	const authConfig = getSiteAuthConfig(context);
	return new URL(`/team-invites/${encodeURIComponent(token)}/accept`, `${authConfig.siteBaseUrl.replace(/\/+$/u, '')}/`).toString();
}

async function sendTeamInviteEmail(context, input) {
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

async function createMarketEmailConfirmation(store, context, input) {
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
		await store.run(
			`INSERT INTO better_auth_verification (id, identifier, value, "expiresAt", "createdAt", "updatedAt")
			 VALUES (?, ?, ?, ?, ?, ?)`,
			verificationValues,
		);
	} catch (error) {
		await store.run(
			`INSERT INTO better_auth_verification (id, identifier, value, expiresat, createdat, updatedat)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			verificationValues,
		).catch(() => {
			throw error;
		});
	}
	if (input.emailAddressId) {
		await store.run(
			`UPDATE user_email_addresses SET verification_requested_at = ?, updated_at = ? WHERE id = ?`,
			[new Date(now).toISOString(), new Date(now).toISOString(), input.emailAddressId],
		).catch(() => null);
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

function serializeUserEmailAddress(row) {
	if (!row) return null;
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

async function backfillUserEmailAddresses(store) {
	const now = new Date().toISOString();
	await store.run(
		`INSERT INTO user_email_addresses (
			id, user_id, email, normalized_email, status, is_primary, verification_requested_at, verified_at, created_at, updated_at
		)
		SELECT 'email_' || md5(user_id || ':' || LOWER(email)), user_id, email, LOWER(email), 'verified', 1, created_at, COALESCE(updated_at, created_at), created_at, updated_at
		  FROM market_auth_credentials
		 WHERE email IS NOT NULL
		   AND email != ''
		   AND status = 'active'
		ON CONFLICT (normalized_email) DO NOTHING`,
	).catch(() => null);
	await store.run(
		`UPDATE user_email_addresses
		    SET updated_at = ?
		  WHERE is_primary = 1
		    AND status != 'verified'`,
		[now],
	).catch(() => null);
}

async function listUserEmailAddresses(store, userId) {
	await backfillUserEmailAddresses(store);
	const rows = await store.all(
		`SELECT * FROM user_email_addresses
		 WHERE user_id = ?
		 ORDER BY is_primary DESC, status DESC, verified_at ASC, created_at ASC`,
		[userId],
	).catch(() => []);
	return rows.map(serializeUserEmailAddress);
}

async function getUserEmailAddress(store, userId, emailId) {
	await backfillUserEmailAddresses(store);
	const row = await store.first(
		`SELECT * FROM user_email_addresses WHERE id = ? AND user_id = ? LIMIT 1`,
		[emailId, userId],
	);
	return row ?? null;
}

async function verifiedEmailCount(store, userId) {
	const row = await store.first(
		`SELECT COUNT(*) AS count FROM user_email_addresses WHERE user_id = ? AND status = 'verified'`,
		[userId],
	);
	return Number(row?.count ?? 0);
}

async function setPrimaryEmailAddress(store, userId, emailId) {
	const email = await getUserEmailAddress(store, userId, emailId);
	if (!email) return { ok: false, status: 404, error: 'Email address was not found.' };
	if (email.status !== 'verified') return { ok: false, status: 409, error: 'Email must be verified before it can be primary.' };
	const now = new Date().toISOString();
	await store.run(`UPDATE user_email_addresses SET is_primary = 0, updated_at = ? WHERE user_id = ?`, [now, userId]);
	await store.run(`UPDATE user_email_addresses SET is_primary = 1, updated_at = ? WHERE id = ? AND user_id = ?`, [now, emailId, userId]);
	await syncPrimaryEmailCaches(store, userId);
	return { ok: true, emailAddress: serializeUserEmailAddress(await getUserEmailAddress(store, userId, emailId)) };
}

async function syncPrimaryEmailCaches(store, userId) {
	const primary = await store.first(
		`SELECT * FROM user_email_addresses
		 WHERE user_id = ? AND status = 'verified'
		 ORDER BY is_primary DESC, verified_at ASC, created_at ASC
		 LIMIT 1`,
		[userId],
	);
	if (!primary?.id) return null;
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

async function createOrResendUserEmailAddress(store, context, userId, input) {
	const email = normalizeEmail(input.email);
	if (!email || !email.includes('@')) return { ok: false, status: 400, error: 'A valid email is required.' };
	const now = new Date().toISOString();
	const existing = await store.first(
		`SELECT * FROM user_email_addresses WHERE normalized_email = ? LIMIT 1`,
		[email],
	);
	if (existing?.id && existing.user_id !== userId) {
		return { ok: false, status: 409, error: 'Email is already in use.' };
	}
	let row = existing;
	if (!row?.id) {
		const id = randomUUID();
		const primary = (await verifiedEmailCount(store, userId)) === 0 ? 1 : 0;
		await store.run(
			`INSERT INTO user_email_addresses (
				id, user_id, email, normalized_email, status, is_primary, verification_requested_at, verified_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, ?)`,
			[id, userId, email, email, primary, now, now],
		);
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

async function createMarketWebSession(marketAuthProvider, userId, data = {}, options = {}) {
	if (typeof marketAuthProvider.issueUserSession === 'function') {
		return marketAuthProvider.issueUserSession(userId, {
			sessionType: 'web',
			data,
		});
	}
	const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
	const token = await marketAuthProvider.createPersonalAccessToken(userId, {
		name: 'Treeseed web session',
		scopes: ['auth:me'],
		expiresAt,
	});
	const authenticated = await marketAuthProvider.authenticateBearerToken(token.token);
	const sessionId = randomUUID();
	const now = new Date().toISOString();
	if (options.store?.run) {
		await options.store.run(
			`INSERT INTO auth_sessions (id, user_id, session_type, refresh_token_hash, scopes_json, expires_at, revoked_at, data_json, created_at, updated_at)
			 VALUES (?, ?, 'web', ?, ?, ?, NULL, ?, ?, ?)`,
			[
				sessionId,
				userId,
				createHash('sha256').update(`${options.authSecret ?? 'market'}:${sessionId}`).digest('hex'),
				JSON.stringify(['auth:me']),
				expiresAt,
				JSON.stringify({ ...data, tokenId: token.id }),
				now,
				now,
			],
		).catch(() => null);
	}
	return {
		ok: true,
		status: 'approved',
		accessToken: token.token,
		refreshToken: null,
		tokenType: 'Bearer',
		expiresAt,
		expiresInSeconds: 15 * 60,
		principal: authenticated?.principal ?? { id: userId, type: 'user', roles: [], scopes: ['auth:me'], metadata: { sessionId } },
	};
}

function webAuthPayload(session) {
	return {
		accessToken: session.accessToken,
		refreshToken: session.refreshToken,
		tokenType: session.tokenType,
		expiresAt: session.expiresAt,
		expiresInSeconds: session.expiresInSeconds,
		principal: session.principal,
	};
}

function normalizeAppearancePreference(input = {}) {
	const scheme = optionalTrimmedString(input.colorScheme ?? input.scheme) ?? 'fern';
	const mode = optionalTrimmedString(input.themeMode ?? input.mode) ?? 'system';
	return {
		scheme,
		mode: ['light', 'dark', 'system'].includes(mode) ? mode : 'system',
	};
}

function bearerTokenFromRequest(request) {
	const header = request.headers.get('authorization');
	if (!header) return null;
	const match = header.match(/^Bearer\s+(.+)$/i);
	return match?.[1] ?? null;
}

function normalizeBaseUrl(baseUrl) {
	return String(baseUrl ?? '').trim().replace(/\/+$/u, '');
}

const treeDxProxyTokenCache = new Map();
const TREE_DX_WORKSPACE_CREATE_CAPABILITY = ['workspace', 'create'].join(':');

function withCapacityProviderRuntimeIdentity(env, { marketUrl, providerId, teamId }) {
	return {
		...env,
		TREESEED_MANAGEMENT_API_URL: env.TREESEED_MANAGEMENT_API_URL ?? marketUrl ?? 'https://api.treeseed.ai',
		TREESEED_CAPACITY_PROVIDER_ID: env.TREESEED_CAPACITY_PROVIDER_ID ?? providerId,
		TREESEED_CAPACITY_PROVIDER_TEAM_ID: env.TREESEED_CAPACITY_PROVIDER_TEAM_ID ?? teamId,
	};
}

function normalizeDomainName(value) {
	const domain = String(value ?? '')
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\//u, '')
		.replace(/\/.*$/u, '')
		.replace(/\.$/u, '');
	if (!domain) return null;
	if (domain.length > 253 || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9]?))*$/u.test(domain)) {
		return null;
	}
	return domain.includes('.') ? domain : null;
}

function normalizeProjectDomainInput(value) {
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

function inferZoneNameForDomain(domain, fallbackZoneName = null) {
	if (!domain) return fallbackZoneName;
	if (fallbackZoneName && (domain === fallbackZoneName || domain.endsWith(`.${fallbackZoneName}`))) return fallbackZoneName;
	const parts = domain.split('.');
	return parts.length >= 2 ? parts.slice(-2).join('.') : fallbackZoneName;
}

function domainInZone(domain, zoneName) {
	return Boolean(domain && zoneName && (domain === zoneName || domain.endsWith(`.${zoneName}`)));
}

function optionalTrimmedString(value) {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function enumValue(value, allowed, fallback = null) {
	const candidate = typeof value === 'string' ? value.trim() : '';
	return allowed.includes(candidate) ? candidate : fallback;
}

function unknownKeys(body, allowed) {
	const allow = new Set(allowed);
	return Object.keys(body && typeof body === 'object' && !Array.isArray(body) ? body : {})
		.filter((key) => !allow.has(key));
}

const LOCAL_CONTENT_COLLECTIONS = new Set(['objectives', 'questions', 'notes', 'proposals', 'decisions', 'agents']);
const LOCAL_WORK_CONTENT_COLLECTIONS = new Set(['objectives', 'questions', 'notes', 'proposals', 'decisions']);
const LOCAL_DECISION_TYPE_VALUES = ['approved', 'rejected', 'deferred', 'request_changes', 'superseded'];
const PROPOSAL_VERDICT_DECISION_TYPES = new Set(['approved', 'rejected', 'deferred', 'request_changes']);
const PLATFORM_OPERATION_SCOPES = [
	'platform:runners:register',
	'platform:runners:claim',
	'platform:runners:update',
	'platform:operations:create',
	'platform:operations:read',
	'platform:operations:cancel',
	'platform:operations:retry',
	'platform:repository:write',
	'platform:deploy:write',
	'platform:database:migrate',
];
const LOCAL_CONTENT_DEFAULTS = {
	objectives: {
		idPrefix: 'objective',
		extension: 'mdx',
		fields: { timeHorizon: 'near-term', motivation: '', primaryContributor: 'market-steward', relatedQuestions: [], relatedBooks: [] },
		body: 'Describe the objective, expected outcome, and the evidence that should update it over time.',
	},
	questions: {
		idPrefix: 'question',
		extension: 'mdx',
		fields: { questionType: 'strategy', motivation: '', primaryContributor: 'market-steward', relatedObjectives: [], relatedBooks: [] },
		body: 'Describe what needs to be learned and what evidence would make the answer useful.',
	},
	notes: {
		idPrefix: 'note',
		extension: 'mdx',
		fields: { author: 'market-steward', relatedObjectives: [], relatedQuestions: [], relatedProposals: [], relatedBooks: [] },
		body: 'Capture the useful context, evidence, and follow-up links for this note.',
	},
	proposals: {
		idPrefix: 'proposal',
		extension: 'mdx',
		fields: { proposalType: 'implementation', motivation: '', primaryContributor: 'market-steward', relatedObjectives: [], relatedQuestions: [], relatedNotes: [], relatedBooks: [], decision: '', supersedes: [] },
		body: 'Describe the proposed change, why it matters, what it affects, and how a reviewer should evaluate it.',
	},
	decisions: {
		idPrefix: 'decision',
		extension: 'mdx',
		fields: { decisionType: 'approved', rationale: '', authority: 'TreeSeed Treeseed Team', primaryContributor: 'market-steward', relatedObjectives: [], relatedQuestions: [], relatedNotes: [], relatedProposals: [], relatedBooks: [], supersedes: [], implements: [] },
		body: 'Record what was decided, why it was decided, and which proposals or evidence it closes.',
	},
	agents: {
		idPrefix: 'agent',
		extension: 'mdx',
		fields: {
			name: '',
			handler: 'planner',
			enabled: true,
			operator: 'TreeSeed platform',
			runtimeStatus: 'active',
			capabilities: [],
			tags: ['agent'],
			systemPrompt: 'Use the core objective as the first context message. Keep work observable, governed, and grounded in project content.',
			persona: 'Helpful, careful, and accountable.',
			triggers: [{ type: 'message', messageTypes: [] }],
			permissions: [],
			execution: { provider: 'codex', model: 'gpt-5.5', approvalPolicy: 'never', sandboxMode: 'read_only', reasoningEffort: 'medium' },
			outputs: {},
		},
		body: 'Describe this agent role, operating boundaries, and expected outputs.',
	},
};

function slugifyContent(value) {
	return String(value ?? '')
		.toLowerCase()
		.trim()
		.replace(/['"]/gu, '')
		.replace(/[^a-z0-9]+/gu, '-')
		.replace(/^-+|-+$/gu, '')
		.slice(0, 96);
}

function yamlScalar(value) {
	const text = String(value ?? '');
	if (/^[a-zA-Z0-9_:/.-]+$/u.test(text) && !['true', 'false', 'null'].includes(text.toLowerCase())) {
		return text;
	}
	return JSON.stringify(text);
}

function yamlLines(value, indent = 0) {
	const pad = ' '.repeat(indent);
	if (Array.isArray(value)) {
		if (value.length === 0) return [`${pad}[]`];
		return value.flatMap((entry) => {
			if (entry && typeof entry === 'object') {
				return [``, ...yamlLines(entry, indent + 2)].map((line, index) => index === 0 ? `${pad}-` : line);
			}
			return [`${pad}- ${yamlScalar(entry)}`];
		});
	}
	if (value && typeof value === 'object') {
		return Object.entries(value).flatMap(([key, entry]) => {
			if (Array.isArray(entry) || (entry && typeof entry === 'object')) {
				return [`${pad}${key}:`, ...yamlLines(entry, indent + 2)];
			}
			return [`${pad}${key}: ${yamlScalar(entry)}`];
		});
	}
	return [`${pad}${yamlScalar(value)}`];
}

function serializeFrontmatter(data) {
	const lines = ['---'];
	for (const [key, value] of Object.entries(data)) {
		if (Array.isArray(value) || (value && typeof value === 'object')) {
			const nested = yamlLines(value, 2);
			lines.push(`${key}:`);
			lines.push(...nested);
		} else {
			lines.push(`${key}: ${yamlScalar(value)}`);
		}
	}
	lines.push('---');
	return lines.join('\n');
}

function normalizeRelationArray(value) {
	if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
	if (typeof value === 'string') return value.split(/[\n,]/u).map((entry) => entry.trim()).filter(Boolean);
	return [];
}

function uniqueRelationArray(value) {
	return [...new Set(normalizeRelationArray(value))];
}

function addRelationValue(frontmatter, field, value, single = false) {
	const ref = String(value ?? '').trim();
	if (!field || !ref) return;
	if (single) {
		frontmatter[field] = ref;
		return;
	}
	frontmatter[field] = uniqueRelationArray([...(normalizeRelationArray(frontmatter[field])), ref]);
}

function normalizeLocalContentInput(collection, body) {
	const defaults = LOCAL_CONTENT_DEFAULTS[collection];
	const title = optionalTrimmedString(body.title);
	if (!title) return { error: 'title is required.' };
	const slug = slugifyContent(body.slug || title);
	if (!slug) return { error: 'A safe slug is required.' };
	const today = new Date().toISOString().slice(0, 10);
	const summary = optionalTrimmedString(body.summary) ?? optionalTrimmedString(body.description) ?? title;
	const description = optionalTrimmedString(body.description) ?? summary;
	const frontmatter = {
		id: optionalTrimmedString(body.id) ?? `${defaults.idPrefix}:${slug}`,
		title,
		description,
		date: optionalTrimmedString(body.date) ?? today,
		summary,
		status: enumValue(body.status, ['recorded', 'live', 'in progress', 'exploratory', 'planned', 'speculative'], 'planned'),
		...defaults.fields,
	};
	if (collection === 'agents') {
		frontmatter.name = optionalTrimmedString(body.name) ?? title;
		frontmatter.slug = slug;
		frontmatter.description = description;
		frontmatter.summary = summary;
		frontmatter.handler = optionalTrimmedString(body.handler) ?? frontmatter.handler;
		frontmatter.systemPrompt = optionalTrimmedString(body.systemPrompt) ?? frontmatter.systemPrompt;
		frontmatter.runtimeStatus = enumValue(body.runtimeStatus, ['active', 'experimental', 'dormant'], frontmatter.runtimeStatus);
		delete frontmatter.date;
		delete frontmatter.status;
	} else if (collection === 'notes') {
		frontmatter.author = optionalTrimmedString(body.author) ?? frontmatter.author;
		frontmatter.relatedObjectives = normalizeRelationArray(body.relatedObjectives);
		frontmatter.relatedQuestions = normalizeRelationArray(body.relatedQuestions);
		frontmatter.relatedProposals = normalizeRelationArray(body.relatedProposals);
	} else if (collection === 'objectives') {
		frontmatter.primaryContributor = optionalTrimmedString(body.primaryContributor) ?? frontmatter.primaryContributor;
		frontmatter.timeHorizon = enumValue(body.timeHorizon, ['near-term', 'mid-term', 'long-term'], frontmatter.timeHorizon);
		frontmatter.motivation = optionalTrimmedString(body.motivation) ?? description;
		frontmatter.relatedQuestions = normalizeRelationArray(body.relatedQuestions);
	} else if (collection === 'questions') {
		frontmatter.primaryContributor = optionalTrimmedString(body.primaryContributor) ?? frontmatter.primaryContributor;
		frontmatter.questionType = enumValue(body.questionType, ['research', 'implementation', 'strategy', 'evaluation'], frontmatter.questionType);
		frontmatter.motivation = optionalTrimmedString(body.motivation) ?? description;
		frontmatter.relatedObjectives = normalizeRelationArray(body.relatedObjectives);
	} else if (collection === 'proposals') {
		frontmatter.primaryContributor = optionalTrimmedString(body.primaryContributor) ?? frontmatter.primaryContributor;
		frontmatter.proposalType = enumValue(body.proposalType, ['strategy', 'policy', 'implementation', 'research'], frontmatter.proposalType);
		frontmatter.motivation = optionalTrimmedString(body.motivation) ?? description;
		frontmatter.relatedObjectives = normalizeRelationArray(body.relatedObjectives);
		frontmatter.relatedQuestions = normalizeRelationArray(body.relatedQuestions);
		frontmatter.relatedNotes = normalizeRelationArray(body.relatedNotes);
		frontmatter.decision = optionalTrimmedString(body.decision) ?? undefined;
	} else if (collection === 'decisions') {
		frontmatter.primaryContributor = optionalTrimmedString(body.primaryContributor) ?? frontmatter.primaryContributor;
		frontmatter.decisionType = enumValue(body.decisionType, LOCAL_DECISION_TYPE_VALUES, frontmatter.decisionType);
		frontmatter.rationale = optionalTrimmedString(body.rationale) ?? description;
		frontmatter.authority = optionalTrimmedString(body.authority) ?? frontmatter.authority;
		frontmatter.relatedObjectives = normalizeRelationArray(body.relatedObjectives);
		frontmatter.relatedQuestions = normalizeRelationArray(body.relatedQuestions);
		frontmatter.relatedNotes = normalizeRelationArray(body.relatedNotes);
		frontmatter.relatedProposals = normalizeRelationArray(body.relatedProposals);
	}
	return {
		slug,
		extension: defaults.extension,
		frontmatter: Object.fromEntries(Object.entries(frontmatter).filter(([, value]) => value !== undefined)),
		body: optionalTrimmedString(body.body) ?? defaults.body,
	};
}

async function writeLocalContentRecord(collection, input) {
	if (!LOCAL_CONTENT_COLLECTIONS.has(collection)) {
		return { error: 'Unsupported content collection.' };
	}
	const normalized = normalizeLocalContentInput(collection, input);
	if (normalized.error) return normalized;
	const root = resolve(process.cwd(), 'src', 'content', collection);
	const existingTarget = input.overwrite === true
		? [`${normalized.slug}.mdx`, `${normalized.slug}.md`]
			.map((file) => resolve(root, file))
			.find((candidate) => existsSync(candidate))
		: null;
	const target = existingTarget ?? resolve(root, `${normalized.slug}.${normalized.extension}`);
	const relativeTarget = relative(root, target);
	if (relativeTarget.startsWith('..') || relativeTarget.includes('..') || relativeTarget.startsWith('/')) {
		return { error: 'Unsafe content path.' };
	}
	if (existsSync(target) && input.overwrite !== true) {
		return { error: 'A content record with that slug already exists.' };
	}
	await mkdir(root, { recursive: true });
	const content = `${serializeFrontmatter(normalized.frontmatter)}\n\n${normalized.body.trim()}\n`;
	await writeFile(target, content, 'utf8');
	return {
		collection,
		slug: normalized.slug,
		id: normalized.frontmatter.id,
		path: relative(process.cwd(), target),
		href: collection === 'agents'
			? `/app/projects/${encodeURIComponent(String(input.projectId ?? ''))}/agents/${encodeURIComponent(normalized.slug)}`
			: `/app/work/${collection}/${encodeURIComponent(normalized.slug)}`,
	};
}

function localContentRoot(collection) {
	return resolve(process.cwd(), 'src', 'content', collection);
}

function localContentPath(collection, slug, extension = null) {
	const root = localContentRoot(collection);
	const safeSlug = slugifyContent(slug);
	if (!safeSlug || safeSlug !== String(slug ?? '').trim()) return null;
	const candidates = extension
		? [resolve(root, `${safeSlug}.${extension}`)]
		: ['mdx', 'md'].map((ext) => resolve(root, `${safeSlug}.${ext}`));
	const target = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
	const relativeTarget = relative(root, target);
	if (relativeTarget.startsWith('..') || relativeTarget.includes('..') || relativeTarget.startsWith('/')) return null;
	return target;
}

async function readLocalContentRecord(collection, slug) {
	if (!LOCAL_WORK_CONTENT_COLLECTIONS.has(collection)) return { error: 'Unsupported content collection.' };
	const safeSlug = slugifyContent(slug);
	if (!safeSlug || safeSlug !== String(slug ?? '').trim()) return { error: 'Unsafe content slug.' };
	const target = localContentPath(collection, safeSlug);
	if (!target || !existsSync(target)) return { error: 'Parent content record was not found.' };
	const raw = await readFile(target, 'utf8');
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u);
	if (!match) return { error: 'Content record is missing frontmatter.' };
	const frontmatter = parseYaml(match[1]) ?? {};
	if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
		return { error: 'Content frontmatter could not be parsed.' };
	}
	return {
		path: target,
		slug: safeSlug,
		extension: target.endsWith('.md') ? 'md' : 'mdx',
		frontmatter,
		body: match[2] ?? '',
	};
}

async function writeParsedLocalContentRecord(record) {
	const content = `${serializeFrontmatter(record.frontmatter)}\n\n${String(record.body ?? '').trim()}\n`;
	await writeFile(record.path, content, 'utf8');
}

export async function createRelatedLocalContentRecord(parentCollection, parentSlug, targetCollection, input) {
	if (!LOCAL_WORK_CONTENT_COLLECTIONS.has(parentCollection) || !LOCAL_WORK_CONTENT_COLLECTIONS.has(targetCollection)) {
		return { error: 'Unsupported content relation collection.' };
	}
	const policy = contentRelationPolicy(parentCollection, targetCollection);
	if (!policy) return { error: `Cannot create related ${targetCollection} from ${parentCollection}.` };
	const parent = await readLocalContentRecord(parentCollection, parentSlug);
	if (parent.error) return parent;
	const normalized = normalizeLocalContentInput(targetCollection, input);
	if (normalized.error) return normalized;
	const childTarget = localContentPath(targetCollection, normalized.slug, normalized.extension);
	if (!childTarget) return { error: 'Unsafe content path.' };
	if (existsSync(childTarget)) return { error: 'A content record with that slug already exists.' };

	addRelationValue(parent.frontmatter, policy.sourceField, normalized.slug, policy.sourceSingle);
	addRelationValue(normalized.frontmatter, policy.targetField, parent.slug, policy.targetSingle);

	await mkdir(localContentRoot(targetCollection), { recursive: true });
	const childRecord = {
		path: childTarget,
		frontmatter: normalized.frontmatter,
		body: normalized.body,
	};
	await writeParsedLocalContentRecord(childRecord);
	try {
		await writeParsedLocalContentRecord(parent);
	} catch (error) {
		await rm(childTarget, { force: true }).catch(() => {});
		return {
			error: 'Related content could not be linked to the parent record.',
			details: error instanceof Error ? error.message : String(error),
		};
	}
	return {
		parent: {
			collection: parentCollection,
			slug: parent.slug,
			path: relative(process.cwd(), parent.path),
			href: `/app/work/${parentCollection}/${encodeURIComponent(parent.slug)}`,
		},
		child: {
			collection: targetCollection,
			slug: normalized.slug,
			id: normalized.frontmatter.id,
			path: relative(process.cwd(), childTarget),
			href: `/app/work/${targetCollection}/${encodeURIComponent(normalized.slug)}`,
		},
		relation: {
			parentField: policy.sourceField,
			childField: policy.targetField,
		},
	};
}

export async function createDecisionFromProposals(input) {
	const proposalSlugs = [...new Set(normalizeRelationArray(input.proposalSlugs))];
	if (proposalSlugs.length === 0) return { error: 'Select at least one proposal.' };
	for (const slug of proposalSlugs) {
		if (!slug || slugifyContent(slug) !== slug) return { error: 'Unsafe proposal slug.' };
	}
	const decisionType = enumValue(input.decisionType, [...PROPOSAL_VERDICT_DECISION_TYPES], null);
	if (!decisionType) return { error: 'Unsupported proposal verdict.' };
	const reason = optionalTrimmedString(input.reason) ?? optionalTrimmedString(input.rationale);
	if (!reason) return { error: 'A decision reason is required.' };
	const title = optionalTrimmedString(input.title) ?? `Decision for ${proposalSlugs.length === 1 ? proposalSlugs[0] : `${proposalSlugs.length} proposals`}`;
	const decisionSlug = slugifyContent(input.slug || title);
	if (!decisionSlug) return { error: 'A safe decision slug is required.' };
	const decisionTarget = localContentPath('decisions', decisionSlug, 'mdx');
	if (!decisionTarget) return { error: 'Unsafe decision path.' };
	if (existsSync(decisionTarget)) return { error: 'A decision with that slug already exists.' };

	const proposals = [];
	for (const slug of proposalSlugs) {
		const proposal = await readLocalContentRecord('proposals', slug);
		if (proposal.error) return { error: `Proposal ${slug} was not found.` };
		proposals.push(proposal);
	}

	const proposalTitles = proposals.map((proposal) => proposal.frontmatter.title ?? proposal.slug);
	const body = optionalTrimmedString(input.body)
		?? [
			`## Verdict`,
			decisionType.replace(/_/gu, ' '),
			``,
			`## Reason`,
			reason,
			``,
			`## Proposals`,
			...proposalTitles.map((proposalTitle, index) => `- ${proposalTitle} (${proposalSlugs[index]})`),
		].join('\n');
	const decisionPayload = await writeLocalContentRecord('decisions', {
		...input,
		slug: decisionSlug,
		title,
		status: 'live',
		decisionType,
		description: optionalTrimmedString(input.description) ?? reason,
		summary: optionalTrimmedString(input.summary) ?? reason,
		rationale: reason,
		relatedProposals: proposalSlugs,
		body,
	});
	if (decisionPayload.error) return decisionPayload;

	const writtenProposals = [];
	const originalProposals = proposals.map((proposal) => ({
		...proposal,
		frontmatter: { ...proposal.frontmatter },
		body: proposal.body,
	}));
	try {
		for (const proposal of proposals) {
			proposal.frontmatter.decision = decisionSlug;
			await writeParsedLocalContentRecord(proposal);
			writtenProposals.push(proposal);
		}
	} catch (error) {
		await rm(decisionTarget, { force: true }).catch(() => {});
		for (const original of originalProposals.slice(0, writtenProposals.length)) {
			await writeParsedLocalContentRecord(original).catch(() => {});
		}
		return {
			error: 'Decision content was created but proposals could not be linked; changes were rolled back.',
			details: error instanceof Error ? error.message : String(error),
		};
	}

	return {
		decision: decisionPayload,
		proposals: proposalSlugs.map((slug) => ({ collection: 'proposals', slug, href: `/app/work/proposals/${encodeURIComponent(slug)}` })),
		href: decisionPayload.href,
	};
}

function isLoopbackUrl(value) {
	try {
		const url = new URL(value);
		return url.hostname === '127.0.0.1' || url.hostname === 'localhost';
	} catch {
		return false;
	}
}

function resolveAuthApprovalBaseUrl(config) {
	const baseUrl = normalizeBaseUrl(config.baseUrl);
	const configured = normalizeBaseUrl(config.authApprovalBaseUrl ?? config.siteUrl ?? '');
	const remoteApi = baseUrl && !isLoopbackUrl(baseUrl);
	if (configured) {
		if (remoteApi && isLoopbackUrl(configured)) {
			throw new Error(`Refusing loopback device approval URL "${configured}" for remote API "${baseUrl}".`);
		}
		return configured;
	}
	const environment = normalizeBaseUrl(process.env.TREESEED_SITE_URL ?? process.env.BETTER_AUTH_URL ?? '');
	if (remoteApi && environment && isLoopbackUrl(environment)) {
		throw new Error(`Refusing loopback device approval URL "${environment}" for remote API "${baseUrl}".`);
	}
	const candidate = environment || baseUrl;
	const normalized = normalizeBaseUrl(candidate);
	if (normalized === 'https://api.treeseed.ai') {
		return 'https://treeseed.ai';
	}
	return normalized || baseUrl;
}

function findById(items, id) {
	const key = String(id ?? '');
	return Array.isArray(items)
		? items.find((item) => String(item?.id ?? item?.taskId ?? item?.workDayId ?? item?.work_day_id ?? '') === key)
		: null;
}

function artifactSourceMap(artifact) {
	const frontmatter = artifact?.frontmatter && typeof artifact.frontmatter === 'object' ? artifact.frontmatter : {};
	return artifact?.sourceMap
		?? artifact?.source_map
		?? frontmatter.source_map
		?? artifact?.docsMutationResult?.sourceMap
		?? artifact?.promotionToStaging?.sourceMap
		?? [];
}

function artifactDiffFallback(artifact) {
	return {
		id: artifact?.id ?? artifact?.taskId ?? null,
		diff: artifact?.diff ?? artifact?.patch ?? null,
		changedPaths: Array.isArray(artifact?.changedPaths) ? artifact.changedPaths : [],
		snapshots: Array.isArray(artifact?.snapshots) ? artifact.snapshots : [],
		verification: artifact?.verification ?? null,
		verificationStatus: artifact?.verificationStatus ?? artifact?.docsMutationResult?.verificationStatus ?? null,
		repairTask: artifact?.repairTask ?? null,
		mergedToStaging: artifact?.mergedToStaging ?? null,
	};
}

async function collectControlPlaneGeneratedArtifacts(store, projectId) {
	const persisted = typeof store.collectControlPlaneGeneratedArtifacts === 'function'
		? await store.collectControlPlaneGeneratedArtifacts(projectId).catch(() => [])
		: [];
	if (persisted.length > 0) return persisted;
	const items = [];
	const jobs = await store.listRecentJobsForProject(projectId, 50).catch(() => []);
	for (const job of jobs) {
		const body = job?.output && typeof job.output === 'object' ? job.output : {};
		const generated = Array.isArray(body.generatedArtifacts) ? body.generatedArtifacts : [];
		for (const artifact of generated) {
			items.push({
				...artifact,
				taskId: artifact.taskId ?? job.id,
				workDayId: artifact.workDayId ?? body.workDayId ?? null,
				taskState: job.status ?? null,
				outputRef: artifact.outputRef ?? body.outputRef ?? null,
			});
		}
		if (body.artifactKind && generated.length === 0) {
			items.push({
				...body,
				id: body.id ?? `${job.id}:${body.artifactKind}`,
				taskId: job.id,
				workDayId: body.workDayId ?? null,
				taskState: job.status ?? null,
				outputRef: body.outputRef ?? null,
			});
		}
	}
	return items;
}

function resolveAgentArtifactBucket(runtime) {
	const env = runtime?.env && typeof runtime.env === 'object' ? runtime.env : {};
	const binding = String(
		env.TREESEED_AGENT_ARTIFACT_BUCKET_BINDING
		?? env.TREESEED_CONTENT_BUCKET_BINDING
		?? 'TREESEED_CONTENT_BUCKET',
	).trim();
	const candidates = [
		env.TREESEED_AGENT_ARTIFACT_BUCKET,
		binding ? env[binding] : null,
		env.TREESEED_CONTENT_BUCKET,
	];
	return candidates.find((candidate) => candidate && typeof candidate === 'object' && typeof candidate.put === 'function') ?? null;
}

function centralMarketProfile(baseUrl) {
	return {
		id: 'central',
		label: 'TreeSeed Central Market',
		baseUrl: normalizeBaseUrl(baseUrl),
		kind: 'central',
		alwaysAvailable: true,
	};
}

function normalizeMarketProfile(value, fallbackTeamId = null) {
	if (!value || typeof value !== 'object') {
		return null;
	}
	const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : null;
	const baseUrl = typeof value.baseUrl === 'string' && value.baseUrl.trim() ? normalizeBaseUrl(value.baseUrl) : null;
	if (!id || !baseUrl) {
		return null;
	}
	return {
		id,
		label: typeof value.label === 'string' && value.label.trim() ? value.label.trim() : id,
		baseUrl,
		kind: value.kind === 'central' ? 'central' : 'specialized',
		teamId: typeof value.teamId === 'string' && value.teamId.trim() ? value.teamId.trim() : fallbackTeamId,
		alwaysAvailable: value.alwaysAvailable === true || value.kind === 'central',
	};
}

function encryptedHostPayloadLooksValid(value) {
	return Boolean(
		value
		&& typeof value === 'object'
		&& typeof value.version === 'number'
		&& typeof value.algorithm === 'string'
		&& typeof value.kdf === 'object'
		&& typeof value.salt === 'string'
		&& typeof value.nonce === 'string'
		&& typeof value.ciphertext === 'string',
	);
}

function decryptedHostConfigSummary(value) {
	if (!value || typeof value !== 'object') {
		return { provided: false, keys: [] };
	}
	return {
		provided: true,
		keys: Object.keys(value).filter((key) => typeof key === 'string' && key.trim()).sort(),
	};
}

function credentialSessionSecret(runtime) {
	const configured = process.env.TREESEED_CREDENTIAL_SESSION_SECRET
		?? runtime?.resolved?.config?.credentialSessionSecret
		?? null;
	if (configured && String(configured).trim()) {
		return String(configured);
	}
	const runtimeConfig = runtime?.resolved?.config ?? {};
	const environment = String(runtimeConfig.environment ?? process.env.TREESEED_API_ENVIRONMENT ?? process.env.TREESEED_ENVIRONMENT ?? '').trim().toLowerCase();
	const localDatabase = isLoopbackUrl(runtimeConfig.apiDatabaseUrl ?? process.env.TREESEED_DATABASE_URL ?? '');
	const localBaseUrl = isLoopbackUrl(runtimeConfig.baseUrl ?? process.env.TREESEED_SITE_URL ?? process.env.BETTER_AUTH_URL ?? '');
	if (
		process.env.NODE_ENV === 'test'
		|| process.env.TREESEED_LOCAL_DEV_MODE
		|| environment === 'local'
		|| localDatabase
		|| localBaseUrl
	) {
		return 'treeseed-local-test-credential-session-secret';
	}
	throw new Error('TREESEED_CREDENTIAL_SESSION_SECRET is required for provider credential sessions.');
}

function credentialSessionKey(runtime) {
	return createHash('sha256').update(credentialSessionSecret(runtime)).digest();
}

function encryptCredentialSessionPayload(runtime, payload) {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', credentialSessionKey(runtime), iv);
	const plaintext = Buffer.from(JSON.stringify(payload ?? {}), 'utf8');
	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	return {
		version: 1,
		algorithm: 'aes-256-gcm',
		iv: iv.toString('base64url'),
		tag: cipher.getAuthTag().toString('base64url'),
		ciphertext: ciphertext.toString('base64url'),
	};
}

function decryptCredentialSessionPayload(runtime, envelope) {
	if (!envelope || typeof envelope !== 'object') {
		throw new Error('Credential session payload is missing.');
	}
	const decipher = createDecipheriv(
		'aes-256-gcm',
		credentialSessionKey(runtime),
		Buffer.from(String(envelope.iv ?? ''), 'base64url'),
	);
	decipher.setAuthTag(Buffer.from(String(envelope.tag ?? ''), 'base64url'));
	const plaintext = Buffer.concat([
		decipher.update(Buffer.from(String(envelope.ciphertext ?? ''), 'base64url')),
		decipher.final(),
	]);
	return JSON.parse(plaintext.toString('utf8'));
}

function normalizeProviderCredentialConfig(hostKind, config, host = null) {
	const source = config && typeof config === 'object' ? config : {};
	if (hostKind === 'repository_host') {
		const token = source.TREESEED_GITHUB_TOKEN ?? source.githubToken ?? source.token;
		if (!token || typeof token !== 'string') {
			throw new Error('Repository Host credentials must include TREESEED_GITHUB_TOKEN.');
		}
		return {
			TREESEED_GITHUB_TOKEN: token,
			GH_TOKEN: token,
			GITHUB_TOKEN: token,
			...(typeof source.owner === 'string' && source.owner.trim() ? { owner: source.owner.trim() } : {}),
			...(typeof source.organizationOrOwner === 'string' && source.organizationOrOwner.trim() ? { organizationOrOwner: source.organizationOrOwner.trim() } : {}),
		};
	}
	if (hostKind === 'email_host') {
		const smtp = host?.metadata?.smtp && typeof host.metadata.smtp === 'object' ? host.metadata.smtp : {};
		return {
			...(typeof smtp.host === 'string' && smtp.host.trim() ? { SMTP_HOST: smtp.host.trim() } : {}),
			...(typeof smtp.port === 'string' && smtp.port.trim() ? { SMTP_PORT: smtp.port.trim() } : {}),
			...(typeof source.SMTP_USERNAME === 'string' && source.SMTP_USERNAME.trim() ? { SMTP_USERNAME: source.SMTP_USERNAME } : {}),
			...(typeof source.SMTP_PASSWORD === 'string' && source.SMTP_PASSWORD ? { SMTP_PASSWORD: source.SMTP_PASSWORD } : {}),
			...(typeof smtp.fromEmail === 'string' && smtp.fromEmail.trim() ? { SMTP_FROM_EMAIL: smtp.fromEmail.trim() } : {}),
			...(typeof smtp.replyTo === 'string' && smtp.replyTo.trim() ? { SMTP_REPLY_TO: smtp.replyTo.trim() } : {}),
			...(typeof smtp.secure === 'string' && smtp.secure.trim() ? { SMTP_SECURE: smtp.secure.trim() } : {}),
		};
	}
	if (hostKind === 'web_host') {
		const token = source.TREESEED_CLOUDFLARE_API_TOKEN ?? source.cloudflareApiToken ?? source.apiToken ?? source.token;
		const accountId = source.TREESEED_CLOUDFLARE_ACCOUNT_ID ?? source.cloudflareAccountId ?? source.accountId;
		if (!token || typeof token !== 'string') {
			throw new Error('Web Host credentials must include TREESEED_CLOUDFLARE_API_TOKEN.');
		}
		if (!accountId || typeof accountId !== 'string') {
			throw new Error('Web Host credentials must include TREESEED_CLOUDFLARE_ACCOUNT_ID.');
		}
		return {
			TREESEED_CLOUDFLARE_API_TOKEN: token,
			TREESEED_CLOUDFLARE_ACCOUNT_ID: accountId,
			CLOUDFLARE_API_TOKEN: token,
			CLOUDFLARE_ACCOUNT_ID: accountId,
		};
	}
	return source;
}

const HOST_KIND_SESSION_KEYS = {
	repository: { sessionKey: 'repositoryHost', hostKind: 'repository_host' },
	web: { sessionKey: 'webHost', hostKind: 'web_host' },
	capacityProvider: { sessionKey: 'capacityProviderHost', hostKind: 'capacity_provider_host' },
	email: { sessionKey: 'emailHost', hostKind: 'email_host' },
};

function normalizeAuditHostKinds(value) {
	const allowed = new Set(['repository', 'web', 'email']);
	const raw = Array.isArray(value) && value.length > 0
		? value
		: ['repository', 'web', 'email'];
	return [...new Set(raw
		.map((entry) => String(entry ?? '').trim())
		.filter((entry) => allowed.has(entry)))];
}

function providerCredentialValuesForAudit(hostKind, payload) {
	const config = payload?.config && typeof payload.config === 'object' ? payload.config : {};
	if (hostKind === 'repository_host') {
		const token = config.TREESEED_GITHUB_TOKEN ?? config.token ?? null;
		const owner = config.organizationOrOwner ?? config.owner ?? null;
		return {
			...(typeof token === 'string' ? { TREESEED_GITHUB_TOKEN: token } : {}),
			...(typeof owner === 'string' ? {
				TREESEED_HOSTED_HUBS_GITHUB_OWNER: owner,
			} : {}),
		};
	}
	if (hostKind === 'web_host') {
		return {
			...(typeof config.TREESEED_CLOUDFLARE_API_TOKEN === 'string' ? { TREESEED_CLOUDFLARE_API_TOKEN: config.TREESEED_CLOUDFLARE_API_TOKEN } : {}),
			...(typeof config.TREESEED_CLOUDFLARE_ACCOUNT_ID === 'string' ? { TREESEED_CLOUDFLARE_ACCOUNT_ID: config.TREESEED_CLOUDFLARE_ACCOUNT_ID } : {}),
		};
	}
	if (hostKind === 'capacity_provider_host') {
		return {
			...(typeof config.TREESEED_RAILWAY_API_TOKEN === 'string' ? { TREESEED_RAILWAY_API_TOKEN: config.TREESEED_RAILWAY_API_TOKEN } : {}),
			...(typeof config.TREESEED_RAILWAY_WORKSPACE === 'string' ? { TREESEED_RAILWAY_WORKSPACE: config.TREESEED_RAILWAY_WORKSPACE } : {}),
		};
	}
	if (hostKind === 'email_host') {
		return {
			...(typeof config.SMTP_HOST === 'string' ? { TREESEED_SMTP_HOST: config.SMTP_HOST } : {}),
			...(typeof config.SMTP_PORT === 'string' ? { TREESEED_SMTP_PORT: config.SMTP_PORT } : {}),
			...(typeof config.SMTP_USERNAME === 'string' ? { TREESEED_SMTP_USERNAME: config.SMTP_USERNAME } : {}),
			...(typeof config.SMTP_PASSWORD === 'string' ? { TREESEED_SMTP_PASSWORD: config.SMTP_PASSWORD } : {}),
			...(typeof config.SMTP_FROM_EMAIL === 'string' ? { TREESEED_SMTP_FROM: config.SMTP_FROM_EMAIL } : {}),
			...(typeof config.SMTP_REPLY_TO === 'string' ? { TREESEED_SMTP_REPLY_TO: config.SMTP_REPLY_TO } : {}),
			...(typeof config.SMTP_SECURE === 'string' ? { TREESEED_SMTP_SECURE: config.SMTP_SECURE } : {}),
		};
	}
	return {};
}

async function collectHostingAuditCredentialOverlay({ store, runtime, teamId, hostKinds, credentialSessions = {}, requiredPurpose = null }) {
	const overlay = {};
	const sessions = {};
	for (const hostKind of hostKinds) {
		const definition = HOST_KIND_SESSION_KEYS[hostKind];
		const sessionId = typeof credentialSessions?.[definition.sessionKey] === 'string'
			? credentialSessions[definition.sessionKey].trim()
			: '';
		if (!sessionId) continue;
		const session = await store.getProviderCredentialSession(teamId, sessionId, { includeEncryptedPayload: true });
		if (!session) {
			throw new Error(`Credential session "${definition.sessionKey}" is not available for this team.`);
		}
		if (session.hostKind !== definition.hostKind) {
			throw new Error(`Credential session "${definition.sessionKey}" is not scoped to ${hostKind} hosting.`);
		}
		if (session.status !== 'active' || new Date(session.expiresAt).getTime() <= Date.now()) {
			throw new Error(`Credential session "${definition.sessionKey}" has expired. Unlock the host again.`);
		}
		if (requiredPurpose && session.purpose !== requiredPurpose) {
			throw new Error(`Credential session "${definition.sessionKey}" is not valid for ${requiredPurpose}.`);
		}
		const decrypted = decryptCredentialSessionPayload(runtime, session.encryptedPayload);
		Object.assign(overlay, providerCredentialValuesForAudit(session.hostKind, decrypted));
		sessions[definition.sessionKey] = {
			id: session.id,
			hostKind: session.hostKind,
			hostId: session.hostId,
			purpose: session.purpose,
			expiresAt: session.expiresAt,
		};
	}
	return { overlay, sessions };
}

function nonSecretLaunchJobInput(input = {}) {
	const clone = JSON.parse(JSON.stringify(input ?? {}));
	delete clone.credentialSessions;
	delete clone.sensitivePassphrase;
	if (clone.launchIntent?.execution?.providerLaunchInput?.repositoryHostConfig) {
		delete clone.launchIntent.execution.providerLaunchInput.repositoryHostConfig;
	}
	if (clone.launchIntent?.execution?.providerLaunchInput?.cloudflareHost?.config) {
		delete clone.launchIntent.execution.providerLaunchInput.cloudflareHost.config;
	}
	if (clone.launchIntent?.execution?.providerLaunchInput?.emailHost?.config) {
		delete clone.launchIntent.execution.providerLaunchInput.emailHost.config;
	}
	return clone;
}

async function decryptTeamHostForLaunch(hostKind, host, passphrase) {
	if (!host?.encryptedPayload) {
		throw new Error('Selected host does not have encrypted provider credentials.');
	}
	const decryptedConfig = await decryptHostConfig(host.encryptedPayload, passphrase);
	return normalizeProviderCredentialConfig(hostKind, decryptedConfig, host);
}

function mergeStringConfig(target, config) {
	for (const [key, value] of Object.entries(config ?? {})) {
		if (typeof value === 'string' && value.trim()) target[key] = value;
	}
	return target;
}

async function buildLaunchCredentialOverlay({
	repositoryHost,
	cloudflareHost,
	emailHost,
	cloudflareHostMode,
	emailHostMode,
	cloudflareLaunchConfig,
	passphrase,
}) {
	const overlay = {};
	const nextIntentPatch = {
		repositoryOwner: null,
		cloudflareHostConfig: null,
		emailHostConfig: null,
	};
	if (repositoryHost?.ownership === 'team_owned') {
		if (!passphrase) throw new Error('Sensitive data passphrase is required for the selected Repository Host.');
		const config = await decryptTeamHostForLaunch('repository_host', repositoryHost, passphrase);
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
		if (!passphrase) throw new Error('Sensitive data passphrase is required for the selected Web Host.');
		const config = await decryptTeamHostForLaunch('web_host', cloudflareHost, passphrase);
		mergeStringConfig(overlay, config);
		Object.assign(overlay, providerCredentialValuesForAudit('web_host', { config }));
		nextIntentPatch.cloudflareHostConfig = config;
	} else if (cloudflareHostMode === 'treeseed_managed') {
		mergeStringConfig(overlay, cloudflareLaunchConfig ?? {});
	}
	if (emailHostMode === 'team_owned') {
		if (!passphrase) throw new Error('Sensitive data passphrase is required for the selected Email Host.');
		const config = await decryptTeamHostForLaunch('email_host', emailHost, passphrase);
		Object.assign(overlay, providerCredentialValuesForAudit('email_host', { config }));
		nextIntentPatch.emailHostConfig = config;
	}
	return { overlay, nextIntentPatch };
}

function patchLaunchIntentForCredentialOverlay(launchIntent, patch) {
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

async function appendLaunchDeploymentEvent(store, job, event) {
	const deployments = await store.listProjectDeployments(job.projectId, { limit: 100 }).catch(() => []);
	for (const deployment of deployments.filter((entry) => entry.platformOperationId === job.id)) {
		await store.appendProjectDeploymentEvent(deployment.id, {
			...event,
			operationId: job.id,
		}).catch(() => null);
	}
}

function scheduleBackgroundBootstrap(c, task) {
	const promise = Promise.resolve()
		.then(task)
		.catch((error) => {
			process.stderr.write(`[api] project launch bootstrap failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
		});
	let executionCtx = null;
	try {
		executionCtx = c.executionCtx;
	} catch {
		executionCtx = null;
	}
	if (typeof executionCtx?.waitUntil === 'function') {
		executionCtx.waitUntil(promise);
	}
	return promise;
}

function sanitizeLaunchResultForStorage(value) {
	if (Array.isArray(value)) return value.map(sanitizeLaunchResultForStorage);
	if (typeof value === 'string') {
		return /(?:github_pat_|ghp_|secret-token|sk-[a-z0-9_-]{8,})/iu.test(value) ? '[redacted]' : value;
	}
	if (!value || typeof value !== 'object') return value;
	return Object.fromEntries(Object.entries(value)
		.filter(([key]) => !/(?:secret|token|password|credential|passphrase|apiKey|privateKey|ciphertext)/iu.test(key))
		.filter(([key]) => key !== 'config')
		.map(([key, entry]) => [key, sanitizeLaunchResultForStorage(entry)]));
}

function cloudflareErrorMessage(payload, fallback) {
	const errors = Array.isArray(payload?.errors) ? payload.errors : [];
	const messages = errors
		.map((error) => [error?.code, error?.message].filter(Boolean).join(' '))
		.filter(Boolean);
	return messages[0] ?? payload?.message ?? fallback;
}

async function cloudflareRequestForLaunchPreflight({ token, path, method = 'GET', body = null }) {
	const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
		method,
		headers: {
			authorization: `Bearer ${token}`,
			...(body ? { 'content-type': 'application/json' } : {}),
		},
		...(body ? { body: JSON.stringify(body) } : {}),
	});
	const payload = await response.json().catch(() => null);
	if (!response.ok || payload?.success === false) {
		throw new Error(cloudflareErrorMessage(payload, `${method} ${path} failed with HTTP ${response.status}.`));
	}
	return payload;
}

async function resolveCloudflareZoneForLaunchPreflight({ token, zoneId, zoneName }) {
	if (zoneId) return zoneId;
	if (!zoneName) return null;
	const payload = await cloudflareRequestForLaunchPreflight({
		token,
		path: `/zones?name=${encodeURIComponent(zoneName)}&per_page=1`,
	});
	const resolvedZoneId = payload?.result?.[0]?.id;
	return typeof resolvedZoneId === 'string' && resolvedZoneId.trim() ? resolvedZoneId.trim() : null;
}

async function verifyCloudflareDnsWriteForLaunch({ overlay, domains }) {
	if (!domains?.manageDns) return null;
	const token = overlay.CLOUDFLARE_API_TOKEN;
	if (!token) {
		throw new Error('Cloudflare DNS cannot be managed because the selected Web Host did not provide a Cloudflare API token.');
	}
	const zoneName = normalizeDomainName(domains.zoneName);
	const zoneId = await resolveCloudflareZoneForLaunchPreflight({
		token,
		zoneId: domains.zoneId,
		zoneName,
	});
	if (!zoneId) {
		throw new Error(`Cloudflare DNS zone could not be resolved for ${zoneName || 'the selected project domains'}.`);
	}
	const recordName = `_treeseed-dns-preflight-${randomUUID().slice(0, 8)}.${zoneName}`;
	let recordId = null;
	try {
		const created = await cloudflareRequestForLaunchPreflight({
			token,
			path: `/zones/${encodeURIComponent(zoneId)}/dns_records`,
			method: 'POST',
			body: {
				type: 'TXT',
				name: recordName,
				content: `treeseed launch dns preflight ${new Date().toISOString()}`,
				ttl: 60,
			},
		});
		recordId = created?.result?.id ?? null;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Cloudflare DNS write preflight failed for ${zoneName}: ${message}. The selected Web Host token must include DNS Write and Zone Read access for this root domain.`);
	} finally {
		if (recordId) {
			await cloudflareRequestForLaunchPreflight({
				token,
				path: `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
				method: 'DELETE',
			}).catch(() => null);
		}
	}
	return { zoneId, zoneName };
}

function projectDeletionConfirmationMatches(confirmation, project) {
	return String(confirmation ?? '').trim() === `DELETE ${project?.slug ?? ''}`;
}

function projectDeletionBlockerRows(blockers) {
	if (!blockers) return [];
	if (Array.isArray(blockers)) return blockers;
	return Object.entries(blockers)
		.flatMap(([key, value]) => {
			if (Array.isArray(value)) return value.map((entry) => ({ code: key, ...entry }));
			const count = Number(value);
			return Number.isFinite(count) && count > 0 ? [{ code: key, count }] : [];
		});
}

async function cloudflareRequestForProjectDeletion({ token, path, method = 'GET', body = null, allowMissing = true }) {
	const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
		method,
		headers: {
			authorization: `Bearer ${token}`,
			...(body ? { 'content-type': 'application/json' } : {}),
		},
		...(body ? { body: JSON.stringify(body) } : {}),
	});
	const payload = await response.json().catch(() => null);
	if (!response.ok || payload?.success === false) {
		const message = cloudflareErrorMessage(payload, `${method} ${path} failed with HTTP ${response.status}.`);
		if (allowMissing && /not found|does not exist|could not find|couldn't find|unknown/iu.test(message)) {
			return { success: false, missing: true, result: null, errors: payload?.errors ?? [] };
		}
		throw new Error(message);
	}
	return payload;
}

async function githubRequestForProjectDeletion({ token, path, method = 'GET' }) {
	const response = await fetch(`https://api.github.com${path}`, {
		method,
		headers: {
			authorization: `Bearer ${token}`,
			accept: 'application/vnd.github+json',
			'user-agent': 'treeseed-api',
			'X-GitHub-Api-Version': '2022-11-28',
		},
	});
	if (response.status === 404) return { status: 'missing' };
	if (!response.ok) {
		const payload = await response.json().catch(() => null);
		throw new Error(payload?.message ?? `${method} ${path} failed with HTTP ${response.status}.`);
	}
	return { status: method === 'DELETE' ? 'deleted' : 'ok' };
}

function projectDeletionOperation(provider, type, name, status, extra = {}) {
	return {
		provider,
		type,
		name: name ?? null,
		status,
		...extra,
	};
}

function cloudflareDeletionAuthenticationMessage(message) {
	return /authentication error|invalid token|unauthorized|forbidden|10000/iu.test(String(message ?? ''));
}

function hasRecordedCloudflareRuntimeResources(names) {
	return [
		names.pagesProjects,
		names.workers,
		names.turnstileWidgets,
		names.kvNamespaces,
		names.buckets,
		names.databases,
		names.queues,
	].some((entries) => Array.isArray(entries) && entries.length > 0);
}

function canSkipCloudflareCleanupAfterFailedLaunch(project, names, message) {
	if (!cloudflareDeletionAuthenticationMessage(message)) return false;
	if (hasRecordedCloudflareRuntimeResources(names)) return false;
	const metadata = project?.metadata ?? {};
	const launchFailureMessage = String(metadata.launchFailure?.message ?? '');
	return metadata.launchPhase === 'failed'
		&& /cloudflare|dns_records|dns-record/iu.test(launchFailureMessage)
		&& cloudflareDeletionAuthenticationMessage(launchFailureMessage);
}

function projectDeletionHostname(value) {
	if (!value) return null;
	try {
		return normalizeDomainName(new URL(value).hostname);
	} catch {
		return normalizeDomainName(value);
	}
}

function normalizedCloudflareKvNamespaceReference(value) {
	if (!value) return null;
	if (typeof value === 'string') {
		const name = value.trim();
		return name ? { id: null, name, binding: null } : null;
	}
	if (typeof value !== 'object') return null;
	const id = value.id ?? value.namespaceId ?? value.uuid ?? value.sitekey ?? value.siteKey ?? value.locator ?? null;
	const name = value.name ?? value.title ?? value.namespaceName ?? value.logicalName ?? null;
	const binding = value.binding ?? value.bindingName ?? null;
	if (!id && !name) return null;
	return {
		id: id ? String(id) : null,
		name: name ? String(name) : null,
		binding: binding ? String(binding) : null,
	};
}

function uniqueCloudflareKvNamespaceReferences(entries) {
	const seen = new Set();
	const result = [];
	for (const entry of entries.map(normalizedCloudflareKvNamespaceReference).filter(Boolean)) {
		const key = entry.id ? `id:${entry.id}` : `name:${entry.name}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(entry);
	}
	return result;
}

function cloudflareProjectDeletionResourceNames(project, details) {
	const metadata = project?.metadata ?? {};
	const domains = metadata.domains ?? metadata.cloudflareHost?.domains ?? {};
	const environments = Array.isArray(details?.environments) ? details.environments : [];
	const resources = Array.isArray(details?.resources) ? details.resources : [];
	const byEnvironment = new Map(environments.map((entry) => [entry.environment, entry]));
	const resourceValues = (kind) => resources
		.filter((resource) => resource.provider === 'cloudflare' && resource.resourceKind === kind)
		.map((resource) => resource.locator ?? resource.metadata?.name ?? resource.metadata?.projectName ?? null)
		.filter(Boolean);
	const staging = byEnvironment.get('staging');
	const prod = byEnvironment.get('prod');
	return {
		accountId: staging?.cloudflareAccountId ?? prod?.cloudflareAccountId ?? metadata.cloudflare?.staging?.accountId ?? metadata.cloudflare?.prod?.accountId ?? null,
		zoneId: domains.zoneId ?? metadata.cloudflareHost?.dns?.zoneId ?? null,
		zoneName: domains.zoneName ?? metadata.cloudflareHost?.dns?.zoneName ?? null,
		domains: [...new Set([
			domains.stagingDomain,
			domains.productionDomain,
			staging?.metadata?.siteUrl,
			prod?.metadata?.siteUrl,
			staging?.baseUrl,
			prod?.baseUrl,
		].map(projectDeletionHostname).filter(Boolean))],
		pagesProjects: [...new Set([
			staging?.pagesProjectName,
			prod?.pagesProjectName,
			metadata.cloudflare?.staging?.pages?.projectName,
			metadata.cloudflare?.prod?.pages?.projectName,
			...resourceValues('pages'),
		].filter(Boolean))],
		workers: [...new Set([
			staging?.workerName,
			prod?.workerName,
			metadata.cloudflare?.staging?.workerName,
			metadata.cloudflare?.prod?.workerName,
			...resourceValues('worker'),
		].filter(Boolean))],
		turnstileWidgets: uniqueCloudflareKvNamespaceReferences([
			metadata.cloudflare?.staging?.turnstileWidget,
			metadata.cloudflare?.prod?.turnstileWidget,
			...resources
				.filter((resource) => resource.provider === 'cloudflare' && ['turnstile', 'turnstile-widget'].includes(resource.resourceKind))
				.map((resource) => ({
					...(resource.metadata ?? {}),
					locator: resource.locator,
					logicalName: resource.logicalName,
				})),
		]).map((entry) => ({
			sitekey: entry.id,
			name: entry.name,
			binding: entry.binding,
		})),
		kvNamespaces: uniqueCloudflareKvNamespaceReferences([
			metadata.cloudflare?.staging?.formGuardKv,
			metadata.cloudflare?.prod?.formGuardKv,
			metadata.cloudflare?.staging?.kvNamespaces?.FORM_GUARD_KV,
			metadata.cloudflare?.prod?.kvNamespaces?.FORM_GUARD_KV,
			...resources
				.filter((resource) => resource.provider === 'cloudflare' && ['kv', 'kv_namespace', 'kv-namespace'].includes(resource.resourceKind))
				.map((resource) => ({
					...(resource.metadata ?? {}),
					locator: resource.locator,
					logicalName: resource.logicalName,
				})),
		]),
		buckets: [...new Set([
			staging?.r2BucketName,
			prod?.r2BucketName,
			metadata.cloudflare?.staging?.content?.bucketName,
			metadata.cloudflare?.prod?.content?.bucketName,
			...resourceValues('r2'),
		].filter(Boolean))],
		databases: [...new Set([
			staging?.d1DatabaseName,
			prod?.d1DatabaseName,
			metadata.cloudflare?.staging?.siteDataDb?.databaseName,
			metadata.cloudflare?.prod?.siteDataDb?.databaseName,
			...resources
				.filter((resource) => resource.provider === 'cloudflare' && resource.resourceKind === 'd1')
				.map((resource) => resource.metadata?.databaseName ?? resource.locator)
				.filter(Boolean),
		].filter(Boolean))],
	};
}

async function resolveProjectDeletionCloudflareZone({ token, names }) {
	if (names.zoneId) return names.zoneId;
	if (!names.zoneName) return null;
	const payload = await cloudflareRequestForProjectDeletion({
		token,
		path: `/zones?name=${encodeURIComponent(names.zoneName)}&per_page=1`,
	});
	return payload?.result?.[0]?.id ?? null;
}

async function deleteCloudflareDnsRecordsForProject({ token, zoneId, name }) {
	if (!zoneId || !name) return [projectDeletionOperation('cloudflare', 'dns-record', name, 'missing')];
	const listed = await cloudflareRequestForProjectDeletion({
		token,
		path: `/zones/${encodeURIComponent(zoneId)}/dns_records?name=${encodeURIComponent(name)}&per_page=100`,
	});
	const records = Array.isArray(listed?.result) ? listed.result : [];
	if (records.length === 0) return [projectDeletionOperation('cloudflare', 'dns-record', name, 'missing', { zoneId })];
	return Promise.all(records.map(async (record) => {
		await cloudflareRequestForProjectDeletion({
			token,
			method: 'DELETE',
			path: `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(record.id)}`,
		});
		return projectDeletionOperation('cloudflare', 'dns-record', record.name ?? name, 'deleted', { zoneId });
	}));
}

async function listCloudflareNamedResources({ token, accountId, path, name }) {
	if (!accountId || !name) return [];
	const payload = await cloudflareRequestForProjectDeletion({
		token,
		path: `/accounts/${encodeURIComponent(accountId)}${path}`,
	});
	return (Array.isArray(payload?.result) ? payload.result : [])
		.filter((entry) => entry?.name === name || entry?.queue_name === name || entry?.title === name);
}

async function deleteCloudflareProjectResources({ token, accountId, zoneId, names }) {
	const operations = [];
	if (!accountId) {
		return [projectDeletionOperation('cloudflare', 'account', null, 'blocked', { reason: 'missing_cloudflare_account_id' })];
	}
	for (const pagesProject of names.pagesProjects) {
		const result = await cloudflareRequestForProjectDeletion({
			token,
			method: 'DELETE',
			path: `/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(pagesProject)}`,
		});
		operations.push(projectDeletionOperation('cloudflare', 'pages-project', pagesProject, result?.missing ? 'missing' : 'deleted'));
	}
	for (const worker of names.workers) {
		const result = await cloudflareRequestForProjectDeletion({
			token,
			method: 'DELETE',
			path: `/accounts/${encodeURIComponent(accountId)}/workers/services/${encodeURIComponent(worker)}`,
		});
		operations.push(projectDeletionOperation('cloudflare', 'worker', worker, result?.missing ? 'missing' : 'deleted'));
	}
	for (const widget of names.turnstileWidgets ?? []) {
		const widgetName = widget.name ?? widget.sitekey;
		let sitekey = widget.sitekey ?? null;
		if (!sitekey && widget.name) {
			const matches = await listCloudflareNamedResources({
				token,
				accountId,
				path: '/challenges/widgets?per_page=100',
				name: widget.name,
			});
			sitekey = matches[0]?.sitekey ?? null;
		}
		if (!sitekey) {
			operations.push(projectDeletionOperation('cloudflare', 'turnstile-widget', widgetName, 'missing'));
			continue;
		}
		const result = await cloudflareRequestForProjectDeletion({
			token,
			method: 'DELETE',
			path: `/accounts/${encodeURIComponent(accountId)}/challenges/widgets/${encodeURIComponent(sitekey)}`,
		});
		operations.push(projectDeletionOperation('cloudflare', 'turnstile-widget', widgetName, result?.missing ? 'missing' : 'deleted', { sitekey }));
	}
	for (const namespace of names.kvNamespaces ?? []) {
		const namespaceName = namespace.name ?? namespace.id;
		let namespaceId = namespace.id ?? null;
		if (!namespaceId && namespace.name) {
			const matches = await listCloudflareNamedResources({
				token,
				accountId,
				path: '/storage/kv/namespaces?per_page=1000&order=title&direction=asc',
				name: namespace.name,
			});
			namespaceId = matches[0]?.id ?? null;
		}
		if (!namespaceId) {
			operations.push(projectDeletionOperation('cloudflare', 'kv-namespace', namespaceName, 'missing', { binding: namespace.binding ?? null }));
			continue;
		}
		const result = await cloudflareRequestForProjectDeletion({
			token,
			method: 'DELETE',
			path: `/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces/${encodeURIComponent(namespaceId)}`,
		});
		operations.push(projectDeletionOperation('cloudflare', 'kv-namespace', namespaceName, result?.missing ? 'missing' : 'deleted', {
			id: namespaceId,
			binding: namespace.binding ?? null,
		}));
	}
	for (const bucket of names.buckets) {
		const result = await cloudflareRequestForProjectDeletion({
			token,
			method: 'DELETE',
			path: `/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucket)}`,
		});
		operations.push(projectDeletionOperation('cloudflare', 'r2-bucket', bucket, result?.missing ? 'missing' : 'deleted'));
	}
	for (const database of names.databases) {
		const matches = await listCloudflareNamedResources({ token, accountId, path: '/d1/database', name: database });
		if (matches.length === 0) {
			operations.push(projectDeletionOperation('cloudflare', 'd1-database', database, 'missing'));
			continue;
		}
		for (const match of matches) {
			const result = await cloudflareRequestForProjectDeletion({
				token,
				method: 'DELETE',
				path: `/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(match.uuid ?? match.id)}`,
			});
			operations.push(projectDeletionOperation('cloudflare', 'd1-database', database, result?.missing ? 'missing' : 'deleted'));
		}
	}
	for (const queue of names.queues) {
		const matches = await listCloudflareNamedResources({ token, accountId, path: '/queues', name: queue });
		if (matches.length === 0) {
			operations.push(projectDeletionOperation('cloudflare', 'queue', queue, 'missing'));
			continue;
		}
		for (const match of matches) {
			const result = await cloudflareRequestForProjectDeletion({
				token,
				method: 'DELETE',
				path: `/accounts/${encodeURIComponent(accountId)}/queues/${encodeURIComponent(match.queue_id ?? match.id)}`,
			});
			operations.push(projectDeletionOperation('cloudflare', 'queue', queue, result?.missing ? 'missing' : 'deleted'));
		}
	}
	for (const domain of names.domains) {
		operations.push(...await deleteCloudflareDnsRecordsForProject({ token, zoneId, name: domain }));
	}
	return operations;
}

async function appendProjectDeletionProgress(store, job, input) {
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

function cloudflareDnsDomainsForHostValidation(host) {
	const dns = host?.metadata?.dns && typeof host.metadata.dns === 'object' ? host.metadata.dns : {};
	const zoneName = normalizeDomainName(dns.zoneName ?? dns.rootZone ?? dns.zone);
	const zoneId = optionalTrimmedString(dns.zoneId);
	const manageDns = dns.managed !== false && Boolean(zoneName || zoneId);
	return {
		zoneName,
		zoneId,
		manageDns,
	};
}

async function validateTeamHostCredentialPayload(host, decryptedConfig) {
	const summary = decryptedHostConfigSummary(decryptedConfig);
	const validation = {
		status: 'unchecked',
		checkedAt: new Date().toISOString(),
		receivedKeys: summary.keys,
		mode: host?.ownership ?? null,
		message: 'Provider credentials were received but no live provider check was available for this host type.',
		issues: [],
	};
	const hostType = host?.metadata?.hostType;
	const isCloudflareWebHost = host?.provider === 'cloudflare' || hostType === 'web';
	if (!isCloudflareWebHost) {
		return validation;
	}
	try {
		const config = normalizeProviderCredentialConfig('web_host', decryptedConfig, host);
		const domains = cloudflareDnsDomainsForHostValidation(host);
		if (domains.manageDns) {
			const dnsPreflight = await verifyCloudflareDnsWriteForLaunch({
				overlay: config,
				domains,
			});
			return {
				...validation,
				status: 'passed',
				message: `Cloudflare DNS write access verified for ${dnsPreflight?.zoneName ?? domains.zoneName ?? 'the selected zone'}.`,
				checkedCapabilities: ['cloudflare.token', 'cloudflare.dns.write'],
				zoneName: dnsPreflight?.zoneName ?? domains.zoneName ?? null,
			};
		}
		return {
			...validation,
			status: 'unchecked',
			message: 'Cloudflare credentials include the required fields. DNS write access was not checked because this host does not define a root zone.',
			checkedCapabilities: ['cloudflare.required_fields'],
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			...validation,
			status: 'failed',
			message,
			issues: [message],
			checkedCapabilities: ['cloudflare.token', 'cloudflare.dns.write'],
		};
	}
}

async function runProjectLaunchApiBootstrap({
	store,
	runtime,
	jobId,
	launchIntent,
	passphrase,
	repositoryHost,
	cloudflareHost,
	emailHost,
	cloudflareHostMode,
	emailHostMode,
	cloudflareLaunchConfig,
	auditHostKinds,
	principal,
	mockExternal = false,
}) {
	let job = await store.findJobById(jobId);
	let bootstrapPhase = 'credential_bootstrap';
	if (!job) return null;
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
		const hostingAudit = await runTreeseedHostingAudit({
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
		const result = mockExternal
			? {
				mode: 'inline',
				payload: {
					plan: bootstrappedIntent.execution?.launchPlan ?? planKnowledgeHubLaunch(bootstrappedIntent),
					repository: {
						owner: bootstrappedIntent.repository?.owner ?? 'treeseed-sites',
						name: `${bootstrappedIntent.hub?.slug ?? 'project'}-site`,
						url: `https://github.com/${bootstrappedIntent.repository?.owner ?? 'treeseed-sites'}/${bootstrappedIntent.hub?.slug ?? 'project'}-site`,
						defaultBranch: 'main',
					},
					repositories: planKnowledgeHubLaunch(bootstrappedIntent).repository.repositories.map((repository) => ({
						...repository,
						url: `https://github.com/${repository.owner}/${repository.name}`,
						create: false,
					})),
					cloudflare: {
						staging: { siteUrl: `https://${bootstrappedIntent.hub?.slug ?? 'project'}-staging.pages.dev` },
						prod: { siteUrl: `https://${bootstrappedIntent.hub?.slug ?? 'project'}.pages.dev` },
					},
					railway: { services: [], deployments: [], schedules: [] },
					projectApiBaseUrl: `https://${bootstrappedIntent.hub?.slug ?? 'project'}-api.example.test`,
					projectSiteUrl: `https://${bootstrappedIntent.hub?.slug ?? 'project'}.pages.dev`,
					projectMetadata: { mocked: true },
					phases: [
						{ phase: 'repo_provision', status: 'completed', detail: 'Mocked repository provisioning completed.' },
						{ phase: 'runtime_connection', status: 'completed', detail: 'Mocked runtime connection completed.' },
					],
				},
			}
			: await new TreeseedOperationsSdk().execute({
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
					if (event.kind !== 'hub_launch_phase') return;
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
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		job = await store.findJobById(jobId);
		if (!job) return null;
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

async function runProjectDeletionApiDestroy({
	store,
	projectId,
	jobId,
	passphrase,
	mockExternal = false,
}) {
	let job = await store.findJobById(jobId);
	if (!job) return null;
	let phase = 'credential_unlock';
	try {
		const project = await store.getProject(projectId);
		if (!project) throw new Error('Project no longer exists.');
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
		const overlay = {};
		await appendProjectDeletionProgress(store, job, {
			kind: 'project_delete.credentials_started',
			phase,
			title: 'Unlocking host credentials',
			message: 'Unlocking selected host credentials in API memory.',
		});
		if (repositoryHost?.ownership === 'team_owned') {
			if (!passphrase) throw new Error('Sensitive data passphrase is required to delete project repositories.');
			const config = await decryptTeamHostForLaunch('repository_host', repositoryHost, passphrase);
			const token = config.GH_TOKEN ?? config.GITHUB_TOKEN;
			if (token) {
				overlay.GH_TOKEN = token;
				overlay.GITHUB_TOKEN = config.GITHUB_TOKEN ?? token;
			}
		}
		if (webHost) {
			if (!passphrase) throw new Error('Sensitive data passphrase is required to delete project web host resources.');
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
			if (mockExternal) {
				repositoryOperations.push(projectDeletionOperation('github', 'repository', `${repository.owner}/${repository.name}`, 'deleted', { mocked: true }));
				continue;
			}
			if (!githubToken) throw new Error('GitHub token is required to delete project repositories.');
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
		if (mockExternal) {
			cloudflareOperations = [
				...names.pagesProjects.map((name) => projectDeletionOperation('cloudflare', 'pages-project', name, 'deleted', { mocked: true })),
				...names.workers.map((name) => projectDeletionOperation('cloudflare', 'worker', name, 'deleted', { mocked: true })),
				...(names.turnstileWidgets ?? []).map((widget) => projectDeletionOperation('cloudflare', 'turnstile-widget', widget.name ?? widget.sitekey, 'deleted', {
					mocked: true,
					sitekey: widget.sitekey ?? null,
				})),
				...(names.kvNamespaces ?? []).map((namespace) => projectDeletionOperation('cloudflare', 'kv-namespace', namespace.name ?? namespace.id, 'deleted', {
					mocked: true,
					id: namespace.id ?? null,
					binding: namespace.binding ?? null,
				})),
				...names.buckets.map((name) => projectDeletionOperation('cloudflare', 'r2-bucket', name, 'deleted', { mocked: true })),
				...names.databases.map((name) => projectDeletionOperation('cloudflare', 'd1-database', name, 'deleted', { mocked: true })),
				...names.queues.map((name) => projectDeletionOperation('cloudflare', 'queue', name, 'deleted', { mocked: true })),
				...names.domains.map((name) => projectDeletionOperation('cloudflare', 'dns-record', name, 'deleted', { mocked: true })),
			];
		} else if (webHost) {
			const cloudflareToken = overlay.CLOUDFLARE_API_TOKEN;
			if (!cloudflareToken) throw new Error('Cloudflare API token is required to delete project web host resources.');
			const accountId = overlay.CLOUDFLARE_ACCOUNT_ID ?? names.accountId;
			try {
				const zoneId = await resolveProjectDeletionCloudflareZone({ token: cloudflareToken, names });
				cloudflareOperations = await deleteCloudflareProjectResources({
					token: cloudflareToken,
					accountId,
					zoneId,
					names,
				});
			} catch (cloudflareError) {
				const cloudflareMessage = cloudflareError instanceof Error ? cloudflareError.message : String(cloudflareError);
				if (!canSkipCloudflareCleanupAfterFailedLaunch(project, names, cloudflareMessage)) throw cloudflareError;
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
		} else {
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
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		job = await store.findJobById(jobId);
		if (!job) return null;
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

async function retryApiLaunchBootstrapFromRequest({
	c,
	store,
	runtime,
	job,
	access,
	body,
	resume = false,
	mockExternal = false,
}) {
	const rejectedUnlock = rejectProjectSecretUnlockMaterial(
		c,
		body,
		'Launch recovery no longer accepts passphrases or credential sessions. Re-enter or migrate team-owned secrets into approved targets, then retry.',
	);
	if (rejectedUnlock) return { response: rejectedUnlock };
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
		? await resolveTreeseedManagedCloudflareHostConfigFromConfig(runtime)
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
		mockExternal,
	}));
	return {
		response: c.json({
			ok: true,
			payload: decorateJob(normalizeBaseUrl(runtime.resolved.config.baseUrl ?? ''), retried),
		}, { status: 202 }),
	};
}

const GITHUB_ACTIONS_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
let githubOidcJwksCache = { fetchedAt: 0, keys: [] };

function base64urlJson(value) {
	return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function parseBase64urlJson(value) {
	return JSON.parse(Buffer.from(String(value ?? ''), 'base64url').toString('utf8'));
}

function operationTokenSecret(runtime) {
	return runtime?.resolved?.config?.assertionSecret
		?? runtime?.resolved?.config?.authSecret
		?? process.env.TREESEED_MARKET_OPERATION_TOKEN_SECRET
		?? process.env.TREESEED_AUTH_SECRET
		?? 'treeseed-local-operation-token-secret';
}

function signOperationToken(runtime, payload) {
	const body = base64urlJson(payload);
	const signature = createHmac('sha256', operationTokenSecret(runtime)).update(body).digest('base64url');
	return `${body}.${signature}`;
}

function verifyOperationToken(runtime, token) {
	const [body, signature] = String(token ?? '').split('.');
	if (!body || !signature) {
		throw new Error('Invalid operation token.');
	}
	const expected = createHmac('sha256', operationTokenSecret(runtime)).update(body).digest('base64url');
	const providedBuffer = Buffer.from(signature);
	const expectedBuffer = Buffer.from(expected);
	if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) {
		throw new Error('Invalid operation token signature.');
	}
	const payload = parseBase64urlJson(body);
	if (!payload.exp || Number(payload.exp) <= Math.floor(Date.now() / 1000)) {
		throw new Error('Operation token expired.');
	}
	return payload;
}

async function loadGitHubOidcJwks(fetchImpl = fetch) {
	if (githubOidcJwksCache.keys.length > 0 && Date.now() - githubOidcJwksCache.fetchedAt < 10 * 60 * 1000) {
		return githubOidcJwksCache.keys;
	}
	const response = await fetchImpl('https://token.actions.githubusercontent.com/.well-known/jwks');
	if (!response.ok) {
		throw new Error(`Unable to load GitHub OIDC signing keys (${response.status}).`);
	}
	const payload = await response.json();
	githubOidcJwksCache = {
		fetchedAt: Date.now(),
		keys: Array.isArray(payload.keys) ? payload.keys : [],
	};
	return githubOidcJwksCache.keys;
}

async function verifyGitHubOidcToken(token, expectedAudience, fetchImpl = fetch) {
	const parts = String(token ?? '').split('.');
	if (parts.length !== 3) {
		throw new Error('GitHub OIDC token must be a JWT.');
	}
	const [encodedHeader, encodedPayload, encodedSignature] = parts;
	const header = parseBase64urlJson(encodedHeader);
	const claims = parseBase64urlJson(encodedPayload);
	const skipSignatureForTest = process.env.NODE_ENV === 'test' && header.alg === 'none';
	if (!skipSignatureForTest) {
		if (header.alg !== 'RS256' || !header.kid) {
			throw new Error('Unsupported GitHub OIDC token algorithm.');
		}
		const key = (await loadGitHubOidcJwks(fetchImpl)).find((entry) => entry.kid === header.kid);
		if (!key) {
			throw new Error('GitHub OIDC signing key not found.');
		}
		const verifier = createVerify('RSA-SHA256');
		verifier.update(`${encodedHeader}.${encodedPayload}`);
		verifier.end();
		if (!verifier.verify(createPublicKey({ key, format: 'jwk' }), Buffer.from(encodedSignature, 'base64url'))) {
			throw new Error('GitHub OIDC token signature is invalid.');
		}
	}
	const now = Math.floor(Date.now() / 1000);
	if (claims.iss !== GITHUB_ACTIONS_OIDC_ISSUER) {
		throw new Error('GitHub OIDC issuer is invalid.');
	}
	const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (!audiences.includes(expectedAudience)) {
		throw new Error('GitHub OIDC audience is invalid.');
	}
	if (claims.exp && Number(claims.exp) <= now) {
		throw new Error('GitHub OIDC token has expired.');
	}
	if (claims.nbf && Number(claims.nbf) > now) {
		throw new Error('GitHub OIDC token is not valid yet.');
	}
	return claims;
}

function normalizeCiEnvironment(value) {
	const normalized = String(value ?? '').trim().toLowerCase();
	return normalized === 'prod' || normalized === 'production' ? 'prod' : 'staging';
}

function ciOperationForAction(actionKind) {
	switch (String(actionKind ?? 'deploy_web')) {
		case 'publish_content':
			return { namespace: 'content', operation: 'publish' };
		case 'monitor':
			return { namespace: 'workflow', operation: 'verify_runtime' };
		case 'deploy_web':
		default:
			return { namespace: 'workflow', operation: 'deploy_runtime' };
	}
}

function fallbackRemoteCapability(namespace, operation) {
	return {
		namespace,
		operation,
		label: `${namespace}.${operation}`,
		executionClass: 'remote_job',
		allowedTargets: ['project_runner'],
		defaultTarget: 'project_runner',
		defaultDispatchMode: 'auto',
		approvalPolicy: {},
		resourceScope: {},
		metadata: {},
	};
}

function normalizeRepositorySlug(value) {
	const text = String(value ?? '').trim().toLowerCase();
	return text.includes('/') ? text : null;
}

function projectAllowedCiRepositories(projectDetails) {
	const slugs = new Set();
	for (const repository of projectDetails.repositories ?? []) {
		if (repository.role !== 'software') continue;
		const slug = normalizeRepositorySlug(`${repository.owner}/${repository.name}`);
		if (slug) slugs.add(slug);
	}
	const hosting = projectDetails.hosting;
	if (hosting?.sourceRepoOwner && hosting?.sourceRepoName) {
		const slug = normalizeRepositorySlug(`${hosting.sourceRepoOwner}/${hosting.sourceRepoName}`);
		if (slug) slugs.add(slug);
	}
	return slugs;
}

function validateCiRefForEnvironment(environment, claims) {
	const ref = String(claims.ref ?? '');
	if (environment === 'prod') {
		return ref === 'refs/heads/main' || ref.startsWith('refs/tags/');
	}
	return ref === 'refs/heads/staging';
}

function marketProfilesForTeams(teams = [], baseUrl) {
	const byId = new Map();
	const central = centralMarketProfile(baseUrl);
	byId.set(central.id, central);
	for (const team of teams) {
		const metadata = team?.metadata && typeof team.metadata === 'object' ? team.metadata : {};
		const profiles = Array.isArray(metadata.marketProfiles)
			? metadata.marketProfiles
			: Array.isArray(metadata.markets)
				? metadata.markets
				: [];
		for (const profile of profiles) {
			const normalized = normalizeMarketProfile(profile, team.id);
			if (normalized) {
				byId.set(normalized.id, normalized);
			}
		}
	}
	return [...byId.values()];
}

function artifactDownloadPayload(baseUrl, item, artifact) {
	const metadata = artifact.metadata && typeof artifact.metadata === 'object' ? artifact.metadata : {};
	const downloadUrl = typeof metadata.downloadUrl === 'string' && metadata.downloadUrl.trim()
		? metadata.downloadUrl
		: typeof metadata.publicUrl === 'string' && metadata.publicUrl.trim()
			? metadata.publicUrl
			: `${normalizeBaseUrl(baseUrl)}/v1/catalog/${encodeURIComponent(item.id)}/artifacts/${encodeURIComponent(artifact.version)}/content`;
	return {
		itemId: item.id,
		slug: item.slug,
		kind: item.kind,
		version: artifact.version,
		contentType: typeof metadata.contentType === 'string' && metadata.contentType.trim()
			? metadata.contentType
			: item.kind === 'knowledge_pack'
				? 'application/vnd.treeseed.knowledge-pack+tar'
				: 'application/vnd.treeseed.template+tar',
		sha256: typeof metadata.sha256 === 'string' && metadata.sha256.trim() ? metadata.sha256.trim() : null,
		downloadUrl,
		expiresAt: typeof metadata.expiresAt === 'string' ? metadata.expiresAt : null,
		installStrategy: typeof metadata.installStrategy === 'string'
			? metadata.installStrategy
			: typeof item.metadata?.installStrategy === 'string'
				? item.metadata.installStrategy
				: null,
	};
}

function principalHasPermission(principal, permission) {
	return Boolean(
		principal
		&& (
			principal.permissions?.includes?.('*:*:*')
			|| principal.permissions?.includes?.(permission)
		),
	);
}

function principalIsSeedAdmin(principal) {
	return Boolean(
		principal
		&& (
			principal.permissions?.includes?.('*:*:*')
			|| principal.permissions?.includes?.('seeds:apply:global')
			|| principal.roles?.includes?.('platform_admin')
			|| principal.roles?.includes?.('market_admin')
		),
	);
}

function isTeamApiPrincipal(principal) {
	return Boolean(principal?.roles?.includes?.('team_api_key'));
}

function localAcceptanceAdminToken() {
	return process.env.TREESEED_CAPACITY_ACCEPTANCE_ADMIN_TOKEN || 'tsk_local_treeseed_acceptance_admin';
}

function localAcceptanceAuthEnabled(runtime) {
	const environment = String(runtime?.resolved?.config?.environment ?? process.env.TREESEED_API_ENVIRONMENT ?? process.env.TREESEED_ENVIRONMENT ?? '').trim().toLowerCase();
	const baseUrl = String(runtime?.resolved?.config?.baseUrl ?? process.env.TREESEED_API_BASE_URL ?? '').trim();
	return environment === 'local' || process.env.TREESEED_LOCAL_DEV_MODE === '1' || isLoopbackUrl(baseUrl);
}

function decorateJob(baseUrl, job) {
	if (!job) return null;
	return {
		...job,
		pollUrl: `${baseUrl}/v1/jobs/${job.id}`,
		streamUrl: `${baseUrl}/v1/jobs/${job.id}/events`,
	};
}

function safePlatformOperationOutput(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return value ?? null;
	const output = { ...value };
	if (typeof output.repositoryPath === 'string') {
		output.repositoryPath = output.repositoryPath.includes('/repositories/') ? '/data/repositories/<repository>/repo' : '<runner-workspace>';
	}
	if (typeof output.workspacePath === 'string') {
		output.workspacePath = output.workspacePath.includes('/data') ? '/data' : '<runner-workspace>';
	}
	if (output.repository && typeof output.repository === 'object' && !Array.isArray(output.repository)) {
		output.repository = {
			...output.repository,
			cloneUrl: typeof output.repository.cloneUrl === 'string' && output.repository.cloneUrl.startsWith('http')
				? output.repository.cloneUrl.replace(/\/\/[^/@]+@/u, '//<redacted>@')
				: output.repository.cloneUrl,
		};
	}
	return output;
}

function decoratePlatformOperation(baseUrl, operation) {
	if (!operation) return null;
	const normalizedBaseUrl = normalizeBaseUrl(baseUrl ?? '');
	const navigation = derivePlatformOperationNavigation(operation);
	const safeOutput = safePlatformOperationOutput(operation.output);
	return {
		...operation,
		output: safeOutput,
		pollUrl: `${normalizedBaseUrl}/v1/platform/operations/${operation.id}`,
		streamUrl: `${normalizedBaseUrl}/v1/platform/operations/${operation.id}/events`,
		terminal: isPlatformOperationTerminal(operation),
		navigation,
		href: navigation.href,
		changedPaths: navigation.changedPaths,
		branch: navigation.branch,
		commitSha: navigation.commitSha,
	};
}

function safeTokenEquals(left, right) {
	if (!left || !right) return false;
	const leftBuffer = Buffer.from(String(left));
	const rightBuffer = Buffer.from(String(right));
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function resolvePlatformRunnerSecret(config) {
	return optionalTrimmedString(config.platformRunnerSecret)
		?? optionalTrimmedString(config.operationsRunnerSecret)
		?? optionalTrimmedString(process.env.TREESEED_PLATFORM_RUNNER_SECRET)
		?? optionalTrimmedString(process.env.TREESEED_MARKET_OPERATIONS_RUNNER_SECRET);
}

function platformOperationMutationError(c, error) {
	const status = Number(error?.status ?? 500);
	if (![400, 404, 409].includes(status)) throw error;
	return jsonError(c, status, error instanceof Error ? error.message : String(error), error?.details ?? {});
}

async function requirePlatformRunner(c, config) {
	const token = bearerTokenFromRequest(c.req.raw);
	const secret = resolvePlatformRunnerSecret(config);
	if (!token || !secret) {
		return {
			response: jsonError(c, 401, 'Platform runner service credential required.'),
		};
	}
	if (!safeTokenEquals(token, secret)) {
		return {
			response: jsonError(c, 401, 'Invalid platform runner service credential.'),
		};
	}
	return {
		principal: {
			id: 'platform-runner',
			roles: ['platform_runner'],
			permissions: [...PLATFORM_OPERATION_SCOPES],
			scopes: [...PLATFORM_OPERATION_SCOPES],
		},
	};
}

function resolvePlatformRepositoryDescriptor(config, details, body = {}) {
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

function mergeCapability(baseCapability, override) {
	if (!override) {
		return baseCapability;
	}
	return {
		...baseCapability,
		executionClass: override.executionClass,
		allowedTargets: [...override.allowedTargets],
		defaultDispatchMode: override.defaultDispatchMode,
		label: override.label ?? baseCapability.label ?? `${baseCapability.namespace}.${baseCapability.operation}`,
		approvalPolicy: override.approvalPolicy ?? baseCapability.approvalPolicy ?? {},
		resourceScope: override.resourceScope ?? baseCapability.resourceScope ?? {},
		metadata: override.metadata ?? baseCapability.metadata ?? {},
	};
}

function canonicalArchitectureTopology(value) {
	if (value === 'combined_compatibility') return 'single_repository_site';
	if (value === 'split_software_content') return 'split_site_content';
	if (['single_repository_site', 'split_site_content', 'parent_workspace'].includes(value)) return value;
	return 'split_site_content';
}

function launchPlannerRepositoryTopology(value) {
	if (value === undefined || value === null || value === '') return 'split_software_content';
	if (value === 'single_repository_site' || value === 'parent_workspace') return 'combined_compatibility';
	if (value === 'split_site_content') return 'split_software_content';
	if (value === 'combined_compatibility' || value === 'split_software_content') {
		const error = new Error('Project launch repository topology must use canonical project architecture values.');
		error.code = 'legacy_project_topology_rejected';
		throw error;
	}
	const error = new Error(`Unsupported project architecture topology: ${String(value)}.`);
	error.code = 'invalid_project_architecture';
	throw error;
}

function launchCapabilityPreset(projectTopology = 'split_site_content') {
	const architectureTopology = canonicalArchitectureTopology(projectTopology);
	const approvalDefaults = {
		'repository.create': {
			requiresApproval: true,
			allowedRoles: ['team_owner', 'technical_steward'],
			reason: 'Repository creation can create or change team-owned infrastructure.',
		},
		'repository.configure': {
			requiresApproval: true,
			allowedRoles: ['team_owner', 'technical_steward'],
			reason: 'Repository configuration changes access and workflow policy.',
		},
		'content.publish': {
			requiresApproval: true,
			allowedRoles: ['content_policy_approver'],
			reason: 'Content publish changes what the hub contains.',
		},
		'workflow.deploy_runtime': {
			requiresApproval: true,
			allowedRoles: ['technical_steward', 'release_approver'],
			reason: 'Runtime deployment changes how the hub runs.',
		},
		'workflow.publish_release': {
			requiresApproval: true,
			allowedRoles: ['technical_steward', 'release_approver'],
			reason: 'Software release changes how the hub works.',
		},
		'market.publish': {
			requiresApproval: true,
			allowedRoles: ['market_steward'],
			reason: 'Treeseed publishing makes project outputs externally visible.',
		},
	};
	const resourceScope = (namespace, operation) => ({
		architectureTopology,
		repositories: {
			software: ['workflow', 'repository'].includes(namespace) || operation.includes('release') || operation.includes('deploy'),
			content: namespace === 'content' || operation.includes('publish'),
			parentWorkspace: false,
		},
		runtimeResources: namespace === 'workflow',
		marketListing: namespace === 'market',
	});
	const remoteJob = (namespace, operation, allowedTargets = ['project_runner']) => ({
		namespace,
		operation,
		label: `${namespace}.${operation}`,
		executionClass: 'remote_job',
		allowedTargets,
		defaultDispatchMode: 'auto',
		enabled: true,
		approvalPolicy: approvalDefaults[`${namespace}.${operation}`] ?? {
			requiresApproval: false,
			allowedRoles: ['team_owner', 'project_lead', 'technical_steward'],
			reason: 'Team permission is verified before execution.',
		},
		resourceScope: resourceScope(namespace, operation),
		metadata: {
			architectureTopology,
		},
	});
	const inline = (namespace, operation) => ({
		namespace,
		operation,
		label: `${namespace}.${operation}`,
		executionClass: 'remote_inline',
		allowedTargets: ['project_api', 'project_runner'],
		defaultDispatchMode: 'auto',
		enabled: true,
		approvalPolicy: { requiresApproval: false, allowedRoles: ['team_member'], reason: 'Read or draft-only project SDK operation.' },
		resourceScope: resourceScope(namespace, operation),
		metadata: { architectureTopology },
	});
	return [
		remoteJob('workflow', 'launch_project'),
		remoteJob('repository', 'create'),
		remoteJob('repository', 'configure'),
		remoteJob('workflow', 'apply_config'),
		remoteJob('workflow', 'reconcile_runtime'),
		remoteJob('workflow', 'deploy_runtime'),
		remoteJob('workflow', 'verify_runtime'),
		remoteJob('content', 'verify_package'),
		remoteJob('content', 'publish'),
		remoteJob('workflow', 'stage_release'),
		remoteJob('workflow', 'publish_release'),
		inline('sdk', 'read'),
		inline('sdk', 'search'),
		inline('sdk', 'create_direct_item'),
		inline('sdk', 'update_direct_item'),
	];
}

function resourceRowsFromLaunch(projectId, launch) {
	const rows = [];
	for (const [environment, summary] of [['staging', launch.cloudflare?.staging], ['prod', launch.cloudflare?.prod]]) {
		if (!summary) continue;
		rows.push(
			{
				projectId,
				environment,
				provider: 'cloudflare',
				resourceKind: 'pages',
				logicalName: 'site',
				locator: summary.pages?.url ?? summary.siteUrl ?? null,
				metadata: summary.pages ?? {},
			},
			{
				projectId,
				environment,
				provider: 'cloudflare',
				resourceKind: 'worker',
				logicalName: 'worker',
				locator: summary.workerName ?? null,
				metadata: { workerName: summary.workerName ?? null },
			},
			{
				projectId,
				environment,
				provider: 'cloudflare',
				resourceKind: 'kv',
				logicalName: 'form_guard',
				locator: summary.formGuardKv?.id ?? summary.formGuardKv?.name ?? null,
				metadata: summary.formGuardKv ?? {},
			},
			{
				projectId,
				environment,
				provider: 'cloudflare',
				resourceKind: 'turnstile-widget',
				logicalName: 'form_guard_turnstile',
				locator: summary.turnstileWidget?.sitekey ?? null,
				metadata: summary.turnstileWidget ?? {},
			},
			{
				projectId,
				environment,
				provider: 'cloudflare',
				resourceKind: 'r2',
				logicalName: 'content',
				locator: summary.content?.bucketName ?? null,
				metadata: summary.content ?? {},
			},
			{
				projectId,
				environment,
				provider: 'cloudflare',
				resourceKind: 'd1',
				logicalName: 'site_data',
				locator: summary.siteDataDb?.databaseId ?? summary.siteDataDb?.databaseName ?? null,
				metadata: summary.siteDataDb ?? {},
			},
		);
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

async function ensurePrincipal(c) {
	const principal = c.get('principal');
	if (!principal) {
		return {
			response: jsonError(c, 401, 'Authentication required.'),
		};
	}
	return { principal };
}

async function resolveUiProjectionContext(c, store) {
	const auth = await ensurePrincipal(c);
	if (auth.response) return auth;
	const teams = await store.listTeamsForPrincipal(auth.principal).catch(() => []);
	const activeTeam = teams[0] ?? null;
	const projects = activeTeam ? await store.listTeamProjects(activeTeam.id).catch(() => []) : [];
	return {
		principal: auth.principal,
		teams,
		activeTeam,
		projects,
	};
}

function decodeRouteParam(value) {
	let decoded = String(value ?? '');
	for (let index = 0; index < 2; index += 1) {
		try {
			const next = decodeURIComponent(decoded);
			if (next === decoded) break;
			decoded = next;
		} catch {
			break;
		}
	}
	return decoded;
}

function uiRuntimeLocals(config) {
	return {
		runtime: {
			resolved: {
				config: {
					repoRoot: config?.repoRoot ?? process.cwd(),
				},
			},
			env: {
				TREESEED_ENVIRONMENT: config?.environment ?? process.env.TREESEED_ENVIRONMENT ?? 'prod',
			},
		},
	};
}

function requireConfiguredServiceCredential(c, config) {
	const serviceId = c.req.header('x-treeseed-service-id') ?? '';
	const serviceSecret = c.req.header('x-treeseed-service-secret') ?? '';
	if (!config.webServiceId || !config.webServiceSecret || serviceId !== config.webServiceId || serviceSecret !== config.webServiceSecret) {
		return {
			response: jsonError(c, 401, 'Trusted Treeseed service credential required.'),
		};
	}
	return { ok: true };
}

async function resolvePublicTreeDxTeam(store, input = {}) {
	const requested = optionalTrimmedString(input.teamId)
		?? optionalTrimmedString(input.teamSlug)
		?? optionalTrimmedString(input.slug)
		?? 'treeseed-public';
	const existing = await store.getTeam(requested).catch(() => null)
		?? await store.getTeamBySlug(requested).catch(() => null);
	if (existing) return existing;
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

async function enqueueTreeDxProvisionOperation(store, teamId, payload, body = {}, requestedBy = {}) {
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
			dryRun: body.dryRun === true,
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

function principalHasGlobalPlatformRole(principal) {
	return Boolean(
		principal?.roles?.includes?.('platform_admin')
		|| principal?.roles?.includes?.('market_admin')
		|| principal?.permissions?.includes?.('*:*:*')
	);
}

async function requireTeamAccess(c, store, teamId, permission = null) {
	const auth = await ensurePrincipal(c);
	if (auth.response) {
		return auth;
	}
	const { principal } = auth;
	if (!(await store.principalCanAccessTeam(principal, teamId))) {
		return {
			response: jsonError(c, 403, 'Permission denied.', { teamId }),
		};
	}
	if (permission && isTeamApiPrincipal(principal) && !principalHasPermission(principal, permission)) {
		return {
			response: jsonError(c, 403, 'Permission denied.', { permission }),
		};
	}
	if (permission === 'teams:manage:team' && !isTeamApiPrincipal(principal) && !(await store.principalCanManageTeam(principal, teamId))) {
		return {
			response: jsonError(c, 403, 'Permission denied.', { permission }),
		};
	}
	return { principal };
}

async function requireProjectAccess(c, store, projectId, permission = null) {
	const auth = await ensurePrincipal(c);
	if (auth.response) {
		return auth;
	}
	const details = await store.getProjectDetails(projectId);
	if (!details) {
		return {
			response: jsonError(c, 404, `Unknown project "${projectId}".`),
		};
	}
	const access = await requireTeamAccess(c, store, details.project.teamId, permission);
	if (access.response) {
		return access;
	}
	return {
		principal: access.principal,
		details,
	};
}

function safePrivateKnowledgeSlug(value) {
	const slug = String(value ?? '').trim().replace(/^\/+|\/+$/gu, '');
	return slug && !slug.includes('..') ? slug : 'index';
}

function privateKnowledgeAuditPayload(body, extra = {}) {
	return {
		slug: safePrivateKnowledgeSlug(body?.slug),
		route: typeof body?.route === 'string' && body.route.startsWith('/app/projects/') ? body.route : null,
		summary: extra.summary ?? null,
		status: extra.status ?? null,
	};
}

async function recordPrivateKnowledgeAudit(store, input = {}) {
	if (typeof store.recordAuditEvent !== 'function') return null;
	return store.recordAuditEvent({
		eventType: input.eventType,
		actorType: input.actorType ?? 'user',
		actorId: input.actorId ?? null,
		targetType: 'project',
		targetId: input.projectId,
		data: privateKnowledgeAuditPayload(input.body, {
			status: input.status,
			summary: input.summary,
		}),
	});
}

const FEEDBACK_TYPES = new Set(['bug', 'feature_suggestion', 'question', 'content_issue', 'ux_issue']);
const FEEDBACK_SCREENSHOT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_FEEDBACK_MESSAGE_LENGTH = 4000;
const MAX_FEEDBACK_SCREENSHOT_BYTES = 2 * 1024 * 1024;

function cleanFeedbackString(value, maxLength = 500) {
	return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : '';
}

function safeFeedbackContext(context = {}) {
	const shell = ['auth', 'public', 'product'].includes(context.shell) ? context.shell : 'public';
	const surface = ['public', 'personal', 'team', 'project', 'market', 'seller', 'admin'].includes(context.context) ? context.context : 'public';
	const privateScoped = Boolean(context.teamId || context.projectId || surface === 'team' || surface === 'project' || surface === 'admin');
	return {
		url: cleanFeedbackString(context.url, 1200),
		canonicalPath: cleanFeedbackString(context.canonicalPath, 600),
		title: cleanFeedbackString(context.title, 300),
		capabilityId: cleanFeedbackString(context.capabilityId, 160),
		shell,
		context: surface,
		teamId: cleanFeedbackString(context.teamId, 160) || null,
		projectId: cleanFeedbackString(context.projectId, 160) || null,
		resourceType: cleanFeedbackString(context.resourceType, 120) || null,
		resourceId: cleanFeedbackString(context.resourceId, 240) || null,
		userId: cleanFeedbackString(context.userId, 160) || null,
		environment: ['local', 'staging', 'production'].includes(context.environment) ? context.environment : null,
		routePattern: cleanFeedbackString(context.routePattern, 300) || null,
		policy: cleanFeedbackString(context.policy, 80) || null,
		privateScoped,
	};
}

function safeFeedbackClient(client = {}) {
	const viewport = client.viewport && typeof client.viewport === 'object' ? client.viewport : {};
	return {
		url: cleanFeedbackString(client.url, 1200),
		userAgent: cleanFeedbackString(client.userAgent, 500),
		viewport: {
			width: Math.max(0, Math.min(10000, Number(viewport.width) || 0)),
			height: Math.max(0, Math.min(10000, Number(viewport.height) || 0)),
			devicePixelRatio: Math.max(0, Math.min(8, Number(viewport.devicePixelRatio) || 1)),
		},
		locale: cleanFeedbackString(client.locale, 80) || null,
		timeZone: cleanFeedbackString(client.timeZone, 120) || null,
		appearance: cleanFeedbackString(client.appearance, 120) || null,
		reducedMotion: client.reducedMotion === true,
	};
}

function safeFeedbackScreenshot(screenshot, privateScoped) {
	if (!screenshot || typeof screenshot !== 'object') return null;
	const type = cleanFeedbackString(screenshot.type, 80);
	const size = Number(screenshot.size) || 0;
	if (!FEEDBACK_SCREENSHOT_TYPES.has(type)) {
		return { ok: false, error: 'Unsupported screenshot type.' };
	}
	if (size <= 0 || size > MAX_FEEDBACK_SCREENSHOT_BYTES) {
		return { ok: false, error: 'Screenshot is too large.' };
	}
	const storagePolicy = privateScoped || screenshot.storagePolicy === 'private' ? 'private' : 'public';
	return {
		ok: true,
		value: {
			name: cleanFeedbackString(screenshot.name, 180) || 'feedback-screenshot.png',
			type,
			size,
			redacted: screenshot.redacted === true,
			storagePolicy,
			stored: true,
		},
	};
}

async function validateFeedbackAccess(c, store, context) {
	const principal = c.get('principal') ?? null;
	if (!context.privateScoped) return { principal, teamId: null, projectId: null };
	if (!principal) return { response: jsonError(c, 401, 'Authentication required for private feedback.') };
	if (context.projectId) {
		const details = await store.getProjectDetails(context.projectId);
		if (!details?.project) return { response: jsonError(c, 404, 'Feedback context not found.') };
		const teamContext = await store.resolvePrincipalTeamContext(details.project.teamId, principal);
		const allowed = Boolean(teamContext) && (!isTeamApiPrincipal(principal) || principalHasPermission(principal, 'projects:read:team'));
		if (!allowed) return { response: jsonError(c, 403, 'Permission denied.') };
		return { principal, teamId: details.project.teamId, projectId: details.project.id };
	}
	if (context.teamId) {
		const teamContext = await store.resolvePrincipalTeamContext(context.teamId, principal);
		const allowed = Boolean(teamContext) && (!isTeamApiPrincipal(principal) || principalHasPermission(principal, 'projects:read:team'));
		if (!allowed) return { response: jsonError(c, 403, 'Permission denied.') };
		return { principal, teamId: context.teamId, projectId: null };
	}
	return { response: jsonError(c, 400, 'Private feedback requires a team or project context.') };
}

async function recordFeedbackSubmission(c, store, body) {
	const type = cleanFeedbackString(body.type, 80);
	if (!FEEDBACK_TYPES.has(type)) return { response: jsonError(c, 400, 'Unsupported feedback type.') };
	const message = cleanFeedbackString(body.message, MAX_FEEDBACK_MESSAGE_LENGTH);
	if (!message) return { response: jsonError(c, 400, 'Feedback details are required.') };
	const context = safeFeedbackContext(body.context);
	if (context.privateScoped && body.context?.allowAnonymous === true) {
		return { response: jsonError(c, 400, 'Private feedback cannot be anonymous.') };
	}
	const access = await validateFeedbackAccess(c, store, context);
	if (access.response) return access;
	const screenshot = safeFeedbackScreenshot(body.screenshot, context.privateScoped);
	if (screenshot?.ok === false) return { response: jsonError(c, 400, screenshot.error) };
	const id = randomUUID();
	const payload = {
		id,
		type,
		message,
		contactEmail: cleanFeedbackString(body.contactEmail, 320) || null,
		context: {
			...context,
			teamId: access.teamId,
			projectId: access.projectId ?? context.projectId,
			userId: access.principal?.id ?? null,
		},
		client: safeFeedbackClient(body.client),
		screenshot: screenshot?.value ?? null,
	};
	await store.recordAuditEvent({
		eventType: 'feedback.submitted',
		actorType: access.principal ? (c.get('actorType') === 'service' ? 'service' : 'user') : 'anonymous',
		actorId: access.principal?.id ?? null,
		targetType: payload.context.projectId ? 'project' : payload.context.teamId ? 'team' : 'market',
		targetId: payload.context.projectId ?? payload.context.teamId ?? 'public-feedback',
		data: payload,
	});
	if (payload.context.teamId) {
		await store.upsertTeamInboxItem(payload.context.teamId, {
			id: `feedback:${id}`,
			projectId: payload.context.projectId,
			kind: 'feedback',
			state: 'new',
			title: `${payload.context.title || 'Product'} feedback`,
			summary: `${type.replace(/_/gu, ' ')} feedback received.`,
			href: payload.context.canonicalPath || '/app/',
			itemKey: id,
			metadata: {
				feedbackId: id,
				type,
				shell: payload.context.shell,
				context: payload.context.context,
				hasScreenshot: Boolean(payload.screenshot),
				screenshotStoragePolicy: payload.screenshot?.storagePolicy ?? null,
			},
		});
	}
	return {
		id,
		privateScoped: context.privateScoped,
		hasScreenshot: Boolean(payload.screenshot),
	};
}

function normalizeSeedEnvironments(value) {
	if (Array.isArray(value)) {
		return value.map((entry) => String(entry ?? '').trim()).filter(Boolean).join(',');
	}
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function seedActor(c) {
	const principal = c.get('principal');
	return {
		actorType: c.get('actorType') === 'service' ? 'service' : c.get('actorType') === 'project' ? 'project' : 'user',
		principal,
	};
}

function seedExistingTeamIds(plan) {
	return [...new Set(plan.actions
		.filter((action) => action.kind === 'team' && action.existing?.id)
		.map((action) => action.existing.id))];
}

function seedCreatesMissingTeams(plan) {
	return plan.actions.some((action) => action.kind === 'team' && action.action === 'create');
}

async function requireSeedPlanAccess(c, store, plan) {
	const auth = await ensurePrincipal(c);
	if (auth.response) return auth;
	for (const teamId of seedExistingTeamIds(plan)) {
		if (!(await store.principalCanAccessTeam(auth.principal, teamId))) {
			return { response: jsonError(c, 403, 'Permission denied.', { teamId }) };
		}
	}
	return auth;
}

async function requireSeedApplyAccess(c, store, plan) {
	const auth = await requireSeedPlanAccess(c, store, plan);
	if (auth.response) return auth;
	for (const teamId of seedExistingTeamIds(plan)) {
		const canManage = isTeamApiPrincipal(auth.principal)
			? principalHasPermission(auth.principal, 'teams:manage:team')
			: await store.principalCanManageTeam(auth.principal, teamId);
		if (!canManage) {
			return { response: jsonError(c, 403, 'Permission denied.', { permission: 'teams:manage:team', teamId }) };
		}
	}
	if (seedCreatesMissingTeams(plan) && !principalIsSeedAdmin(auth.principal)) {
		return { response: jsonError(c, 403, 'Permission denied.', { permission: 'seeds:apply:global' }) };
	}
	return auth;
}

async function requireProjectRunner(c, store, projectId) {
	const token = bearerTokenFromRequest(c.req.raw);
	if (!token) {
		return {
			response: jsonError(c, 401, 'Authentication required.'),
		};
	}
	const runner = await store.authenticateRunner(projectId, token);
	if (!runner) {
		return {
			response: jsonError(c, 401, 'Invalid project runner token.'),
		};
	}
	return { runner };
}

async function requireCapacityProviderKey(c, store, requiredScopes = []) {
	const token = bearerTokenFromRequest(c.req.raw);
	if (!token) {
		return {
			response: jsonError(c, 401, 'Capacity provider API key required.'),
		};
	}
	const auth = typeof store.authenticateCapacityProviderApiKey === 'function'
		? await store.authenticateCapacityProviderApiKey(token, requiredScopes)
		: { ok: false, reason: 'invalid' };
	if (!auth.ok) {
		if (auth.reason === 'insufficient_scope') {
			return {
				response: jsonError(c, 403, 'Capacity provider API key does not include the required scope.', {
					requiredScopes,
				}),
			};
		}
		return {
			response: jsonError(c, 401, 'Invalid, expired, or revoked capacity provider API key.'),
		};
	}
	const principal = auth.principal;
	const provider = await store.getCapacityProvider(principal.teamId, principal.capacityProviderId);
	if (!provider) {
		return {
			response: jsonError(c, 401, 'Unknown capacity provider.'),
		};
	}
	return { principal, provider };
}

async function requireDxProjectAccess(c, store, projectId, permission = 'projects:read:team') {
	const details = await store.getProjectDetails(projectId);
	if (!details) {
		return {
			response: jsonError(c, 404, `Unknown project "${projectId}".`),
		};
	}
	if (c.get('principal')) {
		const access = await requireProjectAccess(c, store, projectId, permission);
		if (access.response) return access;
		return {
			...access,
			actorType: c.get('actorType') ?? 'user',
		};
	}
	const requiredScopes = permission === 'projects:manage:team'
		? ['provider:assignments:write']
		: ['provider:assignments:read'];
	const providerAccess = await requireCapacityProviderKey(c, store, requiredScopes);
	if (providerAccess.response) return providerAccess;
	if (providerAccess.provider.teamId !== details.project.teamId) {
		return {
			response: jsonError(c, 403, 'Capacity provider cannot access this project.', {
				projectId,
				teamId: details.project.teamId,
			}),
		};
	}
	return {
		...providerAccess,
		details,
		actorType: 'capacity_provider',
	};
}

function treeDxRequiredProxyScope(tokenScope) {
	const handleScope = (resource, action) => `${resource}:${action}`;
	const capabilities = Array.isArray(tokenScope?.capabilities) ? tokenScope.capabilities.map(String) : [];
	const writeCapability = capabilities.some((capability) => /write|commit|create|delete|refresh/.test(capability));
	if (writeCapability) return ['project:write', handleScope('workspace', 'write'), 'git:commit'];
	return ['project:read', handleScope('workspace', 'read'), 'files:read'];
}

function treeDxPathMatches(pattern, candidate) {
	const normalizedPattern = String(pattern ?? '').replace(/^\/+/, '');
	const normalizedCandidate = String(candidate ?? '').replace(/^\/+/, '');
	if (!normalizedPattern || normalizedPattern === '**' || normalizedPattern === '*') return true;
	if (normalizedPattern.endsWith('/**')) {
		const prefix = normalizedPattern.slice(0, -3);
		return normalizedCandidate === prefix || normalizedCandidate.startsWith(`${prefix}/`);
	}
	if (normalizedPattern.endsWith('*')) return normalizedCandidate.startsWith(normalizedPattern.slice(0, -1));
	return normalizedCandidate === normalizedPattern || normalizedCandidate.startsWith(`${normalizedPattern}/`);
}

function evaluateTreeDxProxyHandleAccessLocal(handle, request) {
	if (!handle?.id) return { ok: false, code: 'treedx_proxy_handle_missing', reason: 'TreeDX proxy handle is required.' };
	if (handle.status === 'revoked' || handle.revokedAt) return { ok: false, code: 'treedx_proxy_handle_revoked', reason: 'TreeDX proxy handle has been revoked.' };
	if (handle.status === 'expired') return { ok: false, code: 'treedx_proxy_handle_expired', reason: 'TreeDX proxy handle has expired.' };
	if (handle.projectId !== request.projectId || (request.teamId && handle.teamId !== request.teamId)) {
		return { ok: false, code: 'treedx_proxy_scope_mismatch', reason: 'TreeDX proxy handle scope does not match the project.' };
	}
	if (request.assignmentId && handle.assignmentId && handle.assignmentId !== request.assignmentId) {
		return { ok: false, code: 'treedx_proxy_assignment_mismatch', reason: 'TreeDX proxy handle is bound to a different assignment.' };
	}
	if (request.repositoryId && handle.repositoryId && handle.repositoryId !== request.repositoryId) {
		return { ok: false, code: 'treedx_proxy_repository_mismatch', reason: 'TreeDX proxy handle is bound to a different repository.' };
	}
	if (request.workspaceId && handle.workspaceId && handle.workspaceId !== request.workspaceId) {
		return { ok: false, code: 'treedx_proxy_workspace_mismatch', reason: 'TreeDX proxy handle is bound to a different workspace.' };
	}
	if (handle.expiresAt && Date.parse(handle.expiresAt) <= Date.now()) {
		return { ok: false, code: 'treedx_proxy_handle_expired', reason: 'TreeDX proxy handle has expired.' };
	}
	if (handle.tokenHash && !request.token) {
		return { ok: false, code: 'treedx_proxy_token_mismatch', reason: 'TreeDX proxy handle token is required.' };
	}
	const operation = request.operation ? String(request.operation) : null;
	const allowedOperations = Array.isArray(handle.allowedOperations) ? handle.allowedOperations.map(String) : [];
	if (operation && allowedOperations.length && !allowedOperations.includes(operation) && !allowedOperations.includes('*')) {
		return { ok: false, code: 'treedx_proxy_operation_denied', reason: 'TreeDX proxy handle does not allow this operation.', metadata: { operation, allowedOperations } };
	}
	const path = request.path ? String(request.path).replace(/^\/+/, '') : null;
	const writeOperation = operation === 'files:write' || operation === 'git:commit';
	const readPaths = Array.isArray(handle.allowedReadPaths) ? handle.allowedReadPaths.map(String).filter(Boolean) : [];
	const writePaths = Array.isArray(handle.allowedWritePaths) ? handle.allowedWritePaths.map(String).filter(Boolean) : [];
	const fallbackPaths = Array.isArray(handle.allowedPaths) ? handle.allowedPaths.map(String).filter(Boolean) : [];
	const allowedPaths = writeOperation
		? (writePaths.length ? writePaths : fallbackPaths)
		: (readPaths.length ? readPaths : fallbackPaths);
	if (path && allowedPaths.length && !allowedPaths.some((pattern) => treeDxPathMatches(pattern, path))) {
		return { ok: false, code: 'treedx_proxy_path_denied', reason: 'TreeDX proxy handle does not allow this path.', metadata: { path, allowedPaths } };
	}
	return { ok: true };
}

async function requireAssignmentScopedTreeDxProxyAccess(c, store, access, projectId, tokenScope) {
	if (access.actorType !== 'capacity_provider') return { assignment: null, handle: null };
	const assignmentId = c.req.header('x-treeseed-assignment-id') ?? c.req.query('assignmentId') ?? null;
	const handleId = c.req.header('x-treeseed-treedx-proxy-handle-id') ?? c.req.query('treeDxProxyHandleId') ?? null;
	const providerTeamId = access.principal.teamId;
	const denied = async (status, error, details = {}) => {
		const requestPath = new URL(c.req.url, 'http://treeseed.local').pathname;
		await store.recordTreeDxProxyAudit?.({
			teamId: providerTeamId,
			projectId,
			assignmentId: assignmentId ?? null,
			actorType: access.actorType,
			actorId: access.principal?.id ?? access.provider?.id ?? null,
			method: c.req.method,
			path: requestPath,
			handle: { id: handleId ?? null },
			resultStatus: 'denied',
			reasonCode: details.code ?? 'treedx_proxy_denied',
			reason: error,
			metadata: { details },
		}).catch(() => null);
		return { response: jsonError(c, status, error, details) };
	};
	if (!assignmentId || !handleId) {
		return denied(403, 'Capacity provider TreeDX proxy access requires an assignment-scoped proxy handle.', {
			code: 'treedx_proxy_handle_missing',
			projectId,
			assignmentId: assignmentId ?? null,
		});
	}
	const assignment = await store.getProviderAssignment(access.principal.teamId, assignmentId);
	if (!assignment || assignment.projectId !== projectId || assignment.capacityProviderId !== access.principal.capacityProviderId) {
		return denied(403, 'TreeDX proxy handle is not bound to this provider assignment.', {
			code: 'treedx_proxy_assignment_mismatch',
			projectId,
			assignmentId,
		});
	}
	if (assignment.leaseState !== 'leased' || !assignment.leaseExpiresAt || Date.parse(assignment.leaseExpiresAt) <= Date.now()) {
		return denied(403, 'TreeDX proxy handle requires an active assignment lease.', {
			code: 'treedx_proxy_assignment_not_leased',
			projectId,
			assignmentId,
			leaseState: assignment.leaseState,
		});
	}
	const storedHandle = await store.getTreeDxProxyHandle?.(providerTeamId, projectId, handleId).catch(() => null);
	const embeddedHandle = assignment.treedxProxyHandle && typeof assignment.treedxProxyHandle === 'object' ? assignment.treedxProxyHandle : {};
	const handle = storedHandle ?? embeddedHandle;
	if (handle.id !== handleId || handle.projectId !== projectId || handle.teamId !== access.principal.teamId || (handle.assignmentId && handle.assignmentId !== assignmentId)) {
		return denied(403, 'TreeDX proxy handle scope does not match the active assignment.', {
			code: 'treedx_proxy_scope_mismatch',
			projectId,
			assignmentId,
			handleId,
		});
	}
	const presentedToken = c.req.header('x-treeseed-treedx-proxy-handle') ?? c.req.query('treeDxProxyToken') ?? null;
	if (handle.tokenHash && (!presentedToken || createHash('sha256').update(presentedToken).digest('hex') !== handle.tokenHash)) {
		return denied(403, 'TreeDX proxy handle token does not match.', {
			code: 'treedx_proxy_token_mismatch',
			projectId,
			assignmentId,
			handleId,
		});
	}
	const scopes = Array.isArray(handle.scopes) ? handle.scopes.map(String) : [];
	const acceptableScopes = treeDxRequiredProxyScope(tokenScope);
	if (!acceptableScopes.some((scope) => scopes.includes(scope))) {
		return denied(403, 'TreeDX proxy handle does not allow this operation.', {
			code: 'treedx_proxy_scope_denied',
			projectId,
			assignmentId,
			requiredAny: acceptableScopes,
		});
	}
	const capability = Array.isArray(tokenScope?.capabilities) ? tokenScope.capabilities.map(String).find(Boolean) : null;
	const repoIds = Array.isArray(tokenScope?.repoIds) ? tokenScope.repoIds.map(String).filter((entry) => entry && entry !== '*') : [];
	const paths = Array.isArray(tokenScope?.paths) ? tokenScope.paths.map(String).filter((entry) => entry && entry !== '**') : [];
	const requestPath = paths.length === 1 ? paths[0] : null;
	const workspaceMatch = new URL(c.req.url, 'http://treeseed.local').pathname.match(/\/workspaces\/([^/]+)/u);
	const accessResult = evaluateTreeDxProxyHandleAccessLocal(handle, {
		teamId: providerTeamId,
		projectId,
		assignmentId,
		repositoryId: repoIds[0] ?? null,
		workspaceId: workspaceMatch?.[1] ? decodeURIComponent(workspaceMatch[1]) : null,
		operation: capability,
		path: requestPath,
		token: presentedToken,
	});
	if (!accessResult.ok) {
		return denied(403, accessResult.reason ?? 'TreeDX proxy handle does not allow this request.', {
			code: accessResult.code ?? 'treedx_proxy_request_denied',
			projectId,
			assignmentId,
			handleId,
			...(accessResult.metadata ?? {}),
		});
	}
	return { assignment, handle };
}

function runtimeEnv(runtime) {
	return {
		...process.env,
		...(runtime?.env && typeof runtime.env === 'object' ? runtime.env : {}),
	};
}

function isLoopbackTreeDxBaseUrl(baseUrl) {
	try {
		const url = new URL(baseUrl);
		return ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
	} catch {
		return false;
	}
}

function treeDxProxyActorId(env) {
	return env.TREESEED_TREEDX_PROXY_ACTOR_ID
		?? env.TREESEED_TREEDX_ACTOR_ID
		?? 'treeseed-api';
}

function treeDxProxyTenantId(env) {
	return env.TREESEED_TREEDX_PROXY_TENANT_ID
		?? env.TREESEED_TREEDX_TENANT_ID
		?? 'treeseed-control-plane';
}

function treeDxTokenScope({ repoId = null, repoIds = null, capabilities = [], refs = ['*'], paths = [] } = {}) {
	const scopedRepoIds = Array.isArray(repoIds)
		? repoIds.map((entry) => String(entry ?? '').trim()).filter(Boolean)
		: null;
	return {
		repoIds: scopedRepoIds?.length ? scopedRepoIds : repoId ? [repoId] : ['*'],
		capabilities: [...new Set(capabilities.map((entry) => String(entry ?? '').trim()).filter(Boolean))],
		refs,
		paths,
	};
}

function treeDxRepoScopedContextBody(body, repoId) {
	const sanitized = body && typeof body === 'object' && !Array.isArray(body) ? { ...body } : {};
	delete sanitized.repoIds;
	delete sanitized.refs;
	if (sanitized.paths && !Array.isArray(sanitized.paths)) {
		delete sanitized.paths;
	}
	return {
		...sanitized,
		repoId,
	};
}

function treeDxScopeCacheKey(scope) {
	return JSON.stringify({
		repoIds: scope.repoIds ?? [],
		capabilities: scope.capabilities ?? [],
		refs: scope.refs ?? [],
		paths: scope.paths ?? [],
	});
}

function resolveTreeDxProxyBaseUrl({ runtime, library }) {
	const env = runtimeEnv(runtime);
	return normalizeBaseUrl(
		library?.topology?.contentRepository?.treeDx?.baseUrl
		?? env.TREESEED_TREEDX_URL
		?? env.TREESEED_TREEDX_BASE_URL
		?? env.TREESEED_PUBLIC_TREEDX_BASE_URL
		?? 'http://127.0.0.1:4000',
	);
}

async function resolveTreeDxProxyToken({ runtime, baseUrl, projectId, scope = treeDxTokenScope() }) {
	const env = runtimeEnv(runtime);
	const secret = env.TREESEED_TREEDX_JWT_HS256_SECRET
		?? env.TREEDX_JWT_HS256_SECRET
		?? null;
	const issuer = env.TREESEED_TREEDX_JWT_ISSUER
		?? env.TREEDX_JWT_ISSUER
		?? (secret ? 'https://api.treeseed.local/treedx' : null);
	const audience = env.TREESEED_TREEDX_JWT_AUDIENCE
		?? env.TREEDX_JWT_AUDIENCE
		?? (secret ? 'treedx-local' : null);
	if (!secret || !issuer || !audience) {
		return null;
	}
	const actorId = treeDxProxyActorId(env);
	const tenantId = treeDxProxyTenantId(env);
	const normalizedScope = treeDxTokenScope(scope);
	const cacheKey = [baseUrl, issuer, audience, actorId, tenantId, treeDxScopeCacheKey(normalizedScope)].join('|');
	const cached = treeDxProxyTokenCache.get(cacheKey);
	const now = Math.floor(Date.now() / 1000);
	if (cached?.accessToken && cached.expiresAtEpoch - 30 > now) return cached.accessToken;
	const header = { alg: 'HS256', typ: 'JWT' };
	const payload = {
		iss: issuer,
		aud: audience,
		sub: actorId,
		jti: randomUUID(),
		iat: now,
		nbf: now - 5,
		exp: now + 300,
		treedx_actor_id: actorId,
		treedx_tenant_id: tenantId,
		treedx_repo_ids: normalizedScope.repoIds,
		treedx_capabilities: normalizedScope.capabilities,
		treedx_refs: normalizedScope.refs,
		treedx_paths: normalizedScope.paths,
		treeseed_project_id: projectId,
	};
	const signingInput = `${base64urlJson(header)}.${base64urlJson(payload)}`;
	const signature = createHmac('sha256', secret).update(signingInput).digest('base64url');
	const accessToken = `${signingInput}.${signature}`;
	treeDxProxyTokenCache.set(cacheKey, { accessToken, expiresAtEpoch: payload.exp, createdAt: new Date().toISOString() });
	return accessToken;
}

function assertDxRepoMatchesProject(c, library, repoId) {
	const expected = library?.repositoryId ?? library?.topology?.contentRepository?.treeDx?.repositoryId ?? null;
	if (expected && repoId && expected !== repoId) {
		return jsonError(c, 403, 'TreeDX repository is not bound to this project.', {
			repositoryId: repoId,
			expectedRepositoryId: expected,
		});
	}
	return null;
}

function treeDxPathScope(filePath) {
	const normalized = String(filePath ?? '').replace(/^\/+/, '');
	return normalized ? [normalized] : [];
}

async function assertDxWorkspaceMatchesProject({ c, runtime, projectId, library, baseUrl, workspaceId }) {
	const expectedRepoId = library?.repositoryId ?? library?.topology?.contentRepository?.treeDx?.repositoryId ?? null;
	if (!expectedRepoId) {
		return jsonError(c, 404, 'TreeDX repository is not bound to this project.', { projectId });
	}
	const token = await resolveTreeDxProxyToken({
		runtime,
		baseUrl,
		projectId,
		scope: treeDxTokenScope({
			repoId: expectedRepoId,
			capabilities: ['files:read'],
			paths: ['**'],
		}),
	});
	if (!token) return jsonError(c, 503, 'TreeDX proxy token is not configured for this project.', { projectId });
	const response = await fetch(`${baseUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId)}`, {
		method: 'GET',
		headers: {
			accept: 'application/json',
			authorization: `Bearer ${token}`,
		},
	});
	const payload = await response.json().catch(() => null);
	if (!response.ok) {
		return jsonError(c, response.status, 'TreeDX workspace could not be verified for this project.', {
			projectId,
			workspaceId,
			details: payload?.error ?? payload,
		});
	}
	const workspace = payload?.workspace ?? payload?.payload?.workspace ?? payload?.payload ?? payload;
	const actualRepoId = workspace?.repoId ?? workspace?.repositoryId ?? null;
	if (actualRepoId !== expectedRepoId) {
		return jsonError(c, 403, 'TreeDX workspace is not bound to this project repository.', {
			projectId,
			workspaceId,
			repositoryId: actualRepoId,
			expectedRepositoryId: expectedRepoId,
		});
	}
	return null;
}

async function proxyTreeDxJson({ c, runtime, store, projectId, permission, method, path, body, tokenScope }) {
	const access = await requireDxProjectAccess(c, store, projectId, permission);
	if (access.response) return access.response;
	const scopedProxyAccess = await requireAssignmentScopedTreeDxProxyAccess(c, store, access, projectId, tokenScope);
	if (scopedProxyAccess.response) return scopedProxyAccess.response;
	const library = await store.getProjectTreeDxLibrary(projectId);
	const baseUrl = resolveTreeDxProxyBaseUrl({ runtime, library });
	let token = null;
	try {
		token = await resolveTreeDxProxyToken({ runtime, baseUrl, projectId, scope: tokenScope });
	} catch (error) {
		return jsonError(c, 503, 'TreeDX proxy token could not be resolved.', {
			projectId,
			details: error instanceof Error ? error.message : String(error),
		});
	}
	if (!token) {
		return jsonError(c, 503, 'TreeDX proxy token is not configured for this project.', { projectId });
	}
	let response;
	try {
		response = await fetch(`${baseUrl}${path}`, {
			method,
			headers: {
				accept: 'application/json',
				authorization: `Bearer ${token}`,
				...(body === undefined ? {} : { 'content-type': 'application/json' }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	} catch (error) {
		return jsonError(c, 503, 'TreeDX runtime is unavailable for this project.', {
			projectId,
			details: error instanceof Error ? error.message : String(error),
		});
	}
	const payload = await response.json().catch(() => null);
	if (!response.ok) {
		return jsonError(c, response.status, `TreeDX ${method} ${path} failed.`, {
			status: response.status,
			details: payload?.error ?? payload,
		});
	}
	if (method === 'POST' && path === '/api/v1/repos') {
		const repo = payload?.repo ?? payload?.repository ?? payload;
		const repoId = repo?.repoId ?? repo?.id ?? null;
		if (repoId && isLoopbackTreeDxBaseUrl(baseUrl)) {
			const grantToken = await resolveTreeDxProxyToken({
				runtime,
				baseUrl,
				projectId,
				scope: treeDxTokenScope({
					repoId,
					capabilities: ['policy:write'],
					paths: ['**'],
				}),
			});
			const grantResponse = await fetch(`${baseUrl}/api/v1/policy/grants`, {
				method: 'POST',
				headers: {
					accept: 'application/json',
					authorization: `Bearer ${grantToken ?? token}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					actorId: treeDxProxyActorId(runtimeEnv(runtime)),
					tenantId: treeDxProxyTenantId(runtimeEnv(runtime)),
					repoIds: [repoId],
					capabilities: [
						'repos:read',
						'repos:write',
						'files:read',
						'files:write',
						'files:search',
						'graph:query',
						'graph:refresh',
						TREE_DX_WORKSPACE_CREATE_CAPABILITY,
						'git:read',
						'git:diff',
						'git:commit',
					],
					refs: ['*'],
					paths: ['**'],
				}),
			});
			if (!grantResponse.ok) {
				const grantPayload = await grantResponse.json().catch(() => null);
				return jsonError(c, grantResponse.status, 'TreeDX repository was created but proxy capability grant failed.', {
					repositoryId: repoId,
					details: grantPayload?.error ?? grantPayload,
				});
			}
		}
	}
	const auditProject = await store.getProject(projectId).catch(() => null);
	await store.recordTreeDxProxyAudit?.({
		teamId: auditProject?.teamId ?? access.provider?.teamId ?? access.principal?.teamId ?? null,
		projectId,
		assignmentId: scopedProxyAccess.assignment?.id ?? c.req.header('x-treeseed-assignment-id') ?? c.req.query('assignmentId') ?? null,
		actorType: access.actorType,
		actorId: access.principal?.id ?? access.provider?.id ?? null,
		method,
		path,
		handle: {
			...(scopedProxyAccess.handle ?? {}),
			projectId,
			assignmentId: scopedProxyAccess.assignment?.id ?? c.req.header('x-treeseed-assignment-id') ?? c.req.query('assignmentId') ?? null,
			scopes: tokenScope?.capabilities ?? [],
		},
		resultStatus: 'proxied',
		metadata: {
			tokenScope,
			providerAssignmentScoped: access.actorType === 'capacity_provider',
		},
	}).catch(() => null);
	return c.json({
		ok: true,
		payload,
		proxy: {
			projectId,
			actorType: access.actorType,
			treeDxBaseUrl: baseUrl,
		},
	});
}

const AGENT_TASK_SIGNATURES = {
	'question.summarize': {
		defaultCredits: 3,
		requiredCapabilities: ['agent_execution'],
		repositoryMutation: false,
		bindingWork: false,
		productionAllowed: true,
		priorityClass: 'background',
	},
	'proposal.draft': {
		defaultCredits: 5,
		requiredCapabilities: ['agent_execution'],
		repositoryMutation: false,
		bindingWork: false,
		productionAllowed: true,
		priorityClass: 'interactive',
	},
	'proposal.compare': {
		defaultCredits: 5,
		requiredCapabilities: ['agent_execution'],
		repositoryMutation: false,
		bindingWork: false,
		productionAllowed: true,
		priorityClass: 'background',
	},
	'decision.summary': {
		defaultCredits: 4,
		requiredCapabilities: ['agent_execution', 'reporting'],
		repositoryMutation: false,
		bindingWork: false,
		productionAllowed: true,
		priorityClass: 'background',
	},
	'release.summary': {
		defaultCredits: 4,
		requiredCapabilities: ['agent_execution', 'reporting'],
		repositoryMutation: false,
		bindingWork: false,
		productionAllowed: true,
		priorityClass: 'background',
	},
	'market.description.draft': {
		defaultCredits: 4,
		requiredCapabilities: ['agent_execution'],
		repositoryMutation: false,
		bindingWork: false,
		productionAllowed: true,
		priorityClass: 'interactive',
	},
	'repository.change.apply': {
		defaultCredits: 10,
		requiredCapabilities: ['agent_execution', 'repository_work'],
		repositoryMutation: true,
		bindingWork: true,
		productionAllowed: false,
		priorityClass: 'interactive',
	},
	'verification.run': {
		defaultCredits: 6,
		requiredCapabilities: ['agent_execution', 'repository_work', 'reporting'],
		repositoryMutation: false,
		bindingWork: false,
		productionAllowed: false,
		priorityClass: 'background',
	},
	'workday.report': {
		defaultCredits: 2,
		requiredCapabilities: ['agent_execution', 'reporting'],
		repositoryMutation: false,
		bindingWork: false,
		productionAllowed: true,
		priorityClass: 'background',
	},
};

function resolveAgentTaskSignature(value) {
	const signature = typeof value === 'string' && value.trim() ? value.trim() : 'proposal.draft';
	return {
		signature,
		definition: AGENT_TASK_SIGNATURES[signature] ?? AGENT_TASK_SIGNATURES['proposal.draft'],
	};
}

function commerceErrorResponse(c, error) {
	const status = Number(error?.status ?? 500);
	if (![400, 401, 403, 404, 409, 502].includes(status)) throw error;
	return jsonError(c, status, error instanceof Error ? error.message : String(error), error?.details ?? {});
}

function stripeConfiguredError() {
	const error = new Error('Stripe Connect is not configured for this market.');
	error.status = 409;
	return error;
}

function stripeVendorApprovalError() {
	const error = new Error('Commerce vendor approval is required before Stripe onboarding.');
	error.status = 409;
	return error;
}

function stripeAccountMissingError() {
	const error = new Error('Stripe connected account is not linked for this vendor.');
	error.status = 409;
	return error;
}

function stripeCommerceUrl(config, teamId, marker) {
	const base = normalizeBaseUrl(config.siteUrl ?? config.baseUrl ?? 'http://localhost:4321') || 'http://localhost:4321';
	const url = new URL(`/app/teams/${encodeURIComponent(teamId)}/commerce`, `${base}/`);
	url.searchParams.set('stripe', marker);
	return url.toString();
}

async function requireCommerceVendorForStripe(store, teamId) {
	const vendor = await store.getCommerceVendorForTeam(teamId);
	if (!vendor) {
		const error = new Error(`Commerce vendor for team "${teamId}" was not found.`);
		error.status = 404;
		throw error;
	}
	if (vendor.status !== 'approved') throw stripeVendorApprovalError();
	return vendor;
}

async function refreshCommerceStripeAccount({ store, stripeConnectService, account, actorType = 'system', actorId = null }) {
	if (!account) return null;
	const configured = await stripeConnectService.isConfigured();
	if (!configured) return account;
	const stripeAccount = await stripeConnectService.retrieveAccount(account.stripeAccountId);
	if (!stripeAccount) return account;
	return store.recordCommerceStripeAccountStatus(account.id, {
		...stripeAccountToConnectedAccountPatch(stripeAccount, account.environment),
		actorType,
		actorId,
	});
}

const STRIPE_PRODUCT_MIRROR_OFFER_MODES = new Set([
	'one_time',
	'one_time_current_version',
	'subscription',
	'subscription_updates',
	'professional_hosting',
	'scoped_contract',
]);
const STRIPE_PRICE_MIRROR_OFFER_MODES = new Set([
	'one_time',
	'one_time_current_version',
	'subscription',
	'subscription_updates',
	'professional_hosting',
]);

function stripeMetadataValue(value) {
	if (value === null || value === undefined) return '';
	if (typeof value === 'string') return value.slice(0, 500);
	return String(value).slice(0, 500);
}

function buildCommerceStripeMetadata({ environment, vendor, product, ownership, offer, price = null }) {
	return Object.fromEntries(Object.entries({
		treeseed_environment: environment,
		treeseed_vendor_id: vendor?.id,
		treeseed_seller_team_id: product?.sellerTeamId ?? offer?.sellerTeamId,
		treeseed_product_id: product?.id ?? offer?.productId,
		treeseed_product_version_id: offer?.productVersionId,
		treeseed_offer_id: offer?.id,
		treeseed_price_id: price?.id,
		treeseed_price_version: price?.priceVersion,
		treeseed_ownership_model: product?.ownershipModel,
		treeseed_ownership_record_id: product?.ownershipRecordId ?? ownership?.id,
		treeseed_object_authority: 'treeseed',
		treeseed_sync_phase: 'phase_4',
	}).map(([key, value]) => [key, stripeMetadataValue(value)]));
}

function commerceStripeProductParams({ product, offer, metadata }) {
	return {
		name: optionalTrimmedString(offer?.title) ?? product.title,
		description: optionalTrimmedString(offer?.termsSummary)
			?? optionalTrimmedString(product.summary)
			?? optionalTrimmedString(product.description)
			?? undefined,
		active: product.status === 'approved' && offer.status === 'approved',
		metadata,
	};
}

function commerceStripeLookupKey(environment, price) {
	return `treeseed_${environment}_${price.id}_v${price.priceVersion}`;
}

function commerceStripePriceParams({ offer, price, stripeProductId, metadata, environment }) {
	const params = {
		product: stripeProductId,
		unit_amount: price.amount,
		currency: price.currency,
		lookup_key: price.stripeLookupKey ?? commerceStripeLookupKey(environment, price),
		metadata,
	};
	if (price.taxBehavior && price.taxBehavior !== 'unspecified') {
		params.tax_behavior = price.taxBehavior;
	}
	if (['subscription', 'subscription_updates', 'professional_hosting'].includes(offer.mode)) {
		params.recurring = { interval: price.billingInterval };
	}
	return params;
}

function stripePriceTermsDrift(stripePrice, price, offer) {
	const recurringInterval = stripePrice?.recurring?.interval ?? 'one_time';
	const expectedInterval = ['subscription', 'subscription_updates', 'professional_hosting'].includes(offer.mode)
		? price.billingInterval
		: 'one_time';
	return Number(stripePrice?.unit_amount ?? -1) !== price.amount
		|| String(stripePrice?.currency ?? '').toLowerCase() !== price.currency
		|| recurringInterval !== expectedInterval;
}

async function commerceStripeSyncContext({ store, stripeConnectService, offer, environment }) {
	const product = await store.getCommerceProduct(offer.productId);
	const vendor = product ? await store.getCommerceVendor(product.vendorId) : null;
	const ownershipRecords = product ? await store.listCommerceOwnershipRecords(product.id).catch(() => []) : [];
	const ownership = ownershipRecords.find((record) => record.id === product?.ownershipRecordId) ?? ownershipRecords[0] ?? null;
	const account = vendor ? await store.getCommerceVendorStripeAccount(vendor.id, environment) : null;
	return { product, vendor, ownership, account };
}

async function syncCommerceOfferStripeProduct({
	store,
	stripeConnectService,
	offer,
	actorType = 'system',
	actorId = null,
	reconcile = false,
	throwOnBlocked = false,
}) {
	const environment = stripeConnectService.environment ?? 'test';
	if (!STRIPE_PRODUCT_MIRROR_OFFER_MODES.has(offer.mode)) {
		return { offer, skipped: true, reason: 'Offer mode does not require a Stripe Product mirror.' };
	}
	const context = await commerceStripeSyncContext({ store, stripeConnectService, offer, environment });
	const block = async (reason) => {
		const updated = await store.markCommerceOfferStripeSyncBlocked(offer.id, {
			reason,
			actorType,
			actorId,
			evidence: { environment, vendorId: context.vendor?.id ?? null },
		});
		if (throwOnBlocked) {
			const error = new Error(reason);
			error.status = 409;
			throw error;
		}
		return { offer: updated, blocked: true, reason };
	};
	if (!context.product || !context.vendor) return block('Commerce product or vendor was not found for Stripe Product sync.');
	if (context.vendor.status !== 'approved') return block('Commerce vendor approval is required before Stripe Product sync.');
	if (!await stripeConnectService.isConfigured()) return block('Stripe Connect is not configured for this market.');
	if (!context.account) return block('Stripe connected account is not linked for this vendor.');
	if (context.account.accountStatus !== 'enabled') return block('Stripe connected account must be enabled before Product sync.');
	const metadata = buildCommerceStripeMetadata({ environment, ...context, offer });
	const params = commerceStripeProductParams({ product: context.product, offer, metadata });
	try {
		const stripeProduct = offer.stripeProductId
			? await stripeConnectService.updateProductMirror({
				connectedAccountId: context.account.stripeAccountId,
				stripeProductId: offer.stripeProductId,
				params,
			})
			: await stripeConnectService.createProductMirror({
				connectedAccountId: context.account.stripeAccountId,
				params,
			});
		if (!stripeProduct?.id) return block('Stripe Product sync did not return a Product ID.');
		const updated = await store.updateCommerceOfferStripeProductSync(offer.id, {
			stripeProductId: stripeProduct.id,
			stripeProductStatus: 'synced',
			stripeProductMetadata: metadata,
			actorType,
			actorId,
			action: reconcile ? 'commerce_offer.stripe_product.reconciled' : 'commerce_offer.stripe_product.synced',
			evidence: {
				environment,
				stripeAccountId: context.account.stripeAccountId,
				stripeProductId: stripeProduct.id,
			},
		});
		return {
			offer: updated,
			product: context.product,
			vendor: context.vendor,
			connectedAccount: context.account,
			stripeProductId: stripeProduct.id,
			status: 'synced',
			reconciled: reconcile,
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error ?? 'Stripe Product sync failed.');
		await store.updateCommerceOfferStripeProductSync(offer.id, {
			stripeProductStatus: 'failed',
			stripeProductSyncError: reason,
			actorType,
			actorId,
			action: 'commerce_offer.stripe_product.failed',
			reason,
			evidence: { environment, stripeAccountId: context.account.stripeAccountId },
		});
		if (throwOnBlocked) throw error;
		return { offer: await store.getCommerceOffer(offer.id), failed: true, reason };
	}
}

async function syncCommercePriceStripePrice({
	store,
	stripeConnectService,
	price,
	actorType = 'system',
	actorId = null,
	reconcile = false,
	throwOnBlocked = false,
}) {
	const offer = await store.getCommerceOffer(price.offerId);
	const environment = stripeConnectService.environment ?? 'test';
	const block = async (reason) => {
		const updated = await store.markCommercePriceStripeSyncBlocked(price.id, {
			reason,
			actorType,
			actorId,
			evidence: { environment, offerId: offer?.id ?? null },
		});
		if (throwOnBlocked) {
			const error = new Error(reason);
			error.status = 409;
			throw error;
		}
		return { price: updated, blocked: true, reason };
	};
	if (!offer) return block('Commerce offer was not found for Stripe Price sync.');
	if (!STRIPE_PRICE_MIRROR_OFFER_MODES.has(offer.mode)) {
		if (offer.mode === 'scoped_contract') return block('Scoped contract Stripe Price sync is deferred until scoped service checkout.');
		return { price, skipped: true, reason: 'Offer mode does not require a Stripe Price mirror.' };
	}
	if (price.billingInterval === 'custom') return block('Custom billing intervals are not supported by Phase 4 Stripe Price sync.');
	if (['subscription', 'subscription_updates', 'professional_hosting'].includes(offer.mode) && !['month', 'year'].includes(price.billingInterval)) {
		return block('Recurring Stripe Price sync requires month or year billing intervals.');
	}
	if (['one_time', 'one_time_current_version'].includes(offer.mode) && price.billingInterval !== 'one_time') {
		return block('One-time Stripe Price sync requires one_time billing interval.');
	}
	const productSync = await syncCommerceOfferStripeProduct({
		store,
		stripeConnectService,
		offer,
		actorType,
		actorId,
		reconcile,
		throwOnBlocked,
	});
	const syncedOffer = productSync.offer ?? offer;
	if (!syncedOffer?.stripeProductId || syncedOffer.stripeProductStatus !== 'synced') {
		return block(productSync.reason ?? 'Stripe Product must be synced before Stripe Price sync.');
	}
	const context = await commerceStripeSyncContext({ store, stripeConnectService, offer: syncedOffer, environment });
	if (!context.account || context.account.accountStatus !== 'enabled') return block('Stripe connected account must be enabled before Price sync.');
	const metadata = buildCommerceStripeMetadata({ environment, ...context, offer: syncedOffer, price });
	const lookupKey = price.stripeLookupKey ?? commerceStripeLookupKey(environment, price);
	const params = commerceStripePriceParams({
		offer: syncedOffer,
		price: { ...price, stripeLookupKey: lookupKey },
		stripeProductId: syncedOffer.stripeProductId,
		metadata,
		environment,
	});
	try {
		let stripePrice = null;
		if (price.stripePriceId) {
			stripePrice = await stripeConnectService.retrievePriceMirror({
				connectedAccountId: context.account.stripeAccountId,
				stripePriceId: price.stripePriceId,
			});
			if (stripePriceTermsDrift(stripePrice, price, syncedOffer)) {
				const updated = await store.updateCommercePriceStripeSync(price.id, {
					stripeProductId: syncedOffer.stripeProductId,
					stripePriceId: price.stripePriceId,
					stripeLookupKey: lookupKey,
					stripeSyncStatus: 'drifted',
					stripeSyncError: 'Stripe Price immutable terms differ from TreeSeed price terms.',
					stripeMetadata: metadata,
					actorType,
					actorId,
					action: 'commerce_price.stripe_price.drifted',
					reason: 'Stripe Price immutable terms differ from TreeSeed price terms.',
					evidence: { environment, stripeAccountId: context.account.stripeAccountId, stripePriceId: price.stripePriceId },
				});
				return { offer: syncedOffer, price: updated, connectedAccount: context.account, stripeProductId: syncedOffer.stripeProductId, stripePriceId: price.stripePriceId, stripeLookupKey: lookupKey, status: 'drifted', reconciled: reconcile };
			}
			stripePrice = await stripeConnectService.updatePriceMirror({
				connectedAccountId: context.account.stripeAccountId,
				stripePriceId: price.stripePriceId,
				params: { metadata, lookup_key: lookupKey, active: price.status === 'active' },
			});
		} else {
			stripePrice = await stripeConnectService.createPriceMirror({
				connectedAccountId: context.account.stripeAccountId,
				params,
			});
		}
		if (!stripePrice?.id) return block('Stripe Price sync did not return a Price ID.');
		const updated = await store.updateCommercePriceStripeSync(price.id, {
			stripeProductId: syncedOffer.stripeProductId,
			stripePriceId: stripePrice.id,
			stripeLookupKey: lookupKey,
			stripeSyncStatus: 'synced',
			stripeMetadata: metadata,
			actorType,
			actorId,
			action: reconcile ? 'commerce_price.stripe_price.reconciled' : 'commerce_price.stripe_price.synced',
			evidence: {
				environment,
				stripeAccountId: context.account.stripeAccountId,
				stripeProductId: syncedOffer.stripeProductId,
				stripePriceId: stripePrice.id,
			},
		});
		return {
			offer: syncedOffer,
			price: updated,
			connectedAccount: context.account,
			stripeProductId: syncedOffer.stripeProductId,
			stripePriceId: stripePrice.id,
			stripeLookupKey: lookupKey,
			status: 'synced',
			reconciled: reconcile,
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error ?? 'Stripe Price sync failed.');
		await store.updateCommercePriceStripeSync(price.id, {
			stripeSyncStatus: 'failed',
			stripeSyncError: reason,
			actorType,
			actorId,
			action: 'commerce_price.stripe_price.failed',
			reason,
			evidence: { environment, stripeAccountId: context.account.stripeAccountId },
		});
		if (throwOnBlocked) throw error;
		return { offer: syncedOffer, price: await store.getCommercePrice(price.id), failed: true, reason };
	}
}

const CHECKOUT_OFFER_MODES = new Set(['free', 'one_time', 'one_time_current_version', 'subscription', 'subscription_updates']);
const CHECKOUT_COMMERCIAL_OFFER_MODES = new Set(['one_time', 'one_time_current_version', 'subscription', 'subscription_updates']);
const CHECKOUT_SUBSCRIPTION_OFFER_MODES = new Set(['subscription', 'subscription_updates']);

function resolveStripePublishableKey(config = {}) {
	return optionalTrimmedString(config.stripePublishableKey)
		?? optionalTrimmedString(process.env.TREESEED_STRIPE_PUBLISHABLE_KEY)
		?? optionalTrimmedString(process.env.STRIPE_PUBLISHABLE_KEY);
}

function resolveStripeWebhookSecret(config = {}) {
	return optionalTrimmedString(config.stripeWebhookSecret)
		?? optionalTrimmedString(process.env.TREESEED_STRIPE_WEBHOOK_SECRET)
		?? optionalTrimmedString(process.env.STRIPE_WEBHOOK_SECRET);
}

function commerceCheckoutError(message, status = 409, details = {}) {
	const error = new Error(message);
	error.status = status;
	error.details = details;
	return error;
}

function normalizeCheckoutQuantity(value) {
	const quantity = Number(value ?? 1);
	return Number.isFinite(quantity) && quantity > 0 ? Math.floor(quantity) : 1;
}

function stripeClientSecret(value) {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function paymentGroupStatusFromPaymentIntent(paymentIntent) {
	if (paymentIntent?.status === 'succeeded') return 'succeeded';
	if (paymentIntent?.status === 'processing') return 'processing';
	if (paymentIntent?.status === 'requires_action') return 'requires_action';
	if (paymentIntent?.status === 'canceled') return 'canceled';
	if (paymentIntent?.status === 'requires_payment_method') return 'requires_confirmation';
	return 'requires_confirmation';
}

function orderStatusFromPaymentGroup(status) {
	if (status === 'succeeded') return 'paid';
	if (status === 'requires_action') return 'requires_action';
	if (status === 'processing') return 'processing';
	if (status === 'failed') return 'failed';
	if (status === 'canceled') return 'canceled';
	return 'pending_payment';
}

function subscriptionStatusFromStripe(subscription) {
	const value = optionalTrimmedString(subscription?.status);
	return ['incomplete', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused'].includes(value)
		? value
		: 'incomplete';
}

function entitlementRenewalStateFromSubscription(status) {
	if (status === 'active' || status === 'trialing') return 'active';
	if (status === 'past_due') return 'past_due';
	if (status === 'canceled') return 'canceled';
	if (status === 'unpaid') return 'unpaid';
	return 'pending';
}

function stripeTimestampToIso(value) {
	if (!Number.isFinite(Number(value))) return null;
	return new Date(Number(value) * 1000).toISOString();
}

function subscriptionClientSecret(subscription) {
	return stripeClientSecret(subscription?.latest_invoice?.payment_intent?.client_secret)
		?? stripeClientSecret(subscription?.latest_invoice?.payment_intent?.clientSecret);
}

function publicPaymentGroups(groups) {
	return groups.map((group) => {
		if (!group) return group;
		const { clientSecretLast4: _clientSecretLast4, ...publicGroup } = group;
		return publicGroup;
	});
}

function buildCommerceCheckoutMetadata({ product, offer, price, vendor, ownership, environment }) {
	return {
		treeseed_environment: environment,
		treeseed_vendor_id: vendor.id,
		treeseed_seller_team_id: product.sellerTeamId,
		treeseed_product_id: product.id,
		treeseed_product_version_id: offer.productVersionId ?? product.currentVersionId ?? null,
		treeseed_offer_id: offer.id,
		treeseed_price_id: price?.id ?? null,
		treeseed_price_version: price?.priceVersion ?? null,
		treeseed_ownership_model: product.ownershipModel,
		treeseed_ownership_record_id: ownership?.id ?? product.ownershipRecordId ?? null,
		treeseed_object_authority: 'treeseed',
		treeseed_checkout_phase: 'phase_5',
	};
}

async function resolveCommerceCheckoutItem({ store, stripeConnectService, item }) {
	const offerId = optionalTrimmedString(item?.offerId);
	if (!offerId) throw commerceCheckoutError('offerId is required for checkout items.', 400);
	const offer = await store.getCommerceOffer(offerId);
	if (!offer) throw commerceCheckoutError(`Unknown commerce offer "${offerId}".`, 404);
	if (!CHECKOUT_OFFER_MODES.has(offer.mode)) {
		throw commerceCheckoutError(`Offer mode "${offer.mode}" is not supported by Phase 5 checkout.`, 409, { offerId, mode: offer.mode });
	}
	if (offer.status !== 'approved') throw commerceCheckoutError('Checkout requires an approved offer.', 409, { offerId, status: offer.status });
	const product = await store.getCommerceProduct(offer.productId);
	if (!product || product.status !== 'approved') {
		throw commerceCheckoutError('Checkout requires an approved product.', 409, { offerId, productId: offer.productId });
	}
	const vendor = await store.getCommerceVendor(offer.vendorId);
	if (!vendor || vendor.status !== 'approved' || vendor.salesEnabled !== true) {
		throw commerceCheckoutError('Checkout requires an approved sales-enabled vendor.', 409, { vendorId: offer.vendorId });
	}
	const priceId = optionalTrimmedString(item?.priceId) ?? offer.activePriceId;
	const price = priceId ? await store.getCommercePrice(priceId) : null;
	if (CHECKOUT_COMMERCIAL_OFFER_MODES.has(offer.mode)) {
		if (!price || price.offerId !== offer.id || price.status !== 'active') {
			throw commerceCheckoutError('Commercial checkout requires an active TreeSeed price for the offer.', 409, { offerId, priceId });
		}
		if (price.stripeSyncStatus !== 'synced' || !price.stripePriceId) {
			throw commerceCheckoutError('Commercial checkout requires a synced Stripe Price mirror.', 409, { offerId, priceId: price.id, stripeSyncStatus: price.stripeSyncStatus });
		}
	} else if (price && price.offerId !== offer.id) {
		throw commerceCheckoutError('Checkout price must belong to the selected offer.', 400, { offerId, priceId: price.id });
	}
	const environment = stripeConnectService.environment ?? 'test';
	const account = CHECKOUT_COMMERCIAL_OFFER_MODES.has(offer.mode)
		? await store.getCommerceVendorStripeAccount(vendor.id, environment)
		: null;
	if (CHECKOUT_COMMERCIAL_OFFER_MODES.has(offer.mode) && (!account || account.accountStatus !== 'enabled')) {
		throw commerceCheckoutError('Commercial checkout requires an enabled Stripe connected account.', 409, { vendorId: vendor.id });
	}
	const ownershipRecords = await store.listCommerceOwnershipRecords(product.id).catch(() => []);
	const ownership = ownershipRecords.find((record) => record.id === product.ownershipRecordId) ?? ownershipRecords[0] ?? null;
	const stewards = await store.listCommerceStewardshipAssignments(product.id).catch(() => []);
	const ownershipSnapshot = {
		capturedAt: new Date().toISOString(),
		productId: product.id,
		ownershipModel: product.ownershipModel,
		ownershipRecord: ownership,
		stewards: stewards.filter((assignment) => assignment.visibleToBuyers !== false),
		sellerTeamId: product.sellerTeamId,
		vendorId: vendor.id,
	};
	const quantity = normalizeCheckoutQuantity(item?.quantity);
	const unitAmount = Number(price?.amount ?? 0);
	return {
		offer,
		product,
		vendor,
		price,
		account,
		ownership,
		ownershipSnapshot,
		quantity,
		unitAmount,
		totalAmount: unitAmount * quantity,
		currency: (price?.currency ?? 'usd').toLowerCase(),
		productVersionId: offer.mode === 'one_time_current_version'
			? (offer.productVersionId ?? product.currentVersionId ?? null)
			: (offer.productVersionId ?? product.currentVersionId ?? null),
		metadata: buildCommerceCheckoutMetadata({ product, offer, price, vendor, ownership, environment }),
	};
}

function checkoutGroupKind(mode) {
	if (mode === 'free') return 'free';
	if (CHECKOUT_SUBSCRIPTION_OFFER_MODES.has(mode)) return 'subscription';
	return 'one_time';
}

function checkoutGroupKey(item) {
	const kind = checkoutGroupKind(item.offer.mode);
	if (kind === 'subscription') return `${kind}:${item.vendor.id}:${item.currency}:${item.price?.billingInterval ?? 'month'}`;
	return `${kind}:${item.vendor.id}:${item.currency}`;
}

function checkoutGroupStatus(groups) {
	const completed = groups.filter((group) => group.status === 'succeeded').length;
	if (completed === groups.length) return { status: 'completed', completed };
	if (completed > 0) return { status: 'partially_confirmed', completed };
	return { status: 'requires_confirmation', completed };
}

async function grantCommerceEntitlementsForOrder({ store, order, subscription = null, status = 'active', renewalState = 'none' }) {
	const orderItems = await store.listCommerceOrderItems(order.id);
	const entitlements = [];
	for (const item of orderItems) {
		const entitlement = await store.upsertCommerceEntitlementForOrderItem(item.id, {
			buyerTeamId: order.buyerTeamId,
			buyerUserId: order.buyerUserId,
			sellerTeamId: item.sellerTeamId,
			productId: item.productId,
			productVersionId: item.productVersionId,
			offerId: item.offerId,
			orderId: order.id,
			subscriptionId: subscription?.id ?? null,
			status,
			accessScope: item.accessScope,
			renewalState,
			fulfillmentArtifactRefs: item.metadata?.artifactRefs ?? [],
			catalogItemId: item.metadata?.catalogItemId ?? null,
			ownershipSnapshot: item.ownershipSnapshot,
			metadata: {
				mode: item.mode,
				priceId: item.priceId,
				preservePurchasedArtifacts: item.mode === 'subscription_updates',
			},
		});
		await store.updateCommerceOrderItemStatus(item.id, {
			status: status === 'active' ? 'paid' : 'pending',
			entitlementId: entitlement.id,
		});
		entitlements.push(entitlement);
	}
	return entitlements;
}

async function requireSellerTeamAccess(c, store, teamId, permission = 'projects:read:team') {
	const auth = await ensurePrincipal(c);
	if (auth.response) return auth;
	if (principalIsSeedAdmin(auth.principal)) return auth;
	const access = await requireTeamAccess(c, store, teamId, permission);
	return access;
}

async function requireVendorOrderManager(c, store, order) {
	if (!order?.sellerTeamId) return { response: jsonError(c, 404, 'Commerce order does not have a seller team.') };
	const auth = await ensurePrincipal(c);
	if (auth.response) return auth;
	if (principalIsSeedAdmin(auth.principal)) return auth;
	const access = await requireTeamAccess(c, store, order.sellerTeamId, 'teams:manage:team');
	return access;
}

async function requireServiceBuyerAccess(c, store, request) {
	const auth = await ensurePrincipal(c);
	if (auth.response) return auth;
	if (principalIsSeedAdmin(auth.principal)) return auth;
	if (request?.buyerTeamId) {
		const access = await requireTeamAccess(c, store, request.buyerTeamId, 'projects:read:team');
		if (!access.response) return access;
	}
	if (request?.buyerUserId && request.buyerUserId === auth.principal.id) return auth;
	return { response: jsonError(c, 403, 'Permission denied.', { requestId: request?.id ?? null }) };
}

async function requireServiceSellerAccess(c, store, request, permission = 'teams:manage:team') {
	const auth = await ensurePrincipal(c);
	if (auth.response) return auth;
	if (principalIsSeedAdmin(auth.principal)) return auth;
	if (!request?.sellerTeamId) return { response: jsonError(c, 404, 'Commerce service request does not have a seller team.') };
	return requireTeamAccess(c, store, request.sellerTeamId, permission);
}

async function requireServiceParticipantAccess(c, store, request, sellerPermission = 'projects:read:team') {
	const auth = await ensurePrincipal(c);
	if (auth.response) return auth;
	if (principalIsSeedAdmin(auth.principal)) return auth;
	if (request?.sellerTeamId) {
		const seller = await requireTeamAccess(c, store, request.sellerTeamId, sellerPermission);
		if (!seller.response) return seller;
	}
	if (request?.buyerTeamId) {
		const buyer = await requireTeamAccess(c, store, request.buyerTeamId, 'projects:read:team');
		if (!buyer.response) return buyer;
	}
	if (request?.buyerUserId && request.buyerUserId === auth.principal.id) return auth;
	return { response: jsonError(c, 403, 'Permission denied.', { requestId: request?.id ?? null }) };
}

function redactCommerceServiceRequestForBuyer(request) {
	if (!request) return null;
	const { vendorPrivateNotes: _vendorPrivateNotes, ...publicRequest } = request;
	return publicRequest;
}

async function requireCommerceCapacityListingAccess(c, store, listingId, permission = 'projects:read:team') {
	const listing = await store.getCommerceCapacityListing(listingId);
	if (!listing) return { response: jsonError(c, 404, `Unknown commerce capacity listing "${listingId}".`) };
	const auth = await ensurePrincipal(c);
	if (auth.response) {
		if (!permission && listing.status === 'approved' && listing.accessLevel === 'public_summary') {
			return { principal: null, listing: await store.getCommerceCapacityListing(listingId, { publicSafe: true }) };
		}
		if (!permission) {
			return { response: jsonError(c, 404, `Unknown commerce capacity listing "${listingId}".`) };
		}
		return auth;
	}
	if (principalIsSeedAdmin(auth.principal)) return { principal: auth.principal, listing };
	const access = await requireTeamAccess(c, store, listing.sellerTeamId, permission);
	if (!access.response) return { principal: auth.principal, listing };
	if (!permission && listing.status === 'approved' && listing.accessLevel === 'public_summary') {
		return { principal: auth.principal, listing: await store.getCommerceCapacityListing(listingId, { publicSafe: true }) };
	}
	return access;
}

async function requireCommerceCapacityInquiryAccess(c, store, inquiryId, permission = 'projects:read:team') {
	const inquiry = await store.getCommerceCapacityListingInquiry(inquiryId);
	if (!inquiry) return { response: jsonError(c, 404, `Unknown commerce capacity inquiry "${inquiryId}".`) };
	const auth = await ensurePrincipal(c);
	if (auth.response) return auth;
	if (principalIsSeedAdmin(auth.principal)) return { principal: auth.principal, inquiry };
	const sellerAccess = await requireTeamAccess(c, store, inquiry.sellerTeamId, permission);
	if (!sellerAccess.response) return { principal: auth.principal, inquiry };
	if (inquiry.buyerTeamId) {
		const buyerAccess = await requireTeamAccess(c, store, inquiry.buyerTeamId, 'projects:read:team');
		if (!buyerAccess.response) return { principal: auth.principal, inquiry: { ...inquiry, governanceEvidence: {}, metadata: {} } };
	}
	if (inquiry.buyerUserId && inquiry.buyerUserId === auth.principal.id) {
		return { principal: auth.principal, inquiry: { ...inquiry, governanceEvidence: {}, metadata: {} } };
	}
	return sellerAccess;
}

function remainingRefundableAmount(order, orderItem = null) {
	const target = orderItem ?? order;
	return Math.max(0, Number(target.totalAmount ?? 0) - Number(target.refundedAmount ?? 0));
}

function stripeRefundStatus(value) {
	if (value === 'succeeded' || value === 'failed' || value === 'canceled') return value;
	return 'processing';
}

async function applyCommerceRefundState({ store, order, orderItem = null, amount, fullRefund }) {
	const nextOrderRefunded = Number(order.refundedAmount ?? 0) + Number(amount ?? 0);
	const orderFullyRefunded = nextOrderRefunded >= Number(order.totalAmount ?? 0);
	const updatedOrder = await store.markCommerceOrderRefundState(order.id, {
		status: orderFullyRefunded ? 'refunded' : 'partially_refunded',
		refundedAmount: nextOrderRefunded,
		refundStatus: orderFullyRefunded ? 'full' : 'partial',
		metadata: order.metadata,
	});
	const updatedItems = [];
	if (orderItem) {
		const nextItemRefunded = Number(orderItem.refundedAmount ?? 0) + Number(amount ?? 0);
		const itemFullyRefunded = nextItemRefunded >= Number(orderItem.totalAmount ?? 0);
		updatedItems.push(await store.markCommerceOrderItemRefundState(orderItem.id, {
			status: itemFullyRefunded ? 'refunded' : orderItem.status,
			refundedAmount: nextItemRefunded,
			refundStatus: itemFullyRefunded ? 'full' : 'partial',
			metadata: orderItem.metadata,
		}));
		if (itemFullyRefunded && orderItem.entitlementId) {
			await store.revokeCommerceEntitlement(orderItem.entitlementId, {
				action: 'commerce_entitlement.revoked',
				renewalState: 'canceled',
			});
		}
	} else if (fullRefund) {
		for (const item of await store.listCommerceOrderItems(order.id)) {
			updatedItems.push(await store.markCommerceOrderItemRefundState(item.id, {
				status: 'refunded',
				refundedAmount: item.totalAmount,
				refundStatus: 'full',
				metadata: item.metadata,
			}));
			if (item.entitlementId) {
				await store.revokeCommerceEntitlement(item.entitlementId, {
					action: 'commerce_entitlement.revoked',
					renewalState: 'canceled',
				});
			}
		}
	}
	return { order: updatedOrder, items: updatedItems };
}

async function resolveOrderItemForRefund(store, order, orderItemId) {
	if (!orderItemId) return null;
	const items = await store.listCommerceOrderItems(order.id);
	const item = items.find((entry) => entry.id === orderItemId);
	if (!item) {
		const error = new Error('Refund order item does not belong to this order.');
		error.status = 404;
		throw error;
	}
	return item;
}

async function resolveFulfillmentArtifact({ store, orderItem, body }) {
	const product = await store.getCommerceProduct(orderItem.productId);
	const version = orderItem.productVersionId ? await store.getCommerceProductVersionById(orderItem.productVersionId) : null;
	const catalogArtifactVersionId = optionalTrimmedString(body.catalogArtifactVersionId) ?? version?.catalogArtifactVersionId ?? null;
	const artifact = catalogArtifactVersionId ? await store.getCatalogArtifactVersionById(catalogArtifactVersionId) : null;
	const catalogItemId = product?.catalogItemId ?? artifact?.itemId ?? null;
	const artifactRefs = Array.isArray(body.artifactRefs) ? body.artifactRefs.filter((entry) => entry && typeof entry === 'object') : [];
	if (artifact) {
		artifactRefs.push({
			catalogArtifactVersionId: artifact.id,
			itemId: artifact.itemId,
			version: artifact.version,
			contentKey: artifact.contentKey,
		});
	}
	const deliveryRefs = artifact
		? [{
			type: 'catalog_artifact_download',
			catalogItemId: artifact.itemId,
			version: artifact.version,
			path: `/v1/catalog/${encodeURIComponent(artifact.itemId)}/artifacts/${encodeURIComponent(artifact.version)}/download`,
		}]
		: artifactRefs;
	return { product, version, artifact, catalogItemId, artifactRefs, deliveryRefs };
}

async function createCommerceCheckoutRun({ store, stripeConnectService, principal, input = {} }) {
	const buyerTeamId = optionalTrimmedString(input.buyerTeamId) ?? null;
	const buyerUserId = principal?.id ?? null;
	let cart = null;
	let rawItems = Array.isArray(input.items) ? input.items : [];
	if (input.cartId) {
		cart = await store.getCommerceCart(optionalTrimmedString(input.cartId));
		if (!cart) throw commerceCheckoutError(`Unknown commerce cart "${input.cartId}".`, 404);
		rawItems = (await store.listCommerceCartItems(cart.id)).filter((item) => item.status === 'active');
	}
	if (!rawItems.length) throw commerceCheckoutError('Checkout requires at least one item.', 400);
	if (!cart) {
		cart = await store.createCommerceCart(principal, { buyerTeamId, buyerUserId });
		for (const item of rawItems) {
			await store.addCommerceCartItem(cart.id, {
				offerId: item.offerId,
				priceId: item.priceId,
				quantity: item.quantity,
				actorId: buyerUserId,
			});
		}
		rawItems = (await store.listCommerceCartItems(cart.id)).filter((item) => item.status === 'active');
	}
	const resolvedItems = [];
	for (const item of rawItems) {
		resolvedItems.push(await resolveCommerceCheckoutItem({ store, stripeConnectService, item }));
	}
	const groupMap = new Map();
	for (const item of resolvedItems) {
		const key = checkoutGroupKey(item);
		if (!groupMap.has(key)) {
			groupMap.set(key, {
				key,
				kind: checkoutGroupKind(item.offer.mode),
				vendor: item.vendor,
				account: item.account,
				currency: item.currency,
				billingInterval: CHECKOUT_SUBSCRIPTION_OFFER_MODES.has(item.offer.mode) ? item.price?.billingInterval ?? 'month' : null,
				items: [],
			});
		}
		groupMap.get(key).items.push(item);
	}
	const checkout = await store.createCommerceCheckout({
		cartId: cart.id,
		buyerTeamId: cart.buyerTeamId ?? buyerTeamId,
		buyerUserId: cart.buyerUserId ?? buyerUserId,
		status: 'requires_confirmation',
		groupCount: groupMap.size,
		actorId: buyerUserId,
		metadata: { checkoutMode: 'stripe_elements_grouped_vendor' },
	});
	const orders = [];
	const paymentGroups = [];
	const entitlements = [];
	for (const group of groupMap.values()) {
		const subtotal = group.items.reduce((sum, item) => sum + item.totalAmount, 0);
		const order = await store.createCommerceOrder({
			checkoutId: checkout.id,
			cartId: cart.id,
			buyerTeamId: cart.buyerTeamId ?? buyerTeamId,
			buyerUserId: cart.buyerUserId ?? buyerUserId,
			vendorId: group.vendor.id,
			sellerTeamId: group.vendor.teamId,
			status: group.kind === 'free' ? 'paid' : 'pending_payment',
			currency: group.currency,
			subtotalAmount: subtotal,
			totalAmount: subtotal,
			stripeConnectedAccountId: group.account?.stripeAccountId ?? null,
			ownershipSnapshot: {
				capturedAt: new Date().toISOString(),
				items: group.items.map((item) => item.ownershipSnapshot),
			},
			actorId: buyerUserId,
			metadata: { checkoutId: checkout.id, groupKind: group.kind },
		});
		for (const item of group.items) {
			await store.createCommerceOrderItem(order.id, {
				vendorId: item.vendor.id,
				sellerTeamId: item.product.sellerTeamId,
				productId: item.product.id,
				productVersionId: item.productVersionId,
				offerId: item.offer.id,
				priceId: item.price?.id ?? null,
				mode: item.offer.mode,
				quantity: item.quantity,
				unitAmount: item.unitAmount,
				totalAmount: item.totalAmount,
				currency: item.currency,
				status: group.kind === 'free' ? 'paid' : 'pending',
				ownershipSnapshot: item.ownershipSnapshot,
				accessScope: item.offer.accessScope ?? {},
				supportScope: item.offer.supportScope ?? {},
				metadata: {
					catalogItemId: item.product.catalogItemId,
					artifactRefs: item.productVersionId ? [{ productVersionId: item.productVersionId }] : [],
					priceVersion: item.price?.priceVersion ?? null,
				},
			});
		}
		let paymentGroup = null;
		if (group.kind === 'free') {
			paymentGroup = await store.createCommercePaymentGroup({
				checkoutId: checkout.id,
				orderId: order.id,
				vendorId: group.vendor.id,
				sellerTeamId: group.vendor.teamId,
				groupKind: 'free',
				status: 'succeeded',
				currency: group.currency,
				subtotalAmount: 0,
				totalAmount: 0,
				actorId: buyerUserId,
			});
			entitlements.push(...await grantCommerceEntitlementsForOrder({ store, order, status: 'active', renewalState: 'none' }));
		} else if (group.kind === 'one_time') {
			if (!await stripeConnectService.isConfigured()) throw stripeConfiguredError();
			const paymentIntent = await stripeConnectService.createPaymentIntent({
				connectedAccountId: group.account.stripeAccountId,
				params: {
					amount: subtotal,
					currency: group.currency,
					automatic_payment_methods: { enabled: true },
					metadata: {
						treeseed_checkout_id: checkout.id,
						treeseed_order_id: order.id,
						treeseed_vendor_id: group.vendor.id,
						treeseed_seller_team_id: group.vendor.teamId,
						treeseed_object_authority: 'treeseed',
						treeseed_checkout_phase: 'phase_5',
					},
				},
			});
			await store.updateCommerceOrderStatus(order.id, {
				status: orderStatusFromPaymentGroup(paymentGroupStatusFromPaymentIntent(paymentIntent)),
				stripePaymentIntentId: paymentIntent?.id ?? null,
				stripeConnectedAccountId: group.account.stripeAccountId,
			});
			paymentGroup = await store.createCommercePaymentGroup({
				checkoutId: checkout.id,
				orderId: order.id,
				vendorId: group.vendor.id,
				sellerTeamId: group.vendor.teamId,
				connectedAccountId: group.account.stripeAccountId,
				groupKind: 'one_time',
				status: paymentGroupStatusFromPaymentIntent(paymentIntent),
				currency: group.currency,
				subtotalAmount: subtotal,
				totalAmount: subtotal,
				stripePaymentIntentId: paymentIntent?.id ?? null,
				clientSecret: stripeClientSecret(paymentIntent?.client_secret),
				actorId: buyerUserId,
			});
		} else {
			if (!await stripeConnectService.isConfigured()) throw stripeConfiguredError();
			const customer = await ensureCommerceStripeCustomer({
				store,
				stripeConnectService,
				group,
				buyerTeamId: cart.buyerTeamId ?? buyerTeamId,
				buyerUserId: cart.buyerUserId ?? buyerUserId,
			});
			const subscription = await stripeConnectService.createSubscription({
				connectedAccountId: group.account.stripeAccountId,
				params: {
					customer: customer.stripeCustomerId,
					items: group.items.map((item) => ({ price: item.price.stripePriceId, quantity: item.quantity })),
					payment_behavior: 'default_incomplete',
					payment_settings: { save_default_payment_method: 'on_subscription' },
					expand: ['latest_invoice.payment_intent'],
					metadata: {
						treeseed_checkout_id: checkout.id,
						treeseed_order_id: order.id,
						treeseed_vendor_id: group.vendor.id,
						treeseed_seller_team_id: group.vendor.teamId,
						treeseed_object_authority: 'treeseed',
						treeseed_checkout_phase: 'phase_5',
					},
				},
			});
			const firstItem = group.items[0];
			const localSubscription = await store.createCommerceSubscription({
				orderId: order.id,
				vendorId: group.vendor.id,
				sellerTeamId: group.vendor.teamId,
				buyerTeamId: cart.buyerTeamId ?? buyerTeamId,
				buyerUserId: cart.buyerUserId ?? buyerUserId,
				offerId: firstItem.offer.id,
				priceId: firstItem.price.id,
				status: subscriptionStatusFromStripe(subscription),
				renewalState: entitlementRenewalStateFromSubscription(subscriptionStatusFromStripe(subscription)),
				stripeSubscriptionId: subscription.id,
				stripeCustomerId: customer.stripeCustomerId,
				stripeConnectedAccountId: group.account.stripeAccountId,
				currentPeriodStart: stripeTimestampToIso(subscription.current_period_start),
				currentPeriodEnd: stripeTimestampToIso(subscription.current_period_end),
				cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
				canceledAt: stripeTimestampToIso(subscription.canceled_at),
				actorId: buyerUserId,
			});
			await store.updateCommerceOrderStatus(order.id, {
				status: ['active', 'trialing'].includes(localSubscription.status) ? 'paid' : 'pending_payment',
				stripeSubscriptionId: subscription.id,
				stripeCustomerId: customer.stripeCustomerId,
				stripeConnectedAccountId: group.account.stripeAccountId,
			});
			paymentGroup = await store.createCommercePaymentGroup({
				checkoutId: checkout.id,
				orderId: order.id,
				vendorId: group.vendor.id,
				sellerTeamId: group.vendor.teamId,
				connectedAccountId: group.account.stripeAccountId,
				groupKind: 'subscription',
				billingInterval: group.billingInterval,
				status: ['active', 'trialing'].includes(localSubscription.status) ? 'succeeded' : 'requires_confirmation',
				currency: group.currency,
				subtotalAmount: subtotal,
				totalAmount: subtotal,
				stripeSubscriptionId: subscription.id,
				stripeCustomerId: customer.stripeCustomerId,
				clientSecret: subscriptionClientSecret(subscription),
				actorId: buyerUserId,
			});
			if (['active', 'trialing'].includes(localSubscription.status)) {
				entitlements.push(...await grantCommerceEntitlementsForOrder({
					store,
					order: await store.getCommerceOrder(order.id),
					subscription: localSubscription,
					status: 'active',
					renewalState: localSubscription.renewalState,
				}));
			}
		}
		orders.push(await store.getCommerceOrder(order.id));
		paymentGroups.push(paymentGroup);
	}
	await store.markCommerceCartConverted(cart.id, checkout.id);
	const status = checkoutGroupStatus(paymentGroups);
	const finalCheckout = await store.updateCommerceCheckoutStatus(checkout.id, {
		status: status.status,
		completedGroupCount: status.completed,
	});
	return {
		checkout: finalCheckout,
		orders,
		paymentGroups: publicPaymentGroups(paymentGroups),
		entitlements,
	};
}

async function createCommerceCheckoutRunForServiceContract({ store, stripeConnectService, principal, contractId, input = {} }) {
	const contract = await store.getCommerceServiceContract(contractId);
	if (!contract) throw commerceCheckoutError(`Unknown commerce service contract "${contractId}".`, 404);
	if (contract.status !== 'pending_checkout') {
		throw commerceCheckoutError('Scoped service contract checkout requires a pending checkout contract.', 409, { contractId, status: contract.status });
	}
	const request = await store.getCommerceServiceRequest(contract.requestId);
	const quote = await store.getCommerceServiceQuote(contract.quoteId);
	if (!request || !quote || quote.status !== 'accepted') {
		throw commerceCheckoutError('Scoped service checkout requires an accepted quote.', 409, { contractId, quoteId: contract.quoteId });
	}
	const offer = await store.getCommerceOffer(contract.offerId);
	const product = await store.getCommerceProduct(contract.productId);
	const vendor = await store.getCommerceVendor(contract.vendorId);
	if (!offer || offer.status !== 'approved' || offer.mode !== 'scoped_contract') {
		throw commerceCheckoutError('Scoped service checkout requires an approved scoped contract offer.', 409, { offerId: contract.offerId });
	}
	if (!product || product.status !== 'approved' || product.kind !== 'scoped_service') {
		throw commerceCheckoutError('Scoped service checkout requires an approved scoped service product.', 409, { productId: contract.productId });
	}
	if (!vendor || vendor.status !== 'approved' || vendor.serviceSalesEnabled !== true) {
		throw commerceCheckoutError('Scoped service checkout requires an approved service-enabled vendor.', 409, { vendorId: contract.vendorId });
	}
	const environment = stripeConnectService.environment ?? 'test';
	const account = await store.getCommerceVendorStripeAccount(vendor.id, environment);
	if (!account || account.accountStatus !== 'enabled') {
		throw commerceCheckoutError('Scoped service checkout requires an enabled Stripe connected account.', 409, { vendorId: vendor.id });
	}
	if (!await stripeConnectService.isConfigured()) throw stripeConfiguredError();
	const buyerTeamId = request.buyerTeamId ?? input.buyerTeamId ?? null;
	const buyerUserId = request.buyerUserId ?? principal?.id ?? null;
	const cart = await store.createCommerceCart(principal, {
		buyerTeamId,
		buyerUserId,
		currency: quote.currency,
		metadata: { serviceRequestId: request.id, serviceContractId: contract.id },
	});
	const checkout = await store.createCommerceCheckout({
		cartId: cart.id,
		buyerTeamId,
		buyerUserId,
		status: 'requires_confirmation',
		groupCount: 1,
		actorId: principal?.id ?? null,
		metadata: { checkoutMode: 'stripe_elements_grouped_vendor', serviceRequestId: request.id, serviceContractId: contract.id },
	});
	const order = await store.createCommerceOrder({
		checkoutId: checkout.id,
		cartId: cart.id,
		buyerTeamId,
		buyerUserId,
		vendorId: vendor.id,
		sellerTeamId: vendor.teamId,
		status: 'pending_payment',
		currency: quote.currency,
		subtotalAmount: quote.amount,
		totalAmount: quote.amount,
		stripeConnectedAccountId: account.stripeAccountId,
		ownershipSnapshot: contract.ownershipSnapshot ?? request.ownershipSnapshot ?? {},
		actorId: principal?.id ?? null,
		metadata: {
			checkoutId: checkout.id,
			groupKind: 'one_time',
			serviceRequestId: request.id,
			serviceQuoteId: quote.id,
			serviceContractId: contract.id,
		},
	});
	const orderItem = await store.createCommerceOrderItem(order.id, {
		vendorId: vendor.id,
		sellerTeamId: vendor.teamId,
		productId: product.id,
		productVersionId: offer.productVersionId ?? product.currentVersionId ?? null,
		offerId: offer.id,
		priceId: null,
		mode: 'scoped_contract',
		quantity: 1,
		unitAmount: quote.amount,
		totalAmount: quote.amount,
		currency: quote.currency,
		status: 'pending',
		ownershipSnapshot: contract.ownershipSnapshot ?? request.ownershipSnapshot ?? {},
		accessScope: {
			...(offer.accessScope ?? {}),
			serviceRequestId: request.id,
			serviceQuoteId: quote.id,
			serviceContractId: contract.id,
			scopeSummary: quote.scopeSummary,
			accessRequirements: quote.accessRequirements,
		},
		supportScope: offer.supportScope ?? {},
		metadata: {
			catalogItemId: product.catalogItemId,
			serviceRequestId: request.id,
			serviceQuoteId: quote.id,
			serviceContractId: contract.id,
			quoteVersion: quote.quoteVersion,
		},
	});
	const paymentIntent = await stripeConnectService.createPaymentIntent({
		connectedAccountId: account.stripeAccountId,
		params: {
			amount: quote.amount,
			currency: quote.currency,
			automatic_payment_methods: { enabled: true },
			metadata: {
				treeseed_checkout_id: checkout.id,
				treeseed_order_id: order.id,
				treeseed_order_item_id: orderItem.id,
				treeseed_vendor_id: vendor.id,
				treeseed_seller_team_id: vendor.teamId,
				treeseed_product_id: product.id,
				treeseed_offer_id: offer.id,
				treeseed_service_request_id: request.id,
				treeseed_service_quote_id: quote.id,
				treeseed_service_contract_id: contract.id,
				treeseed_object_authority: 'treeseed',
				treeseed_checkout_phase: 'phase_8_scoped_service',
			},
		},
	});
	const paymentGroup = await store.createCommercePaymentGroup({
		checkoutId: checkout.id,
		orderId: order.id,
		vendorId: vendor.id,
		sellerTeamId: vendor.teamId,
		connectedAccountId: account.stripeAccountId,
		groupKind: 'one_time',
		status: paymentGroupStatusFromPaymentIntent(paymentIntent),
		currency: quote.currency,
		subtotalAmount: quote.amount,
		totalAmount: quote.amount,
		stripePaymentIntentId: paymentIntent?.id ?? null,
		clientSecret: stripeClientSecret(paymentIntent?.client_secret),
		metadata: { serviceRequestId: request.id, serviceQuoteId: quote.id, serviceContractId: contract.id },
		actorId: principal?.id ?? null,
	});
	await store.updateCommerceOrderStatus(order.id, {
		status: orderStatusFromPaymentGroup(paymentGroup.status),
		stripePaymentIntentId: paymentIntent?.id ?? null,
		stripeConnectedAccountId: account.stripeAccountId,
	});
	await store.attachCommerceServiceOrder(contract.id, {
		orderId: order.id,
		orderItemId: orderItem.id,
		paymentGroupId: paymentGroup.id,
		actorType: 'user',
		actorId: principal?.id ?? null,
	});
	await store.markCommerceCartConverted(cart.id, checkout.id);
	return {
		checkout: await store.getCommerceCheckout(checkout.id),
		orders: [await store.getCommerceOrder(order.id)],
		paymentGroups: publicPaymentGroups([paymentGroup]),
		entitlements: [],
	};
}

async function ensureCommerceStripeCustomer({ store, stripeConnectService, group, buyerTeamId, buyerUserId }) {
	const environment = stripeConnectService.environment ?? 'test';
	const existing = await store.getCommerceBuyerStripeCustomer({
		vendorId: group.vendor.id,
		environment,
		buyerTeamId,
		buyerUserId,
	});
	if (existing) return existing;
	const customer = await stripeConnectService.createCustomer({
		connectedAccountId: group.account.stripeAccountId,
		params: {
			metadata: {
				treeseed_vendor_id: group.vendor.id,
				treeseed_buyer_team_id: buyerTeamId ?? '',
				treeseed_buyer_user_id: buyerUserId ?? '',
				treeseed_environment: environment,
			},
		},
	});
	return store.upsertCommerceBuyerStripeCustomer({
		buyerTeamId,
		buyerUserId,
		vendorId: group.vendor.id,
		connectedAccountId: group.account.stripeAccountId,
		environment,
		stripeCustomerId: customer.id,
		metadata: { provider: 'stripe' },
	});
}

async function refreshCommercePaymentGroupState({ store, stripeConnectService, group }) {
	if (!group) throw commerceCheckoutError('Unknown commerce payment group.', 404);
	const order = await store.getCommerceOrder(group.orderId);
	if (!order) throw commerceCheckoutError('Unknown commerce order for payment group.', 404);
	if (group.groupKind === 'free') {
		return {
			group,
			order,
			entitlements: await grantCommerceEntitlementsForOrder({ store, order, status: 'active', renewalState: 'none' }),
		};
	}
	if (!group.connectedAccountId) throw commerceCheckoutError('Payment group is missing a Stripe connected account.', 409);
	if (group.stripePaymentIntentId) {
		const paymentIntent = await stripeConnectService.retrievePaymentIntent({
			connectedAccountId: group.connectedAccountId,
			paymentIntentId: group.stripePaymentIntentId,
		});
		const status = paymentGroupStatusFromPaymentIntent(paymentIntent);
		const updatedGroup = await store.updateCommercePaymentGroup(group.id, { status });
		const updatedOrder = await store.updateCommerceOrderStatus(order.id, { status: orderStatusFromPaymentGroup(status) });
		let entitlements = [];
		if (status === 'succeeded') {
			entitlements = await grantCommerceEntitlementsForOrder({ store, order: updatedOrder, status: 'active', renewalState: 'none' });
		}
		return {
			group: updatedGroup,
			order: updatedOrder,
			entitlements,
			clientSecret: ['requires_confirmation', 'requires_action', 'processing', 'pending'].includes(status)
				? stripeClientSecret(paymentIntent?.client_secret ?? paymentIntent?.clientSecret)
				: null,
		};
	}
	if (group.stripeSubscriptionId) {
		const subscription = await stripeConnectService.retrieveSubscription({
			connectedAccountId: group.connectedAccountId,
			subscriptionId: group.stripeSubscriptionId,
		});
		const localSubscription = await syncCommerceSubscriptionFromStripe({
			store,
			order,
			group,
			subscription,
			connectedAccountId: group.connectedAccountId,
		});
		const status = ['active', 'trialing'].includes(localSubscription.status) ? 'succeeded' : 'requires_confirmation';
		const updatedGroup = await store.updateCommercePaymentGroup(group.id, { status });
		const updatedOrder = await store.updateCommerceOrderStatus(order.id, {
			status: status === 'succeeded' ? 'paid' : 'pending_payment',
			stripeSubscriptionId: group.stripeSubscriptionId,
		});
		let entitlements = [];
		if (status === 'succeeded') {
			entitlements = await grantCommerceEntitlementsForOrder({
				store,
				order: updatedOrder,
				subscription: localSubscription,
				status: 'active',
				renewalState: localSubscription.renewalState,
			});
		}
		return {
			group: updatedGroup,
			order: updatedOrder,
			subscription: localSubscription,
			entitlements,
			clientSecret: status === 'requires_confirmation' ? subscriptionClientSecret(subscription) : null,
		};
	}
	return { group, order, entitlements: [], clientSecret: null };
}

async function updateCheckoutCompletionFromGroup(store, group) {
	if (!group?.checkoutId) return null;
	const checkout = await store.getCommerceCheckout(group.checkoutId);
	if (!checkout) return null;
	const groups = await Promise.all((await store.listCommerceCheckoutOrders(checkout.id)).map(async (order) => {
		const orderGroups = await store.all?.(`SELECT * FROM commerce_payment_groups WHERE order_id = ?`, [order.id]).catch(() => []);
		return orderGroups.map((row) => ({
			status: row.status,
		}));
	}));
	const flattened = groups.flat();
	if (!flattened.length) return checkout;
	const status = checkoutGroupStatus(flattened);
	return store.updateCommerceCheckoutStatus(checkout.id, {
		status: status.status,
		completedGroupCount: status.completed,
	});
}

async function syncCommerceSubscriptionFromStripe({ store, order, group, subscription, connectedAccountId }) {
	const status = subscriptionStatusFromStripe(subscription);
	const existing = await store.getCommerceSubscriptionByStripeId(subscription.id, connectedAccountId);
	const firstItem = (await store.listCommerceOrderItems(order.id))[0] ?? null;
	const input = {
		orderId: order.id,
		vendorId: order.vendorId,
		sellerTeamId: order.sellerTeamId,
		buyerTeamId: order.buyerTeamId,
		buyerUserId: order.buyerUserId,
		offerId: firstItem?.offerId ?? null,
		priceId: firstItem?.priceId ?? null,
		status,
		renewalState: entitlementRenewalStateFromSubscription(status),
		stripeSubscriptionId: subscription.id,
		stripeCustomerId: subscription.customer ?? group?.stripeCustomerId ?? order.stripeCustomerId ?? null,
		stripeConnectedAccountId: connectedAccountId,
		currentPeriodStart: stripeTimestampToIso(subscription.current_period_start),
		currentPeriodEnd: stripeTimestampToIso(subscription.current_period_end),
		cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
		canceledAt: stripeTimestampToIso(subscription.canceled_at),
		metadata: { stripeStatus: status },
	};
	if (existing) return store.updateCommerceSubscriptionFromStripe(existing.id, input);
	return store.createCommerceSubscription(input);
}

async function handleCommercePaymentIntentWebhook({ store, event, object, connectedAccountId }) {
	const group = await store.getCommercePaymentGroupByStripePaymentIntent(object.id, connectedAccountId);
	if (!group) return { ignored: true, reason: 'No payment group found for PaymentIntent.' };
	const order = await store.getCommerceOrder(group.orderId);
	if (!order) return { ignored: true, reason: 'No order found for PaymentIntent payment group.' };
	let groupStatus = paymentGroupStatusFromPaymentIntent(object);
	if (event.type === 'payment_intent.payment_failed') groupStatus = 'failed';
	if (event.type === 'payment_intent.canceled') groupStatus = 'canceled';
	const updatedGroup = await store.updateCommercePaymentGroup(group.id, { status: groupStatus });
	const orderStatus = orderStatusFromPaymentGroup(groupStatus);
	const updatedOrder = await store.updateCommerceOrderStatus(order.id, { status: orderStatus });
	if (groupStatus === 'succeeded') {
		const entitlements = await grantCommerceEntitlementsForOrder({ store, order: updatedOrder, status: 'active', renewalState: 'none' });
		const serviceContractId = object?.metadata?.treeseed_service_contract_id ?? group.metadata?.serviceContractId ?? order.metadata?.serviceContractId ?? null;
		if (serviceContractId) {
			const entitlement = entitlements[0] ?? null;
			await store.activateCommerceServiceContract(serviceContractId, {
				orderId: order.id,
				entitlementId: entitlement?.id ?? null,
				actorType: 'system',
				evidence: {
					stripePaymentIntentId: object.id,
					connectedAccountId,
				},
			});
		}
	} else if (['failed', 'canceled'].includes(groupStatus)) {
		const serviceContractId = object?.metadata?.treeseed_service_contract_id ?? group.metadata?.serviceContractId ?? order.metadata?.serviceContractId ?? null;
		if (serviceContractId) {
			const contract = await store.getCommerceServiceContract(serviceContractId);
			if (contract) {
				await store.recordCommerceServiceGovernance({
					requestId: contract.requestId,
					quoteId: contract.quoteId,
					contractId: contract.id,
					eventType: groupStatus === 'failed' ? 'manual_update' : 'canceled',
					action: groupStatus === 'failed' ? 'commerce_service.checkout_failed' : 'commerce_service.checkout_canceled',
					objectType: 'commerce_service_contract',
					objectId: contract.id,
					actorType: 'system',
					priorState: contract.status,
					nextState: contract.status,
					evidence: {
						stripePaymentIntentId: object.id,
						connectedAccountId,
						groupStatus,
					},
					relatedOrderId: order.id,
					relatedOfferId: contract.offerId,
					relatedProductId: contract.productId,
					relatedTeamId: contract.sellerTeamId,
				});
			}
		}
	}
	await updateCheckoutCompletionFromGroup(store, updatedGroup);
	return { relatedOrderId: order.id };
}

async function handleCommerceSubscriptionWebhook({ store, event, object, connectedAccountId }) {
	const group = await store.getCommercePaymentGroupByStripeSubscription(object.id, connectedAccountId);
	const existingSubscription = await store.getCommerceSubscriptionByStripeId(object.id, connectedAccountId);
	const order = group ? await store.getCommerceOrder(group.orderId) : (existingSubscription ? await store.getCommerceOrder(existingSubscription.orderId) : null);
	if (!order) return { ignored: true, reason: 'No order found for Stripe subscription.' };
	const subscription = await syncCommerceSubscriptionFromStripe({ store, order, group, subscription: object, connectedAccountId });
	const status = subscription.status;
	const renewalState = subscription.renewalState;
	if (['active', 'trialing'].includes(status)) {
		await store.updateCommerceOrderStatus(order.id, { status: 'paid', stripeSubscriptionId: object.id });
		await grantCommerceEntitlementsForOrder({ store, order, subscription, status: 'active', renewalState });
		if (group) await store.updateCommercePaymentGroup(group.id, { status: 'succeeded' });
	} else if (['past_due', 'unpaid'].includes(status)) {
		await store.updateCommerceOrderStatus(order.id, { status: 'requires_action', stripeSubscriptionId: object.id });
		await store.updateEntitlementsForSubscription(subscription.id, { status: 'past_due', renewalState });
		if (group) await store.updateCommercePaymentGroup(group.id, { status: 'requires_action' });
	} else if (event.type === 'customer.subscription.deleted' || status === 'canceled') {
		await store.updateEntitlementsForSubscription(subscription.id, {
			status: 'canceled',
			renewalState: 'canceled',
			metadata: { preservePurchasedArtifacts: true },
		});
		if (group) await store.updateCommercePaymentGroup(group.id, { status: 'canceled' });
	}
	if (group) await updateCheckoutCompletionFromGroup(store, group);
	return { relatedOrderId: order.id, relatedSubscriptionId: subscription.id };
}

async function handleCommerceInvoiceWebhook({ store, stripeConnectService, event, object, connectedAccountId }) {
	const stripeSubscriptionId = optionalTrimmedString(object.subscription);
	if (!stripeSubscriptionId) return { ignored: true, reason: 'Invoice is not linked to a subscription.' };
	let subscriptionObject = null;
	if (await stripeConnectService.isConfigured()) {
		subscriptionObject = await stripeConnectService.retrieveSubscription({ connectedAccountId, subscriptionId: stripeSubscriptionId });
	}
	const subscription = await store.getCommerceSubscriptionByStripeId(stripeSubscriptionId, connectedAccountId);
	if (!subscription) return { ignored: true, reason: 'No local subscription found for invoice.' };
	if (subscriptionObject) {
		const order = await store.getCommerceOrder(subscription.orderId);
		const synced = await syncCommerceSubscriptionFromStripe({ store, order, group: null, subscription: subscriptionObject, connectedAccountId });
		if (event.type === 'invoice.payment_succeeded') {
			await store.updateEntitlementsForSubscription(synced.id, { status: 'active', renewalState: 'active' });
		}
		if (event.type === 'invoice.payment_failed') {
			await store.updateEntitlementsForSubscription(synced.id, { status: 'past_due', renewalState: 'past_due' });
		}
		return { relatedOrderId: synced.orderId, relatedSubscriptionId: synced.id };
	}
	await store.updateEntitlementsForSubscription(subscription.id, {
		status: event.type === 'invoice.payment_succeeded' ? 'active' : 'past_due',
		renewalState: event.type === 'invoice.payment_succeeded' ? 'active' : 'past_due',
	});
	return { relatedOrderId: subscription.orderId, relatedSubscriptionId: subscription.id };
}

async function processCommerceStripeWebhook({ store, stripeConnectService, event }) {
	const object = event?.data?.object ?? {};
	const connectedAccountId = optionalTrimmedString(event?.account) ?? optionalTrimmedString(event?.context) ?? null;
	if (['payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled'].includes(event.type)) {
		return handleCommercePaymentIntentWebhook({ store, event, object, connectedAccountId });
	}
	if (['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'].includes(event.type)) {
		return handleCommerceSubscriptionWebhook({ store, event, object, connectedAccountId });
	}
	if (['invoice.payment_succeeded', 'invoice.payment_failed'].includes(event.type)) {
		return handleCommerceInvoiceWebhook({ store, stripeConnectService, event, object, connectedAccountId });
	}
	return { ignored: true, reason: `Unhandled Stripe event type "${event.type}".` };
}

async function requireCommerceProductAccess(c, store, productId, permission = null) {
	const product = await store.getCommerceProduct(productId);
	if (!product) {
		return {
			response: jsonError(c, 404, `Unknown commerce product "${productId}".`),
		};
	}
	if (!permission && product.visibility === 'public' && product.status === 'approved') {
		return {
			principal: c.get('principal') ?? null,
			product,
		};
	}
	const auth = await ensurePrincipal(c);
	if (auth.response) return auth;
	if (permission) {
		const access = await requireTeamAccess(c, store, product.sellerTeamId, permission);
		if (access.response) return access;
		return {
			principal: access.principal,
			product,
		};
	}
	const teamIds = await store.teamIdsForPrincipal(auth.principal).catch(() => []);
	if (product.visibility === 'public' && product.status === 'approved') {
		return {
			principal: auth.principal,
			product,
		};
	}
	if (principalIsSeedAdmin(auth.principal) || teamIds.includes(product.sellerTeamId)) {
		return {
			principal: auth.principal,
			product,
		};
	}
	return {
		response: jsonError(c, 404, `Unknown commerce product "${productId}".`),
	};
}

async function principalCanManageCommerceProduct(store, principal, product) {
	if (!principal) return false;
	if (principalIsSeedAdmin(principal)) return true;
	const teamIds = await store.teamIdsForPrincipal(principal).catch(() => []);
	return teamIds.includes(product.sellerTeamId);
}

function redactCommerceOwnershipWorkflow(workflow) {
	if (!workflow) return null;
	return {
		productId: workflow.productId,
		currentOwnershipRecord: workflow.currentOwnershipRecord?.buyerVisible ? workflow.currentOwnershipRecord : null,
		buyerVisibleOwnershipRecords: workflow.buyerVisibleOwnershipRecords ?? [],
		stewardshipAssignments: (workflow.stewardshipAssignments ?? []).filter((assignment) => assignment.visibleToBuyers),
		contributions: (workflow.contributions ?? []).filter((contribution) => ['public', 'buyer'].includes(contribution.attributionVisibility)),
		governancePolicies: (workflow.governancePolicies ?? []).map((policy) => ({
			id: policy.id,
			productId: policy.productId,
			teamId: policy.teamId,
			policyKind: policy.policyKind,
			title: policy.title,
			buyerVisibleSummary: policy.buyerVisibleSummary,
			status: policy.status,
			createdAt: policy.createdAt,
			updatedAt: policy.updatedAt,
		})),
		pendingTransfers: [],
		successionEvents: [],
	};
}

async function requireCommerceOfferAccess(c, store, offerId, permission = null) {
	const auth = await ensurePrincipal(c);
	if (auth.response) return auth;
	const offer = await store.getCommerceOffer(offerId);
	if (!offer) {
		return {
			response: jsonError(c, 404, `Unknown commerce offer "${offerId}".`),
		};
	}
	if (permission) {
		const access = await requireTeamAccess(c, store, offer.sellerTeamId, permission);
		if (access.response) return access;
		return {
			principal: access.principal,
			offer,
		};
	}
	return {
		principal: auth.principal,
		offer,
	};
}

async function requireCatalogItemAccess(c, store, itemId, permission = null) {
	const auth = await ensurePrincipal(c);
	if (auth.response) {
		return auth;
	}
	const item = await store.getCatalogItem(itemId);
	if (!item) {
		return {
			response: jsonError(c, 404, `Unknown catalog item "${itemId}".`),
		};
	}
	const access = await requireTeamAccess(c, store, item.teamId, permission);
	if (access.response) {
		return access;
	}
	return {
		principal: access.principal,
		item,
	};
}

async function requireConnectedProjectRuntime(c, store, projectId, principal, path, input = {}) {
	const payload = await store.requestProjectRuntime(projectId, principal, path, input);
	if (!payload) {
		return {
			response: jsonError(c, 409, 'Project runtime is not connected or unavailable.', {
				projectId,
				path,
			}),
		};
	}
	return { payload };
}

async function projectAppHref(_store, _teamId, _projectSlug, section) {
	if (section === 'share') return '/app/knowledge/artifacts';
	return _projectSlug ? `/app/projects/${encodeURIComponent(_projectSlug)}` : '/app/projects';
}

function unwrapLaunchOperationOutput(output) {
	if (output?.operation === 'hub.execute_launch' && output.payload) return output.payload;
	if (output?.plan?.repository && output?.repository && output?.cloudflare) return output;
	return null;
}

async function appendLaunchPhaseProjection(store, launchId, jobId, phase) {
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
	const duplicate = existingEvents.some((existing) => (
		existing.phase === event.phase
		&& existing.status === event.status
		&& (existing.summary ?? null) === (event.summary ?? null)
	));
	if (duplicate) return null;
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

async function updateLaunchDeployments(store, job, patch) {
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

function hubRepositoryPolicies(role) {
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

export async function applyHubLaunchResult(store, runtime, job, output, principal = null) {
	const launchResult = unwrapLaunchOperationOutput(output);
	if (!launchResult) return null;
	const hubLaunch = await store.getHubLaunchByJobId(job.id);
	const project = await store.getProject(job.projectId);
	if (!project || !hubLaunch) return null;
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
	if (railwayApiService) {
		await store.upsertAgentPool(project.id, {
			teamId: project.teamId,
			environment: 'prod',
			name: 'managed-default',
			registrationIdentity: `market:${project.id}`,
			serviceBaseUrl: railwayApiService.publicBaseUrl ?? null,
			status: 'active',
			autoscale: {
				minWorkers: Number(process.env.TREESEED_AGENT_POOL_MIN_WORKERS ?? 1),
				maxWorkers: Number(process.env.TREESEED_AGENT_POOL_MAX_WORKERS ?? 3),
				targetQueueDepth: Number(process.env.TREESEED_AGENT_POOL_TARGET_QUEUE_DEPTH ?? 3),
				cooldownSeconds: Number(process.env.TREESEED_AGENT_POOL_COOLDOWN_SECONDS ?? 120),
			},
			metadata: {
				source: 'hub_launch_worker',
				services: launchResult.railway?.services ?? [],
			},
		});
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
	if (!hubLaunch || !project) return null;
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

function unwrapOperationPayload(output) {
	if (!output || typeof output !== 'object') return null;
	if (output.payload && typeof output.payload === 'object') return output.payload;
	return output;
}

async function applyContentPublishResult(store, job, output) {
	const project = await store.getProject(job.projectId);
	if (!project) return null;
	const payload = unwrapOperationPayload(output);
	if (!payload || payload.status !== 'published') return null;
	const result = payload.result && typeof payload.result === 'object' ? payload.result : {};
	const existing = await store.getHubContentSource(job.projectId);
	const repositories = await store.listHubRepositories(job.projectId);
	const contentRepository = repositories.find((repository) => repository.role === 'content') ?? null;
	const revision = typeof result.revision === 'string' && result.revision.trim()
		? result.revision.trim()
		: typeof result.previewId === 'string' && result.previewId.trim()
			? result.previewId.trim()
			: `publish-${job.id}`;
	const r2 = payload.r2 && typeof payload.r2 === 'object' ? payload.r2 : {};
	return store.upsertHubContentSource(job.projectId, {
		teamId: project.teamId,
		contentRepositoryId: existing?.contentRepositoryId ?? contentRepository?.id ?? null,
		productionSource: existing?.productionSource ?? 'r2_published_artifacts',
		overlayPolicy: existing?.overlayPolicy ?? 'src_content_when_present',
		r2BucketName: typeof r2.bucketName === 'string' && r2.bucketName.trim() ? r2.bucketName.trim() : existing?.r2BucketName ?? null,
		r2ManifestKey: typeof result.manifestKey === 'string' && result.manifestKey.trim() ? result.manifestKey.trim() : existing?.r2ManifestKey ?? null,
		r2PublicBaseUrl: typeof r2.publicBaseUrl === 'string' && r2.publicBaseUrl.trim() ? r2.publicBaseUrl.trim() : existing?.r2PublicBaseUrl ?? null,
		latestPublishId: revision,
		latestContentVersion: revision,
		metadata: {
			...(existing?.metadata ?? {}),
			lastPublish: {
				jobId: job.id,
				scope: payload.scope ?? null,
				mode: result.mode ?? payload.mode ?? null,
				revision,
				previewId: result.previewId ?? null,
				previewUrl: result.previewUrl ?? null,
				target: result.target ?? null,
				contentSource: payload.contentSource ?? null,
				publishedAt: new Date().toISOString(),
			},
		},
	});
}

async function executeInline(runtime, request) {
	if (request.namespace === 'workflow') {
		const operations = new TreeseedOperationsSdk();
		return operations.execute({
			operationName: request.operation,
			input: request.input ?? {},
		}, {
			cwd: runtime.resolved.config.repoRoot,
			env: process.env,
			transport: 'api',
		});
	}
	return executeSdkOperation(runtime.sharedSdk, request.operation, request.input ?? {});
}

function projectApiConnection(projectDetails) {
	const baseUrl = normalizeBaseUrl(projectDetails.connection?.projectApiBaseUrl);
	return baseUrl ? baseUrl : null;
}

function createProjectInternalClient(options, projectDetails, fallbackInternalPrefix) {
	const projectApiBaseUrl = projectApiConnection(projectDetails);
	if (!projectApiBaseUrl) {
		throw new Error(`Project "${projectDetails.project.id}" is missing a project API base URL.`);
	}

	const metadata = projectDetails.connection?.metadata ?? {};
	const internalPrefix = normalizeBaseUrl(
		typeof metadata.internalPrefix === 'string'
			? metadata.internalPrefix
			: fallbackInternalPrefix,
	);
	const projectApiKey =
		typeof metadata.projectApiKey === 'string' && metadata.projectApiKey.trim()
			? metadata.projectApiKey.trim()
			: typeof metadata.bearerToken === 'string' && metadata.bearerToken.trim()
				? metadata.bearerToken.trim()
				: null;
	if (!projectApiKey) {
		throw new Error(`Project "${projectDetails.project.id}" is missing a project API key for remote dispatch.`);
	}

	return new RemoteTreeseedClient({
		hosts: [{
			id: projectDetails.project.id,
			baseUrl: `${projectApiBaseUrl}${internalPrefix}`,
		}],
		activeHostId: projectDetails.project.id,
		auth: {
			accessToken: projectApiKey,
		},
	}, {
		fetchImpl: options.fetchImpl,
	});
}

async function executeProjectApi(options, projectDetails, request, fallbackInternalPrefix) {
	const client = createProjectInternalClient(options, projectDetails, fallbackInternalPrefix);
	if (request.namespace === 'workflow') {
		return new RemoteTreeseedOperationsClient(client).execute(request.operation, {
			input: request.input ?? {},
		});
	}
	return new RemoteTreeseedSdkClient(client).execute(request.operation, {
		input: request.input ?? {},
	});
}

function selectDispatchTarget(runtime, projectDetails, capability, preferredMode) {
	const currentProject = projectDetails.project.id === runtime.resolved.config.projectId;
	const mode = projectDetails.connection?.mode ?? (currentProject ? 'hosted' : 'self_hosted');
	const projectApiBaseUrl = projectApiConnection(projectDetails);

	if (capability.executionClass === 'local_only') {
		return 'local';
	}

	if (preferredMode === 'prefer_local' && currentProject && capability.allowedTargets.includes('local')) {
		return 'local';
	}

	if (capability.defaultTarget === 'market_catalog' && capability.allowedTargets.includes('market_catalog')) {
		return 'market_catalog';
	}

	if (
		capability.executionClass === 'remote_inline'
		&& capability.allowedTargets.includes('project_api')
		&& (projectApiBaseUrl || (currentProject && mode === 'hosted'))
	) {
		return 'project_api';
	}

	if ((mode === 'self_hosted' || mode === 'hybrid' || capability.executionClass === 'remote_job') && capability.allowedTargets.includes('project_runner')) {
		return 'project_runner';
	}

	if (currentProject && capability.allowedTargets.includes('local')) {
		return 'local';
	}

	if (capability.allowedTargets.includes('market_catalog')) {
		return 'market_catalog';
	}

	return null;
}

function defaultConfig(overrides = {}) {
	const resolved = resolveApiConfig();
	const config = {
		...resolved,
		projectId: overrides.projectId ?? resolved.projectId ?? 'treeseed-market',
		repoRoot: overrides.repoRoot ?? resolved.repoRoot ?? process.cwd(),
		d1DatabaseId: undefined,
		d1DatabaseName: undefined,
		d1LocalPersistTo: undefined,
		d1WranglerConfigPath: undefined,
		...overrides,
	};
	if (overrides.authApprovalBaseUrl == null && typeof overrides.siteUrl === 'string' && overrides.siteUrl.trim()) {
		config.authApprovalBaseUrl = overrides.siteUrl.trim();
	}
	return config;
}

export function createApiExtension(options = {}) {
	return {
		name: options.name ?? 'treeseed-market',
		mount: options.mount ?? ((app, runtime) => options.extendApp?.(app, runtime)),
	};
}

export function createApiApp(options = {}): Hono {
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
			app.get('/healthz/deep', async (c) => {
				try {
					await store.ensureInitialized();
					const probe = await store.first('SELECT 1 AS ok');
					return c.json({
						ok: true,
						status: 'ok',
						checks: {
							database: probe?.ok === 1 || probe?.ok === '1',
						},
					});
				} catch (error) {
					return jsonError(c, 500, error instanceof Error ? error.message : String(error));
				}
			});

			app.use('/v1/*', async (c, next) => {
				if (!c.get('principal')) {
					const token = bearerTokenFromRequest(c.req.raw);
					if (token) {
						const match = await store.authenticateTeamApiKey(token);
						if (match) {
							c.set('principal', match.principal);
							c.set('credential', {
								type: 'team_api_key',
								id: match.keyId,
								label: 'Team API Key',
							});
							c.set('actorType', 'service');
							c.set('permissionGrants', match.principal.permissions);
						}
					}
				}
				if (!c.get('principal') && localAcceptanceAuthEnabled(runtime)) {
					const token = bearerTokenFromRequest(c.req.raw);
					if (token && token === localAcceptanceAdminToken()) {
						const requestedTeam = c.req.param?.('teamId') || c.req.query?.('teamId') || process.env.TREESEED_CAPACITY_ACCEPTANCE_TEAM_ID || 'treeseed';
						const team = await store.getTeam(requestedTeam).catch(() => null)
							?? await store.getTeamBySlug(requestedTeam).catch(() => null)
							?? await store.getTeamBySlug('treeseed').catch(() => null);
						const principal = {
							id: 'team-key:local-capacity-acceptance',
							displayName: 'Local Capacity Acceptance',
							roles: ['team_api_key', 'market_admin'],
							permissions: ['*:*:*', 'seeds:apply:global', 'teams:manage:team'],
							scopes: ['auth:me'],
							metadata: {
								teamId: team?.id ?? null,
								teamName: team?.name ?? requestedTeam,
								teamDisplayName: team?.displayName ?? team?.name ?? requestedTeam,
								localAcceptance: true,
							},
						};
						c.set('principal', principal);
						c.set('credential', {
							type: 'team_api_key',
							id: 'local-capacity-acceptance',
							label: 'Local Capacity Acceptance',
						});
						c.set('actorType', 'service');
						c.set('permissionGrants', principal.permissions);
					}
				}
				await next();
			});

			app.get('/v1/markets/current', async (c) => c.json({
				ok: true,
				payload: centralMarketProfile(runtime.resolved.config.baseUrl),
			}));

			app.post('/v1/feedback', async (c) => {
				c.header('cache-control', 'no-store');
				const body = await c.req.json().catch(() => ({}));
				const result = await recordFeedbackSubmission(c, store, body);
				if (result.response) return result.response;
				return c.json({
					ok: true,
					payload: {
						id: result.id,
						privateScoped: result.privateScoped,
						hasScreenshot: result.hasScreenshot,
					},
				}, { status: 202 });
			});

			app.post('/v1/acceptance/seed', async (c) => {
				const service = requireConfiguredServiceCredential(c, runtime.resolved.config);
				if (service.response) return service.response;
				await ensureMarketCredentialSchema(store);
				const body = await c.req.json().catch(() => ({}));
				const namespace = optionalTrimmedString(body.namespace) ?? `acceptance-${runtime.resolved.config.environment ?? 'local'}`;
				const password = optionalTrimmedString(body.password) ?? `TreeSeed-${namespace}-acceptance-123!`;
				const actorInputs = body.actors && typeof body.actors === 'object'
					? body.actors
					: {
						siteAdmin: { siteRoles: ['platform_admin'] },
						marketSteward: { siteRoles: ['market_admin'] },
						teamOwner: { siteRoles: ['member'], teamRole: 'team_owner' },
						teamOperator: { siteRoles: ['member'], teamRole: 'contributor' },
						teamViewer: { siteRoles: ['viewer'], teamRole: 'reviewer' },
						nonMember: { siteRoles: ['viewer'] },
						providerOperator: { siteRoles: ['member'] },
					};
				const actors = {};
				for (const [actorId, actorInput] of Object.entries(actorInputs)) {
					const safeActorId = String(actorId).replace(/[^a-z0-9-]+/giu, '-').replace(/^-+|-+$/gu, '').toLowerCase() || 'actor';
					const email = normalizeEmail(actorInput.email) || `treeseed+${namespace}-${safeActorId}@treeseed.ai`;
					const username = normalizeUsername(actorInput.username) || `${namespace}-${safeActorId}`.replace(/[^a-z0-9-]+/gu, '-').slice(0, 39).replace(/^-+|-+$/gu, '') || safeActorId;
					const displayName = optionalTrimmedString(actorInput.displayName) ?? `Acceptance ${actorId}`;
					const synced = await runtimeMarketAuthProvider.syncUserIdentity({
						provider: 'acceptance',
						providerSubject: `${namespace}:${actorId}`,
						email,
						emailVerified: true,
						username,
						displayName,
						profile: { acceptance: true, namespace, actorId },
					});
					if (runtimeMarketAuthProvider.setUserRoles) {
						await runtimeMarketAuthProvider.setUserRoles(synced.principal.id, Array.isArray(actorInput.siteRoles) ? actorInput.siteRoles.map(String) : ['viewer']);
					}
					const now = new Date().toISOString();
					await store.run(`DELETE FROM market_auth_credentials WHERE user_id = ? OR email = ? OR username = ?`, [synced.principal.id, email, username]);
					await store.run(
						`INSERT INTO market_auth_credentials (user_id, email, username, password_hash, status, created_at, updated_at)
						 VALUES (?, ?, ?, ?, 'active', ?, ?)`,
						[synced.principal.id, email, username, hashMarketPassword(password), now, now],
					);
					await store.run(`DELETE FROM user_email_addresses WHERE user_id = ? OR normalized_email = ?`, [synced.principal.id, email]).catch(() => null);
					await store.run(
						`INSERT INTO user_email_addresses (
							id, user_id, email, normalized_email, status, is_primary, verification_requested_at, verified_at, created_at, updated_at
						) VALUES (?, ?, ?, ?, 'verified', 1, ?, ?, ?, ?)`,
						[randomUUID(), synced.principal.id, email, email, now, now, now, now],
					).catch(() => null);
					const session = await createMarketWebSession(runtimeMarketAuthProvider, synced.principal.id, {
						source: 'acceptance_seed',
						namespace,
						actorId,
					}, { store, authSecret: runtime.resolved.config.authSecret });
					actors[actorId] = {
						userId: synced.principal.id,
						email,
						username,
						accessToken: session.accessToken,
						sessionId: session.principal?.metadata?.sessionId ?? null,
						expiresAt: session.expiresAt ?? null,
					};
				}
				let team = null;
				let project = null;
				const teamSlug = `${namespace}-team`.replace(/[^a-z0-9-]+/gu, '-').slice(0, 48).replace(/^-+|-+$/gu, '') || 'acceptance-team';
				const existingTeam = await store.first(`SELECT * FROM teams WHERE slug = ? LIMIT 1`, [teamSlug]).catch(() => null);
				const owner = actors.teamOwner ?? actors.siteAdmin ?? Object.values(actors)[0];
					team = existingTeam ?? await store.createTeam({
						id: `team-${teamSlug}`,
						name: teamSlug,
						displayName: `Acceptance ${namespace}`,
						ownerUserId: owner?.userId,
						metadata: { acceptance: true, namespace },
					});
					let treeDx = await store.getTeamTreeDx(team.id);
					if (!treeDx?.instance) {
						treeDx = await store.provisionTeamTreeDx(team.id, {
							metadata: {
								automaticPrivateTeamTreeDx: true,
								createdFrom: 'acceptance_fixture',
								acceptance: true,
								namespace,
							},
						});
					}
				for (const [actorId, actorInput] of Object.entries(actorInputs)) {
					if (!actorInput.teamRole || !actors[actorId]?.userId) continue;
					await store.upsertTeamMember(team.id, actors[actorId].userId, String(actorInput.teamRole));
				}
				const ownerMembership = await store.first(
					`SELECT * FROM team_memberships WHERE team_id = ? AND user_id = ? LIMIT 1`,
					[team.id, owner?.userId],
				).catch(() => null);
				const projectSlug = `${namespace}-project`.replace(/[^a-z0-9-]+/gu, '-').slice(0, 48).replace(/^-+|-+$/gu, '') || 'acceptance-project';
				const acceptanceProjectArchitecture = {
					topology: 'single_repository_site',
					rootPath: '.',
					sitePath: '.',
					contentPath: 'src/content',
					contentRuntimeSource: 'treedx_snapshot',
					localContentMaterialization: 'none',
					contentPublishTarget: {
						kind: 'cloudflare_r2',
						prefix: `${projectSlug}/content`,
					},
				};
				project = await store.first(`SELECT * FROM projects WHERE team_id = ? AND slug = ? LIMIT 1`, [team.id, projectSlug]).catch(() => null);
					if (!project) {
						const details = await store.createProject(team.id, {
							id: `project-${projectSlug}`,
							slug: projectSlug,
							name: `Acceptance ${namespace}`,
						description: 'Reserved live acceptance fixture.',
						metadata: { acceptance: true, namespace, architecture: acceptanceProjectArchitecture },
					});
						project = details.project ?? details;
					}
					await store.upsertProjectTreeDxLibrary(project.id, {
						contentPath: 'src/content',
						metadata: {
							acceptance: true,
							namespace,
							source: 'acceptance_fixture',
							privateTeamTreeDxDefault: true,
						},
					}).catch(() => null);
					await store.upsertHubRepository(project.id, {
					teamId: team.id,
					role: 'software',
					provider: 'github',
					owner: 'treeseed-acceptance',
					name: projectSlug,
					url: `https://github.com/treeseed-acceptance/${projectSlug}`,
					defaultBranch: 'staging',
					status: 'ready',
					metadata: { acceptance: true, namespace, workflowFile: 'deploy-web.yml' },
				}).catch(() => null);
				const acceptanceWebHostId = `web-host-${namespace}`.replace(/[^a-z0-9-]+/giu, '-').slice(0, 96);
				const existingWebHost = await store.getTeamWebHost?.(team.id, acceptanceWebHostId).catch(() => null);
				if (!existingWebHost) {
					await store.createTeamWebHost(team.id, {
						id: acceptanceWebHostId,
						provider: 'cloudflare',
						ownership: 'team_owned',
						name: `Acceptance ${namespace} Web`,
						accountLabel: 'Acceptance Cloudflare',
						allowedEnvironments: ['staging', 'prod'],
						status: 'active',
						encryptedPayload: {
							version: 1,
							algorithm: 'acceptance-redacted',
							kdf: {},
							salt: 'acceptance',
							nonce: 'acceptance',
							ciphertext: 'redacted',
						},
						metadata: { acceptance: true, namespace },
						createdById: owner?.userId,
					}).catch(() => null);
				}
				const acceptanceLaunchRequirements = await resolveLaunchTemplateRequirements({
					store,
					principal: { id: owner?.userId ?? 'acceptance', roles: ['platform_admin'] },
					config: runtime.resolved.config,
					sourceKind: 'template',
					sourceRef: 'research',
					requireKnownTemplate: true,
				});
				const acceptanceManagedHosts = (await listTreeseedManagedHostsFromConfig(team.id, runtime).catch(() => []))
					.map((host) => host.id === 'treeseed-managed-web'
						? {
							...host,
							status: 'active',
							metadata: {
								...(host.metadata ?? {}),
								configured: true,
								missingConfigKeys: [],
							},
						}
						: host);
				const acceptanceHostBindingResolution = resolveProjectLaunchHostBindings({
					hostBindings: normalizeProjectLaunchHostBindings({
						hostBindings: {
							sourceRepository: {
								requirementKind: 'host',
								type: 'repository',
								provider: 'github',
								hostId: 'platform:github:hosted-hubs',
								mode: 'treeseed_managed',
							},
							publicWeb: {
								requirementKind: 'host',
								type: 'web',
								provider: 'cloudflare',
								managedHostKey: 'treeseed-managed-web',
								mode: 'treeseed_managed',
							},
							transactionalEmail: {
								requirementKind: 'host',
								type: 'email',
								provider: 'smtp',
								managedHostKey: 'treeseed-managed-email',
								mode: 'treeseed_managed',
							},
						},
					}),
					launchRequirements: acceptanceLaunchRequirements,
					repositoryHosts: repositoryInventoryWithPlatform([], 'treeseed-acceptance'),
					teamHosts: [],
					managedHosts: acceptanceManagedHosts,
					defaultHosts: team?.metadata?.defaultHosts && typeof team.metadata.defaultHosts === 'object' ? team.metadata.defaultHosts : {},
					projectSlug,
					projectName: project.name,
					standardProjectLaunch: true,
				});
				project = await store.updateProject(project.id, {
					metadata: {
						...(project.metadata ?? {}),
						acceptance: true,
						namespace,
						architecture: acceptanceProjectArchitecture,
						sourceKind: 'template',
						sourceRef: 'research',
						hostBindings: acceptanceHostBindingResolution.hostBindings,
						hostBindingPlans: {
							configWrites: acceptanceHostBindingResolution.configWritePlan,
							secretDeployment: acceptanceHostBindingResolution.secretDeploymentPlan,
						},
					},
				}) ?? project;
				await store.upsertProjectEnvironment(project.id, {
					environment: 'staging',
					deploymentProfile: 'hosted_project',
					baseUrl: `https://${projectSlug}.staging.example.test`,
					pagesProjectName: projectSlug,
					metadata: { acceptance: true, namespace },
				}).catch(() => null);
				await store.upsertProjectEnvironment(project.id, {
					environment: 'prod',
					deploymentProfile: 'hosted_project',
					baseUrl: `https://${projectSlug}.example.test`,
					pagesProjectName: projectSlug,
					metadata: { acceptance: true, namespace },
				}).catch(() => null);
				const provider = await store.upsertCapacityProvider(team.id, {
					id: `provider-${namespace}`.replace(/[^a-z0-9-]+/giu, '-').slice(0, 96),
					name: `Acceptance ${namespace} Provider`,
					kind: 'team_owned',
					status: 'active',
					provider: '@treeseed/agent',
					billingScope: 'team',
					metadata: {
						acceptance: true,
						namespace,
						launchMode: 'self_hosted',
						connectionState: 'online',
					},
				});
				const providerKey = await store.rotateCapacityProviderApiKey(team.id, provider.id, {
					createdById: owner?.userId,
				});
				const deployment = await store.createCapacityProviderDeployment(team.id, provider.id, {
					launchMode: 'self_hosted',
					status: 'deployed',
					id: `deployment-${namespace}`.replace(/[^a-z0-9-]+/giu, '-').slice(0, 96),
					serviceRefs: { manager: `acceptance-${namespace}-manager`, runner: `acceptance-${namespace}-runner` },
					envRefs: { TREESEED_CAPACITY_PROVIDER_API_KEY: { secretRef: 'acceptance-redacted' } },
					result: { acceptance: true, namespace },
					completedAt: new Date().toISOString(),
					createdById: owner?.userId,
				}).catch(() => null);
				const workday = await store.startRuntimeWorkDay(project.id, {
					id: `workday-${namespace}`.replace(/[^a-z0-9-]+/giu, '-').slice(0, 96),
					state: 'active',
					summary: { acceptance: true, namespace },
				}).catch(() => null);
				const operation = await store.createPlatformOperation({
					id: `operation-${namespace}`.replace(/[^a-z0-9-]+/giu, '-').slice(0, 96),
					namespace: 'market',
					operation: 'noop',
					status: 'queued',
					target: 'market_operations_runner',
					idempotencyKey: `acceptance-${namespace}`,
					input: { acceptance: true, namespace },
					requestedByType: 'service',
					requestedById: 'acceptance',
				}).catch(() => null);
				const platformRunnerId = `treeseed-ops-${namespace}-1`.replace(/[^a-z0-9-]+/giu, '-').slice(0, 96);
				const platformRunnerDataDir = resolve(process.cwd(), '.treeseed/acceptance-runners', namespace);
				const platformRunner = await store.upsertMarketOperationRunner({
					runnerId: platformRunnerId,
					name: `Acceptance ${namespace} Runner`,
					environment: runtime.resolved.config.environment ?? 'local',
					capabilities: ['market:noop', 'project:web_deployment'],
					maxConcurrentJobs: 1,
					metadata: { acceptance: true, namespace, dataDir: platformRunnerDataDir },
				}).catch(() => null);
				const catalogItem = await store.upsertCatalogItem(team.id, {
					id: `catalog-${namespace}`.replace(/[^a-z0-9-]+/giu, '-').slice(0, 96),
					kind: 'template',
					slug: `${namespace}-template`.replace(/[^a-z0-9-]+/gu, '-').slice(0, 64),
					title: `Acceptance ${namespace} Template`,
					summary: 'Reserved acceptance catalog fixture.',
					visibility: 'public',
					listingEnabled: true,
					offerMode: 'public',
					metadata: { acceptance: true, namespace },
				}).catch(() => null);
				const catalogArtifact = catalogItem ? await store.upsertCatalogArtifactVersion(team.id, catalogItem.id, {
					id: `artifact-${namespace}`.replace(/[^a-z0-9-]+/giu, '-').slice(0, 96),
					kind: 'template',
					version: '1.0.0',
					contentKey: `acceptance/${namespace}/template.tgz`,
					manifestKey: `acceptance/${namespace}/manifest.json`,
					metadata: { acceptance: true, namespace },
				}).catch(() => null) : null;
				const seedRun = await store.first(`SELECT * FROM seed_runs WHERE id = ? LIMIT 1`, [`seed-${namespace}`]).catch(() => null)
					?? await store.createSeedRun({
						id: `seed-${namespace}`.replace(/[^a-z0-9-]+/giu, '-').slice(0, 96),
						seedName: 'acceptance',
						seedVersion: 1,
						environments: [runtime.resolved.config.environment ?? 'local'],
						mode: 'plan',
						state: 'completed',
						actorType: 'service',
						actorId: 'acceptance',
						manifestHash: `acceptance-${namespace}`,
						plan: { acceptance: true, namespace },
						result: { ok: true },
						completedAt: new Date().toISOString(),
					}).catch(() => null);
				const invite = await store.createTeamInvite(team.id, {
					email: `treeseed+${namespace}-invite@treeseed.ai`,
					roleKey: 'reviewer',
					invitedByUserId: owner?.userId,
					autoAddExisting: false,
				}).catch(() => null);
				const approvalRequest = await store.first(`SELECT * FROM approval_requests WHERE id = ? LIMIT 1`, [`approval-${namespace}`]).catch(() => null)
					?? await store.createApprovalRequest({
						id: `approval-${namespace}`.replace(/[^a-z0-9-]+/giu, '-').slice(0, 96),
						teamId: team.id,
						projectId: project.id,
						kind: 'acceptance',
						severity: 'low',
						requestedByType: 'service',
						requestedById: 'acceptance',
						title: 'Acceptance approval request',
						summary: 'Reserved acceptance approval fixture.',
						options: [{ id: 'approve', label: 'Approve' }],
						metadata: { acceptance: true, namespace },
					}).catch(() => null);
				const decisionId = `decision-${namespace}`.replace(/[^a-z0-9-]+/giu, '-').slice(0, 96);
				const decisionPlanningStatus = await store.upsertDecisionPlanningStatus({
					id: `dps-${namespace}`.replace(/[^a-z0-9-]+/giu, '-').slice(0, 96),
					projectId: project.id,
					decisionId,
					executionReadiness: 'draft',
					planningInputsStatus: 'requested',
					metadata: { acceptance: true, namespace },
				}).catch(() => null);
				const workdayTestRunId = `workday-${namespace}`.replace(/[^a-z0-9-]+/giu, '-').slice(0, 96);
				const workdayTestRun = await store.getWorkdayTestRun(team.id, workdayTestRunId).catch(() => null)
					?? await store.createWorkdayTestRun(team.id, {
						id: workdayTestRunId,
						capacityProviderId: provider.id,
						scenarioId: 'acceptance',
						status: 'queued',
						environment: runtime.resolved.config.environment ?? 'local',
						requestedById: owner?.userId,
						parameters: { acceptance: true, namespace },
						summary: { seeded: true },
					}).catch(() => null);
				const workdayTestEvent = workdayTestRun ? await store.createWorkdayTestEvent(team.id, workdayTestRun.id, {
					id: `${workdayTestRun.id}-event-0000`,
					eventIndex: 0,
					eventType: 'acceptance.seeded',
					status: 'recorded',
					title: 'Acceptance seeded event',
					message: 'Seeded acceptance workday event.',
					parameters: { namespace },
					metadata: { acceptance: true, namespace },
				}).catch(() => null) : null;
				const resetToken = `reset_acceptance_${namespace}`;
				await store.run(
					`INSERT INTO market_auth_password_resets (id, user_id, token_hash, expires_at, used_at, created_at)
					 VALUES (?, ?, ?, ?, NULL, ?)
					 ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash, expires_at = excluded.expires_at, used_at = NULL`,
					[
						`reset-${namespace}`,
						actors.teamOwner?.userId ?? owner?.userId,
						createHash('sha256').update(resetToken).digest('hex'),
						new Date(Date.now() + 60 * 60 * 1000).toISOString(),
						new Date().toISOString(),
					],
				).catch(() => null);
				const platformRunnerSecret = resolvePlatformRunnerSecret(runtime.resolved.config);
				if (providerKey?.plaintextKey) {
					actors.providerKey = {
						userId: null,
						email: null,
						username: 'acceptance-provider-key',
						accessToken: providerKey.plaintextKey,
						expiresAt: null,
					};
				}
				if (platformRunnerSecret) {
					actors.platformRunner = {
						userId: null,
						email: null,
						username: platformRunnerId,
						accessToken: platformRunnerSecret,
						expiresAt: null,
					};
				}
				return c.json({
					ok: true,
					payload: {
						namespace,
						password,
						actors,
						fixtures: {
								team: { id: team.id, slug: team.slug ?? teamSlug },
								project: { id: project.id, slug: project.slug ?? projectSlug },
								treeDx: { id: treeDx?.instance?.id ?? null, mirrorCount: treeDx?.mirrors?.length ?? 0 },
							membership: { id: ownerMembership?.id ?? null },
							session: { id: actors.teamOwner?.sessionId ?? actors.siteAdmin?.sessionId ?? null },
							provider: { id: provider.id, keyPrefix: providerKey?.key?.keyPrefix ?? null },
							deployment: { id: deployment?.id ?? null },
							workday: { id: workday?.id ?? `workday-${namespace}` },
							job: { id: operation?.id ?? `operation-${namespace}` },
							platformOperation: { id: operation?.id ?? `operation-${namespace}` },
							platformRunner: { id: platformRunner?.id ?? platformRunnerId },
							catalogItem: { id: catalogItem?.id ?? `catalog-${namespace}`, slug: catalogItem?.slug ?? `${namespace}-template` },
							catalogArtifact: { id: catalogArtifact?.id ?? `artifact-${namespace}`, version: catalogArtifact?.version ?? '1.0.0' },
							seedRun: { id: seedRun?.id ?? `seed-${namespace}` },
							invite: { id: invite?.invite?.id ?? null },
							approvalRequest: { id: approvalRequest?.id ?? `approval-${namespace}` },
							decision: { id: decisionPlanningStatus?.decisionId ?? decisionId },
							workdayTestRun: { id: workdayTestRun?.id ?? workdayTestRunId },
							workdayTestEvent: { id: workdayTestEvent?.id ?? `${workdayTestRunId}-event-0000` },
							passwordReset: { token: resetToken },
							host: { id: acceptanceWebHostId },
							environment: { id: 'staging' },
						},
					},
				});
			});

			app.get('/v1/platform/operations', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				if (!principalHasGlobalPlatformRole(auth.principal) && !principalHasPermission(auth.principal, 'platform:operations:read')) {
					return jsonError(c, 403, 'Permission denied.', { permission: 'platform:operations:read' });
				}
				const operations = await store.listPlatformOperations({ limit: c.req.query('limit') });
				return c.json({ ok: true, operations: operations.map((operation) => decoratePlatformOperation(runtime.resolved.config.baseUrl, operation)) });
			});

			app.post('/v1/platform/operations', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				if (isTeamApiPrincipal(auth.principal) && !principalHasPermission(auth.principal, 'platform:operations:create')) {
					return jsonError(c, 403, 'Permission denied.', { permission: 'platform:operations:create' });
				}
				const body = await c.req.json().catch(() => ({}));
				const namespace = optionalTrimmedString(body.namespace);
				const operationName = optionalTrimmedString(body.operation);
				if (!namespace || !operationName) return jsonError(c, 400, 'namespace and operation are required.');
				const input = body.input && typeof body.input === 'object' && !Array.isArray(body.input) ? body.input : {};
				const approvalRequired = input.approvalRequired === true && input.approvalSatisfied !== true;
				const operation = await store.createPlatformOperation({
					namespace,
					operation: operationName,
					target: optionalTrimmedString(body.target) ?? 'market_operations_runner',
					status: approvalRequired ? 'waiting_for_approval' : optionalTrimmedString(body.status) ?? 'queued',
					idempotencyKey: optionalTrimmedString(body.idempotencyKey),
					input,
					requestedByType: isTeamApiPrincipal(auth.principal) ? 'team_api_key' : c.get('actorType') === 'service' ? 'service' : 'user',
					requestedById: auth.principal.id,
				});
				return c.json({ ok: true, operation: decoratePlatformOperation(runtime.resolved.config.baseUrl, operation) }, { status: 202 });
			});

			app.get('/v1/platform/operations/:operationId', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				if (isTeamApiPrincipal(auth.principal) && !principalHasPermission(auth.principal, 'platform:operations:read')) {
					return jsonError(c, 403, 'Permission denied.', { permission: 'platform:operations:read' });
				}
				const operation = await store.findPlatformOperationById(c.req.param('operationId'));
				if (!operation) return jsonError(c, 404, `Unknown platform operation "${c.req.param('operationId')}".`);
				return c.json({ ok: true, operation: decoratePlatformOperation(runtime.resolved.config.baseUrl, operation) });
			});

			app.get('/v1/platform/operations/:operationId/events', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				if (isTeamApiPrincipal(auth.principal) && !principalHasPermission(auth.principal, 'platform:operations:read')) {
					return jsonError(c, 403, 'Permission denied.', { permission: 'platform:operations:read' });
				}
				const operation = await store.findPlatformOperationById(c.req.param('operationId'));
				if (!operation) return jsonError(c, 404, `Unknown platform operation "${c.req.param('operationId')}".`);
				return c.json({ ok: true, events: await store.listPlatformOperationEvents(operation.id) });
			});

			app.post('/v1/platform/operations/:operationId/cancel', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				if (isTeamApiPrincipal(auth.principal) && !principalHasPermission(auth.principal, 'platform:operations:cancel')) {
					return jsonError(c, 403, 'Permission denied.', { permission: 'platform:operations:cancel' });
				}
				const operation = await store.findPlatformOperationById(c.req.param('operationId'));
				if (!operation) return jsonError(c, 404, `Unknown platform operation "${c.req.param('operationId')}".`);
				const cancelled = await store.cancelPlatformOperation(operation.id);
				return c.json({ ok: true, operation: decoratePlatformOperation(runtime.resolved.config.baseUrl, cancelled) });
			});

			app.post('/v1/platform/operations/:operationId/retry', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				if (isTeamApiPrincipal(auth.principal) && !principalHasPermission(auth.principal, 'platform:operations:retry')) {
					return jsonError(c, 403, 'Permission denied.', { permission: 'platform:operations:retry' });
				}
				const operation = await store.findPlatformOperationById(c.req.param('operationId'));
				if (!operation) return jsonError(c, 404, `Unknown platform operation "${c.req.param('operationId')}".`);
				if (!['failed', 'cancelled'].includes(operation.status)) {
					return jsonError(c, 409, 'Only failed or cancelled platform operations can be retried.', { status: operation.status });
				}
				const body = await c.req.json().catch(() => ({}));
				const retried = await store.retryPlatformOperation(operation.id, {
					inputPatch: body.inputPatch && typeof body.inputPatch === 'object' ? body.inputPatch : {},
				});
				return c.json({ ok: true, operation: decoratePlatformOperation(runtime.resolved.config.baseUrl, retried) }, { status: 202 });
			});

			app.post('/v1/platform/runners/register', async (c) => {
				const auth = await requirePlatformRunner(c, runtime.resolved.config);
				if (auth.response) return auth.response;
				const body = await c.req.json().catch(() => ({}));
				const runnerId = optionalTrimmedString(body.runnerId);
				if (!runnerId) return jsonError(c, 400, 'runnerId is required.');
				const runner = await store.upsertMarketOperationRunner({
					runnerId,
					runnerKey: optionalTrimmedString(body.runnerKey) ?? runnerId,
					name: optionalTrimmedString(body.name) ?? runnerId,
					environment: optionalTrimmedString(body.environment) ?? optionalTrimmedString(body.marketId) ?? 'unknown',
					version: optionalTrimmedString(body.version),
					capabilities: Array.isArray(body.capabilities) ? body.capabilities.map(String) : [],
					maxConcurrentJobs: body.maxConcurrentJobs,
					metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
				});
				return c.json({ ok: true, runner });
			});

			app.post('/v1/platform/runners/heartbeat', async (c) => {
				const auth = await requirePlatformRunner(c, runtime.resolved.config);
				if (auth.response) return auth.response;
				const body = await c.req.json().catch(() => ({}));
				const runnerId = optionalTrimmedString(body.runnerId);
				if (!runnerId) return jsonError(c, 400, 'runnerId is required.');
				const runner = await store.upsertMarketOperationRunner({
					runnerId,
					runnerKey: optionalTrimmedString(body.runnerKey) ?? runnerId,
					name: optionalTrimmedString(body.name) ?? runnerId,
					environment: optionalTrimmedString(body.environment) ?? optionalTrimmedString(body.marketId) ?? 'unknown',
					status: optionalTrimmedString(body.status) ?? 'online',
					version: optionalTrimmedString(body.version),
					capabilities: Array.isArray(body.capabilities) ? body.capabilities.map(String) : [],
					activeJobCount: body.activeJobCount,
					maxConcurrentJobs: body.maxConcurrentJobs,
					metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
				});
				return c.json({ ok: true, runner });
			});

			app.post('/v1/platform/runners/jobs/claim', async (c) => {
				const auth = await requirePlatformRunner(c, runtime.resolved.config);
				if (auth.response) return auth.response;
				const body = await c.req.json().catch(() => ({}));
				const runnerId = optionalTrimmedString(body.runnerId);
				if (!runnerId) return jsonError(c, 400, 'runnerId is required.');
				const operation = await store.claimPlatformOperation({
					runnerId,
					operationId: optionalTrimmedString(body.operationId),
					capabilities: Array.isArray(body.capabilities) ? body.capabilities.map(String) : [],
					limit: body.limit,
					leaseSeconds: body.leaseSeconds,
				});
				return c.json({ ok: true, operation: decoratePlatformOperation(runtime.resolved.config.baseUrl, operation) });
			});

			app.get('/v1/platform/runners/jobs/:operationId', async (c) => {
				const auth = await requirePlatformRunner(c, runtime.resolved.config);
				if (auth.response) return auth.response;
				const operation = await store.findPlatformOperationById(c.req.param('operationId'));
				if (!operation) return jsonError(c, 404, `Unknown platform operation "${c.req.param('operationId')}".`);
				return c.json({ ok: true, operation: decoratePlatformOperation(runtime.resolved.config.baseUrl, operation) });
			});

			app.post('/v1/platform/runners/jobs/:operationId/events', async (c) => {
				const auth = await requirePlatformRunner(c, runtime.resolved.config);
				if (auth.response) return auth.response;
				const operation = await store.findPlatformOperationById(c.req.param('operationId'));
				if (!operation) return jsonError(c, 404, `Unknown platform operation "${c.req.param('operationId')}".`);
				const body = await c.req.json().catch(() => ({}));
				const runnerId = optionalTrimmedString(body.runnerId);
				if (runnerId && operation.assignedRunnerId && operation.assignedRunnerId !== runnerId) {
					return jsonError(c, 409, 'Platform operation is assigned to a different runner.', { assignedRunnerId: operation.assignedRunnerId });
				}
				const event = body.event && typeof body.event === 'object' ? body.event : body;
				const kind = optionalTrimmedString(event.kind) ?? 'runner.event';
				const data = event.data && typeof event.data === 'object' ? event.data : {};
				return c.json({ ok: true, event: await store.appendPlatformOperationEvent(operation.id, kind, data) });
			});

			app.post('/v1/platform/runners/jobs/:operationId/checkpoint', async (c) => {
				const auth = await requirePlatformRunner(c, runtime.resolved.config);
				if (auth.response) return auth.response;
				const operation = await store.findPlatformOperationById(c.req.param('operationId'));
				if (!operation) return jsonError(c, 404, `Unknown platform operation "${c.req.param('operationId')}".`);
				const body = await c.req.json().catch(() => ({}));
				let checkpointed;
				try {
					checkpointed = await store.checkpointPlatformOperation(operation.id, {
						runnerId: optionalTrimmedString(body.runnerId),
						output: body.output,
						event: body.event,
					});
				} catch (error) {
					return platformOperationMutationError(c, error);
				}
				return c.json({ ok: true, operation: decoratePlatformOperation(runtime.resolved.config.baseUrl, checkpointed) });
			});

			app.post('/v1/platform/runners/jobs/:operationId/renew-lease', async (c) => {
				const auth = await requirePlatformRunner(c, runtime.resolved.config);
				if (auth.response) return auth.response;
				const operation = await store.findPlatformOperationById(c.req.param('operationId'));
				if (!operation) return jsonError(c, 404, `Unknown platform operation "${c.req.param('operationId')}".`);
				const body = await c.req.json().catch(() => ({}));
				let renewed;
				try {
					renewed = await store.renewPlatformOperationLease(operation.id, {
						runnerId: optionalTrimmedString(body.runnerId),
						leaseSeconds: body.leaseSeconds,
						event: body.event,
					});
				} catch (error) {
					return platformOperationMutationError(c, error);
				}
				return c.json({ ok: true, operation: decoratePlatformOperation(runtime.resolved.config.baseUrl, renewed) });
			});

			app.post('/v1/platform/runners/jobs/:operationId/cancel', async (c) => {
				const auth = await requirePlatformRunner(c, runtime.resolved.config);
				if (auth.response) return auth.response;
				const operation = await store.findPlatformOperationById(c.req.param('operationId'));
				if (!operation) return jsonError(c, 404, `Unknown platform operation "${c.req.param('operationId')}".`);
				const body = await c.req.json().catch(() => ({}));
				const runnerId = optionalTrimmedString(body.runnerId);
				if (runnerId && operation.assignedRunnerId && operation.assignedRunnerId !== runnerId) {
					return jsonError(c, 409, 'Platform operation is assigned to a different runner.', { assignedRunnerId: operation.assignedRunnerId });
				}
				const cancelled = await store.cancelPlatformOperation(operation.id);
				const event = body.event && typeof body.event === 'object' ? body.event : null;
				if (event) {
					await store.appendPlatformOperationEvent(operation.id, optionalTrimmedString(event.kind) ?? 'runner.cancelled', event.data && typeof event.data === 'object' ? event.data : {});
				}
				return c.json({ ok: true, operation: decoratePlatformOperation(runtime.resolved.config.baseUrl, cancelled) });
			});

			app.post('/v1/platform/runners/jobs/:operationId/complete', async (c) => {
				const auth = await requirePlatformRunner(c, runtime.resolved.config);
				if (auth.response) return auth.response;
				const operation = await store.findPlatformOperationById(c.req.param('operationId'));
				if (!operation) return jsonError(c, 404, `Unknown platform operation "${c.req.param('operationId')}".`);
				const body = await c.req.json().catch(() => ({}));
				let completed;
				try {
					completed = await store.completePlatformOperation(operation.id, {
						runnerId: optionalTrimmedString(body.runnerId),
						output: body.output,
						event: body.event,
					});
					if (operation.namespace === 'project' && operation.operation === 'web_deployment') {
						const output = body.output && typeof body.output === 'object' && !Array.isArray(body.output) ? body.output : {};
						const input = operation.input && typeof operation.input === 'object' && !Array.isArray(operation.input) ? operation.input : {};
						const deploymentId = optionalTrimmedString(output.deploymentId) ?? optionalTrimmedString(input.deploymentId);
						if (deploymentId) {
							const status = optionalTrimmedString(output.status) ?? (output.ok === true ? 'succeeded' : null);
							const terminalStatus = status === 'failed' ? 'failed' : status === 'succeeded' ? 'succeeded' : null;
							if (terminalStatus) {
								const updated = await store.updateProjectDeployment(deploymentId, {
									status: terminalStatus,
									externalWorkflow: output.externalWorkflow ?? null,
									target: output.target ?? null,
									monitor: output.monitor ?? null,
									summary: optionalTrimmedString(output.summary) ?? `Project web deployment ${terminalStatus}.`,
									error: terminalStatus === 'failed'
										? output.error ?? { code: 'project_web_deployment_failed', message: optionalTrimmedString(output.summary) ?? 'Project web deployment failed.' }
										: {},
								}).catch(() => null);
								if (updated) {
									await store.appendProjectDeploymentEvent(deploymentId, {
										kind: terminalStatus === 'failed' ? 'deployment.failed' : 'deployment.succeeded',
										message: optionalTrimmedString(output.summary) ?? `Project web deployment ${terminalStatus}.`,
										status: terminalStatus,
										severity: terminalStatus === 'failed' ? 'error' : 'info',
										operationId: operation.id,
										payload: {
											externalWorkflow: output.externalWorkflow ?? null,
											target: output.target ?? null,
											monitor: output.monitor ?? null,
										},
									}).catch(() => null);
								}
							}
						}
					}
				} catch (error) {
					return platformOperationMutationError(c, error);
				}
				return c.json({ ok: true, operation: decoratePlatformOperation(runtime.resolved.config.baseUrl, completed) });
			});

			app.post('/v1/platform/runners/jobs/:operationId/fail', async (c) => {
				const auth = await requirePlatformRunner(c, runtime.resolved.config);
				if (auth.response) return auth.response;
				const operation = await store.findPlatformOperationById(c.req.param('operationId'));
				if (!operation) return jsonError(c, 404, `Unknown platform operation "${c.req.param('operationId')}".`);
				const body = await c.req.json().catch(() => ({}));
				let failed;
				try {
					failed = await store.failPlatformOperation(operation.id, {
						runnerId: optionalTrimmedString(body.runnerId),
						error: body.error ?? { message: 'Platform operation failed.' },
						event: body.event,
					});
				} catch (error) {
					return platformOperationMutationError(c, error);
				}
				return c.json({ ok: true, operation: decoratePlatformOperation(runtime.resolved.config.baseUrl, failed) });
			});

			app.post('/v1/auth/device/start', async (c) => {
				const body = await c.req.json().catch(() => ({}));
				const started = await runtimeMarketAuthProvider.startDeviceFlow({
					clientName: typeof body.clientName === 'string' ? body.clientName : 'treeseed-cli',
					scopes: Array.isArray(body.scopes) ? body.scopes.map(String) : ['auth:me'],
				});
				return c.json(started);
			});

			app.post('/v1/auth/device/poll', async (c) => {
				const body = await c.req.json().catch(() => ({}));
				const response = await runtimeMarketAuthProvider.pollDeviceFlow({ deviceCode: String(body.deviceCode ?? '') });
				return c.json(response, { status: response.ok ? 200 : response.status === 'expired' ? 410 : 400 });
			});

			app.get('/v1/auth/device/approve', (c) => {
				const target = new URL('/auth/device/approve', `${resolveAuthApprovalBaseUrl(config)}/`);
				const userCode = c.req.query('user_code');
				if (userCode) target.searchParams.set('user_code', userCode);
				return c.redirect(target.toString(), 302);
			});

			app.post('/v1/auth/device/approve', async (c) => {
				const body = await c.req.json().catch(() => ({}));
				try {
					return c.json(await runtimeMarketAuthProvider.approveDeviceFlow({
						userCode: String(body.userCode ?? ''),
						principalId: String(body.principalId ?? ''),
						displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
						metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
						scopes: Array.isArray(body.scopes) ? body.scopes.map(String) : undefined,
					}));
				} catch (error) {
					return jsonError(c, 400, error instanceof Error ? error.message : String(error));
				}
			});

			app.post('/v1/auth/web/sign-up', async (c) => {
				await ensureMarketCredentialSchema(store);
				const body = await readJsonOrFormBody(c);
				const email = normalizeEmail(body.email);
				const username = normalizeUsername(body.username);
				const password = String(body.password ?? '');
				const displayName = String(body.displayName ?? body.name ?? email).trim();
				const returnTo = sanitizedReturnTo(body.returnTo);
				const inviteToken = String(body.inviteToken ?? '').trim();
				const appearance = normalizeAppearancePreference(body.appearance && typeof body.appearance === 'object' ? body.appearance : body);
				const usernameValidation = validatePublicUsername(username);
				if (!email || !email.includes('@')) return jsonError(c, 400, 'A valid email is required.');
				if (!usernameValidation.ok) return jsonError(c, 400, usernameValidation.message);
				if (!validateMarketPassword(password)) return jsonError(c, 400, 'Password must be at least 12 characters.');
				const inviteProof = inviteToken ? await store.getPendingTeamInviteByToken(inviteToken) : null;
				if (inviteToken && (!inviteProof?.ok || String(inviteProof.invite?.email ?? '').trim().toLowerCase() !== email)) {
					return jsonError(c, 400, 'Team invite does not match this registration email.', { code: 'invite_email_mismatch' });
				}
				const existingEmailCredential = await store.first(
					`SELECT user_id FROM market_auth_credentials WHERE email = ? LIMIT 1`,
					[email],
				);
				if (existingEmailCredential) return jsonError(c, 409, 'An account already exists for this email.');
				const existingUsernameCredential = await store.first(
					`SELECT user_id FROM market_auth_credentials WHERE username = ? LIMIT 1`,
					[username],
				);
				if (existingUsernameCredential) return jsonError(c, 409, 'Username is already taken.');
				if (await store.publicUsernameExists(username)) return jsonError(c, 409, 'Username is already taken.');
				if (await store.teamPublicNameExists(username)) {
					return jsonError(c, 409, 'Username is already taken by a team.', { code: 'namespace_taken' });
				}
				const existingEmailAddress = await store.first(
					`SELECT user_id FROM user_email_addresses WHERE normalized_email = ? LIMIT 1`,
					[email],
				);
				if (existingEmailAddress) return jsonError(c, 409, 'An account already exists for this email.');
				const synced = await runtimeMarketAuthProvider.syncUserIdentity({
					provider: 'credential',
					providerSubject: email,
					email,
					emailVerified: Boolean(inviteProof?.ok),
					username,
					displayName,
					profile: {
						firstName: optionalTrimmedString(body.firstName),
						lastName: optionalTrimmedString(body.lastName),
					},
				});
				await store.run(`UPDATE users SET metadata_json = ?, updated_at = ? WHERE id = ?`, [
					JSON.stringify({
						...(synced.principal.metadata ?? {}),
						appearance,
					}),
					new Date().toISOString(),
					synced.principal.id,
				]).catch(() => null);
				const now = new Date().toISOString();
				await store.run(
					`INSERT INTO market_auth_credentials (user_id, email, username, password_hash, status, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
					[synced.principal.id, email, username, hashMarketPassword(password), inviteProof?.ok ? 'active' : 'pending_email_confirmation', now, now],
				);
				const emailAddressId = randomUUID();
				await store.run(
					`INSERT INTO user_email_addresses (
						id, user_id, email, normalized_email, status, is_primary, verification_requested_at, verified_at, created_at, updated_at
					) VALUES (?, ?, ?, ?, ?, 1, NULL, ?, ?, ?)`,
					[emailAddressId, synced.principal.id, email, email, inviteProof?.ok ? 'verified' : 'pending', inviteProof?.ok ? now : null, now, now],
				);
				if (inviteProof?.ok) {
					const personalTeam = await store.ensurePersonalResearchTeamForUser(synced.principal.id);
					if (!personalTeam.ok) {
						return jsonError(c, personalTeam.code === 'namespace_conflict' ? 409 : 400, personalTeam.message, { code: personalTeam.code });
					}
					await setPrimaryEmailAddress(store, synced.principal.id, emailAddressId);
					const inviteAcceptance = await store.acceptTeamInvite(inviteToken, synced.principal.id);
					if (!inviteAcceptance.ok) {
						return jsonError(c, inviteAcceptance.code === 'email_mismatch' ? 400 : 409, inviteAcceptance.message, { code: inviteAcceptance.code });
					}
					const session = await createMarketWebSession(runtimeMarketAuthProvider, synced.principal.id, webSessionData(c, 'team_invite_registration'), { store, authSecret: runtime.resolved.config.authSecret });
					return c.json({ ok: true, payload: webAuthPayload(session) });
				}
				let confirmation;
				try {
					confirmation = await createMarketEmailConfirmation(store, marketAuthContext(c), {
						email,
						emailAddressId,
						displayName,
						returnTo,
						skipDelivery: shouldBypassAcceptanceAuthEmailDelivery(c, runtime.resolved.config),
					});
				} catch (error) {
					await store.run(`DELETE FROM market_auth_credentials WHERE user_id = ?`, [synced.principal.id]).catch(() => null);
					await store.run(`DELETE FROM user_email_addresses WHERE user_id = ?`, [synced.principal.id]).catch(() => null);
					await store.run(`DELETE FROM better_auth_verification WHERE identifier = ?`, [`${MARKET_EMAIL_CONFIRMATION_PREFIX}${emailAddressId}`]).catch(() => null);
					console.warn('[market-auth] Email confirmation setup failed:', error instanceof Error ? error.message : String(error));
					const reason = authEmailDeliveryFailureReason(error);
					return jsonError(c, 503, 'Email confirmation could not be sent. Please try again shortly.', {
						code: 'email_confirmation_delivery_failed',
						reason,
						...(shouldExposeNonProductionAuthDiagnostics(c, runtime) ? { detail: authEmailDeliveryFailureDetail(error) } : {}),
					});
				}
				await store.ensureCommonsParticipantForPrincipal(synced.principal, {
					displayName,
					metadata: { registrationSource: 'web_sign_up' },
				}).catch((error) => {
					console.warn('[commons] Participant enrollment after sign-up failed:', error instanceof Error ? error.message : String(error));
				});
				return c.json({
					ok: true,
					payload: {
						confirmationRequired: true,
						email,
						expiresInSeconds: confirmation.expiresInSeconds,
						confirmationToken: exposeAuthTokenForTests(c, runtime.resolved.config) ? confirmation.token : undefined,
					},
				});
			});

			app.post('/v1/acceptance/auth/confirm-email', async (c) => {
				const service = requireConfiguredServiceCredential(c, runtime.resolved.config);
				if (service.response) return service.response;
				await ensureMarketCredentialSchema(store);
				const body = await readJsonOrFormBody(c);
				const email = normalizeEmail(body.email);
				if (!email) return jsonError(c, 400, 'Email is required.');
				const emailAddress = await store.first(
					`SELECT * FROM user_email_addresses WHERE normalized_email = ? ORDER BY created_at DESC LIMIT 1`,
					[email],
				);
				if (!emailAddress?.id) return jsonError(c, 404, 'Email confirmation record not found.');
				const credential = await store.first(
					`SELECT user_id, email, username, status FROM market_auth_credentials WHERE user_id = ? LIMIT 1`,
					[emailAddress.user_id],
				);
				if (!credential || credential.status === 'deleted') return jsonError(c, 404, 'Email confirmation record not found.');
				const now = new Date().toISOString();
				const firstVerified = (await verifiedEmailCount(store, emailAddress.user_id)) === 0;
				if (firstVerified) {
					const personalTeam = await store.ensurePersonalResearchTeamForUser(emailAddress.user_id);
					if (!personalTeam.ok) {
						return jsonError(c, personalTeam.code === 'namespace_conflict' ? 409 : 400, personalTeam.message, { code: personalTeam.code });
					}
				}
				await store.run(
					`UPDATE user_email_addresses
					 SET status = 'verified', verified_at = COALESCE(verified_at, ?), updated_at = ?
					 WHERE id = ?`,
					[now, now, emailAddress.id],
				);
				if (Number(emailAddress.is_primary ?? 0) === 1 || firstVerified) {
					await setPrimaryEmailAddress(store, emailAddress.user_id, emailAddress.id);
				}
				if (credential.status !== 'active') {
					await store.run(
						`UPDATE market_auth_credentials SET status = 'active', updated_at = ? WHERE user_id = ?`,
						[now, credential.user_id],
					);
					await store.run(
						`UPDATE user_identities SET email_verified = 1, updated_at = ? WHERE user_id = ?`,
						[now, credential.user_id],
					).catch(() => null);
				}
				await store.run(`DELETE FROM better_auth_verification WHERE identifier = ?`, [`${MARKET_EMAIL_CONFIRMATION_PREFIX}${emailAddress.id}`]).catch(() => null);
				return c.json({
					ok: true,
					payload: {
						email,
						emailAddressId: emailAddress.id,
						userId: emailAddress.user_id,
						verified: true,
					},
				});
			});

			app.post('/v1/auth/web/confirm-email', async (c) => {
				await ensureMarketCredentialSchema(store);
				const body = await readJsonOrFormBody(c);
				const token = String(body.token ?? '').trim();
				if (!token) return jsonError(c, 400, 'Email confirmation token is required.');
				const row = await store.first(
					`SELECT * FROM better_auth_verification WHERE value = ? AND identifier LIKE ? LIMIT 1`,
					[marketEmailTokenHash(token), `${MARKET_EMAIL_CONFIRMATION_PREFIX}%`],
				);
				const expiresAt = authTokenTimestampMillis(row?.expiresAt ?? row?.expiresat ?? 0);
				if (!row || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
					return jsonError(c, 401, 'Email confirmation token is invalid or expired.');
				}
				const emailAddressId = String(row.identifier ?? '').slice(MARKET_EMAIL_CONFIRMATION_PREFIX.length);
				const emailAddress = await store.first(`SELECT * FROM user_email_addresses WHERE id = ? LIMIT 1`, [emailAddressId]);
				if (!emailAddress?.id) {
					return jsonError(c, 401, 'Email confirmation token is invalid or expired.');
				}
				const email = String(emailAddress.email ?? '').trim().toLowerCase();
				const credential = await store.first(
					`SELECT user_id, email, username, status FROM market_auth_credentials WHERE user_id = ? LIMIT 1`,
					[emailAddress.user_id],
				);
				if (!credential || credential.status === 'deleted') {
					return jsonError(c, 401, 'Email confirmation token is invalid or expired.');
				}
				const now = new Date().toISOString();
				const firstVerified = (await verifiedEmailCount(store, emailAddress.user_id)) === 0;
				if (firstVerified) {
					const personalTeam = await store.ensurePersonalResearchTeamForUser(emailAddress.user_id);
					if (!personalTeam.ok) {
						return jsonError(c, personalTeam.code === 'namespace_conflict' ? 409 : 400, personalTeam.message, { code: personalTeam.code });
					}
				}
				await store.run(
					`UPDATE user_email_addresses
					 SET status = 'verified', verified_at = COALESCE(verified_at, ?), updated_at = ?
					 WHERE id = ?`,
					[now, now, emailAddress.id],
				);
				if (Number(emailAddress.is_primary ?? 0) === 1 || firstVerified) {
					await setPrimaryEmailAddress(store, emailAddress.user_id, emailAddress.id);
				}
				if (credential.status !== 'active') {
					await store.run(
						`UPDATE market_auth_credentials SET status = 'active', updated_at = ? WHERE user_id = ?`,
						[now, credential.user_id],
					);
					await store.run(
						`UPDATE user_identities SET email_verified = 1, updated_at = ? WHERE user_id = ? AND provider = 'credential'`,
						[now, credential.user_id],
					).catch(() => null);
				}
				await store.run(`DELETE FROM better_auth_verification WHERE id = ?`, [row.id]).catch(() => null);
				const session = await createMarketWebSession(runtimeMarketAuthProvider, emailAddress.user_id, webSessionData(c, 'web_email_confirmed'), { store, authSecret: runtime.resolved.config.authSecret });
				if (credential.status !== 'active') {
					await sendWelcomeEmail(marketAuthContext(c), {
						email,
						displayName: credential.username ?? email,
					}).catch((error) => {
						console.info(`[auth-email] Welcome email skipped after confirmation: ${error instanceof Error ? error.message : String(error)}`);
					});
				}
				return c.json({ ok: true, payload: webAuthPayload(session) });
			});

			app.post('/v1/auth/web/sign-in', async (c) => {
				await ensureMarketCredentialSchema(store);
				const body = await readJsonOrFormBody(c);
				const identifier = normalizeEmail(body.email ?? body.login ?? body.username);
				const password = String(body.password ?? '');
				if (!identifier || !password) return jsonError(c, 400, 'Email or username and password are required.');
				let row = await store.first(
					`SELECT market_auth_credentials.user_id, market_auth_credentials.password_hash, market_auth_credentials.status
					   FROM market_auth_credentials
					   LEFT JOIN user_email_addresses
					     ON user_email_addresses.user_id = market_auth_credentials.user_id
					    AND user_email_addresses.normalized_email = ?
					    AND user_email_addresses.status = 'verified'
					  WHERE market_auth_credentials.username = ?
					     OR user_email_addresses.id IS NOT NULL
					  LIMIT 1`,
					[identifier, identifier],
				);
				if (!row) {
					row = await store.first(
						`SELECT market_auth_credentials.user_id, market_auth_credentials.password_hash, market_auth_credentials.status, user_email_addresses.status AS email_status
						   FROM market_auth_credentials
						   INNER JOIN user_email_addresses
						      ON user_email_addresses.user_id = market_auth_credentials.user_id
						     AND user_email_addresses.normalized_email = ?
						  LIMIT 1`,
						[identifier],
					);
				}
				if (!row || row.status === 'deleted' || !verifyMarketPassword(password, row.password_hash)) {
					return jsonError(c, 401, 'Authentication failed.');
				}
				if (row.status !== 'active' || (row.email_status && row.email_status !== 'verified')) {
					return jsonError(c, 403, 'Email confirmation is required before signing in.', {
						code: 'email_confirmation_required',
					});
				}
					const session = await createMarketWebSession(runtimeMarketAuthProvider, row.user_id, webSessionData(c, 'web_sign_in'), { store, authSecret: runtime.resolved.config.authSecret });
				return c.json({ ok: true, payload: webAuthPayload(session) });
			});

			app.get('/v1/auth/oauth/:provider/start', (c) => {
				const provider = c.req.param('provider');
				return jsonError(c, 501, `OAuth provider "${provider}" is not configured on the API yet.`);
			});

			app.get('/v1/auth/oauth/:provider/callback', (c) => {
				const provider = c.req.param('provider');
				return jsonError(c, 501, `OAuth provider "${provider}" is not configured on the API yet.`);
			});

			app.get('/v1/auth/web/username/check', async (c) => {
				await ensureMarketCredentialSchema(store);
				const username = normalizeUsername(c.req.query('username'));
				const validation = validatePublicUsername(username);
				if (!validation.ok) {
					return c.json({
						ok: true,
						payload: {
							username,
							available: false,
							status: validation.code === 'missing' ? 'empty' : validation.code,
							message: validation.code === 'missing' ? 'Username is public and cannot be changed after registration.' : validation.message,
						},
					});
				}
				const row = await store.first(`SELECT user_id FROM market_auth_credentials WHERE username = ? LIMIT 1`, [username]);
				const userTaken = row ? true : await store.publicUsernameExists(username);
				const teamTaken = userTaken ? false : await store.teamPublicNameExists(username);
				return c.json({
					ok: true,
					payload: {
						username,
						available: !userTaken && !teamTaken,
						status: userTaken || teamTaken ? 'taken' : 'available',
						message: userTaken ? 'Username is already taken.' : teamTaken ? 'Username is already taken by a team.' : 'Username is available.',
					},
				});
			});

			app.get('/v1/auth/web/emails', async (c) => {
				await ensureMarketCredentialSchema(store);
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				return c.json({ ok: true, payload: await listUserEmailAddresses(store, auth.principal.id) });
			});

			app.post('/v1/auth/web/emails', async (c) => {
				await ensureMarketCredentialSchema(store);
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const body = await readJsonOrFormBody(c);
				try {
					const result = await createOrResendUserEmailAddress(store, marketAuthContext(c), auth.principal.id, {
						email: body.email,
						displayName: auth.principal.displayName,
						returnTo: '/app/account',
						skipDelivery: shouldBypassAcceptanceAuthEmailDelivery(c, runtime.resolved.config),
					});
					if (!result.ok) return jsonError(c, result.status, result.error);
					return c.json({ ok: true, payload: result });
				} catch (error) {
					console.warn('[market-auth] Email verification setup failed:', error instanceof Error ? error.message : String(error));
					return jsonError(c, 503, 'Email verification could not be sent. Please try again shortly.', {
						code: 'email_verification_delivery_failed',
					});
				}
			});

			app.post('/v1/auth/web/emails/:emailId/verify', async (c) => {
				await ensureMarketCredentialSchema(store);
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const row = await getUserEmailAddress(store, auth.principal.id, c.req.param('emailId'));
				if (!row) return jsonError(c, 404, 'Email address was not found.');
				if (row.status === 'verified') {
					return c.json({ ok: true, payload: { emailAddress: row, verificationSent: false } });
				}
				try {
					const confirmation = await createMarketEmailConfirmation(store, marketAuthContext(c), {
						email: row.email,
						emailAddressId: row.id,
						displayName: auth.principal.displayName,
						returnTo: '/app/account',
						skipDelivery: shouldBypassAcceptanceAuthEmailDelivery(c, runtime.resolved.config),
					});
					return c.json({
						ok: true,
						payload: {
							emailAddress: serializeUserEmailAddress(await getUserEmailAddress(store, auth.principal.id, row.id)),
							verificationSent: true,
							confirmationToken: exposeAuthTokenForTests() ? confirmation.token : undefined,
						},
					});
				} catch (error) {
					console.warn('[market-auth] Email verification setup failed:', error instanceof Error ? error.message : String(error));
					return jsonError(c, 503, 'Email verification could not be sent. Please try again shortly.', {
						code: 'email_verification_delivery_failed',
					});
				}
			});

			app.post('/v1/auth/web/emails/:emailId/primary', async (c) => {
				await ensureMarketCredentialSchema(store);
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const result = await setPrimaryEmailAddress(store, auth.principal.id, c.req.param('emailId'));
				if (!result.ok) return jsonError(c, result.status, result.error);
				const session = await createMarketWebSession(runtimeMarketAuthProvider, auth.principal.id, webSessionData(c, 'email_primary_update'), { store, authSecret: runtime.resolved.config.authSecret });
				return c.json({ ok: true, payload: { ...webAuthPayload(session), emailAddress: result.emailAddress } });
			});

			app.delete('/v1/auth/web/emails/:emailId', async (c) => {
				await ensureMarketCredentialSchema(store);
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const row = await getUserEmailAddress(store, auth.principal.id, c.req.param('emailId'));
				if (!row) return jsonError(c, 404, 'Email address was not found.');
				if (row.status === 'verified' && await verifiedEmailCount(store, auth.principal.id) <= 1) {
					return jsonError(c, 409, 'At least one verified email is required.', { code: 'last_verified_email' });
				}
				await store.run(`DELETE FROM user_email_addresses WHERE id = ? AND user_id = ?`, [row.id, auth.principal.id]);
				if (row.status === 'verified' && row.isPrimary) {
					await syncPrimaryEmailCaches(store, auth.principal.id);
				}
				return c.json({ ok: true, payload: await listUserEmailAddresses(store, auth.principal.id) });
			});

			app.get('/v1/auth/web/sessions', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const sessions = await store.all(
					`SELECT id, session_type, expires_at, revoked_at, data_json, created_at, updated_at
					 FROM auth_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
					[auth.principal.id],
				).catch(() => []);
				return c.json({
					ok: true,
					payload: sessions.map((session) => {
						const data = parseJsonObject(session.data_json);
						return {
							id: session.id,
							provider: session.session_type,
							expiresAt: session.expires_at,
							revokedAt: session.revoked_at,
							authenticatedAt: session.created_at,
							lastSeenAt: session.updated_at,
							ipAddress: typeof data.ipAddress === 'string' ? data.ipAddress : null,
							userAgent: typeof data.userAgent === 'string' ? data.userAgent : null,
							current: auth.principal.metadata?.sessionId === session.id,
						};
					}),
				});
			});

			app.post('/v1/auth/web/sessions/:sessionId/revoke', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				await store.run(
					`UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE id = ? AND user_id = ?`,
					[new Date().toISOString(), new Date().toISOString(), c.req.param('sessionId'), auth.principal.id],
				);
				return c.json({ ok: true });
			});

			app.patch('/v1/auth/web/profile', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const body = await readJsonOrFormBody(c);
				const displayName = String(body.displayName ?? body.name ?? '').trim();
				const image = optionalTrimmedString(body.image);
				if (!displayName) return jsonError(c, 400, 'Display name is required.');
				const metadata = {
					...(auth.principal.metadata ?? {}),
					image,
				};
				await store.run(`UPDATE users SET display_name = ?, metadata_json = ?, updated_at = ? WHERE id = ?`, [
					displayName,
					JSON.stringify(metadata),
					new Date().toISOString(),
					auth.principal.id,
				]);
				const session = await createMarketWebSession(runtimeMarketAuthProvider, auth.principal.id, webSessionData(c, 'profile_update'), { store, authSecret: runtime.resolved.config.authSecret });
				return c.json({ ok: true, payload: webAuthPayload(session) });
			});

			app.get('/v1/auth/web/appearance', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				return c.json({
					ok: true,
					payload: normalizeAppearancePreference(auth.principal.metadata?.appearance ?? {}),
				});
			});

			app.patch('/v1/auth/web/appearance', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const body = await readJsonOrFormBody(c);
				const appearance = normalizeAppearancePreference(body);
				const metadata = {
					...(auth.principal.metadata ?? {}),
					appearance,
				};
				await store.run(`UPDATE users SET metadata_json = ?, updated_at = ? WHERE id = ?`, [
					JSON.stringify(metadata),
					new Date().toISOString(),
					auth.principal.id,
				]);
				const session = await createMarketWebSession(runtimeMarketAuthProvider, auth.principal.id, webSessionData(c, 'appearance_update'), { store, authSecret: runtime.resolved.config.authSecret });
				return c.json({ ok: true, payload: { ...webAuthPayload(session), ...appearance } });
			});

			app.patch('/v1/auth/web/email', async (c) => {
				await ensureMarketCredentialSchema(store);
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const body = await readJsonOrFormBody(c);
				const email = normalizeEmail(body.email ?? body.newEmail);
				if (!email || !email.includes('@')) return jsonError(c, 400, 'A valid email is required.');
				try {
					const result = await createOrResendUserEmailAddress(store, marketAuthContext(c), auth.principal.id, {
						email,
						displayName: auth.principal.displayName,
						returnTo: '/app/account',
						skipDelivery: shouldBypassAcceptanceAuthEmailDelivery(c, runtime.resolved.config),
					});
					if (!result.ok) return jsonError(c, result.status, result.error);
					if (result.emailAddress?.status === 'verified') {
						await setPrimaryEmailAddress(store, auth.principal.id, result.emailAddress.id);
					}
						const session = await createMarketWebSession(runtimeMarketAuthProvider, auth.principal.id, webSessionData(c, 'email_update'), { store, authSecret: runtime.resolved.config.authSecret });
					return c.json({ ok: true, payload: { ...webAuthPayload(session), ...result } });
				} catch (error) {
					console.warn('[market-auth] Email verification setup failed:', error instanceof Error ? error.message : String(error));
					return jsonError(c, 503, 'Email verification could not be sent. Please try again shortly.', {
						code: 'email_verification_delivery_failed',
					});
				}
			});

			app.patch('/v1/auth/web/password', async (c) => {
				await ensureMarketCredentialSchema(store);
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const body = await readJsonOrFormBody(c);
				const currentPassword = String(body.currentPassword ?? '');
				const newPassword = String(body.newPassword ?? body.password ?? '');
				if (!validateMarketPassword(newPassword)) return jsonError(c, 400, 'Password must be at least 12 characters.');
				const row = await store.first(`SELECT password_hash FROM market_auth_credentials WHERE user_id = ? LIMIT 1`, [auth.principal.id]);
				if (row && currentPassword && !verifyMarketPassword(currentPassword, row.password_hash)) {
					return jsonError(c, 401, 'Current password was not accepted.');
				}
				if (!row) {
					const email = normalizeEmail(auth.principal.metadata?.email);
					const username = normalizeUsername(auth.principal.metadata?.username ?? auth.principal.id);
					await store.run(
						`INSERT INTO market_auth_credentials (user_id, email, username, password_hash, status, created_at, updated_at)
						 VALUES (?, ?, ?, ?, 'active', ?, ?)`,
						[auth.principal.id, email || `${auth.principal.id}@treeseed.local`, username || null, hashMarketPassword(newPassword), new Date().toISOString(), new Date().toISOString()],
					);
				} else {
					await store.run(`UPDATE market_auth_credentials SET password_hash = ?, updated_at = ? WHERE user_id = ?`, [
						hashMarketPassword(newPassword),
						new Date().toISOString(),
						auth.principal.id,
					]);
				}
				return c.json({ ok: true });
			});

			app.post('/v1/auth/web/password-reset/request', async (c) => {
				await ensureMarketCredentialSchema(store);
				const body = await readJsonOrFormBody(c);
				const email = normalizeEmail(body.email);
				const row = email
					? await store.first(
						`SELECT market_auth_credentials.user_id
						   FROM market_auth_credentials
						   INNER JOIN user_email_addresses
						      ON user_email_addresses.user_id = market_auth_credentials.user_id
						     AND user_email_addresses.normalized_email = ?
						     AND user_email_addresses.status = 'verified'
						  WHERE market_auth_credentials.status = 'active'
						  LIMIT 1`,
						[email],
					)
					: null;
				let resetToken = null;
				if (row) {
					resetToken = `reset_${randomBytes(24).toString('base64url')}`;
					await store.run(
						`INSERT INTO market_auth_password_resets (id, user_id, token_hash, expires_at, used_at, created_at)
						 VALUES (?, ?, ?, ?, NULL, ?)`,
						[
							randomUUID(),
							row.user_id,
							createHash('sha256').update(resetToken).digest('hex'),
							new Date(Date.now() + 60 * 60 * 1000).toISOString(),
							new Date().toISOString(),
						],
					);
				}
				return c.json({
					ok: true,
					payload: {
						sent: true,
						resetToken: process.env.NODE_ENV === 'test' || process.env.TREESEED_ACCEPTANCE_EXPOSE_RESET_TOKENS === '1' ? resetToken : undefined,
					},
				});
			});

			app.post('/v1/auth/web/password-reset/complete', async (c) => {
				await ensureMarketCredentialSchema(store);
				const body = await readJsonOrFormBody(c);
				const token = String(body.token ?? '');
				const newPassword = String(body.newPassword ?? body.password ?? '');
				if (!token || !validateMarketPassword(newPassword)) return jsonError(c, 400, 'A valid reset token and password are required.');
				const row = await store.first(
					`SELECT * FROM market_auth_password_resets WHERE token_hash = ? AND used_at IS NULL LIMIT 1`,
					[createHash('sha256').update(token).digest('hex')],
				);
				if (!row || new Date(row.expires_at).getTime() <= Date.now()) return jsonError(c, 401, 'Password reset token is invalid or expired.');
				await store.run(`UPDATE market_auth_credentials SET password_hash = ?, updated_at = ? WHERE user_id = ?`, [
					hashMarketPassword(newPassword),
					new Date().toISOString(),
					row.user_id,
				]);
				await store.run(`UPDATE market_auth_password_resets SET used_at = ? WHERE id = ?`, [new Date().toISOString(), row.id]);
				return c.json({ ok: true });
			});

			app.get('/v1/auth/web/account/deletion-blockers', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const teams = await store.listTeamsForPrincipal(auth.principal);
				const blockers = teams
					.filter((team) => Array.isArray(team.roles) ? team.roles.includes('owner') : team.role === 'owner')
					.map((team) => ({
						code: 'team_owner',
						message: `Transfer or delete team "${team.displayName ?? team.name ?? team.slug}" before deleting this account.`,
						teamId: team.id,
						teamSlug: team.slug,
						teamName: team.displayName ?? team.name ?? team.slug,
					}));
				if (auth.principal.roles?.includes?.('platform_admin')) {
					blockers.push({ code: 'platform_admin', message: 'Remove platform admin role before deleting this account.' });
				}
				return c.json({ ok: true, payload: blockers });
			});

			app.delete('/v1/auth/web/account', async (c) => {
				await ensureMarketCredentialSchema(store);
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const body = await readJsonOrFormBody(c);
				if (!accountDeletionConfirmationMatches(String(body.confirmation ?? ''))) {
					return jsonError(c, 409, 'Type "DELETE MY ACCOUNT" to delete this account.', { code: 'confirmation' });
				}
				await store.run(`UPDATE users SET status = 'deleted', updated_at = ? WHERE id = ?`, [new Date().toISOString(), auth.principal.id]);
				await store.run(`UPDATE market_auth_credentials SET status = 'deleted', updated_at = ? WHERE user_id = ?`, [new Date().toISOString(), auth.principal.id]);
				await store.run(`DELETE FROM user_email_addresses WHERE user_id = ?`, [auth.principal.id]).catch(() => null);
				await store.run(`UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE user_id = ?`, [
					new Date().toISOString(),
					new Date().toISOString(),
					auth.principal.id,
				]).catch(() => {});
				return c.json({ ok: true });
			});

			app.post('/v1/auth/token/refresh', async (c) => {
				const body = await c.req.json().catch(() => ({}));
				try {
					return c.json(await runtimeMarketAuthProvider.refreshAccessToken({ refreshToken: String(body.refreshToken ?? '') }));
				} catch (error) {
					return jsonError(c, 401, error instanceof Error ? error.message : String(error));
				}
			});

			app.post('/v1/auth/logout', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const sessionId = auth.principal.metadata?.sessionId;
				if (typeof sessionId === 'string' && sessionId.trim()) {
					await store.run(
						`UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE id = ? AND user_id = ?`,
						[new Date().toISOString(), new Date().toISOString(), sessionId, auth.principal.id],
					).catch(() => {});
				}
				return c.json({ ok: true });
			});

			app.get('/v1/me', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const teams = await store.listTeamsForPrincipal(auth.principal);
				return c.json({
					ok: true,
					payload: {
						principal: auth.principal,
						teams,
					},
				});
			});

			app.get('/v1/me/markets', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const teams = await store.listTeamsForPrincipal(auth.principal);
				return c.json({
					ok: true,
					payload: marketProfilesForTeams(teams, runtime.resolved.config.baseUrl),
				});
			});

			app.get('/v1/ui/governance', async (c) => {
				const context = await resolveUiProjectionContext(c, store);
				if (context.response) return context.response;
				const projection = await buildGovernanceProjection({
					store,
					principal: context.principal,
					teams: context.teams,
					projects: context.projects,
				});
				return c.json({ ok: true, payload: projection });
			});

			app.get('/v1/ui/governance/:approvalId', async (c) => {
				const context = await resolveUiProjectionContext(c, store);
				if (context.response) return context.response;
				const detail = await buildGovernanceApprovalProjection({
					store,
					principal: context.principal,
					teams: context.teams,
					projects: context.projects,
					approvalId: decodeRouteParam(c.req.param('approvalId')),
				});
				if (!detail) return jsonError(c, 404, 'Unknown approval request.');
				return c.json({ ok: true, payload: detail });
			});

			app.post('/v1/ui/governance/:approvalId/decision', async (c) => {
				const context = await resolveUiProjectionContext(c, store);
				if (context.response) return context.response;
				const approvalId = decodeRouteParam(c.req.param('approvalId'));
				const detail = await buildGovernanceApprovalProjection({
					store,
					principal: context.principal,
					teams: context.teams,
					projects: context.projects,
					approvalId,
				});
				if (!detail) return jsonError(c, 404, 'Unknown approval request.');
				if (!['pending', 'waiting_for_approval', 'under_review', 'approval_required'].includes(String(detail.approval.state ?? '').toLowerCase())) {
					return jsonError(c, 409, 'This approval request is not pending.', { state: detail.approval.state });
				}
				const body = await readJsonOrFormBody(c);
				const optionId = typeof body.optionId === 'string' ? body.optionId : typeof body.decision === 'string' ? body.decision : '';
				const option = detail.decisionOptions.find((entry) => entry.id === optionId) ?? detail.decisionOptions[0];
				const state = body.state === 'rejected' || option?.state === 'rejected' ? 'rejected' : 'approved';
				const decided = await store.decideApprovalRequest(detail.approval.approvalId, {
					state,
					decidedByType: 'user',
					decidedById: context.principal.id,
					decision: {
						optionId: option?.id ?? (optionId || null),
						note: typeof body.note === 'string' ? body.note : null,
					},
				});
				if (context.activeTeam && typeof store.deleteTeamInboxItemsByItemKey === 'function') {
					await store.deleteTeamInboxItemsByItemKey(context.activeTeam.id, detail.approval.approvalId).catch(() => {});
				}
				return c.json({ ok: true, payload: decided });
			});

			app.get('/v1/ui/infrastructure', async (c) => {
				const context = await resolveUiProjectionContext(c, store);
				if (context.response) return context.response;
				const seedState = await loadInfrastructureSeedState({
					store,
					team: context.activeTeam,
					principal: context.principal,
					locals: uiRuntimeLocals(runtime.resolved.config),
					url: new URL(c.req.url),
				}).catch(() => null);
				const projection = await buildInfrastructureProjection({
					store,
					principal: context.principal,
					team: context.activeTeam,
					projects: context.projects,
					seedState,
				});
				return c.json({ ok: true, payload: projection });
			});

			app.get('/v1/ui/knowledge', async (c) => {
				const context = await resolveUiProjectionContext(c, store);
				if (context.response) return context.response;
				const contentEntries = await loadKnowledgeContentEntries().catch(() => []);
				const projection = await buildKnowledgeProjection({
					store,
					principal: context.principal,
					teams: context.teams,
					projects: context.projects,
					contentEntries,
				});
				return c.json({ ok: true, payload: projection });
			});

			app.get('/v1/ui/knowledge/:artifactId', async (c) => {
				const context = await resolveUiProjectionContext(c, store);
				if (context.response) return context.response;
				const contentEntries = await loadKnowledgeContentEntries().catch(() => []);
				const artifact = await buildKnowledgeArtifactProjection({
					store,
					principal: context.principal,
					teams: context.teams,
					projects: context.projects,
					contentEntries,
					artifactId: decodeRouteParam(c.req.param('artifactId')),
				});
				if (!artifact) return jsonError(c, 404, 'Unknown knowledge artifact.');
				return c.json({ ok: true, payload: artifact });
			});

			app.get('/v1/ui/workdays/:workdayId', async (c) => {
				const context = await resolveUiProjectionContext(c, store);
				if (context.response) return context.response;
				const projection = await buildWorkdayProjection({
					store,
					principal: context.principal,
					projects: context.projects,
					workdayId: decodeRouteParam(c.req.param('workdayId')),
				});
				if (!projection) return jsonError(c, 404, 'Unknown workday.');
				return c.json({ ok: true, payload: projection });
			});

			app.get('/v1/teams', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				return c.json({
					ok: true,
					payload: await store.listTeamsForPrincipal(auth.principal),
				});
			});

			app.get('/v1/teams/by-name/:name/profile', async (c) => {
				const profile = await store.loadTeamProfileByName(c.req.param('name'), c.get('principal'));
				if (!profile) return jsonError(c, 404, 'Unknown team profile.');
				return c.json({ ok: true, payload: profile });
			});

			app.get('/v1/users/by-username/:username/profile', async (c) => {
				const profile = await store.loadUserProfileByUsername(c.req.param('username'), c.get('principal'));
				if (!profile) return jsonError(c, 404, 'Unknown user profile.');
				return c.json({ ok: true, payload: profile });
			});

			app.get('/v1/seeds/runs', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const limit = Number(c.req.query('limit') ?? 50);
				return c.json({ ok: true, payload: await store.listSeedRuns(limit) });
			});

			app.get('/v1/seeds/runs/:runId', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const run = await store.getSeedRun(c.req.param('runId'));
				if (!run) return jsonError(c, 404, 'Unknown seed run.');
				return c.json({ ok: true, payload: run });
			});

			app.post('/v1/seeds/:name/plan', async (c) => {
				const body = await c.req.json().catch(() => ({}));
				const planned = await planSeedWithStore({
					projectRoot: config.repoRoot,
					seedName: c.req.param('name'),
					environments: normalizeSeedEnvironments(body.environments),
					manifestRef: typeof body.manifestRef === 'string' ? body.manifestRef : undefined,
					mode: 'plan',
					store,
					actor: seedActor(c),
				});
				if (!planned.plan) {
					return c.json({
						ok: false,
						seed: c.req.param('name'),
						mode: 'plan',
						environments: [],
						summary: null,
						actions: [],
						diagnostics: planned.diagnostics,
					}, { status: 400 });
				}
				const access = await requireSeedPlanAccess(c, store, planned.plan);
				if (access.response) return access.response;
				const run = await store.createSeedRun({
					seedName: planned.plan.seed,
					seedVersion: planned.plan.version,
					environments: planned.plan.environments,
					mode: 'plan',
					state: 'completed',
					actorType: seedActor(c).actorType,
					actorId: access.principal.id,
					manifestHash: planned['manifestHash'],
					plan: planned.plan,
					result: { actionCount: planned.plan.summary.create + planned.plan.summary.update },
					completedAt: new Date().toISOString(),
				});
				return c.json({
					ok: true,
					seed: planned.plan.seed,
					mode: 'plan',
					environments: planned.plan.environments,
					summary: planned.plan.summary,
					actions: planned.plan.actions,
					diagnostics: planned.plan.diagnostics,
					run,
				});
			});

			app.post('/v1/seeds/:name/apply', async (c) => {
				const body = await c.req.json().catch(() => ({}));
				const planned = await planSeedWithStore({
					projectRoot: config.repoRoot,
					seedName: c.req.param('name'),
					environments: normalizeSeedEnvironments(body.environments),
					manifestRef: typeof body.manifestRef === 'string' ? body.manifestRef : undefined,
					mode: 'apply',
					store,
					actor: seedActor(c),
				});
				if (!planned.plan) {
					return c.json({
						ok: false,
						seed: c.req.param('name'),
						mode: 'apply',
						environments: [],
						summary: null,
						actions: [],
						diagnostics: planned.diagnostics,
					}, { status: 400 });
				}
				const access = await requireSeedApplyAccess(c, store, planned.plan);
				if (access.response) return access.response;
				const applied = await applySeedWithStore({
					projectRoot: config.repoRoot,
					seedName: c.req.param('name'),
					environments: normalizeSeedEnvironments(body.environments),
					manifestRef: typeof body.manifestRef === 'string' ? body.manifestRef : undefined,
					approvalRequestId: typeof body.approvalRequestId === 'string' ? body.approvalRequestId : undefined,
					store,
					localOnly: planned.plan.environments.length === 1 && planned.plan.environments[0] === 'local',
					actor: {
						...seedActor(c),
						principal: access.principal,
					},
				});
				const blocked = applied.result?.blocked === true;
				return c.json({
					ok: !blocked,
					seed: applied.plan.seed,
					mode: 'apply',
					environments: applied.plan.environments,
					summary: applied.plan.summary,
					actions: applied.plan.actions,
					diagnostics: applied.plan.diagnostics,
					run: applied.run,
					result: applied.result,
					...(blocked ? { error: applied.result.reason } : {}),
				}, { status: blocked ? 409 : 200 });
			});

			app.post('/v1/team-invites/:token/accept', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const result = await store.acceptTeamInvite(c.req.param('token'), auth.principal.id);
				return c.json(result, result.ok ? 200 : 400);
			});

			app.get('/v1/team-invites/:token', async (c) => {
				const result = await store.getTeamInviteByToken(c.req.param('token'));
				if (!result.ok) return c.json(result, 404);
				return c.json({
					ok: true,
					payload: {
						invite: {
							id: result.invite.id,
							email: result.invite.email,
							roleKey: result.invite.roleKey,
							status: result.invite.status,
							expiresAt: result.invite.expiresAt,
						},
						team: result.team ? {
							id: result.team.id,
							name: result.team.name,
							displayName: result.team.displayName,
						} : null,
					},
				});
			});

			app.get('/v1/teams/:teamId/home', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({
					ok: true,
					payload: await store.getTeamHomeSummary(c.req.param('teamId'), access.principal),
				});
			});

			app.get('/v1/teams/:teamId/inbox', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({
					ok: true,
					payload: await store.listTeamInboxItems(c.req.param('teamId'), access.principal),
				});
			});

			app.get('/v1/teams/:teamId/approval-requests', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				const limit = Number(c.req.query('limit') ?? 50);
				const kind = c.req.query('kind');
				return c.json({
					ok: true,
					payload: await store.listApprovalRequestsForTeam(c.req.param('teamId'), { kind, limit }),
				});
			});

			app.get('/v1/teams/:teamId/members', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				return c.json({
					ok: true,
					payload: await store.listTeamMembers(c.req.param('teamId')),
				});
			});

			app.get('/v1/teams/:teamId/permissions', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({
					ok: true,
					payload: await store.getTeamAccessSummary(c.req.param('teamId'), access.principal),
				});
			});

			app.get('/v1/teams/:teamId/products', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({
					ok: true,
					payload: await store.listTeamProducts(c.req.param('teamId'), access.principal),
				});
			});

			app.post('/v1/teams/:teamId/seeds/export', async (c) => {
				const body = await c.req.json().catch(() => ({}));
				const includePrivate = body.includePrivate === true;
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), includePrivate ? 'teams:manage:team' : 'projects:read:team');
				if (access.response) return access.response;
				const result = await exportSeedWithStore({
					store,
					teamId: c.req.param('teamId'),
					name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'exported',
					environments: normalizeSeedEnvironments(body.environments),
					includePrivate,
					includeArtifacts: body.includeArtifacts === true,
					principal: access.principal,
				});
				return c.json(result, result.ok ? 200 : 400);
			});

			app.post('/v1/teams', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				if (isTeamApiPrincipal(auth.principal) || c.get('actorType') === 'project') {
					return jsonError(c, 403, 'Permission denied.');
				}
				const body = await c.req.json().catch(() => ({}));
				if (!body.name && !body.slug) {
					return jsonError(c, 400, 'name is required.');
				}
				let team;
				try {
					team = await store.createTeam({
						name: String(body.slug ?? body.name),
						displayName: typeof body.displayName === 'string' ? body.displayName : typeof body.label === 'string' ? body.label : String(body.name ?? body.slug),
						logoUrl: typeof body.logoUrl === 'string' ? body.logoUrl : null,
						profileSummary: typeof body.profileSummary === 'string' ? body.profileSummary : typeof body.description === 'string' ? body.description : null,
						metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
						ownerUserId: typeof auth.principal.id === 'string' ? auth.principal.id : null,
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					const status = /already taken|already used/u.test(message) ? 409 : 400;
					return jsonError(c, status, message, { code: status === 409 ? 'namespace_taken' : 'invalid_team' });
				}
				return c.json({ ok: true, payload: team });
			});

			app.patch('/v1/teams/:teamId', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				return c.json({
					...await store.updateTeamSettings(c.req.param('teamId'), {
						name: typeof body.name === 'string' ? body.name : undefined,
						displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
						logoUrl: typeof body.logoUrl === 'string' ? body.logoUrl : undefined,
						profileSummary: typeof body.profileSummary === 'string' ? body.profileSummary : typeof body.description === 'string' ? body.description : undefined,
						metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
					}),
				});
			});

			app.post('/v1/teams/:teamId/invites', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const result = await store.createTeamInvite(c.req.param('teamId'), {
					email: body.email,
					roleKey: body.roleKey ?? body.role,
					invitedByUserId: access.principal.id,
				});
				if (result.ok && result.invite && result.token) {
					try {
						const team = await store.getTeam(c.req.param('teamId'));
						await sendTeamInviteEmail(marketAuthContext(c), {
							invite: result.invite,
							team,
							token: result.token,
						});
					} catch (error) {
						console.warn('[team-invite] Email delivery failed:', error instanceof Error ? error.message : String(error));
						const reason = authEmailDeliveryFailureReason(error);
						return jsonError(c, 503, 'Team invite email could not be sent. Please try again shortly.', {
							code: 'team_invite_delivery_failed',
							reason,
							...(shouldExposeNonProductionAuthDiagnostics(c, runtime) ? { detail: authEmailDeliveryFailureDetail(error) } : {}),
						});
					}
				}
				return c.json(result, result.ok ? 200 : 400);
			});

			app.patch('/v1/teams/:teamId/members/:membershipId', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const result = await store.updateTeamMemberRole(c.req.param('teamId'), c.req.param('membershipId'), String(body.roleKey ?? body.role ?? 'contributor'));
				return c.json(result, result.ok ? 200 : 400);
			});

			app.delete('/v1/teams/:teamId/members/:membershipId', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const result = await store.removeTeamMember(c.req.param('teamId'), c.req.param('membershipId'));
				return c.json(result, result.ok ? 200 : 400);
			});

			app.get('/v1/teams/:teamId/deletion-blockers', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				return c.json({ ok: true, payload: await store.evaluateTeamDeletionBlockers(c.req.param('teamId')) });
			});

			app.delete('/v1/teams/:teamId', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const result = await store.deleteTeam(c.req.param('teamId'), body.confirmation);
				return c.json(result, result.ok ? 200 : 400);
			});

			app.post('/v1/teams/:teamId/api-keys', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				if (!body.name) {
					return jsonError(c, 400, 'name is required.');
				}
				return c.json({
					ok: true,
					payload: await store.createTeamApiKey(c.req.param('teamId'), {
						name: String(body.name),
						permissions: Array.isArray(body.permissions) ? body.permissions.map(String) : [],
						expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : null,
					}),
				});
			});

			app.get('/v1/teams/:teamId/treedx', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({ ok: true, payload: await store.getTeamTreeDx(c.req.param('teamId')) });
			});

			app.put('/v1/teams/:teamId/treedx', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const instance = await store.upsertTeamTreeDx(c.req.param('teamId'), body);
				return c.json({ ok: true, payload: { instance } });
			});

			app.post('/v1/teams/:teamId/treedx/provision', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const payload = await store.provisionTeamTreeDx(c.req.param('teamId'), body);
				if (!payload) return jsonError(c, 404, 'Unknown team.');
				const { operation } = await enqueueTreeDxProvisionOperation(store, c.req.param('teamId'), payload, body, {
					type: 'user',
					id: access.principal.id,
				});
				return c.json({ ok: true, payload: { ...payload, operation } }, { status: 202 });
			});

			app.post('/v1/internal/treedx/public-federation/provision', async (c) => {
				const service = requireConfiguredServiceCredential(c, runtime.resolved.config);
				if (service.response) return service.response;
				const body = await c.req.json().catch(() => ({}));
				const team = await resolvePublicTreeDxTeam(store, body);
				const payload = await store.provisionTeamTreeDx(team.id, {
					...body,
					publicRead: true,
					imageRef: optionalTrimmedString(body.imageRef) ?? 'treeseed/treedx:latest',
					name: optionalTrimmedString(body.name) ?? 'TreeSeed public federation',
				});
				const { operation } = await enqueueTreeDxProvisionOperation(store, team.id, payload, body, {
					type: 'service',
					id: 'public-treedx-bootstrap',
				});
				return c.json({ ok: true, payload: { ...payload, team, operation } }, { status: 202 });
			});

			app.post('/v1/internal/github/app/webhook', async (c) => {
				const bodyText = await c.req.text();
				const adapter = createGitHubAppAdapter({
					store,
					config: runtime.resolved.config,
				});
				if (!adapter.verifyWebhook({
					body: bodyText,
					signature: c.req.header('x-hub-signature-256'),
				})) {
					return jsonError(c, 401, 'Invalid GitHub App webhook signature.');
				}
				const payload = JSON.parse(bodyText || '{}');
				const result = await adapter.applyWebhookEvent({
					event: c.req.header('x-github-event'),
					deliveryId: c.req.header('x-github-delivery'),
					payload,
				});
				return c.json({ ok: true, payload: result });
			});

			app.get('/v1/internal/treedx/public-federation/status', async (c) => {
				const service = requireConfiguredServiceCredential(c, runtime.resolved.config);
				if (service.response) return service.response;
				const teamId = optionalTrimmedString(c.req.query('teamId'));
				const teamSlug = optionalTrimmedString(c.req.query('teamSlug')) ?? optionalTrimmedString(c.req.query('slug')) ?? 'treeseed-public';
				const team = teamId
					? await store.getTeam(teamId).catch(() => null)
					: await store.getTeamBySlug(teamSlug).catch(() => null);
				if (!team) return c.json({ ok: true, payload: { team: null, instance: null, deployments: [] } });
				const payload = await store.getTeamTreeDx(team.id);
				const deployments = Array.isArray(payload.deployments) && payload.deployments.length > 0
					? payload.deployments
					: await store.listTreeDxDeployments(team.id).catch(() => []);
				return c.json({ ok: true, payload: { ...payload, deployments, team } });
			});

			const issueTreeDxGitHubCredential = async (c) => {
				const service = requireConfiguredServiceCredential(c, runtime.resolved.config);
				if (service.response) return service.response;
				const body = await c.req.json().catch(() => ({}));
				const bridge = createTreeDxCredentialBridge({
					store,
					config: runtime.resolved.config,
					githubAppAdapter: options.githubAppAdapter,
				});
				try {
					const payload = await bridge.issueGitCredential(body);
					return c.json({ ok: true, payload }, { status: 201 });
				} catch (error) {
					return jsonThrownError(c, error, 403);
				}
			};
			app.post('/v1/internal/treedx/credentials/github', issueTreeDxGitHubCredential);

			app.get('/v1/teams/:teamId/treedx/mirrors', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({ ok: true, payload: await store.listTreeDxMirrors(c.req.param('teamId')) });
			});

			app.post('/v1/teams/:teamId/treedx/mirrors', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const mirror = await store.createTreeDxMirror(c.req.param('teamId'), body);
				if (!mirror) return jsonError(c, 404, 'Create a team TreeDX binding before adding mirrors.');
				return c.json({ ok: true, payload: mirror }, { status: 201 });
			});

			app.post('/v1/teams/:teamId/treedx/mirrors/:mirrorId/sync', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const mirror = await store.syncTreeDxMirror(c.req.param('teamId'), c.req.param('mirrorId'), body);
				if (!mirror) return jsonError(c, 404, 'Unknown TreeDX mirror.');
				return c.json({ ok: true, payload: mirror });
			});

			app.get('/v1/teams/:teamId/treedx/shares', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({ ok: true, payload: await store.listTreeDxShares(c.req.param('teamId')) });
			});

			app.post('/v1/teams/:teamId/treedx/shares', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const share = await store.createTreeDxShare(c.req.param('teamId'), body);
				return c.json({ ok: true, payload: share }, { status: 201 });
			});

			app.get('/v1/teams/:teamId/web-hosts', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({
					ok: true,
					payload: await store.listTeamWebHosts(c.req.param('teamId')),
				});
			});

			app.get('/v1/teams/:teamId/web-hosts/:hostId', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				const host = await store.getTeamWebHost(c.req.param('teamId'), c.req.param('hostId'));
				if (!host) return jsonError(c, 404, `Unknown web host "${c.req.param('hostId')}".`);
				return c.json({ ok: true, payload: host });
			});

			app.get('/v1/teams/:teamId/repository-hosts', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({
					ok: true,
					payload: await store.listRepositoryHosts(c.req.param('teamId')),
				});
			});

			app.get('/v1/teams/:teamId/repository-hosts/:hostId', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				const host = await store.getRepositoryHost(c.req.param('teamId'), c.req.param('hostId'));
				if (!host) return jsonError(c, 404, `Unknown Repository Host "${c.req.param('hostId')}".`);
				return c.json({ ok: true, payload: host });
			});

			app.post('/v1/teams/:teamId/repository-hosts', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				if (!body.name || !body.organizationOrOwner) {
					return jsonError(c, 400, 'name and organizationOrOwner are required.');
				}
				const plaintextCredentials = rejectPlaintextHostCredentialFields(c, body);
				if (plaintextCredentials) return plaintextCredentials;
				if ((body.ownership ?? 'team_owned') === 'team_owned' && body.encryptedPayload && !encryptedHostPayloadLooksValid(body.encryptedPayload)) {
					return jsonError(c, 400, 'encryptedPayload must use the TreeSeed encrypted host envelope format.');
				}
				try {
					return c.json({
						ok: true,
						payload: await store.upsertRepositoryHost(c.req.param('teamId'), {
							...body,
							provider: 'github',
							createdById: access.principal.id,
							updatedById: access.principal.id,
						}),
					}, { status: 201 });
				} catch (error) {
					return jsonError(c, 400, error instanceof Error ? error.message : String(error));
				}
			});

			app.put('/v1/teams/:teamId/repository-hosts/:hostId', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const existing = await store.getRepositoryHost(c.req.param('teamId'), c.req.param('hostId'));
				if (!existing || existing.teamId === null) return jsonError(c, 404, `Unknown Repository Host "${c.req.param('hostId')}".`);
				const body = await c.req.json().catch(() => ({}));
				const plaintextCredentials = rejectPlaintextHostCredentialFields(c, body);
				if (plaintextCredentials) return plaintextCredentials;
				if ((body.ownership ?? existing.ownership) === 'team_owned' && body.encryptedPayload && !encryptedHostPayloadLooksValid(body.encryptedPayload)) {
					return jsonError(c, 400, 'encryptedPayload must use the TreeSeed encrypted host envelope format.');
				}
				try {
					return c.json({
						ok: true,
						payload: await store.upsertRepositoryHost(c.req.param('teamId'), {
							...existing,
							...body,
							id: existing.id,
							provider: 'github',
							updatedById: access.principal.id,
						}),
					});
				} catch (error) {
					return jsonError(c, 400, error instanceof Error ? error.message : String(error));
				}
			});

			app.delete('/v1/teams/:teamId/repository-hosts/:hostId', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const result = await store.deleteRepositoryHost(c.req.param('teamId'), c.req.param('hostId'));
				if (!result.ok && result.error === 'in_use') {
					return c.json({ ok: false, error: 'in_use', projects: result.projects }, { status: 409 });
				}
				if (!result.ok) return jsonError(c, 404, `Unknown Repository Host "${c.req.param('hostId')}".`);
				return c.json({ ok: true, payload: result.payload });
			});

			app.post('/v1/teams/:teamId/provider-credential-sessions', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:manage:team');
				if (access.response) return access.response;
				const teamId = c.req.param('teamId');
				const body = await c.req.json().catch(() => ({}));
				const hostKind = String(body.hostKind ?? '');
				const hostId = typeof body.hostId === 'string' && body.hostId.trim() ? body.hostId.trim() : null;
				const purpose = typeof body.purpose === 'string' && body.purpose.trim() ? body.purpose.trim() : 'launch_project';
				const passphrase = typeof body.passphrase === 'string' ? body.passphrase : '';
				if (!hostId || !passphrase) {
					return jsonError(c, 400, 'hostId and passphrase are required.');
				}
				let host = null;
				if (hostKind === 'repository_host') {
					host = await store.getRepositoryHost(teamId, hostId);
				} else if (hostKind === 'web_host' || hostKind === 'capacity_provider_host' || hostKind === 'email_host') {
					host = await store.getTeamWebHost(teamId, hostId);
				} else {
					return jsonError(c, 400, 'hostKind must be repository_host, web_host, capacity_provider_host, or email_host.');
				}
				if (!host || host.teamId !== teamId || host.ownership !== 'team_owned') {
					return jsonError(c, 404, 'Selected team-owned provider host is not available for this team.');
				}
				if (!host.encryptedPayload) {
					return jsonError(c, 400, 'Selected host does not have encrypted provider credentials.');
				}
				let normalizedConfig;
				try {
					const decryptedConfig = await decryptHostConfig(host.encryptedPayload, passphrase);
					normalizedConfig = normalizeProviderCredentialConfig(hostKind, decryptedConfig, host);
				} catch (error) {
					return jsonError(c, 400, 'Unable to unlock provider credentials for this host.', {
						message: error instanceof Error ? error.message : String(error),
						hostKind,
						hostId,
					});
				}
				try {
					const requestedSeconds = Number(body.expiresInSeconds ?? 900);
					const expiresInSeconds = Math.max(60, Math.min(Number.isFinite(requestedSeconds) ? requestedSeconds : 900, 3600));
					const session = await store.createProviderCredentialSession(teamId, {
						hostKind,
						hostId,
						purpose,
						expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
						createdById: access.principal.id,
						encryptedPayload: encryptCredentialSessionPayload(runtime, {
							provider: host.provider ?? (hostKind === 'repository_host' ? 'github' : null),
							ownership: host.ownership,
							config: normalizedConfig,
						}),
						metadata: {
							hostName: host.name ?? null,
							provider: host.provider ?? null,
							configSummary: decryptedHostConfigSummary(normalizedConfig),
						},
					});
					return c.json({
						ok: true,
						payload: {
							id: session.id,
							hostKind: session.hostKind,
							hostId: session.hostId,
							purpose: session.purpose,
							expiresAt: session.expiresAt,
						},
					}, { status: 201 });
				} catch (error) {
					return jsonError(c, 500, 'Provider credentials were unlocked, but the launch credential session could not be created.', {
						message: error instanceof Error ? error.message : String(error),
						hostKind,
						hostId,
					});
				}
			});

			app.post('/v1/teams/:teamId/hosting-audit', async (c) => {
				const body = await c.req.json().catch(() => ({}));
				const repair = body.repair === true;
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), repair ? 'teams:manage:team' : 'projects:read:team');
				if (access.response) return access.response;
				const teamId = c.req.param('teamId');
				const hostKinds = normalizeAuditHostKinds(body.hostKinds);
				try {
					const credentialOverlay = await collectHostingAuditCredentialOverlay({
						store,
						runtime,
						teamId,
						hostKinds,
						credentialSessions: body.credentialSessions && typeof body.credentialSessions === 'object' ? body.credentialSessions : {},
					});
					const report = await runTreeseedHostingAudit({
						tenantRoot: runtime?.resolved?.config?.repoRoot ?? process.cwd(),
						environment: ['current', 'local', 'staging', 'prod'].includes(body.environment) ? body.environment : 'current',
						repair,
						hostKinds,
						env: process.env,
						valuesOverlay: credentialOverlay.overlay,
					});
					return c.json({
						ok: true,
						payload: {
							...report,
							credentialSessions: credentialOverlay.sessions,
						},
					});
				} catch (error) {
					return jsonError(c, 400, error instanceof Error ? error.message : String(error));
				}
			});

			app.get('/v1/teams/:teamId/hosts', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				const teamId = c.req.param('teamId');
				return c.json({
					ok: true,
					payload: [
						...(await listTreeseedManagedHostsFromConfig(teamId, runtime)),
						...(await store.listTeamWebHosts(teamId)),
					],
				});
			});

			app.get('/v1/teams/:teamId/hosts/:hostId', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				const host = await store.getTeamWebHost(c.req.param('teamId'), c.req.param('hostId'));
				if (!host) return jsonError(c, 404, `Unknown host "${c.req.param('hostId')}".`);
				return c.json({ ok: true, payload: host });
			});

			app.post('/v1/teams/:teamId/web-hosts', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				if (!body.name) {
					return jsonError(c, 400, 'name is required.');
				}
				const plaintextCredentials = rejectPlaintextHostCredentialFields(c, body);
				if (plaintextCredentials) return plaintextCredentials;
				if ((body.ownership ?? 'team_owned') === 'team_owned' && !encryptedHostPayloadLooksValid(body.encryptedPayload)) {
					return jsonError(c, 400, 'A valid encryptedPayload is required for team-owned hosts.');
				}
				try {
					return c.json({
						ok: true,
						payload: await store.createTeamWebHost(c.req.param('teamId'), {
							...body,
							provider: typeof body.provider === 'string' ? body.provider : 'cloudflare',
							createdById: access.principal.id,
							updatedById: access.principal.id,
						}),
					}, { status: 201 });
				} catch (error) {
					return jsonError(c, 400, error instanceof Error ? error.message : String(error));
				}
			});

			app.post('/v1/teams/:teamId/hosts', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				if (!body.name) {
					return jsonError(c, 400, 'name is required.');
				}
				const plaintextCredentials = rejectPlaintextHostCredentialFields(c, body);
				if (plaintextCredentials) return plaintextCredentials;
				if ((body.ownership ?? 'team_owned') === 'team_owned' && !encryptedHostPayloadLooksValid(body.encryptedPayload)) {
					return jsonError(c, 400, 'A valid encryptedPayload is required for team-owned hosts.');
				}
				try {
					return c.json({
						ok: true,
						payload: await store.createTeamWebHost(c.req.param('teamId'), {
							...body,
							provider: typeof body.provider === 'string' ? body.provider : 'cloudflare',
							createdById: access.principal.id,
							updatedById: access.principal.id,
						}),
					}, { status: 201 });
				} catch (error) {
					return jsonError(c, 400, error instanceof Error ? error.message : String(error));
				}
			});

			app.put('/v1/teams/:teamId/web-hosts/:hostId', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const plaintextCredentials = rejectPlaintextHostCredentialFields(c, body);
				if (plaintextCredentials) return plaintextCredentials;
				if (body.encryptedPayload !== undefined && !encryptedHostPayloadLooksValid(body.encryptedPayload)) {
					return jsonError(c, 400, 'encryptedPayload must be a valid encrypted host envelope.');
				}
				try {
					const payload = await store.updateTeamWebHost(c.req.param('teamId'), c.req.param('hostId'), {
						...body,
						updatedById: access.principal.id,
					});
					if (!payload) {
						return jsonError(c, 404, 'Unknown web host.');
					}
					return c.json({ ok: true, payload });
				} catch (error) {
					return jsonError(c, 400, error instanceof Error ? error.message : String(error));
				}
			});

			app.put('/v1/teams/:teamId/hosts/:hostId', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const plaintextCredentials = rejectPlaintextHostCredentialFields(c, body);
				if (plaintextCredentials) return plaintextCredentials;
				if (body.encryptedPayload !== undefined && !encryptedHostPayloadLooksValid(body.encryptedPayload)) {
					return jsonError(c, 400, 'encryptedPayload must be a valid encrypted host envelope.');
				}
				try {
					const payload = await store.updateTeamWebHost(c.req.param('teamId'), c.req.param('hostId'), {
						...body,
						updatedById: access.principal.id,
					});
					if (!payload) {
						return jsonError(c, 404, 'Unknown host.');
					}
					return c.json({ ok: true, payload });
				} catch (error) {
					return jsonError(c, 400, error instanceof Error ? error.message : String(error));
				}
			});

			app.delete('/v1/teams/:teamId/web-hosts/:hostId', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const result = await store.deleteTeamWebHost(c.req.param('teamId'), c.req.param('hostId'));
				return c.json(result, result.ok ? 200 : result.error === 'in_use' ? 409 : 404);
			});

			app.delete('/v1/teams/:teamId/hosts/:hostId', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const result = await store.deleteTeamWebHost(c.req.param('teamId'), c.req.param('hostId'));
				return c.json(result, result.ok ? 200 : result.error === 'in_use' ? 409 : 404);
			});

			app.post('/v1/teams/:teamId/web-hosts/:hostId/validate', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:manage:team');
				if (access.response) return access.response;
				const host = await store.getTeamWebHost(c.req.param('teamId'), c.req.param('hostId'));
				if (!host) {
					return jsonError(c, 404, 'Unknown web host.');
				}
				const body = await c.req.json().catch(() => ({}));
				if (host.ownership === 'team_owned' && (!body.decryptedConfig || typeof body.decryptedConfig !== 'object')) {
					return jsonError(c, 400, 'decryptedConfig is required to validate a team-owned host.');
				}
				const validation = await validateTeamHostCredentialPayload(host, body.decryptedConfig);
				const validated = await store.updateTeamWebHost(c.req.param('teamId'), c.req.param('hostId'), {
					metadata: {
						...(host.metadata ?? {}),
						lastValidation: validation,
					},
					updatedById: access.principal.id,
				});
				return c.json({
					ok: true,
					payload: {
						host: validated,
						validation: validated?.metadata?.lastValidation ?? null,
					},
				});
			});

			app.post('/v1/teams/:teamId/hosts/:hostId/validate', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:manage:team');
				if (access.response) return access.response;
				const host = await store.getTeamWebHost(c.req.param('teamId'), c.req.param('hostId'));
				if (!host) {
					return jsonError(c, 404, 'Unknown host.');
				}
				const body = await c.req.json().catch(() => ({}));
				if (host.ownership === 'team_owned' && (!body.decryptedConfig || typeof body.decryptedConfig !== 'object')) {
					return jsonError(c, 400, 'decryptedConfig is required to validate a team-owned host.');
				}
				const validation = await validateTeamHostCredentialPayload(host, body.decryptedConfig);
				const validated = await store.updateTeamWebHost(c.req.param('teamId'), c.req.param('hostId'), {
					metadata: {
						...(host.metadata ?? {}),
						lastValidation: validation,
					},
					updatedById: access.principal.id,
				});
				return c.json({
					ok: true,
					payload: {
						host: validated,
						validation: validated?.metadata?.lastValidation ?? null,
					},
				});
			});

			app.get('/v1/teams/:teamId/capacity-providers', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				const teamId = c.req.param('teamId');
				const providers = await store.listTeamCapacityProviders(teamId);
				const payload = await Promise.all(providers.map(async (provider) => ({
					...provider,
					registrations: typeof store.latestCapacityProviderRegistration === 'function'
						? [await store.latestCapacityProviderRegistration(provider.id)].filter(Boolean)
						: [],
					deployments: typeof store.listCapacityProviderDeployments === 'function'
						? await store.listCapacityProviderDeployments(teamId, provider.id)
						: [],
					derivedCapacity: typeof store.getCapacityProviderDerivedCapacity === 'function'
						? await store.getCapacityProviderDerivedCapacity(teamId, provider.id)
						: null,
				})));
				return c.json({ ok: true, payload });
			});

			app.post('/v1/teams/:teamId/capacity-providers', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const extra = unknownKeys(body, ['name', 'launchMode', 'creditBudgetMode']);
				if (extra.length > 0) {
					return jsonError(c, 400, 'Capacity provider creation accepts only name and launchMode. creditBudgetMode is accepted only for legacy compatibility.', { fields: extra });
				}
				if (!body.name || !body.launchMode) return jsonError(c, 400, 'name and launchMode are required.');
				let provider;
				try {
					provider = await store.createStandaloneCapacityProvider(c.req.param('teamId'), {
						name: body.name,
						launchMode: body.launchMode,
						creditBudgetMode: body.creditBudgetMode,
						createdById: access.principal.id,
					});
				} catch (error) {
					return jsonError(c, 400, error instanceof Error ? error.message : String(error));
				}
				const keyResult = typeof store.createCapacityProviderBootstrapKey === 'function'
					? await store.createCapacityProviderBootstrapKey(c.req.param('teamId'), provider.id, {
						createdById: access.principal.id,
					})
					: await store.createCapacityProviderApiKey(c.req.param('teamId'), provider.id, {
						name: 'Capacity provider bootstrap key',
						scopes: ['provider:register', 'provider:heartbeat', 'provider:capabilities:write'],
						createdById: access.principal.id,
					});
				const marketUrl = normalizeBaseUrl(runtime.config?.baseUrl ?? runtime.config?.siteUrl ?? 'http://localhost:4321');
				const selfHosting = renderCapacityProviderSelfHostInstructions({
					marketUrl,
					marketId: String(runtime.config?.marketId ?? runtime.config?.projectId ?? 'local'),
					apiKey: keyResult.plaintextKey,
					providerId: provider.id,
					teamId: c.req.param('teamId'),
				});
				const selfHostingEnv = withCapacityProviderRuntimeIdentity(selfHosting.env, {
					marketUrl,
					providerId: provider.id,
					teamId: c.req.param('teamId'),
				});
				return c.json({
					ok: true,
					provider: await store.getCapacityProvider(c.req.param('teamId'), provider.id),
					apiKey: {
						plaintext: keyResult.plaintextKey,
						prefix: keyResult.key.keyPrefix,
					},
					selfHosting: {
						managementApiUrl: selfHostingEnv.TREESEED_MANAGEMENT_API_URL,
						marketUrl,
						marketId: selfHostingEnv.TREESEED_MANAGER_ID,
						providerId: provider.id,
						teamId: c.req.param('teamId'),
						env: selfHostingEnv,
						redactedEnv: redactCapacityProviderEnv(selfHostingEnv),
						commands: selfHosting.commands,
						composeFile: selfHosting.composeFile,
					},
				}, { status: 201 });
			});

			app.patch('/v1/teams/:teamId/capacity-providers/:providerId', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const existing = await store.getCapacityProvider(c.req.param('teamId'), c.req.param('providerId'));
				if (!existing) return jsonError(c, 404, 'Unknown capacity provider.');
				const body = await c.req.json().catch(() => ({}));
				const extra = unknownKeys(body, ['name', 'creditBudgetMode']);
				if (extra.length > 0) {
					return jsonError(c, 400, 'Capacity provider update accepts only name and creditBudgetMode.', { fields: extra });
				}
				try {
					return c.json({
						ok: true,
						provider: await store.updateCapacityProvider(c.req.param('teamId'), c.req.param('providerId'), body),
					});
				} catch (error) {
					return jsonError(c, 400, error instanceof Error ? error.message : String(error));
				}
			});

			app.get('/v1/teams/:teamId/capacity-providers/:providerId', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				const provider = await store.getCapacityProvider(c.req.param('teamId'), c.req.param('providerId'));
				if (!provider) return jsonError(c, 404, 'Unknown capacity provider.');
				return c.json({
					ok: true,
					provider: {
						...provider,
						registrations: typeof store.latestCapacityProviderRegistration === 'function'
							? [await store.latestCapacityProviderRegistration(provider.id)].filter(Boolean)
							: [],
						deployments: typeof store.listCapacityProviderDeployments === 'function'
							? await store.listCapacityProviderDeployments(c.req.param('teamId'), provider.id)
							: [],
						derivedCapacity: typeof store.getCapacityProviderDerivedCapacity === 'function'
							? await store.getCapacityProviderDerivedCapacity(c.req.param('teamId'), provider.id)
							: null,
					},
				});
			});

			app.get('/v1/teams/:teamId/capacity-providers/:providerId/execution-providers', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				const provider = await store.getCapacityProvider(c.req.param('teamId'), c.req.param('providerId'));
				if (!provider) return jsonError(c, 404, 'Unknown capacity provider.');
				return c.json({
					ok: true,
					payload: await store.listExecutionProviders(c.req.param('teamId'), c.req.param('providerId')),
				});
			});

			app.post('/v1/teams/:teamId/capacity-providers/:providerId/execution-providers', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const provider = await store.getCapacityProvider(c.req.param('teamId'), c.req.param('providerId'));
				if (!provider) return jsonError(c, 404, 'Unknown capacity provider.');
				const body = await c.req.json().catch(() => ({}));
				try {
					const executionProvider = await store.upsertExecutionProvider(c.req.param('teamId'), c.req.param('providerId'), body);
					return executionProvider
						? c.json({ ok: true, payload: executionProvider }, { status: 201 })
						: jsonError(c, 404, 'Unknown capacity provider.');
				} catch (error) {
					return jsonError(c, 400, error instanceof Error ? error.message : String(error));
				}
			});

			app.patch('/v1/teams/:teamId/capacity-providers/:providerId/execution-providers/:executionProviderId', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const provider = await store.getCapacityProvider(c.req.param('teamId'), c.req.param('providerId'));
				if (!provider) return jsonError(c, 404, 'Unknown capacity provider.');
				const body = await c.req.json().catch(() => ({}));
				try {
					const executionProvider = await store.upsertExecutionProvider(c.req.param('teamId'), c.req.param('providerId'), {
						...body,
						id: c.req.param('executionProviderId'),
					});
					return executionProvider
						? c.json({ ok: true, payload: executionProvider })
						: jsonError(c, 404, 'Unknown execution provider.');
				} catch (error) {
					return jsonError(c, 400, error instanceof Error ? error.message : String(error));
				}
			});

			app.post('/v1/teams/:teamId/capacity-providers/:providerId/execution-providers/:executionProviderId/native-limits', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				try {
					const limit = await store.upsertExecutionProviderNativeLimit(
						c.req.param('teamId'),
						c.req.param('providerId'),
						c.req.param('executionProviderId'),
						body,
					);
					return limit ? c.json({ ok: true, payload: limit }, { status: 201 }) : jsonError(c, 404, 'Unknown execution provider.');
				} catch (error) {
					return jsonError(c, 400, error instanceof Error ? error.message : String(error));
				}
			});

			app.get('/v1/teams/:teamId/capacity-providers/:providerId/api-keys', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const provider = await store.getCapacityProvider(c.req.param('teamId'), c.req.param('providerId'));
				if (!provider) return jsonError(c, 404, 'Unknown capacity provider.');
				return c.json({
					ok: true,
					payload: await store.listCapacityProviderApiKeys(c.req.param('teamId'), c.req.param('providerId')),
				});
			});

			app.post('/v1/teams/:teamId/capacity-providers/:providerId/api-keys', async (c) => {
				return jsonError(c, 410, 'Provider API keys are created only during provider creation. Use keys/rotate.');
			});

			app.post('/v1/teams/:teamId/capacity-providers/:providerId/api-keys/reset', async (c) => {
				return jsonError(c, 410, 'Provider API key reset was replaced by keys/rotate.');
			});

			app.post('/v1/teams/:teamId/capacity-providers/:providerId/api-keys/:keyId/revoke', async (c) => {
				return jsonError(c, 410, 'Provider API key revoke was replaced by keys/rotate.');
			});

			app.post('/v1/teams/:teamId/capacity-providers/:providerId/keys/rotate', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const provider = await store.getCapacityProvider(c.req.param('teamId'), c.req.param('providerId'));
				if (!provider) return jsonError(c, 404, 'Unknown capacity provider.');
				const result = await store.rotateCapacityProviderApiKey(c.req.param('teamId'), provider.id, {
					createdById: access.principal.id,
				});
				return c.json({
					ok: true,
					apiKey: {
						plaintext: result.plaintextKey,
						prefix: result.key.keyPrefix,
					},
					requiresRestart: true,
				});
			});

			app.post('/v1/teams/:teamId/capacity-providers/:providerId/deployments', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const provider = await store.getCapacityProvider(c.req.param('teamId'), c.req.param('providerId'));
				if (!provider) return jsonError(c, 404, 'Unknown capacity provider.');
				const body = await c.req.json().catch(() => ({}));
				const plaintextFields = ['apiKey', 'providerApiKey', 'TREESEED_CAPACITY_PROVIDER_API_KEY', 'railwayApiToken', 'TREESEED_RAILWAY_API_TOKEN', 'RAILWAY_API_TOKEN', 'decryptedConfig'];
				const leakedField = plaintextFields.find((field) => Object.prototype.hasOwnProperty.call(body, field));
				if (leakedField) {
					return jsonError(c, 400, 'Plaintext capacity provider deployment credentials are not accepted. Use a provider credential session or the one-time key reveal.', { field: leakedField });
				}
				const launchMode = String(body.launchMode ?? provider.metadata?.launchMode ?? provider.deployment?.launchMode ?? 'self_hosted');
				const marketUrl = normalizeBaseUrl(runtime.config?.baseUrl ?? runtime.config?.siteUrl ?? 'http://localhost:4321');
				const marketId = String(runtime.config?.marketId ?? runtime.config?.projectId ?? 'local');
				if (launchMode === 'self_hosted') {
					const rendered = renderCapacityProviderSelfHostInstructions({
						marketUrl,
						marketId,
						apiKey: '<rotate-to-reveal>',
						providerId: provider.id,
						teamId: c.req.param('teamId'),
					});
					const renderedEnv = withCapacityProviderRuntimeIdentity(rendered.env, {
						marketUrl,
						providerId: provider.id,
						teamId: c.req.param('teamId'),
					});
					return c.json({
						ok: true,
						deployment: null,
						selfHosting: {
							managementApiUrl: renderedEnv.TREESEED_MANAGEMENT_API_URL,
							marketUrl,
							marketId: renderedEnv.TREESEED_MANAGER_ID,
							providerId: provider.id,
							teamId: c.req.param('teamId'),
							env: redactCapacityProviderEnv(renderedEnv),
							commands: rendered.commands,
							composeFile: rendered.composeFile,
							summary: rendered.summary,
						},
					});
				}
				if (launchMode !== 'managed_market_host' && launchMode !== 'connected_host') {
					return jsonError(c, 400, 'launchMode must be self_hosted, managed_market_host, or connected_host.');
				}
				if (launchMode === 'connected_host') {
					const sessionId = typeof body.credentialSessions?.capacityProviderHost === 'string'
						? body.credentialSessions.capacityProviderHost.trim()
						: '';
					if (!sessionId) {
						return jsonError(c, 400, 'credentialSessions.capacityProviderHost is required for connected capacity provider deployments.');
					}
					const session = await store.getProviderCredentialSession(c.req.param('teamId'), sessionId);
					if (!session || session.hostKind !== 'capacity_provider_host' || session.purpose !== 'deploy_capacity_provider' || session.status !== 'active') {
						return jsonError(c, 400, 'Credential session is not available for capacity provider deployment.');
					}
				}
				const hostKind = launchMode === 'connected_host' ? 'railway' : 'managed_market_host';
				let deployment = await store.createCapacityProviderDeployment(c.req.param('teamId'), provider.id, {
					launchMode,
					hostKind,
					hostId: typeof body.hostId === 'string' ? body.hostId : null,
					status: 'deploying',
					imageRef: body.imageRef ?? 'ghcr.io/treeseed-ai/agent:capacity-provider',
					createdById: access.principal.id,
				});
				try {
					let railwayCredentialConfig = {};
					if (launchMode === 'connected_host') {
						const sessionId = typeof body.credentialSessions?.capacityProviderHost === 'string'
							? body.credentialSessions.capacityProviderHost.trim()
							: '';
						const consumed = await store.consumeTeamProviderCredentialSession(c.req.param('teamId'), sessionId, {
							hostKind: 'capacity_provider_host',
							purpose: 'deploy_capacity_provider',
							metadata: {
								deploymentId: deployment.id,
								capacityProviderId: provider.id,
							},
						});
						if (!consumed.ok) {
							return jsonError(c, consumed.error === 'expired' ? 410 : 400, `Credential session is not available: ${consumed.error}.`);
						}
						const sessionPayload = decryptCredentialSessionPayload(runtime, consumed.payload.encryptedPayload);
						railwayCredentialConfig = sessionPayload.config && typeof sessionPayload.config === 'object' ? sessionPayload.config : {};
					}
					const keyResult = await store.rotateCapacityProviderApiKey(c.req.param('teamId'), provider.id, {
						createdById: access.principal.id,
					});
					const env = resolveCapacityProviderEnvironment({
						marketUrl,
						marketId,
						apiKey: keyResult.plaintextKey,
						providerId: provider.id,
						teamId: c.req.param('teamId'),
						providerEnvironment: 'prod',
					});
					const deploymentEnv = withCapacityProviderRuntimeIdentity(env, {
						marketUrl,
						providerId: provider.id,
						teamId: c.req.param('teamId'),
					});
					const deployInput = {
						intent: {
							teamId: c.req.param('teamId'),
							capacityProviderId: provider.id,
							launchMode,
							hostKind,
							hostId: typeof body.hostId === 'string' ? body.hostId : null,
							imageRef: deployment.imageRef,
						},
						env: deploymentEnv,
						redactedEnv: redactCapacityProviderEnv(deploymentEnv),
						imageRef: deployment.imageRef,
						serviceNamePrefix: `capacity-provider-${provider.id}`,
						adapter: launchMode === 'connected_host'
							? {
									async provisionService(spec) {
										const workspace = typeof railwayCredentialConfig.TREESEED_RAILWAY_WORKSPACE === 'string'
											? railwayCredentialConfig.TREESEED_RAILWAY_WORKSPACE
											: 'connected-railway';
										return {
											role: spec.role,
											serviceName: spec.serviceName,
											serviceId: `railway:${workspace}:${spec.serviceName}`,
											url: spec.role === 'api' ? `https://${spec.serviceName}.railway.example.invalid` : null,
											status: 'deployed',
											envRefs: Object.fromEntries(Object.keys(spec.env).map((key) => [key, /(?:KEY|TOKEN|AUTH|SECRET|PASSWORD|CREDENTIAL)/u.test(key) ? `${spec.serviceName}:${key}` : spec.redactedEnv[key] ?? spec.env[key]])),
										};
									},
								}
							: undefined,
					};
					const deployResult = launchMode === 'connected_host'
						? await deployCapacityProviderToRailway(deployInput)
						: await deployCapacityProviderToManagedMarketHost(deployInput);
					deployment = await store.updateCapacityProviderDeployment(c.req.param('teamId'), deployment.id, {
						status: deployResult.status,
						serviceRefs: deployResult.serviceRefs,
						envRefs: deployResult.envRefs,
						result: {
							launchMode: deployResult.launchMode,
							hostKind: deployResult.hostKind,
							diagnostics: deployResult.diagnostics,
							requiresProviderRegistration: true,
						},
						error: deployResult.error ?? null,
						completedAt: deployResult.status === 'deployed' || deployResult.status === 'failed' ? new Date().toISOString() : null,
					});
					return c.json({ ok: deployResult.ok, deployment, result: deployResult }, { status: deployResult.ok ? 201 : 502 });
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					deployment = await store.updateCapacityProviderDeployment(c.req.param('teamId'), deployment.id, {
						status: 'failed',
						error: { message },
						completedAt: new Date().toISOString(),
					});
					return jsonError(c, 502, 'Capacity provider deployment failed.', { deployment, message });
				}
			});

			app.get('/v1/teams/:teamId/capacity-providers/:providerId/self-hosting', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const provider = await store.getCapacityProvider(c.req.param('teamId'), c.req.param('providerId'));
				if (!provider) return jsonError(c, 404, 'Unknown capacity provider.');
				const marketUrl = normalizeBaseUrl(runtime.config?.baseUrl ?? runtime.config?.siteUrl ?? 'http://localhost:4321');
				const rendered = renderCapacityProviderSelfHostInstructions({
					marketUrl,
					marketId: String(runtime.config?.marketId ?? runtime.config?.projectId ?? 'local'),
					apiKey: '<rotate-to-reveal>',
					providerId: provider.id,
					teamId: c.req.param('teamId'),
				});
				const renderedEnv = withCapacityProviderRuntimeIdentity(rendered.env, {
					marketUrl,
					providerId: provider.id,
					teamId: c.req.param('teamId'),
				});
				return c.json({
					ok: true,
					selfHosting: {
						managementApiUrl: renderedEnv.TREESEED_MANAGEMENT_API_URL,
						marketUrl,
						marketId: renderedEnv.TREESEED_MANAGER_ID,
						providerId: provider.id,
						teamId: c.req.param('teamId'),
						env: redactCapacityProviderEnv(renderedEnv),
						commands: rendered.commands,
						composeFile: rendered.composeFile,
						summary: rendered.summary,
					},
				});
			});

			app.get('/v1/teams/:teamId/capacity-providers/:providerId/lanes', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({ ok: true, payload: await store.listCapacityProviderLanes(c.req.param('teamId'), c.req.param('providerId')) });
			});

			app.post('/v1/teams/:teamId/capacity-providers/:providerId/lanes', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				if (!body.name) return jsonError(c, 400, 'name is required.');
				const lane = await store.upsertCapacityProviderLane(c.req.param('teamId'), c.req.param('providerId'), body);
				return lane ? c.json({ ok: true, payload: lane }, { status: 201 }) : jsonError(c, 404, 'Unknown capacity provider.');
			});

			app.patch('/v1/teams/:teamId/capacity-providers/:providerId/lanes/:laneId', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const lane = await store.upsertCapacityProviderLane(c.req.param('teamId'), c.req.param('providerId'), {
					...body,
					id: c.req.param('laneId'),
					name: typeof body.name === 'string' ? body.name : 'Capacity Lane',
				});
				return lane ? c.json({ ok: true, payload: lane }) : jsonError(c, 404, 'Unknown capacity provider.');
			});

			app.get('/v1/teams/:teamId/capacity-grants', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({
					ok: true,
					payload: await store.listCapacityGrants(c.req.param('teamId'), {
						projectId: typeof c.req.query('projectId') === 'string' ? c.req.query('projectId') : null,
						providerId: typeof c.req.query('providerId') === 'string' ? c.req.query('providerId') : null,
					}),
				});
			});

			app.post('/v1/teams/:teamId/capacity-grants', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				if (!body.capacityProviderId) return jsonError(c, 400, 'capacityProviderId is required.');
				return c.json({
					ok: true,
					payload: await store.upsertCapacityGrant(c.req.param('teamId'), {
						...body,
						teamId: typeof body.teamId === 'string' ? body.teamId : c.req.param('teamId'),
					}),
				}, { status: 201 });
			});

			app.get('/v1/teams/:teamId/capacity/allocation-sets', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({ ok: true, payload: await store.listCapacityAllocationSets(c.req.param('teamId')) });
			});

			app.post('/v1/teams/:teamId/capacity/allocation-sets', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const allocationSet = await store.createCapacityAllocationSet(c.req.param('teamId'), {
					...body,
					createdById: access.principal.id,
				});
				return c.json({ ok: true, payload: allocationSet }, { status: 201 });
			});

			app.get('/v1/teams/:teamId/capacity/allocation-sets/:allocationSetId', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				const allocationSet = await store.getCapacityAllocationSet(c.req.param('teamId'), c.req.param('allocationSetId'));
				return allocationSet ? c.json({ ok: true, payload: allocationSet }) : jsonError(c, 404, 'Unknown allocation set.');
			});

			app.post('/v1/teams/:teamId/capacity/allocation-sets/:allocationSetId/activate', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const allocationSet = await store.activateCapacityAllocationSet(c.req.param('teamId'), c.req.param('allocationSetId'));
				return allocationSet ? c.json({ ok: true, payload: allocationSet }) : jsonError(c, 404, 'Unknown allocation set.');
			});

			const listWorkdayRunsHandler = async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({
					ok: true,
					payload: await store.listWorkdayTestRuns(c.req.param('teamId'), {
						status: typeof c.req.query('status') === 'string' ? c.req.query('status') : null,
						providerId: typeof c.req.query('providerId') === 'string' ? c.req.query('providerId') : null,
					}),
				});
			};

			const createWorkdayRunHandler = async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const run = await store.createWorkdayTestRun(c.req.param('teamId'), {
					...body,
					requestedById: access.principal.id,
				});
				return c.json({ ok: true, payload: run }, { status: 201 });
			};

			const getWorkdayRunHandler = async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				const run = await store.getWorkdayTestRun(c.req.param('teamId'), c.req.param('runId'));
				if (!run) return jsonError(c, 404, 'Unknown workday run.');
				const events = await store.listWorkdayTestEvents(c.req.param('teamId'), run.id);
				return c.json({ ok: true, payload: { run, events } });
			};

			const updateWorkdayRunHandler = async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const run = await store.updateWorkdayTestRun(c.req.param('teamId'), c.req.param('runId'), body);
				return run ? c.json({ ok: true, payload: run }) : jsonError(c, 404, 'Unknown workday run.');
			};

			const listWorkdayEventsHandler = async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				const run = await store.getWorkdayTestRun(c.req.param('teamId'), c.req.param('runId'));
				if (!run) return jsonError(c, 404, 'Unknown workday run.');
				return c.json({ ok: true, payload: await store.listWorkdayTestEvents(c.req.param('teamId'), run.id) });
			};

			const createWorkdayEventHandler = async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const event = await store.createWorkdayTestEvent(c.req.param('teamId'), c.req.param('runId'), body);
				return event ? c.json({ ok: true, payload: event }, { status: 201 }) : jsonError(c, 404, 'Unknown workday run.');
			};

			app.get('/v1/teams/:teamId/workday-runs', listWorkdayRunsHandler);
			app.post('/v1/teams/:teamId/workday-runs', createWorkdayRunHandler);
			app.get('/v1/teams/:teamId/workday-runs/:runId', getWorkdayRunHandler);
			app.patch('/v1/teams/:teamId/workday-runs/:runId', updateWorkdayRunHandler);
			app.get('/v1/teams/:teamId/workday-runs/:runId/events', listWorkdayEventsHandler);
			app.post('/v1/teams/:teamId/workday-runs/:runId/events', createWorkdayEventHandler);

			app.get('/v1/teams/:teamId/capacity/provider-sessions', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({
					ok: true,
					payload: await store.listProviderAvailabilitySessions(c.req.param('teamId'), {
						providerId: typeof c.req.query('providerId') === 'string' ? c.req.query('providerId') : null,
						status: typeof c.req.query('status') === 'string' ? c.req.query('status') : null,
					}),
				});
			});

			app.get('/v1/teams/:teamId/capacity/assignments', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({
					ok: true,
					payload: await store.listProviderAssignments(c.req.param('teamId'), {
						projectId: typeof c.req.query('projectId') === 'string' ? c.req.query('projectId') : null,
						providerId: typeof c.req.query('providerId') === 'string' ? c.req.query('providerId') : null,
						status: typeof c.req.query('status') === 'string' ? c.req.query('status') : null,
					}),
				});
			});

			app.get('/v1/teams/:teamId/capacity/execution-runs', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({
					ok: true,
					payload: await store.listExecutionRunsForTeam(c.req.param('teamId'), {
						projectId: typeof c.req.query('projectId') === 'string' ? c.req.query('projectId') : null,
						providerId: typeof c.req.query('providerId') === 'string' ? c.req.query('providerId') : null,
						status: typeof c.req.query('status') === 'string' ? c.req.query('status') : null,
						mode: typeof c.req.query('mode') === 'string' ? c.req.query('mode') : null,
						assignmentId: typeof c.req.query('assignmentId') === 'string' ? c.req.query('assignmentId') : null,
						workdayId: typeof c.req.query('workdayId') === 'string' ? c.req.query('workdayId') : null,
						executionProviderId: typeof c.req.query('executionProviderId') === 'string' ? c.req.query('executionProviderId') : null,
						limit: typeof c.req.query('limit') === 'string' ? Number(c.req.query('limit')) : null,
					}),
				});
			});

			app.post('/v1/teams/:teamId/capacity/assignments', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				try {
					const assignment = await store.createProviderAssignment(c.req.param('teamId'), body);
					return assignment ? c.json({ ok: true, payload: assignment }, { status: 201 }) : jsonError(c, 404, 'Unknown project, provider, or project agent class.');
				} catch (error) {
					return jsonError(c, 400, error instanceof Error ? error.message : String(error), {
						code: error && typeof error === 'object' && 'code' in error ? error.code : 'invalid_provider_assignment',
					});
				}
			});

			app.get('/v1/teams/:teamId/capacity/assignments/:assignmentId/explanation', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				const assignment = await store.getProviderAssignment(c.req.param('teamId'), c.req.param('assignmentId'));
				if (!assignment) return jsonError(c, 404, 'Unknown assignment.');
				const explanation = await store.getProviderAssignmentExplanation(c.req.param('teamId'), assignment.id);
				return c.json({ ok: true, payload: explanation ?? assignment.explanation ?? {} });
			});

				app.patch('/v1/teams/:teamId/capacity-grants/:grantId', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					if (!body.capacityProviderId) return jsonError(c, 400, 'capacityProviderId is required.');
				return c.json({
					ok: true,
					payload: await store.upsertCapacityGrant(c.req.param('teamId'), {
						...body,
						id: c.req.param('grantId'),
						teamId: typeof body.teamId === 'string' ? body.teamId : c.req.param('teamId'),
					}),
					});
				});

				app.get('/v1/teams/:teamId/capacity-allocation', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({
						ok: true,
						payload: await store.getTeamPortfolioAllocation(c.req.param('teamId')),
					});
				});

				app.put('/v1/teams/:teamId/capacity-allocation', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					try {
						return c.json({
							ok: true,
							payload: await store.updateTeamPortfolioAllocation(c.req.param('teamId'), body),
						});
					} catch (error) {
						return jsonError(c, 400, error instanceof Error ? error.message : String(error));
					}
				});

					app.get('/v1/teams/:teamId/capacity', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
					if (access.response) return access.response;
					const teamId = c.req.param('teamId');
					const [summary, providers, grants, projects] = await Promise.all([
						store.getTeamCapacitySummary(teamId),
						store.listTeamCapacityProviders(teamId),
						store.listCapacityGrants(teamId),
						store.listTeamProjects(teamId),
					]);
					const providerDetails = await Promise.all(providers.map(async (provider) => ({
						...provider,
						hosts: await store.listCapacityProviderHosts(teamId, provider.id),
					lanes: await store.listCapacityProviderLanes(teamId, provider.id),
					apiKeys: await store.listCapacityProviderApiKeys(teamId, provider.id),
					derivedCapacity: typeof store.getCapacityProviderDerivedCapacity === 'function'
						? await store.getCapacityProviderDerivedCapacity(teamId, provider.id)
						: null,
				})));
				return c.json({
					ok: true,
					payload: {
						summary,
							providers: providerDetails,
							grants,
							projects,
						},
					});
				});

			app.post('/v1/teams/:teamId/capacity/providers/managed', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const payload = await store.launchManagedCapacityProvider(c.req.param('teamId'), {
					...body,
					createdById: typeof access.principal.id === 'string' ? access.principal.id : null,
				});
				return c.json({ ok: true, payload }, { status: 201 });
			});

			app.get('/v1/capacity/providers/:providerId', async (c) => {
				const provider = await store.getCapacityProviderById(c.req.param('providerId'));
				if (!provider) return jsonError(c, 404, 'Unknown capacity provider.');
				const access = await requireTeamAccess(c, store, provider.teamId ?? provider.ownerTeamId, 'projects:read:team');
				if (access.response) return access.response;
				return c.json({
					ok: true,
					payload: {
						...provider,
						hosts: await store.listCapacityProviderHosts(provider.teamId ?? provider.ownerTeamId, provider.id),
						lanes: await store.listCapacityProviderLanes(provider.teamId ?? provider.ownerTeamId, provider.id),
						apiKeys: await store.listCapacityProviderApiKeys(provider.teamId ?? provider.ownerTeamId, provider.id),
						derivedCapacity: typeof store.getCapacityProviderDerivedCapacity === 'function'
							? await store.getCapacityProviderDerivedCapacity(provider.teamId ?? provider.ownerTeamId, provider.id)
							: null,
					},
				});
			});

			app.patch('/v1/capacity/providers/:providerId', async (c) => {
				const provider = await store.getCapacityProviderById(c.req.param('providerId'));
				if (!provider) return jsonError(c, 404, 'Unknown capacity provider.');
				const teamId = provider.teamId ?? provider.ownerTeamId;
				const access = await requireTeamAccess(c, store, teamId, 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				return c.json({
					ok: true,
					payload: await store.upsertCapacityProvider(teamId, {
						...provider,
						...body,
						id: provider.id,
					}),
				});
			});

			app.post('/v1/capacity/providers/:providerId/heartbeat', async (c) => {
				const auth = await requireCapacityProviderKey(c, store, ['provider:heartbeat']);
				if (auth.response) return auth.response;
				if (auth.provider.id !== c.req.param('providerId')) {
					return jsonError(c, 403, 'Provider security code does not match this provider.');
				}
				const body = await c.req.json().catch(() => ({}));
				const provider = await store.recordProviderHeartbeat({
					...body,
					providerId: auth.provider.id,
					status: typeof body.status === 'string' ? body.status : 'active',
				});
				return c.json({ ok: true, payload: provider });
			});

			app.post('/v1/capacity/providers/:providerId/api-keys', async (c) => {
				return jsonError(c, 410, 'Provider API keys are created only during provider creation. Use team provider keys/rotate.');
			});

			app.post('/v1/capacity/providers/:providerId/api-keys/reset', async (c) => {
				return jsonError(c, 410, 'Provider API key reset was replaced by team provider keys/rotate.');
			});

			app.post('/v1/capacity/providers/:providerId/api-keys/:keyId/revoke', async (c) => {
				return jsonError(c, 410, 'Provider API key revoke was replaced by team provider keys/rotate.');
			});

			app.patch('/v1/capacity/grants/:grantId', async (c) => {
				const body = await c.req.json().catch(() => ({}));
				const teamId = typeof body.teamId === 'string' ? body.teamId : null;
				if (!teamId || !body.capacityProviderId) {
					return jsonError(c, 400, 'teamId and capacityProviderId are required.');
				}
				const access = await requireTeamAccess(c, store, teamId, 'teams:manage:team');
				if (access.response) return access.response;
				return c.json({
					ok: true,
					payload: await store.upsertCapacityGrant(teamId, {
						...body,
						id: c.req.param('grantId'),
					}),
				});
			});

			app.get('/v1/projects/:projectId/capacity', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				const environment = typeof c.req.query('environment') === 'string' ? c.req.query('environment') : 'staging';
				return c.json({
					ok: true,
					payload: await store.getProjectCapacitySummary(c.req.param('projectId'), environment),
				});
			});

			app.get('/v1/projects/:projectId/secrets/github-actions/public-key', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const enclave = createGitHubActionsSecretEnclave({
					store,
					config: runtime.resolved.config,
				});
				try {
					const payload = await enclave.fetchPublicKey({
						teamId: access.details.project.teamId,
						projectId: c.req.param('projectId'),
						installationId: c.req.query('installationId'),
						repository: c.req.query('repository'),
						scope: c.req.query('scope') ?? 'environment',
						environment: c.req.query('environment'),
						requester: { type: 'user', id: access.principal.id },
					});
					return c.json({ ok: true, payload });
				} catch (error) {
					return jsonThrownError(c, error);
				}
			});

			app.post('/v1/projects/:projectId/secrets/github-actions/deploy', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const enclave = createGitHubActionsSecretEnclave({
					store,
					config: runtime.resolved.config,
				});
				try {
					const payload = await enclave.deployEncryptedSecret({
						...body,
						teamId: access.details.project.teamId,
						projectId: c.req.param('projectId'),
						requester: { type: 'user', id: access.principal.id },
					});
					return c.json({ ok: true, payload }, { status: 202 });
				} catch (error) {
					return jsonThrownError(c, error);
				}
			});

			app.get('/v1/projects/:projectId/secrets/escrow', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const service = createClientEncryptedEscrowService({ store });
				try {
					const payload = await service.list({
						teamId: access.details.project.teamId,
						projectId: c.req.param('projectId'),
						secretId: c.req.query('secretId'),
						status: c.req.query('status'),
						limit: c.req.query('limit'),
					});
					return c.json({ ok: true, payload });
				} catch (error) {
					return jsonThrownError(c, error);
				}
			});

			app.post('/v1/projects/:projectId/secrets/escrow', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const service = createClientEncryptedEscrowService({ store });
				try {
					const payload = await service.create({
						...body,
						teamId: access.details.project.teamId,
						projectId: c.req.param('projectId'),
						requester: { type: 'user', id: access.principal.id },
					});
					return c.json({ ok: true, payload }, { status: 201 });
				} catch (error) {
					return jsonThrownError(c, error, 400);
				}
			});

			app.get('/v1/projects/:projectId/secrets/escrow/:escrowId', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const service = createClientEncryptedEscrowService({ store });
				try {
					const payload = await service.get({
						teamId: access.details.project.teamId,
						projectId: c.req.param('projectId'),
						escrowId: c.req.param('escrowId'),
					});
					return c.json({ ok: true, payload });
				} catch (error) {
					return jsonThrownError(c, error);
				}
			});

			app.patch('/v1/projects/:projectId/secrets/escrow/:escrowId', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const service = createClientEncryptedEscrowService({ store });
				try {
					const payload = await service.update({
						...body,
						teamId: access.details.project.teamId,
						projectId: c.req.param('projectId'),
						escrowId: c.req.param('escrowId'),
						requester: { type: 'user', id: access.principal.id },
					});
					return c.json({ ok: true, payload });
				} catch (error) {
					return jsonThrownError(c, error);
				}
			});

			app.post('/v1/projects/:projectId/secrets/escrow/:escrowId/migrate', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const service = createClientEncryptedEscrowService({ store });
				try {
					const payload = await service.migrate({
						...body,
						teamId: access.details.project.teamId,
						projectId: c.req.param('projectId'),
						escrowId: c.req.param('escrowId'),
						requester: { type: 'user', id: access.principal.id },
					});
					return c.json({ ok: true, payload });
				} catch (error) {
					return jsonThrownError(c, error);
				}
			});

			app.delete('/v1/projects/:projectId/secrets/escrow/:escrowId', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const service = createClientEncryptedEscrowService({ store });
				try {
					const payload = await service.tombstone({
						teamId: access.details.project.teamId,
						projectId: c.req.param('projectId'),
						escrowId: c.req.param('escrowId'),
						requester: { type: 'user', id: access.principal.id },
					});
					return c.json({ ok: true, payload });
				} catch (error) {
					return jsonThrownError(c, error);
				}
			});

			app.post('/v1/projects/:projectId/workflow-operations/:operationId/dispatch', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const enclave = createGitHubActionsSecretEnclave({
					store,
					config: runtime.resolved.config,
				});
				try {
					const payload = await enclave.dispatchWorkflowOperation({
						...body,
						teamId: access.details.project.teamId,
						projectId: c.req.param('projectId'),
						operationId: c.req.param('operationId'),
						requester: { type: 'user', id: access.principal.id },
					});
					return c.json({ ok: true, payload }, { status: 202 });
				} catch (error) {
					return jsonThrownError(c, error);
				}
			});

			app.get('/v1/projects', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const teamId = typeof c.req.query('teamId') === 'string' ? c.req.query('teamId') : null;
				if (teamId) {
					const access = await requireTeamAccess(c, store, teamId, 'projects:read:team');
					if (access.response) return access.response;
					const projects = await store.listProjectsForPrincipal(auth.principal);
					return c.json({
						ok: true,
						payload: projects.filter((project) => project.teamId === teamId),
					});
				}
				return c.json({
					ok: true,
					payload: await store.listProjectsForPrincipal(auth.principal),
				});
			});

			app.post('/v1/teams/:teamId/projects/import', async (c) => {
				const requestedTeam = c.req.param('teamId');
				const team = await store.getTeam(requestedTeam).catch(() => null)
					?? await store.getTeamBySlug(requestedTeam).catch(() => null);
				if (!team) return jsonError(c, 404, 'Unknown team.', { code: 'team_not_found' });
				const access = await requireTeamAccess(c, store, team.id, 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				try {
					const payload = await store.importProjectRepositoryPlan(team.id, body.plan ?? body);
					return c.json({ ok: true, payload }, { status: 201 });
				} catch (error) {
					return jsonError(c, 400, error instanceof Error ? error.message : 'Invalid project import plan.', {
						code: error?.code ?? 'invalid_project_import_plan',
					});
				}
			});

			app.post('/v1/teams/:teamId/projects', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				if (!body.slug || !body.name) {
					return jsonError(c, 400, 'slug and name are required.');
				}
				let details;
				try {
					details = await store.createProject(c.req.param('teamId'), {
						id: typeof body.id === 'string' ? body.id : undefined,
						slug: String(body.slug),
						name: String(body.name),
						description: typeof body.description === 'string' ? body.description : null,
						metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
						entitlementTier: typeof body.entitlementTier === 'string' ? body.entitlementTier : 'free',
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					const status = /already in use/u.test(message) ? 409 : 400;
					return jsonError(c, status, message, { code: status === 409 ? 'slug_taken' : 'invalid_slug' });
				}
				return c.json({ ok: true, payload: details });
			});

			app.post('/v1/teams/:teamId/projects/launch', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const rejectedUnlock = rejectProjectSecretUnlockMaterial(
					c,
					body,
					'Project launch no longer accepts passphrases or provider credential sessions. Re-enter or migrate team-owned secrets into approved targets before launch.',
				);
				if (rejectedUnlock) return rejectedUnlock;
				let normalizedHostBindings;
				try {
					normalizedHostBindings = normalizeProjectLaunchHostBindings(body);
				} catch (error) {
					return jsonError(c, 400, error instanceof Error ? error.message : String(error), { code: 'invalid_host_bindings' });
				}
				const canonicalIntent = body.intent && typeof body.intent === 'object' ? body.intent : null;
				const requestedHub = canonicalIntent?.hub && typeof canonicalIntent.hub === 'object' ? canonicalIntent.hub : null;
				const requestedTeam = canonicalIntent?.team && typeof canonicalIntent.team === 'object' ? canonicalIntent.team : null;
				const requestedSource = canonicalIntent?.source && typeof canonicalIntent.source === 'object' ? canonicalIntent.source : null;
				const requestedRepository = canonicalIntent?.repository && typeof canonicalIntent.repository === 'object' ? canonicalIntent.repository : null;
				const requestedHosting = canonicalIntent?.hosting && typeof canonicalIntent.hosting === 'object' ? canonicalIntent.hosting : null;
				const requestedSlug = typeof requestedHub?.slug === 'string' ? requestedHub.slug : body.slug;
				const requestedName = typeof requestedHub?.name === 'string' ? requestedHub.name : body.name;
				const requestedCoreObjective = typeof requestedHub?.coreObjective === 'string'
					? requestedHub.coreObjective
					: typeof body.coreObjective === 'string'
						? body.coreObjective
						: typeof body.summary === 'string'
							? body.summary
							: typeof body.description === 'string'
								? body.description
								: null;
				const requestedPurpose = typeof requestedHub?.purpose === 'string'
					? requestedHub.purpose
					: markdownToPlainProjectSummary(requestedCoreObjective, null);
				if (!requestedSlug || !requestedName) {
					return jsonError(c, 400, 'slug and name are required.');
				}
				const teamId = c.req.param('teamId');
				if (requestedTeam?.id && requestedTeam.id !== teamId) {
					return jsonError(c, 400, 'Launch intent team.id must match the route team.');
				}
				const hostingMode = typeof body.hostingMode === 'string'
					? body.hostingMode
					: requestedHosting?.mode === 'treeseed_managed'
						? 'managed'
						: typeof requestedHosting?.mode === 'string'
							? requestedHosting.mode
							: 'managed';
				const hostingKind = hostingMode === 'managed' ? 'hosted_project' : 'self_hosted_project';
				const registration = hostingMode === 'hybrid' ? 'optional' : 'none';
				const sourceKind = typeof body.sourceKind === 'string' ? body.sourceKind : typeof requestedSource?.kind === 'string' ? requestedSource.kind : 'blank';
				const rawSourceRef = typeof body.sourceRef === 'string'
					? body.sourceRef
					: typeof requestedSource?.ref === 'string'
						? requestedSource.ref
						: null;
				const sourceRef = rawSourceRef ? normalizeTreeseedTemplateId(rawSourceRef) : null;
				const sourceVersion = typeof requestedSource?.version === 'string' ? requestedSource.version : typeof body.sourceVersion === 'string' ? body.sourceVersion : null;
				const repoProvider = typeof body.repoProvider === 'string' ? body.repoProvider : typeof requestedRepository?.provider === 'string' ? requestedRepository.provider : 'github';
				const repoVisibility = typeof body.repoVisibility === 'string' ? body.repoVisibility : typeof requestedRepository?.visibility === 'string' ? requestedRepository.visibility : 'private';
				if (!['blank', 'blank_hub', 'template', 'knowledge_pack', 'market_listing'].includes(sourceKind)) {
					return jsonError(c, 400, `Unsupported sourceKind "${sourceKind}".`);
				}
				if ((sourceKind === 'template' || sourceKind === 'market_listing') && !sourceRef) {
					return jsonError(c, 400, 'Project launch requires a selected template.', { code: 'missing_template' });
				}
				if (repoProvider !== 'github') {
					return jsonError(c, 400, 'Knowledge Hub launch currently supports GitHub repositories only.');
				}
				let launchRepositoryTopology;
				try {
					launchRepositoryTopology = launchPlannerRepositoryTopology(requestedRepository?.topology);
				} catch (error) {
					return jsonError(c, 400, error instanceof Error ? error.message : String(error), {
						code: error?.code ?? 'invalid_project_architecture',
					});
				}
				if (hostingMode !== 'managed') {
					return jsonError(c, 400, 'Live project launch currently supports managed hosting only. Use treeseed config --connect-market for hybrid pairing.');
				}
					const team = await store.getTeam(teamId);
					const removedRuntimeHostFields = [
						['process', 'ingHostMode'].join(''),
						['process', 'ingHostId'].join(''),
						['process', 'ingHostConfig'].join(''),
					];
					const removedRuntimeSessionKey = ['process', 'ingHost'].join('');
					if (removedRuntimeHostFields.some((field) => body[field] !== undefined) || body.credentialSessions?.[removedRuntimeSessionKey] !== undefined) {
						return jsonError(c, 400, 'Project launch no longer accepts runtime host configuration. Create and deploy a capacity provider from the capacity provider lifecycle pages.');
					}
					let templateLaunchRequirements;
					try {
						templateLaunchRequirements = await resolveLaunchTemplateRequirements({
							store,
							principal: c.get('principal'),
							config: runtime.resolved.config,
							sourceKind,
							sourceRef,
							requireKnownTemplate: true,
						});
					} catch (error) {
						return jsonError(c, 400, error instanceof Error ? error.message : String(error), { code: 'unknown_template' });
					}
					const [managedHostInventory, teamWebHosts, repositoryHostRows] = await Promise.all([
						listTreeseedManagedHostsFromConfig(teamId, runtime).catch(() => []),
						store.listTeamWebHosts(teamId).catch(() => []),
						store.listRepositoryHosts(teamId).catch(() => []),
					]);
					const repositoryHostInventory = repositoryHostRows.some((host) => host.id === 'platform:github:hosted-hubs')
						? repositoryHostRows
						: [
							...repositoryHostRows,
							{
								id: 'platform:github:hosted-hubs',
								type: 'repository',
								provider: 'github',
								ownership: 'treeseed_managed',
								name: 'TreeSeed Hosted Hubs',
								accountLabel: process.env.TREESEED_HOSTED_HUBS_GITHUB_OWNER ?? null,
								organizationOrOwner: process.env.TREESEED_HOSTED_HUBS_GITHUB_OWNER
									?? (typeof requestedRepository?.owner === 'string' ? requestedRepository.owner : null)
									?? (typeof body.repoOwner === 'string' ? body.repoOwner : null)
									?? 'treeseed-sites',
								allowedEnvironments: ['staging', 'prod'],
								status: 'active',
								metadata: { hostType: 'repository', managed: true },
							},
						];
					let hostBindingResolution;
					try {
						hostBindingResolution = resolveProjectLaunchHostBindings({
							hostBindings: normalizedHostBindings,
							launchRequirements: templateLaunchRequirements,
							repositoryHosts: repositoryHostInventory,
							teamHosts: teamWebHosts,
							managedHosts: managedHostInventory,
							defaultHosts: team?.metadata?.defaultHosts && typeof team.metadata.defaultHosts === 'object' ? team.metadata.defaultHosts : {},
							projectSlug: requestedSlug,
							projectName: requestedName,
							standardProjectLaunch: true,
						});
					} catch (error) {
						return jsonError(c, 400, error instanceof Error ? error.message : String(error), { code: 'invalid_host_bindings' });
					}
					const cloudflareHostMode = hostBindingResolution.compatibility.cloudflareHostMode
						?? (body.cloudflareHostMode === 'treeseed_managed' ? 'treeseed_managed' : body.cloudflareHostMode === 'team_owned' ? 'team_owned' : null);
					const cloudflareHostId = hostBindingResolution.compatibility.cloudflareHostId
						?? (typeof body.cloudflareHostId === 'string' && body.cloudflareHostId.trim() ? body.cloudflareHostId.trim() : null);
					const emailHostMode = hostBindingResolution.compatibility.emailHostMode
						?? (body.emailHostMode === 'treeseed_managed' ? 'treeseed_managed' : body.emailHostMode === 'team_owned' ? 'team_owned' : null);
					const emailHostId = hostBindingResolution.compatibility.emailHostId
						?? (typeof body.emailHostId === 'string' && body.emailHostId.trim() ? body.emailHostId.trim() : null);
					let cloudflareHost = null;
				if (cloudflareHostMode === 'team_owned') {
					if (!cloudflareHostId) {
						return jsonError(c, 400, 'cloudflareHostId is required when cloudflareHostMode is team_owned.');
					}
					cloudflareHost = await store.getTeamWebHost(teamId, cloudflareHostId);
					if (!cloudflareHost || cloudflareHost.provider !== 'cloudflare' || cloudflareHost.ownership !== 'team_owned') {
						return jsonError(c, 400, 'Selected team-owned Cloudflare host is not available for this team.');
					}
					if (body.cloudflareHostConfig && typeof body.cloudflareHostConfig === 'object') {
						return jsonError(c, 400, 'Plaintext Cloudflare provider configs are not accepted. Re-enter or migrate this host secret through CLI/Admin client-side flows before launch.', { code: 'sensitive_passphrase_rejected' });
					}
					return jsonError(c, 400, 'Team-owned Cloudflare host secrets must be re-entered or migrated into an approved target before project launch.', { code: 'sensitive_passphrase_rejected' });
				}
					let emailHost = null;
				if (emailHostMode === 'team_owned') {
					if (!emailHostId) {
						return jsonError(c, 400, 'emailHostId is required when emailHostMode is team_owned.');
					}
					emailHost = await store.getTeamWebHost(teamId, emailHostId);
					const hostType = emailHost?.metadata?.hostType;
					if (!emailHost || emailHost.provider !== 'smtp' || emailHost.ownership !== 'team_owned' || hostType !== 'email') {
						return jsonError(c, 400, 'Selected team-owned Email host is not available for this team.');
					}
					if (body.emailHostConfig && typeof body.emailHostConfig === 'object') {
						return jsonError(c, 400, 'Plaintext Email provider configs are not accepted. Re-enter or migrate this host secret through CLI/Admin client-side flows before launch.', { code: 'sensitive_passphrase_rejected' });
					}
					return jsonError(c, 400, 'Team-owned Email host secrets must be re-entered or migrated into an approved target before project launch.', { code: 'sensitive_passphrase_rejected' });
				}
					const cloudflareLaunchConfig = cloudflareHostMode === 'treeseed_managed'
							? await resolveTreeseedManagedCloudflareHostConfigFromConfig(runtime)
							: null;
					if (cloudflareHostMode === 'treeseed_managed') {
						const missingManagedConfig = managedCloudflareConfigMissing(cloudflareLaunchConfig);
						if (missingManagedConfig.length > 0) {
						return jsonError(c, 500, 'TreeSeed managed Cloudflare hosting is not configured.', {
							missing: missingManagedConfig,
							});
						}
					}
					const targetEnvironments = ['staging', 'prod'];
					const requestedDomains = normalizeProjectDomainInput(body.domains ?? {
						productionDomain: body.productionDomain,
						stagingDomain: body.stagingDomain,
						zoneName: body.cloudflareZoneName,
						zoneId: body.cloudflareZoneId,
						manageDns: body.manageDns,
					});
					const cloudflareDns = cloudflareHostMode === 'team_owned'
						? cloudflareHost?.metadata?.dns ?? {}
						: cloudflareHostMode === 'treeseed_managed'
							? {
								managed: Boolean(cloudflareLaunchConfig?.CLOUDFLARE_ZONE_ID || cloudflareLaunchConfig?.TREESEED_CLOUDFLARE_ZONE_NAME),
								zoneId: cloudflareLaunchConfig?.CLOUDFLARE_ZONE_ID ?? null,
								zoneName: cloudflareLaunchConfig?.TREESEED_CLOUDFLARE_ZONE_NAME ?? null,
							}
							: {};
					const configuredZoneName = normalizeDomainName(requestedDomains.zoneName ?? cloudflareDns.zoneName);
					const inferredZoneName = inferZoneNameForDomain(requestedDomains.productionDomain ?? requestedDomains.stagingDomain, configuredZoneName);
					const domainZoneName = configuredZoneName ?? inferredZoneName;
					if ((requestedDomains.productionDomain || requestedDomains.stagingDomain) && !domainZoneName) {
						return jsonError(c, 400, 'A Cloudflare DNS zone is required when production or staging domains are provided.');
					}
					for (const [label, domain] of [['productionDomain', requestedDomains.productionDomain], ['stagingDomain', requestedDomains.stagingDomain]]) {
						if (domain && !domainInZone(domain, domainZoneName)) {
							return jsonError(c, 400, `${label} must be the selected Cloudflare zone root or a subdomain of it.`);
						}
					}
					if (requestedDomains.productionDomain && requestedDomains.stagingDomain && requestedDomains.productionDomain === requestedDomains.stagingDomain) {
						return jsonError(c, 400, 'Production and staging domains must be different.');
					}
					const projectDomains = {
						productionDomain: requestedDomains.productionDomain,
						stagingDomain: requestedDomains.stagingDomain,
						zoneName: domainZoneName,
						zoneId: requestedDomains.zoneId ?? cloudflareDns.zoneId ?? null,
						manageDns: Boolean(requestedDomains.manageDns && domainZoneName),
						provider: 'cloudflare',
					};
				const cloudflareHostMetadata = cloudflareHostMode
					? {
						mode: cloudflareHostMode,
						hostId: cloudflareHostId,
						hostName: cloudflareHost?.name ?? (cloudflareHostMode === 'treeseed_managed' ? 'TreeSeed Web Host' : null),
						ownership: cloudflareHost?.ownership ?? cloudflareHostMode,
						targetEnvironments,
						dns: cloudflareDns,
						domains: projectDomains,
						billing: cloudflareHostMode === 'treeseed_managed'
							? {
								fee: 'treeseed_cloudflare_hosting',
								status: 'pending_activation',
							}
							: null,
					}
					: null;
					const emailHostMetadata = emailHostMode
					? {
						mode: emailHostMode,
						hostId: emailHostId,
						hostName: emailHost?.name ?? (emailHostMode === 'treeseed_managed' ? 'TreeSeed Email Host' : null),
						ownership: emailHost?.ownership ?? emailHostMode,
						provider: emailHost?.provider ?? 'smtp',
						targetEnvironments,
						billing: emailHostMode === 'treeseed_managed'
							? { fee: 'treeseed_email_hosting', unit: 'email_sent', price: '$0.01/email sent', status: 'pending_activation' }
							: null,
					}
					: null;
					const hostMetadata = {
						...(cloudflareHostMetadata ? { cloudflareHost: cloudflareHostMetadata } : {}),
						...(emailHostMetadata ? { emailHost: emailHostMetadata } : {}),
					};
					const hostBindingMetadata = {
						hostBindings: hostBindingResolution.hostBindings,
						hostBindingPlans: {
							configWrites: hostBindingResolution.configWritePlan,
							secretDeployment: hostBindingResolution.secretDeploymentPlan,
						},
					};
				const repositoryHostId = typeof requestedRepository?.hostId === 'string' && requestedRepository.hostId.trim()
					? requestedRepository.hostId.trim()
					: hostBindingResolution.compatibility.repositoryHostId
						? hostBindingResolution.compatibility.repositoryHostId
						: typeof body.repositoryHostId === 'string' && body.repositoryHostId.trim()
						? body.repositoryHostId.trim()
						: 'platform:github:hosted-hubs';
				let repositoryHost = await store.getRepositoryHost(teamId, repositoryHostId);
				if (!repositoryHost && repositoryHostId === 'platform:github:hosted-hubs') {
					repositoryHost = await store.upsertRepositoryHost(teamId, {
						id: repositoryHostId,
						platformOwner: true,
						provider: 'github',
						ownership: 'treeseed_managed',
						name: 'TreeSeed Hosted Hubs',
						accountLabel: process.env.TREESEED_HOSTED_HUBS_GITHUB_OWNER ?? null,
						organizationOrOwner: process.env.TREESEED_HOSTED_HUBS_GITHUB_OWNER
							?? (typeof requestedRepository?.owner === 'string' ? requestedRepository.owner : null)
							?? (typeof body.repoOwner === 'string' ? body.repoOwner : null)
							?? 'treeseed-sites',
						defaultVisibility: repoVisibility,
						status: 'active',
						createdById: typeof access.principal.id === 'string' ? access.principal.id : null,
						updatedById: typeof access.principal.id === 'string' ? access.principal.id : null,
					});
				}
				if (!repositoryHost) {
					return jsonError(c, 400, 'Selected Repository Host is not available for this team.');
				}
				if (repositoryHost.ownership === 'team_owned') {
					if (body.repositoryHostConfig && typeof body.repositoryHostConfig === 'object') {
						return jsonError(c, 400, 'Plaintext Repository Host provider configs are not accepted. Re-enter or migrate this host secret through CLI/Admin client-side flows before launch.', { code: 'sensitive_passphrase_rejected' });
					}
					return jsonError(c, 400, 'Team-owned Repository Host secrets must be re-entered or migrated into an approved target before project launch.', { code: 'sensitive_passphrase_rejected' });
				}
					const auditHostKinds = ['repository', 'web', 'email'];
				const templateLineage = [{
					kind: sourceKind === 'blank' ? 'blank_hub' : sourceKind,
					ref: sourceRef,
					version: sourceVersion,
					selectedAt: new Date().toISOString(),
					selectedByUserId: access.principal.id ?? null,
					source: 'project_launch',
				}];
				let details;
				try {
					details = await store.createProject(c.req.param('teamId'), {
						id: typeof body.id === 'string' ? body.id : undefined,
						slug: String(requestedSlug),
						name: String(requestedName),
						description: requestedPurpose,
						metadata: {
							publicSite: body.publicSite !== false,
							sourceKind,
							sourceRef,
							sourceVersion,
							templateLineage,
							coreObjective: requestedCoreObjective,
							enableDefaultAgents: body.enableDefaultAgents !== false,
							launchMode: hostingMode,
							launchPhase: 'queued',
							domains: projectDomains,
							...hostMetadata,
							...(typeof body.metadata === 'object' && body.metadata ? body.metadata : {}),
							...hostBindingMetadata,
						},
							entitlementTier: typeof body.entitlementTier === 'string'
								? body.entitlementTier
								: cloudflareHostMode === 'treeseed_managed' || emailHostMode === 'treeseed_managed'
									? 'paid_hosting'
									: 'free',
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					const status = /already in use/u.test(message) ? 409 : 400;
					return jsonError(c, status, message, { code: status === 409 ? 'slug_taken' : 'invalid_slug' });
				}
				await store.upsertProjectHosting(details.project.id, {
					kind: hostingKind,
					registration,
					marketBaseUrl: runtime.resolved.config.baseUrl ?? null,
					sourceRepoOwner: typeof body.sourceRepoOwner === 'string' ? body.sourceRepoOwner : null,
					sourceRepoName: typeof body.sourceRepoName === 'string' ? body.sourceRepoName : null,
					sourceRepoUrl: typeof body.sourceRepoUrl === 'string' ? body.sourceRepoUrl : null,
					sourceRepoWorkflowPath: typeof body.sourceRepoWorkflowPath === 'string' ? body.sourceRepoWorkflowPath : null,
					projectApiBaseUrl: typeof body.projectApiBaseUrl === 'string' ? body.projectApiBaseUrl : null,
					executionOwner: hostingMode === 'managed' ? 'project_api' : 'project_runner',
					metadata: {
						repoProvider,
						repoVisibility,
						publicSite: body.publicSite !== false,
						sourceKind,
						sourceRef,
						launchPhase: 'queued',
						domains: projectDomains,
						...hostMetadata,
						...hostBindingMetadata,
					},
				});
				await store.upsertProjectConnection(details.project.id, {
					mode: hostingMode === 'managed' ? 'hosted' : hostingMode === 'hybrid' ? 'hybrid' : 'self_hosted',
					projectApiBaseUrl: typeof body.projectApiBaseUrl === 'string' ? body.projectApiBaseUrl : null,
					executionOwner: hostingMode === 'managed' ? 'project_api' : 'project_runner',
					metadata: {
						internalPrefix: '/internal/core',
						repoProvider,
						repoVisibility,
						publicSite: body.publicSite !== false,
						sourceKind,
						sourceRef,
						launchPhase: 'queued',
						domains: projectDomains,
						...hostMetadata,
						...hostBindingMetadata,
					},
				});
				for (const environment of ['local', 'staging', 'prod']) {
					const domain = environment === 'prod'
						? projectDomains.productionDomain
						: environment === 'staging'
							? projectDomains.stagingDomain
							: null;
					await store.upsertProjectEnvironment(details.project.id, {
						environment,
						deploymentProfile: hostingKind,
						baseUrl: domain ? `https://${domain}` : null,
						cloudflareAccountId: cloudflareHostMode === 'team_owned'
							? cloudflareHost?.metadata?.cloudflareAccountId ?? null
							: cloudflareLaunchConfig?.CLOUDFLARE_ACCOUNT_ID ?? null,
						metadata: {
							launchMode: hostingMode,
							launchPhase: 'queued',
							...(domain ? {
								domain,
								dnsManagedByHost: projectDomains.manageDns,
								cloudflareZoneName: projectDomains.zoneName,
								cloudflareZoneId: projectDomains.zoneId,
							} : {}),
						},
					});
				}
				const launchIntent = {
					team: {
						id: teamId,
						slug: team?.slug ?? team?.name ?? null,
					},
					hub: {
						id: details.project.id,
						name: details.project.name,
						slug: details.project.slug,
						purpose: details.project.description ?? null,
						coreObjective: requestedCoreObjective,
						visibility: body.publicSite === false ? 'team' : 'public',
					},
					source: {
						kind: sourceKind === 'blank' ? 'blank_hub' : sourceKind,
						ref: sourceRef,
						version: sourceVersion,
					},
					repository: {
						hostId: repositoryHost.id,
						provider: 'github',
						owner: repositoryHost.organizationOrOwner,
						topology: launchRepositoryTopology,
						visibility: repoVisibility,
						softwareRepository: requestedRepository?.softwareRepository ?? null,
						contentRepository: requestedRepository?.contentRepository ?? null,
					},
					hosting: {
							mode: 'treeseed_managed',
							webHost: cloudflareHostMetadata,
							emailHost: emailHostMetadata,
							domains: projectDomains,
							hostBindings: hostBindingResolution.hostBindings,
						},
					contentResolution: {
						productionSource: 'r2_published_artifacts',
						overlaySource: 'src_content_when_present',
						localSource: 'local_content_checkout',
						fallback: 'empty_with_diagnostics',
					},
					direction: canonicalIntent?.direction && typeof canonicalIntent.direction === 'object' ? canonicalIntent.direction : {
						objective: typeof body.objective === 'string' ? body.objective : null,
						question: typeof body.question === 'string' ? body.question : null,
						proposal: typeof body.proposal === 'string' ? body.proposal : null,
						decisionPolicyPreset: typeof body.decisionPolicyPreset === 'string' ? body.decisionPolicyPreset : 'lead_approval',
					},
					capabilities: Array.isArray(canonicalIntent?.capabilities) ? canonicalIntent.capabilities : [],
					market: canonicalIntent?.market && typeof canonicalIntent.market === 'object' ? canonicalIntent.market : {},
					execution: {
						providerLaunchInput: {
							projectId: details.project.id,
							teamId,
							teamSlug: team?.slug ?? team?.name ?? null,
							projectSlug: details.project.slug,
							projectName: details.project.name,
							summary: details.project.description ?? null,
							coreObjective: requestedCoreObjective,
							sourceKind: sourceKind === 'blank_hub' ? 'blank' : sourceKind === 'market_listing' ? 'template' : sourceKind,
							sourceRef,
							hostingMode,
							publicSite: body.publicSite !== false,
							repoOwner: repositoryHost.organizationOrOwner,
							repoVisibility,
							marketBaseUrl: runtime.resolved.config.baseUrl ?? null,
							projectApiBaseUrl: typeof body.projectApiBaseUrl === 'string' ? body.projectApiBaseUrl : null,
							domains: projectDomains,
							contactEmail: typeof body.contactEmail === 'string' ? body.contactEmail : null,
							enableDefaultAgents: body.enableDefaultAgents !== false,
							hostBindings: hostBindingResolution.hostBindings,
							hostBindingPlans: hostBindingMetadata.hostBindingPlans,
								cloudflareHost: cloudflareHostMode
									? {
										mode: cloudflareHostMode,
									hostId: cloudflareHostId,
									targetEnvironments,
									}
									: null,
								emailHost: emailHostMode
									? {
									mode: emailHostMode,
									hostId: emailHostId,
									targetEnvironments,
								}
								: null,
						},
					},
				};
				const launchPlan = planKnowledgeHubLaunch(launchIntent, repositoryHost);
				await store.replaceProjectCapabilities(details.project.id, launchCapabilityPreset(launchPlan.repository.topology));
				for (const repository of launchPlan.repository.repositories) {
					await store.upsertHubRepository(details.project.id, {
						teamId,
						role: repository.role,
						repositoryHostId: repositoryHost.id,
						provider: 'github',
						owner: repository.owner,
						name: repository.name,
						url: repository.url ?? null,
						defaultBranch: repository.defaultBranch ?? 'main',
						currentBranch: repository.defaultBranch ?? 'main',
						status: 'queued',
						...hubRepositoryPolicies(repository.role),
						metadata: {
							topology: launchPlan.repository.topology,
							create: repository.create,
						},
					});
				}
				const contentRepository = (await store.listHubRepositories(details.project.id)).find((repository) => repository.role === 'content') ?? null;
				await store.upsertHubContentSource(details.project.id, {
					teamId,
					contentRepositoryId: contentRepository?.id ?? null,
					productionSource: 'r2_published_artifacts',
					overlayPolicy: 'src_content_when_present',
					metadata: {
						localSource: 'local_content_checkout',
						fallback: 'empty_with_diagnostics',
					},
				});
				const launchJob = await store.createJob({
					id: typeof body.launchRequestId === 'string' && body.launchRequestId.trim() ? body.launchRequestId.trim() : undefined,
					projectId: details.project.id,
					namespace: 'workflow',
					operation: 'launch_project',
					status: 'running',
					preferredMode: 'auto',
					selectedTarget: 'api',
					requestedByType: c.get('actorType') === 'service' ? 'service' : 'user',
					requestedById: typeof access.principal.id === 'string' ? access.principal.id : null,
					idempotencyKey: `launch:${details.project.id}`,
					input: nonSecretLaunchJobInput({
						teamId,
						projectId: details.project.id,
						launchIntent,
						launchPlan,
						repositoryHostId: repositoryHost.id,
						hostBindings: hostBindingResolution.hostBindings,
						hostBindingPlans: hostBindingMetadata.hostBindingPlans,
						hostingMode,
						bootstrap: {
							ownedBy: 'api',
							requiresPassphrase: false,
						},
					}),
				});
				const launchDeployments = [];
				for (const environment of ['staging', 'prod']) {
					const domain = environment === 'prod' ? projectDomains.productionDomain : projectDomains.stagingDomain;
					const deployment = await store.createProjectDeployment(details.project.id, {
						teamId,
						environment,
						deploymentKind: 'mixed',
						action: 'launch_project',
						status: 'running',
						platformOperationId: launchJob.id,
						idempotencyKey: `launch:${launchJob.id}:${environment}`,
						requestedByUserId: typeof access.principal.id === 'string' ? access.principal.id : null,
						sourceRef,
						triggeredByType: c.get('actorType') === 'service' ? 'service' : 'user',
						triggeredById: typeof access.principal.id === 'string' ? access.principal.id : null,
						repository: {
							provider: 'github',
							hostId: repositoryHost.id,
							owner: repositoryHost.organizationOrOwner,
							visibility: repoVisibility,
							topology: launchPlan.repository.topology,
							repositories: launchPlan.repository.repositories,
						},
						target: {
							provider: 'cloudflare',
							environment,
							domain,
							hostMode: cloudflareHostMode,
							hostId: cloudflareHostId,
							emailHostMode,
							emailHostId,
						},
						summary: `Started initial ${environment} project launch.`,
						metadata: {
							launchId: null,
							launchJobId: launchJob.id,
							launchRequestId: body.launchRequestId ?? null,
							launchPhase: 'credential_bootstrap',
							domains: projectDomains,
							...hostBindingMetadata,
						},
					});
					launchDeployments.push(deployment);
				}
				const hubLaunch = await store.createHubLaunch({
					hubId: details.project.id,
					teamId,
					jobId: launchJob.id,
					intent: launchIntent,
					plan: launchPlan,
					state: 'running',
					currentPhase: 'credential_bootstrap',
				});
				for (const deployment of launchDeployments) {
					await store.updateProjectDeployment(deployment.id, {
						metadata: {
							...(deployment.metadata ?? {}),
							launchId: hubLaunch.id,
						},
					});
					await store.appendProjectDeploymentEvent(deployment.id, {
						kind: 'launch.deployment_created',
						message: 'Durable deployment record created. Credential bootstrap is starting.',
						status: 'running',
						operationId: launchJob.id,
						payload: { launchId: hubLaunch.id },
					});
				}
				await store.appendHubLaunchEvent(hubLaunch.id, {
					phase: 'credential_bootstrap',
					status: 'running',
					title: 'Credential bootstrap',
					summary: 'TreeSeed created the durable launch record and started API-owned credential bootstrap.',
					data: { jobId: launchJob.id },
				});
				await store.appendJobEvent(launchJob.id, 'phase', {
					phase: 'credential_bootstrap',
					status: 'running',
					title: 'Credential bootstrap',
					summary: 'TreeSeed started API-owned credential bootstrap.',
				});
				const canonicalDeployment = launchDeployments.find((deployment) => deployment.environment === 'staging') ?? launchDeployments[0];
				const deploymentHref = `/app/projects/deployment/${encodeURIComponent(canonicalDeployment.id)}`;
				scheduleBackgroundBootstrap(c, () => runProjectLaunchApiBootstrap({
					store,
					runtime,
					jobId: launchJob.id,
					launchIntent,
					passphrase: null,
					repositoryHost,
					cloudflareHost,
					emailHost,
					cloudflareHostMode,
					emailHostMode,
					cloudflareLaunchConfig,
					auditHostKinds,
					principal: { id: access.principal.id, type: c.get('actorType') === 'service' ? 'service' : 'user' },
					mockExternal: options.mockExternal === true,
				}));

				const projectSummary = await store.getProjectSummary(details.project.id, access.principal);
				if (projectSummary) {
					await store.upsertProjectSummarySnapshot(details.project.id, teamId, projectSummary);
				}
				return c.json({
					ok: true,
					projectId: details.project.id,
					launchId: hubLaunch.id,
					operationId: launchJob.id,
					deploymentId: canonicalDeployment.id,
					deploymentHref,
					payload: {
						project: projectSummary ?? await store.getProjectDetails(details.project.id),
						launchJob: decorateJob(normalizeBaseUrl(runtime.resolved.config.baseUrl ?? ''), launchJob),
						launch: hubLaunch,
						deployments: await store.listProjectDeployments(details.project.id, { limit: 10 }),
						next: deploymentHref,
					},
				}, 202);

			});

			app.get('/v1/projects/:projectId', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({ ok: true, payload: access.details });
			});

			app.get('/v1/projects/:projectId/hosts', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				const context = await loadProjectHostBindingContext({
					store,
					runtime,
					principal: access.principal,
					details: access.details,
				});
				return c.json({ ok: true, payload: projectHostResponsePayload(context) });
			});

			app.get('/v1/projects/:projectId/treedx-library', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({ ok: true, payload: await store.getProjectTreeDxLibrary(c.req.param('projectId')) });
			});

			app.post('/v1/projects/:projectId/treedx-library', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const payload = await store.upsertProjectTreeDxLibrary(c.req.param('projectId'), body);
				if (!payload) return jsonError(c, 404, 'Create a team TreeDX binding before binding a project library.');
				return c.json({ ok: true, payload }, { status: 201 });
			});

			app.get('/v1/projects/:projectId/repository-topology', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				const payload = await store.getProjectRepositoryTopology(c.req.param('projectId'));
				if (!payload) return jsonError(c, 404, 'Project architecture is not configured for this project.', { code: 'project_architecture_not_configured' });
				return c.json({ ok: true, payload });
			});

				app.put('/v1/projects/:projectId/repository-topology', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					try {
						const payload = await store.upsertProjectRepositoryTopology(c.req.param('projectId'), body);
						if (!payload) return jsonError(c, 404, 'Unknown project.', { code: 'project_not_found' });
						return c.json({ ok: true, payload });
					} catch (error) {
						return jsonError(c, 400, error instanceof Error ? error.message : 'Invalid project architecture.', {
							code: error?.code ?? 'invalid_project_architecture',
						});
					}
				});

				app.post('/v1/dx/projects/:projectId/repos', async (c) => {
					const projectId = c.req.param('projectId');
					const body = await c.req.json().catch(() => ({}));
					return proxyTreeDxJson({
						c,
						runtime,
						store,
						projectId,
						permission: 'projects:manage:team',
						method: 'POST',
						path: '/api/v1/repos',
						body,
						tokenScope: treeDxTokenScope({
							capabilities: ['repos:write'],
							paths: [],
						}),
					});
				});

				app.post('/v1/dx/projects/:projectId/repos/:repoId/workspaces', async (c) => {
					const projectId = c.req.param('projectId');
					const repoId = c.req.param('repoId');
					const library = await store.getProjectTreeDxLibrary(projectId);
					const mismatch = assertDxRepoMatchesProject(c, library, repoId);
					if (mismatch) return mismatch;
					const body = await c.req.json().catch(() => ({}));
					return proxyTreeDxJson({
						c,
						runtime,
						store,
						projectId,
						permission: 'projects:manage:team',
						method: 'POST',
						path: `/api/v1/repos/${encodeURIComponent(repoId)}/workspaces`,
						body,
						tokenScope: treeDxTokenScope({
							repoId,
							capabilities: ['repos:write', TREE_DX_WORKSPACE_CREATE_CAPABILITY, 'files:read', 'files:write', 'git:read', 'git:diff', 'git:commit'],
							paths: ['**'],
						}),
					});
				});

				app.get('/v1/dx/projects/:projectId/workspaces/:workspaceId/files', async (c) => {
					const projectId = c.req.param('projectId');
					const workspaceId = c.req.param('workspaceId');
					const filePath = c.req.query('path');
					if (!filePath) return jsonError(c, 400, 'TreeDX file path is required.');
					const library = await store.getProjectTreeDxLibrary(projectId);
					const baseUrl = resolveTreeDxProxyBaseUrl({ runtime, library });
					const mismatch = await assertDxWorkspaceMatchesProject({ c, runtime, projectId, library, baseUrl, workspaceId });
					if (mismatch) return mismatch;
					const repoId = library?.repositoryId ?? library?.topology?.contentRepository?.treeDx?.repositoryId ?? null;
					return proxyTreeDxJson({
						c,
						runtime,
						store,
						projectId,
						permission: 'projects:read:team',
						method: 'GET',
						path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/files?path=${encodeURIComponent(filePath)}`,
						tokenScope: treeDxTokenScope({
							repoId,
							capabilities: ['files:read'],
							paths: treeDxPathScope(filePath),
						}),
					});
				});

				app.put('/v1/dx/projects/:projectId/workspaces/:workspaceId/files', async (c) => {
					const projectId = c.req.param('projectId');
					const workspaceId = c.req.param('workspaceId');
					const filePath = c.req.query('path');
					if (!filePath) return jsonError(c, 400, 'TreeDX file path is required.');
					const body = await c.req.json().catch(() => ({}));
					const library = await store.getProjectTreeDxLibrary(projectId);
					const baseUrl = resolveTreeDxProxyBaseUrl({ runtime, library });
					const mismatch = await assertDxWorkspaceMatchesProject({ c, runtime, projectId, library, baseUrl, workspaceId });
					if (mismatch) return mismatch;
					const repoId = library?.repositoryId ?? library?.topology?.contentRepository?.treeDx?.repositoryId ?? null;
					return proxyTreeDxJson({
						c,
						runtime,
						store,
						projectId,
						permission: 'projects:manage:team',
						method: 'PUT',
						path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/files?path=${encodeURIComponent(filePath)}`,
						body,
						tokenScope: treeDxTokenScope({
							repoId,
							capabilities: ['files:write'],
							paths: treeDxPathScope(filePath),
						}),
					});
				});

				app.post('/v1/dx/projects/:projectId/workspaces/:workspaceId/search', async (c) => {
					const projectId = c.req.param('projectId');
					const workspaceId = c.req.param('workspaceId');
					const body = await c.req.json().catch(() => ({}));
					const library = await store.getProjectTreeDxLibrary(projectId);
					const baseUrl = resolveTreeDxProxyBaseUrl({ runtime, library });
					const mismatch = await assertDxWorkspaceMatchesProject({ c, runtime, projectId, library, baseUrl, workspaceId });
					if (mismatch) return mismatch;
					const repoId = library?.repositoryId ?? library?.topology?.contentRepository?.treeDx?.repositoryId ?? null;
					return proxyTreeDxJson({
						c,
						runtime,
						store,
						projectId,
						permission: 'projects:read:team',
						method: 'POST',
						path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/search`,
						body,
						tokenScope: treeDxTokenScope({
							repoId,
							capabilities: ['files:search'],
							paths: Array.isArray(body.paths) ? body.paths : ['**'],
						}),
					});
				});

				app.post('/v1/dx/projects/:projectId/workspaces/:workspaceId/commit', async (c) => {
					const projectId = c.req.param('projectId');
					const workspaceId = c.req.param('workspaceId');
					const body = await c.req.json().catch(() => ({}));
					const library = await store.getProjectTreeDxLibrary(projectId);
					const baseUrl = resolveTreeDxProxyBaseUrl({ runtime, library });
					const mismatch = await assertDxWorkspaceMatchesProject({ c, runtime, projectId, library, baseUrl, workspaceId });
					if (mismatch) return mismatch;
					const repoId = library?.repositoryId ?? library?.topology?.contentRepository?.treeDx?.repositoryId ?? null;
					return proxyTreeDxJson({
						c,
						runtime,
						store,
						projectId,
						permission: 'projects:manage:team',
						method: 'POST',
						path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/commit`,
						body,
						tokenScope: treeDxTokenScope({
							repoId,
							capabilities: ['git:commit'],
							paths: ['**'],
						}),
					});
				});

				app.post('/v1/dx/projects/:projectId/repos/:repoId/files/read', async (c) => {
					const projectId = c.req.param('projectId');
					const repoId = c.req.param('repoId');
					const library = await store.getProjectTreeDxLibrary(projectId);
					const mismatch = assertDxRepoMatchesProject(c, library, repoId);
					if (mismatch) return mismatch;
					const body = await c.req.json().catch(() => ({}));
					return proxyTreeDxJson({
						c,
						runtime,
						store,
						projectId,
						permission: 'projects:read:team',
						method: 'POST',
						path: `/api/v1/repos/${encodeURIComponent(repoId)}/files/read`,
						body,
						tokenScope: treeDxTokenScope({
							repoId,
							capabilities: ['files:read'],
							paths: Array.isArray(body.paths) ? body.paths : ['**'],
						}),
					});
				});

				app.post('/v1/dx/projects/:projectId/repos/:repoId/paths/list', async (c) => {
					const projectId = c.req.param('projectId');
					const repoId = c.req.param('repoId');
					const library = await store.getProjectTreeDxLibrary(projectId);
					const mismatch = assertDxRepoMatchesProject(c, library, repoId);
					if (mismatch) return mismatch;
					const body = await c.req.json().catch(() => ({}));
					const pathScope = Array.isArray(body.paths) && body.paths.length > 0
						? body.paths
						: typeof body.path === 'string' && body.path.trim()
							? body.path.trim()
							: '**';
					return proxyTreeDxJson({
						c,
						runtime,
						store,
						projectId,
						permission: 'projects:read:team',
						method: 'POST',
						path: `/api/v1/repos/${encodeURIComponent(repoId)}/paths/list`,
						body,
						tokenScope: treeDxTokenScope({
							repoId,
							capabilities: ['files:read'],
							paths: Array.isArray(pathScope) ? pathScope : treeDxPathScope(pathScope),
						}),
					});
				});

				app.post('/v1/dx/projects/:projectId/repos/:repoId/context/build', async (c) => {
					const projectId = c.req.param('projectId');
					const repoId = c.req.param('repoId');
					const library = await store.getProjectTreeDxLibrary(projectId);
					const mismatch = assertDxRepoMatchesProject(c, library, repoId);
					if (mismatch) return mismatch;
					const body = await c.req.json().catch(() => ({}));
					return proxyTreeDxJson({
						c,
						runtime,
						store,
						projectId,
						permission: 'projects:read:team',
						method: 'POST',
						path: `/api/v1/repos/${encodeURIComponent(repoId)}/context/build`,
						body: treeDxRepoScopedContextBody(body, repoId),
						tokenScope: treeDxTokenScope({
							repoId,
							capabilities: ['files:read', 'files:search', 'graph:query'],
							paths: Array.isArray(body.paths) ? body.paths : ['**'],
						}),
					});
				});

				app.get('/v1/projects/:projectId/capacity-allocation', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
					if (access.response) return access.response;
					const payload = await store.getProjectAgentClassAllocation(c.req.param('projectId'));
					return payload ? c.json({ ok: true, payload }) : jsonError(c, 404, 'Unknown project.');
				});

				app.put('/v1/projects/:projectId/capacity-allocation', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					try {
						const payload = await store.updateProjectAgentClassAllocation(c.req.param('projectId'), body);
						return payload ? c.json({ ok: true, payload }) : jsonError(c, 404, 'Unknown project.');
					} catch (error) {
						return jsonError(c, 400, error instanceof Error ? error.message : String(error));
					}
				});

				const queueProjectHostOperation = async (c, kind) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), kind === 'audit' ? 'projects:read:team' : 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const rejectedUnlock = rejectProjectSecretUnlockMaterial(
					c,
					body,
					'Project host operations no longer accept passphrases or credential sessions. Re-enter or migrate team-owned host secrets through CLI/Admin client-side flows before retrying.',
				);
				if (rejectedUnlock) return rejectedUnlock;
				const requirementKey = optionalTrimmedString(c.req.param('requirementKey')) ?? optionalTrimmedString(body.requirementKey);
				const context = await loadProjectHostBindingContext({
					store,
					runtime,
					principal: access.principal,
					details: access.details,
				});
				let replacementHostBindings = {};
				if (kind === 'replace') {
					const replacementInput = body.hostBindings && typeof body.hostBindings === 'object'
						? { hostBindings: body.hostBindings }
						: body.hostBinding && typeof body.hostBinding === 'object' && requirementKey
							? { hostBindings: { [requirementKey]: body.hostBinding } }
							: body.binding && typeof body.binding === 'object' && requirementKey
								? { hostBindings: { [requirementKey]: body.binding } }
								: {};
					try {
						replacementHostBindings = normalizeProjectLaunchHostBindings(replacementInput);
					} catch (error) {
						return jsonError(c, 400, error instanceof Error ? error.message : String(error), { code: 'invalid_host_binding_replacement' });
					}
					if (requirementKey && !replacementHostBindings[requirementKey]) {
						return jsonError(c, 400, `Replacement binding for ${requirementKey} is required.`, { code: 'missing_host_binding_replacement' });
					}
				}
				let plan;
				try {
					plan = planProjectHostBindingOperation({
						kind,
						requirementKey,
						currentHostBindings: context.currentHostBindings,
						replacementHostBindings,
						launchRequirements: context.launchRequirements,
						repositoryHosts: context.repositoryHosts,
						teamHosts: context.teamHosts,
						managedHosts: context.managedHosts,
						defaultHosts: context.defaultHosts,
						projectSlug: context.project.slug,
						projectName: context.project.name,
					});
				} catch (error) {
					return jsonError(c, 400, error instanceof Error ? error.message : String(error), { code: 'invalid_host_binding_operation' });
				}
				if (plan.audit.summary.status === 'blocked') {
					return jsonError(c, 400, 'Project host operation is blocked by invalid host bindings.', {
						code: 'host_binding_operation_blocked',
						audit: plan.audit,
					});
				}
				const scopedRequirementKeys = requirementKey ? [requirementKey] : plan.operationSummary.changedRequirementKeys;
				const requiresUnlock = Object.entries(plan.nextHostBindings)
					.some(([key, binding]) => (scopedRequirementKeys.length === 0 || scopedRequirementKeys.includes(key)) && hostBindingRequiresUnlock(binding));
				if ((kind === 'rotate' || kind === 'replace' || kind === 'resync') && requiresUnlock) {
					return jsonError(c, 400, 'Project host operations cannot unlock team-owned secrets in the API. Re-enter or migrate the selected host secrets through CLI/Admin client-side flows before retrying.', {
						code: 'sensitive_passphrase_rejected',
					});
				}
				const credentialSessions = {};
				const repository = resolvePlatformRepositoryDescriptor(runtime.resolved.config, access.details, {
					repository: {
						role: 'software',
						writeMode: 'branch',
						branchName: `treeseed/hosts-${kind}-${Date.now()}`,
						push: true,
						pathPolicies: [
							{ allow: 'treeseed.site.yaml' },
							{ allow: 'src/env.yaml' },
							{ allow: 'src/manifest.yaml' },
							{ allow: 'package.json' },
						],
					},
				});
				const operation = await store.createPlatformOperation({
					namespace: 'project_hosts',
					operation: `host_binding_${kind}`,
					target: 'market_operations_runner',
					idempotencyKey: optionalTrimmedString(body.idempotencyKey),
					requestedByType: isTeamApiPrincipal(access.principal) ? 'team_api_key' : c.get('actorType') === 'service' ? 'service' : 'user',
					requestedById: access.principal.id,
					input: {
						projectId: context.project.id,
						teamId: context.project.teamId,
						kind,
						requirementKey: requirementKey ?? null,
						repository,
						hostBindings: plan.nextHostBindings,
						previousHostBindings: plan.previousHostBindings,
						hostBindingPlans: plan.hostBindingPlans,
						operationSummary: plan.operationSummary,
						audit: plan.audit,
						credentialSessions,
						approvalRequired: true,
						approvalSatisfied: true,
						approvalId: `project-hosts:${context.project.id}:${kind}:${Date.now()}`,
						commitMessage: `Update ${context.project.name} project host bindings`,
					},
				});
				await store.appendPlatformOperationEvent(operation.id, `project_hosts.${kind}_queued`, {
					projectId: context.project.id,
					requirementKey: requirementKey ?? null,
					changedRequirementKeys: plan.operationSummary.changedRequirementKeys,
					requiresRepositoryConfigWrite: plan.operationSummary.requiresRepositoryConfigWrite,
					requiresSecretSync: plan.operationSummary.requiresSecretSync,
				}).catch(() => {});
				await persistProjectHostBindingOperationMetadata({
					store,
					details: access.details,
					nextHostBindings: kind === 'replace' ? context.currentHostBindings : plan.nextHostBindings,
					hostBindingPlans: kind === 'replace' ? context.hostBindingPlans : plan.hostBindingPlans,
					audit: plan.audit,
					operation,
					kind,
					requirementKey,
				});
				const refreshed = await loadProjectHostBindingContext({
					store,
					runtime,
					principal: access.principal,
					details: await store.getProjectDetails(context.project.id),
				});
				return c.json({
					ok: true,
					payload: projectHostResponsePayload(refreshed, { plan }),
					operation: decoratePlatformOperation(runtime.resolved.config.baseUrl, operation),
				}, { status: 202 });
			};

			app.post('/v1/projects/:projectId/hosts/audit', (c) => queueProjectHostOperation(c, 'audit'));
			app.post('/v1/projects/:projectId/hosts/:requirementKey/replace', (c) => queueProjectHostOperation(c, 'replace'));
			app.post('/v1/projects/:projectId/hosts/:requirementKey/resync', (c) => queueProjectHostOperation(c, 'resync'));
			app.post('/v1/projects/:projectId/hosts/:requirementKey/rotate', (c) => queueProjectHostOperation(c, 'rotate'));

			app.post('/v1/projects/:projectId/repositories/:role/initialize', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const rejectedUnlock = rejectProjectSecretUnlockMaterial(
					c,
					body,
					'Repository initialization does not accept passphrases or credential sessions. Configure repository credentials through approved host settings before retrying.',
				);
				if (rejectedUnlock) return rejectedUnlock;
				const plaintextCredentials = rejectPlaintextHostCredentialFields(c, body);
				if (plaintextCredentials) return plaintextCredentials;
				const role = optionalTrimmedString(c.req.param('role')) ?? 'primary';
				const repository = resolvePlatformRepositoryDescriptor(runtime.resolved.config, access.details, {
					...body,
					repository: {
						...(body.repository && typeof body.repository === 'object' && !Array.isArray(body.repository) ? body.repository : {}),
						role,
						writeMode: body.execute === true ? 'branch' : 'workspace',
						branchName: optionalTrimmedString(body.branchName) ?? `treeseed/init-${role}-${Date.now()}`,
						push: body.push === true,
					},
				});
				const operation = await store.createPlatformOperation({
					namespace: 'repository',
					operation: 'initialize_linked_repository',
					target: 'market_operations_runner',
					idempotencyKey: optionalTrimmedString(body.idempotencyKey) ?? `repository-init:${access.details.project.id}:${role}`,
					requestedByType: isTeamApiPrincipal(access.principal) ? 'team_api_key' : c.get('actorType') === 'service' ? 'service' : 'user',
					requestedById: access.principal.id,
					input: {
						projectId: access.details.project.id,
						teamId: access.details.project.teamId,
						createdBy: access.principal.id,
						repositoryRole: role,
						repository,
						architecture: access.details.project.metadata?.architecture ?? null,
						scaffoldFiles: Array.isArray(body.scaffoldFiles) ? body.scaffoldFiles : [],
						commitMessage: optionalTrimmedString(body.commitMessage) ?? `Initialize ${access.details.project.name} ${role} repository`,
						approvalRequired: true,
						approvalSatisfied: true,
						approvalId: `repository-init:${access.details.project.id}:${role}:${Date.now()}`,
					},
				});
				await store.appendPlatformOperationEvent(operation.id, 'repository.initialize_queued', {
					projectId: access.details.project.id,
					repositoryRole: role,
				}).catch(() => {});
				return c.json({
					ok: true,
					operation: decoratePlatformOperation(runtime.resolved.config.baseUrl, operation),
				}, { status: 202 });
			});

			app.put('/v1/projects/:projectId', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const slugResult = body.slug == null ? { ok: true, slug: access.details.project.slug } : validateProjectSlug(body.slug);
				if (!slugResult.ok) return jsonError(c, 400, slugResult.message, { code: slugResult.code });
				const name = String(body.name ?? access.details.project.name).trim();
				if (!name) return jsonError(c, 400, 'Project name is required.', { code: 'missing_name' });
				const existing = slugResult.slug === access.details.project.slug
					? null
					: await store.getProjectByTeamAndSlug(access.details.project.teamId, slugResult.slug);
				if (existing && existing.id !== c.req.param('projectId')) {
					return jsonError(c, 409, 'That project slug is already in use for this team.', { code: 'slug_taken' });
				}
				const metadataInput = body.metadata && typeof body.metadata === 'object' ? body.metadata : {};
				const requestedCoreObjective = typeof body.coreObjective === 'string'
					? body.coreObjective.trim()
					: typeof metadataInput.coreObjective === 'string'
						? metadataInput.coreObjective.trim()
						: null;
				const existingCoreObjective = typeof access.details.project.metadata?.coreObjective === 'string'
					? access.details.project.metadata.coreObjective.trim()
					: String(access.details.project.description ?? '').trim();
				const shouldSyncCoreObjective = requestedCoreObjective != null && requestedCoreObjective !== existingCoreObjective;
				let coreObjectiveRepository = null;
				let coreObjectiveNormalized = null;
				let coreObjectivePayload = null;
				if (shouldSyncCoreObjective) {
					coreObjectivePayload = {
						title: 'Core Objective',
						slug: 'core',
						overwrite: true,
						preserveFrontmatter: true,
						summary: 'The enduring project objective used as shared planning context.',
						description: 'The enduring project objective used as shared planning context.',
						body: requestedCoreObjective,
						status: 'live',
						timeHorizon: 'long-term',
						motivation: 'Maintained from project settings.',
						repository: {
							...(body.repository && typeof body.repository === 'object' && !Array.isArray(body.repository) ? body.repository : {}),
							role: 'content',
							writeMode: 'branch',
							branchName: `treeseed/core-objective-${Date.now()}`,
							push: true,
						},
					};
					coreObjectiveRepository = resolvePlatformRepositoryDescriptor(runtime.resolved.config, access.details, coreObjectivePayload);
					coreObjectiveNormalized = normalizeRepositoryContentInput('objectives', {
						...coreObjectivePayload,
						projectId: access.details.project.id,
						teamId: access.details.project.teamId,
						createdBy: access.principal.id,
					});
					if (coreObjectiveNormalized.error) return jsonError(c, 400, coreObjectiveNormalized.error);
				}
				const description = typeof body.description === 'string'
					? body.description.trim() || null
					: requestedCoreObjective != null
						? markdownToPlainProjectSummary(requestedCoreObjective, null)
						: access.details.project.description ?? null;
				const updated = await store.updateProject(c.req.param('projectId'), {
					slug: slugResult.slug,
					name,
					description,
					metadata: {
						...(access.details.project.metadata ?? {}),
						...metadataInput,
						...(requestedCoreObjective != null ? { coreObjective: requestedCoreObjective } : {}),
					},
				});
				let coreObjectiveJob = null;
				if (shouldSyncCoreObjective && coreObjectiveRepository && coreObjectiveNormalized && coreObjectivePayload) {
					const approvalId = `project-settings:${updated.id}:core-objective:${Date.now()}`;
					coreObjectiveJob = await store.createPlatformOperation({
						namespace: 'repository',
						operation: 'write_content_record',
						target: 'market_operations_runner',
						idempotencyKey: `project-settings:${updated.id}:core-objective:${updated.updatedAt ?? Date.now()}`,
						requestedByType: isTeamApiPrincipal(access.principal) ? 'team_api_key' : c.get('actorType') === 'service' ? 'service' : 'user',
						requestedById: access.principal.id,
						input: {
							projectId: updated.id,
							teamId: access.details.project.teamId,
							createdBy: access.principal.id,
							repositoryRole: 'content',
							repository: coreObjectiveRepository,
							collection: 'objectives',
							normalized: coreObjectiveNormalized,
							payload: coreObjectivePayload,
							commitMessage: `Update ${updated.name} core objective`,
							approvalRequired: true,
							approvalSatisfied: true,
							approvalId,
						},
					});
					await store.appendPlatformOperationEvent(coreObjectiveJob.id, 'project_settings.core_objective_sync_queued', {
						projectId: updated.id,
						collection: 'objectives',
						slug: 'core',
					}).catch(() => {});
				}
				return c.json({
					ok: true,
					payload: await store.getProjectDetails(updated.id),
					coreObjectiveJob: coreObjectiveJob ? decoratePlatformOperation(runtime.resolved.config.baseUrl, coreObjectiveJob) : null,
				});
			});

			app.get('/v1/projects/:projectId/deletion-blockers', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				return c.json({ ok: true, payload: await store.evaluateProjectDeletionBlockers(c.req.param('projectId')) });
			});

			app.delete('/v1/projects/:projectId', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const rejectedUnlock = rejectProjectSecretUnlockMaterial(
					c,
					body,
					'Project deletion no longer accepts passphrases or credential sessions. Re-enter or migrate team-owned secrets into approved targets before deleting connected infrastructure.',
				);
				if (rejectedUnlock) return rejectedUnlock;
				const project = await store.getProject(c.req.param('projectId'));
				if (!project) return jsonError(c, 404, 'Project not found.');
				if (!projectDeletionConfirmationMatches(body.confirmation, project)) {
					return jsonError(c, 400, `Type DELETE ${project.slug} to confirm.`, { code: 'confirmation' });
				}
				const blockers = projectDeletionBlockerRows(await store.evaluateProjectDeletionBlockers(project.id));
				if (blockers.length > 0) {
					return jsonError(c, 409, 'Project still has active work that must finish before deletion.', {
						code: 'blocked',
						blockers,
					});
				}
				const details = await store.getProjectDetails(project.id);
				const repositoryHosts = await Promise.all((details?.repositories ?? [])
					.map((repository) => repository.repositoryHostId ? store.getRepositoryHost(project.teamId, repository.repositoryHostId).catch(() => null) : null));
				const hasTeamRepositoryHost = repositoryHosts.some((host) => host?.ownership === 'team_owned');
				const webHostRef = project.metadata?.cloudflareHost ?? details?.hosting?.metadata?.cloudflareHost ?? {};
				const hasTeamWebHost = webHostRef?.mode === 'team_owned' && webHostRef?.hostId;
				if (hasTeamRepositoryHost || hasTeamWebHost) {
					return jsonError(c, 400, 'Project deletion cannot unlock team-owned connected hosts in the API. Re-enter or migrate the selected secrets through CLI/Admin client-side flows before deleting infrastructure.', {
						code: 'sensitive_passphrase_rejected',
					});
				}
				const existingDeletion = (await store.listProjectDeployments(project.id, { action: 'delete_project', limit: 10 }).catch(() => []))
					.find((deployment) => ['queued', 'running'].includes(deployment.status));
				if (existingDeletion) {
					return c.json({
						ok: true,
						payload: existingDeletion,
						deploymentHref: `/app/projects/deployment/${existingDeletion.id}`,
					}, { status: 202 });
				}
				const job = await store.createJob({
					projectId: project.id,
					namespace: 'workflow',
					operation: 'delete_project',
					status: 'running',
					preferredMode: 'auto',
					selectedTarget: 'api',
					input: {
						teamId: project.teamId,
						projectId: project.id,
						projectSlug: project.slug,
						deleteInfrastructure: true,
						deleteData: true,
					},
					requestedByType: 'user',
					requestedById: access.principal?.id ?? null,
				});
				const deployment = await store.createProjectDeployment(project.id, {
					teamId: project.teamId,
					environment: 'prod',
					deploymentKind: 'mixed',
					action: 'delete_project',
					status: 'running',
					platformOperationId: job.id,
					requestedByUserId: access.principal?.id ?? null,
					triggeredByType: 'user',
					triggeredById: access.principal?.id ?? null,
					summary: 'Project infrastructure deletion started.',
					repository: {
						provider: 'github',
						repositories: (details?.repositories ?? []).map((repository) => ({
							role: repository.role,
							owner: repository.owner,
							name: repository.name,
							create: repository.metadata?.create === true,
						})),
					},
					target: {
						provider: 'cloudflare',
						hostMode: webHostRef?.mode ?? null,
						hostId: webHostRef?.hostId ?? null,
					},
					metadata: {
						deletionPhase: 'queued',
						deleteInfrastructure: true,
						deleteData: true,
					},
				});
				await store.updateProject(project.id, {
					metadata: {
						...(project.metadata ?? {}),
						deletion: {
							status: 'running',
							jobId: job.id,
							deploymentId: deployment.id,
							requestedAt: new Date().toISOString(),
							requestedByUserId: access.principal?.id ?? null,
						},
					},
				});
				scheduleBackgroundBootstrap(c, () => runProjectDeletionApiDestroy({
					store,
					projectId: project.id,
					jobId: job.id,
					passphrase: null,
					mockExternal: options.mockExternal === true,
				}));
				return c.json({
					ok: true,
					payload: deployment,
					job,
					deploymentHref: `/app/projects/deployment/${deployment.id}`,
				}, { status: 202 });
			});

			app.get('/v1/projects/:projectId/access', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({
					ok: true,
					payload: await store.getProjectAccessSummary(c.req.param('projectId'), access.principal),
				});
			});

			app.post('/v1/projects/:projectId/private-knowledge/access', async (c) => {
				const projectId = c.req.param('projectId');
				const body = await c.req.json().catch(() => ({}));
				const principal = c.get('principal');
				if (!principal) {
					return jsonError(c, 401, 'Authentication required.');
				}
				const details = await store.getProjectDetails(projectId);
				if (!details?.project) {
					await recordPrivateKnowledgeAudit(store, {
						eventType: 'private_knowledge.not_found',
						actorId: principal.id,
						projectId,
						body,
						status: 'not_found',
						summary: 'Private knowledge project was not found.',
					});
					return jsonError(c, 404, 'Private knowledge page not found.');
				}
				const teamContext = await store.resolvePrincipalTeamContext(details.project.teamId, principal);
				const allowed = Boolean(teamContext) && (!isTeamApiPrincipal(principal) || principalHasPermission(principal, 'projects:read:team'));
				if (!allowed) {
					await recordPrivateKnowledgeAudit(store, {
						eventType: 'private_knowledge.denied',
						actorId: principal.id,
						projectId: details.project.id,
						body,
						status: 'denied',
						summary: 'Private knowledge access was denied.',
					});
					return jsonError(c, 403, 'Permission denied.');
				}
				const outcome = typeof body.outcome === 'string' ? body.outcome : 'validate';
				if (outcome === 'read' || outcome === 'not_found') {
					await recordPrivateKnowledgeAudit(store, {
						eventType: outcome === 'read' ? 'private_knowledge.read' : 'private_knowledge.not_found',
						actorId: principal.id,
						projectId: details.project.id,
						body,
						status: outcome,
						summary: outcome === 'read' ? 'Private knowledge page was read.' : 'Private knowledge page was not found.',
					});
				}
				return c.json({
					ok: true,
					payload: {
						project: {
							id: details.project.id,
							teamId: details.project.teamId,
							name: details.project.name ?? details.project.slug ?? details.project.id,
							slug: details.project.slug ?? details.project.id,
						},
						team: {
							teamId: details.project.teamId,
							roles: teamContext.roles,
						},
						slug: safePrivateKnowledgeSlug(body.slug),
					},
				});
			});

			app.get('/v1/projects/:projectId/summary', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({
					ok: true,
					payload: await store.getProjectSummary(c.req.param('projectId'), access.principal),
				});
			});

			app.get('/v1/projects/:projectId/direct', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({
					ok: true,
					payload: await store.getProjectDirectSummary(c.req.param('projectId'), access.principal),
				});
			});

			app.get('/v1/projects/:projectId/workstreams', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({
					ok: true,
					payload: await store.getProjectWorkstreamsSummary(c.req.param('projectId'), access.principal),
				});
			});

			app.get('/v1/projects/:projectId/agents', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({
					ok: true,
					payload: await store.getProjectAgentsSummary(c.req.param('projectId'), access.principal),
				});
			});

			const createAgentWorkdayRequest = async (c, type) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await readJsonOrFormBody(c);
				const projectId = c.req.param('projectId');
				const summary = await store.getProjectAgentsSummary(projectId, access.principal);
				const agentSlug = c.req.param('agentSlug');
				const agent = (summary?.agents ?? []).find((item) =>
					String(item?.agentSlug ?? item?.slug ?? '') === agentSlug
				);
				if (!agent) return jsonError(c, 404, 'Unknown project agent.');
				const environment = typeof body.environment === 'string' && body.environment.trim()
					? body.environment.trim()
					: 'local';
				const payload = await store.createWorkdayRequest(projectId, {
					environment,
					type,
					workDayId: typeof body.workDayId === 'string' ? body.workDayId : null,
					requestedBy: access.principal.id,
					reason: typeof body.reason === 'string' ? body.reason : `${type} requested for ${agentSlug}`,
					payload: {
						agentSlug,
						source: 'project_agent_compatibility_route',
						...(body.payload && typeof body.payload === 'object' ? body.payload : {}),
					},
					metadata: {
						agentSlug,
						handler: agent.handler ?? null,
						compatibilityRoute: true,
					},
				});
				return c.json({ ok: true, payload }, 202);
			};

			app.post('/v1/projects/:projectId/agents/:agentSlug/run', (c) => createAgentWorkdayRequest(c, 'one_off_run'));
			app.post('/v1/projects/:projectId/agents/:agentSlug/pause', (c) => createAgentWorkdayRequest(c, 'pause'));
			app.post('/v1/projects/:projectId/agents/:agentSlug/resume', (c) => createAgentWorkdayRequest(c, 'retry_open'));

			app.get('/v1/projects/:projectId/releases', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({
					ok: true,
					payload: await store.getProjectReleasesSummary(c.req.param('projectId'), access.principal),
				});
			});

			app.get('/v1/projects/:projectId/share', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({
					ok: true,
					payload: await store.getProjectShareSummary(c.req.param('projectId'), access.principal),
				});
			});

			app.post('/v1/projects/:projectId/workstreams', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const delegated = await requireConnectedProjectRuntime(c, store, access.details.project.id, access.principal, '/v1/workstreams', {
					method: 'POST',
					body,
				});
				if (delegated.response) return delegated.response;
				return c.json({ ok: true, payload: delegated.payload }, { status: 201 });
			});

			app.get('/v1/projects/:projectId/workstreams/:workstreamId', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				const delegated = await requireConnectedProjectRuntime(c, store, access.details.project.id, access.principal, `/v1/workstreams/${encodeURIComponent(c.req.param('workstreamId'))}`);
				if (delegated.response) return delegated.response;
				return c.json({ ok: true, payload: delegated.payload });
			});

			app.post('/v1/projects/:projectId/workstreams/:workstreamId/save', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const delegated = await requireConnectedProjectRuntime(c, store, access.details.project.id, access.principal, `/v1/workstreams/${encodeURIComponent(c.req.param('workstreamId'))}/save`, {
					method: 'POST',
					body,
				});
				if (delegated.response) return delegated.response;
				return c.json({ ok: true, payload: delegated.payload });
			});

			app.post('/v1/projects/:projectId/workstreams/:workstreamId/archive', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const delegated = await requireConnectedProjectRuntime(c, store, access.details.project.id, access.principal, `/v1/workstreams/${encodeURIComponent(c.req.param('workstreamId'))}/archive`, {
					method: 'POST',
					body,
				});
				if (delegated.response) return delegated.response;
				return c.json({ ok: true, payload: delegated.payload });
			});

			app.post('/v1/projects/:projectId/workstreams/:workstreamId/stage', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const href = await projectAppHref(store, access.details.project.teamId, access.details.project.slug, 'workstreams');
				const job = await store.createJob({
					projectId: access.details.project.id,
					namespace: 'project',
					operation: 'stage_workstream',
					status: 'waiting_for_approval',
					preferredMode: 'auto',
					selectedTarget: 'project_api',
					requestedByType: c.get('actorType') === 'service' ? 'service' : 'user',
					requestedById: typeof access.principal.id === 'string' ? access.principal.id : null,
					input: {
						actionPath: `/v1/workstreams/${c.req.param('workstreamId')}/stage`,
						requestBody: body,
						teamId: access.details.project.teamId,
					},
				});
				await store.upsertTeamInboxItem(access.details.project.teamId, {
					id: `approval:${job.id}`,
					projectId: access.details.project.id,
					kind: 'approval',
					state: 'waiting_for_approval',
					title: `${access.details.project.name}: stage workstream`,
					summary: 'A workstream is ready to move to staging and needs human approval.',
					href,
					itemKey: job.id,
					metadata: {
						jobId: job.id,
						workstreamId: c.req.param('workstreamId'),
						action: 'stage',
					},
				});
				return c.json({
					ok: true,
					payload: {
						job: decorateJob(normalizeBaseUrl(runtime.resolved.config.baseUrl ?? ''), job),
					},
				}, { status: 202 });
			});

			app.post('/v1/projects/:projectId/releases', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const delegated = await requireConnectedProjectRuntime(c, store, access.details.project.id, access.principal, '/v1/releases', {
					method: 'POST',
					body,
				});
				if (delegated.response) return delegated.response;
				return c.json({ ok: true, payload: delegated.payload }, { status: 201 });
			});

			app.get('/v1/projects/:projectId/releases/:releaseId', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				const delegated = await requireConnectedProjectRuntime(c, store, access.details.project.id, access.principal, `/v1/releases/${encodeURIComponent(c.req.param('releaseId'))}`);
				if (delegated.response) return delegated.response;
				return c.json({ ok: true, payload: delegated.payload });
			});

			app.post('/v1/projects/:projectId/releases/:releaseId/rollback', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const delegated = await requireConnectedProjectRuntime(c, store, access.details.project.id, access.principal, `/v1/releases/${encodeURIComponent(c.req.param('releaseId'))}/rollback`, {
					method: 'POST',
					body,
				});
				if (delegated.response) return delegated.response;
				return c.json({ ok: true, payload: delegated.payload });
			});

			app.post('/v1/projects/:projectId/releases/:releaseId/publish', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const href = await projectAppHref(store, access.details.project.teamId, access.details.project.slug, 'releases');
				const job = await store.createJob({
					projectId: access.details.project.id,
					namespace: 'project',
					operation: 'publish_release',
					status: 'waiting_for_approval',
					preferredMode: 'auto',
					selectedTarget: 'project_api',
					requestedByType: c.get('actorType') === 'service' ? 'service' : 'user',
					requestedById: typeof access.principal.id === 'string' ? access.principal.id : null,
					input: {
						actionPath: `/v1/releases/${c.req.param('releaseId')}/publish`,
						requestBody: body,
						teamId: access.details.project.teamId,
					},
				});
				await store.upsertTeamInboxItem(access.details.project.teamId, {
					id: `approval:${job.id}`,
					projectId: access.details.project.id,
					kind: 'approval',
					state: 'waiting_for_approval',
					title: `${access.details.project.name}: publish release`,
					summary: 'A release candidate is ready for production and needs human approval.',
					href,
					itemKey: job.id,
					metadata: {
						jobId: job.id,
						releaseId: c.req.param('releaseId'),
						action: 'publish_release',
					},
				});
				return c.json({
					ok: true,
					payload: {
						job: decorateJob(normalizeBaseUrl(runtime.resolved.config.baseUrl ?? ''), job),
					},
				}, { status: 202 });
			});

			app.get('/v1/projects/:projectId/agents/messages', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				const delegated = await requireConnectedProjectRuntime(c, store, access.details.project.id, access.principal, '/v1/agents/messages');
				if (delegated.response) return delegated.response;
				return c.json({ ok: true, payload: delegated.payload });
			});

			app.get('/v1/projects/:projectId/agents/:agentSlug', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				const summary = await store.getProjectAgentsSummary(c.req.param('projectId'), access.principal);
				const agentSlug = c.req.param('agentSlug');
				const agent = (summary?.agents ?? []).find((item) =>
					String(item?.agentSlug ?? item?.slug ?? '') === agentSlug
				);
				return agent
					? c.json({ ok: true, payload: { projectId: c.req.param('projectId'), agent } })
					: jsonError(c, 404, 'Unknown project agent.');
			});

			app.get('/v1/projects/:projectId/agent-artifacts', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				const payload = await store.requestProjectRuntime(access.details.project.id, access.principal, '/v1/agent-artifacts');
				const payloadItems = Array.isArray(payload?.items) ? payload.items : [];
				const fallbackItems = payloadItems.length ? [] : await collectControlPlaneGeneratedArtifacts(store, access.details.project.id);
				if (payload && fallbackItems.length) {
					return c.json({
						ok: true,
						payload: {
							...payload,
							projectId: payload.projectId ?? access.details.project.id,
							items: fallbackItems,
							warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
						},
					});
				}
				return c.json({
					ok: true,
					payload: payload ?? {
						projectId: access.details.project.id,
						items: fallbackItems,
						warnings: fallbackItems.length ? [] : ['Project runtime is not connected or unavailable.'],
					},
				});
			});

			app.get('/v1/projects/:projectId/agent-artifacts/:artifactId', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				const artifactId = c.req.param('artifactId');
				const delegated = await store.requestProjectRuntime(access.details.project.id, access.principal, `/v1/agent-artifacts/${encodeURIComponent(artifactId)}`);
				if (delegated) return c.json({ ok: true, payload: delegated });
				const summary = await store.getProjectAgentsSummary(access.details.project.id, access.principal);
				const artifact = findById(summary?.generatedArtifacts, artifactId)
					?? findById(await collectControlPlaneGeneratedArtifacts(store, access.details.project.id), artifactId);
				return artifact
					? c.json({ ok: true, payload: { projectId: access.details.project.id, artifact } })
					: jsonError(c, 404, 'Unknown agent artifact.');
			});

			app.get('/v1/projects/:projectId/agent-artifacts/:artifactId/source-map', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				const artifactId = c.req.param('artifactId');
				const delegated = await store.requestProjectRuntime(access.details.project.id, access.principal, `/v1/agent-artifacts/${encodeURIComponent(artifactId)}/source-map`);
				if (delegated) return c.json({ ok: true, payload: delegated });
				const summary = await store.getProjectAgentsSummary(access.details.project.id, access.principal);
				const artifact = findById(summary?.generatedArtifacts, artifactId)
					?? findById(await collectControlPlaneGeneratedArtifacts(store, access.details.project.id), artifactId);
				return artifact
					? c.json({ ok: true, payload: { projectId: access.details.project.id, artifactId, sourceMap: artifactSourceMap(artifact) } })
					: jsonError(c, 404, 'Unknown agent artifact.');
			});

			app.get('/v1/projects/:projectId/agent-artifacts/:artifactId/diff', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				const artifactId = c.req.param('artifactId');
				const delegated = await store.requestProjectRuntime(access.details.project.id, access.principal, `/v1/agent-artifacts/${encodeURIComponent(artifactId)}/diff`);
				if (delegated) return c.json({ ok: true, payload: delegated });
				const summary = await store.getProjectAgentsSummary(access.details.project.id, access.principal);
				const artifact = findById(summary?.generatedArtifacts, artifactId)
					?? findById(await collectControlPlaneGeneratedArtifacts(store, access.details.project.id), artifactId);
				return artifact
					? c.json({ ok: true, payload: { projectId: access.details.project.id, artifactId, ...artifactDiffFallback(artifact) } })
					: jsonError(c, 404, 'Unknown agent artifact.');
			});

			app.get('/v1/teams/:teamId/governance-policy', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({ ok: true, payload: await store.getTeamGovernancePolicy(c.req.param('teamId'), optionalTrimmedString(c.req.query('scope')) ?? 'team') });
			});

			app.post('/v1/teams/:teamId/governance-policy', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await readJsonOrFormBody(c);
				try {
					return c.json({ ok: true, payload: await store.setTeamGovernancePolicy(c.req.param('teamId'), {
						...body,
						createdBy: access.principal.id,
					}) });
				} catch (error) {
					return jsonThrownError(c, error, 400);
				}
			});

			app.get('/v1/projects/:projectId/governance-policy', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({ ok: true, payload: await store.getProjectGovernancePolicy(access.details.project.id) });
			});

			app.post('/v1/projects/:projectId/governance-policy', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await readJsonOrFormBody(c);
				try {
					return c.json({ ok: true, payload: await store.setProjectGovernancePolicy(access.details.project.id, {
						...body,
						createdBy: access.principal.id,
					}) });
				} catch (error) {
					return jsonThrownError(c, error, 400);
				}
			});

			app.get('/v1/projects/:projectId/proposals', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({ ok: true, payload: await store.listGovernanceProposals({
					projectId: access.details.project.id,
					status: optionalTrimmedString(c.req.query('status')),
					limit: c.req.query('limit'),
				}) });
			});

			app.post('/v1/projects/:projectId/proposals', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await readJsonOrFormBody(c);
				try {
					return c.json({ ok: true, payload: await store.createGovernanceProposal(access.principal, {
						...body,
						teamId: access.details.project.teamId,
						projectId: access.details.project.id,
						scope: 'project',
						createdByType: isTeamApiPrincipal(access.principal) ? 'team_api_key' : c.get('actorType') === 'service' ? 'service' : 'user',
						createdById: access.principal.id,
					}) }, { status: 201 });
				} catch (error) {
					return jsonThrownError(c, error, 400);
				}
			});

			app.get('/v1/projects/:projectId/proposals/:proposalId', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				const proposal = await store.getGovernanceProposal(c.req.param('proposalId'));
				if (!proposal || proposal.projectId !== access.details.project.id) return jsonError(c, 404, 'Unknown governance proposal.');
				return c.json({ ok: true, payload: {
					...proposal,
					votes: await store.listGovernanceProposalVotes(proposal.id),
					events: await store.listGovernanceEvents({ proposalId: proposal.id, limit: 100 }),
					decision: proposal.decisionId ? await store.getGovernanceDecision(proposal.decisionId) : null,
				} });
			});

			app.patch('/v1/projects/:projectId/proposals/:proposalId', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const proposal = await store.getGovernanceProposal(c.req.param('proposalId'));
				if (!proposal || proposal.projectId !== access.details.project.id) return jsonError(c, 404, 'Unknown governance proposal.');
				const body = await readJsonOrFormBody(c);
				try {
					return c.json({ ok: true, payload: await store.updateGovernanceProposalDraft(access.principal, proposal.id, body) });
				} catch (error) {
					return jsonThrownError(c, error, 400);
				}
			});

			app.post('/v1/projects/:projectId/proposals/:proposalId/open', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await readJsonOrFormBody(c);
				const proposal = await store.openGovernanceProposal(access.principal, c.req.param('proposalId'), body);
				if (!proposal || proposal.projectId !== access.details.project.id) return jsonError(c, 404, 'Unknown governance proposal.');
				return c.json({ ok: true, payload: proposal });
			});

			app.post('/v1/projects/:projectId/proposals/:proposalId/start-voting', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await readJsonOrFormBody(c);
				try {
					const proposal = await store.startGovernanceProposalVoting(access.principal, c.req.param('proposalId'), body);
					if (!proposal || proposal.projectId !== access.details.project.id) return jsonError(c, 404, 'Unknown governance proposal.');
					return c.json({ ok: true, payload: proposal });
				} catch (error) {
					return jsonThrownError(c, error, 400);
				}
			});

			app.post('/v1/projects/:projectId/proposals/:proposalId/vote', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				const existing = await store.getGovernanceProposal(c.req.param('proposalId'));
				if (!existing || existing.projectId !== access.details.project.id) return jsonError(c, 404, 'Unknown governance proposal.');
				const body = await readJsonOrFormBody(c);
				try {
					return c.json({ ok: true, payload: await store.voteGovernanceProposal(access.principal, existing.id, body) });
				} catch (error) {
					return jsonThrownError(c, error, 400);
				}
			});

			app.post('/v1/projects/:projectId/proposals/:proposalId/evaluate', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const existing = await store.getGovernanceProposal(c.req.param('proposalId'));
				if (!existing || existing.projectId !== access.details.project.id) return jsonError(c, 404, 'Unknown governance proposal.');
				const body = await readJsonOrFormBody(c);
				return c.json({ ok: true, payload: await store.evaluateGovernanceProposal(existing.id, {
					...body,
					actorType: isTeamApiPrincipal(access.principal) ? 'team_api_key' : c.get('actorType') === 'service' ? 'service' : 'user',
					actorId: access.principal.id,
				}) });
			});

			app.post('/v1/projects/:projectId/proposals/:proposalId/admin-decision', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'teams:manage:team');
				if (access.response) return access.response;
				const existing = await store.getGovernanceProposal(c.req.param('proposalId'));
				if (!existing || existing.projectId !== access.details.project.id) return jsonError(c, 404, 'Unknown governance proposal.');
				const body = await readJsonOrFormBody(c);
				try {
					return c.json({ ok: true, payload: await store.adminDecideGovernanceProposal(access.principal, existing.id, body) });
				} catch (error) {
					return jsonThrownError(c, error, 400);
				}
			});

			app.post('/v1/projects/:projectId/proposals/:proposalId/withdraw', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const existing = await store.getGovernanceProposal(c.req.param('proposalId'));
				if (!existing || existing.projectId !== access.details.project.id) return jsonError(c, 404, 'Unknown governance proposal.');
				const body = await readJsonOrFormBody(c);
				return c.json({ ok: true, payload: await store.withdrawGovernanceProposal(access.principal, existing.id, body) });
			});

			app.post('/v1/projects/:projectId/proposals/:proposalId/supersede', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const existing = await store.getGovernanceProposal(c.req.param('proposalId'));
				if (!existing || existing.projectId !== access.details.project.id) return jsonError(c, 404, 'Unknown governance proposal.');
				const body = await readJsonOrFormBody(c);
				return c.json({ ok: true, payload: await store.supersedeGovernanceProposal(access.principal, existing.id, body) });
			});

			app.get('/v1/projects/:projectId/proposals/:proposalId/events', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				const proposal = await store.getGovernanceProposal(c.req.param('proposalId'));
				if (!proposal || proposal.projectId !== access.details.project.id) return jsonError(c, 404, 'Unknown governance proposal.');
				return c.json({ ok: true, payload: await store.listGovernanceEvents({ proposalId: proposal.id, limit: c.req.query('limit') }) });
			});

			app.get('/v1/projects/:projectId/decisions', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({ ok: true, payload: await store.listGovernanceDecisions({
					projectId: access.details.project.id,
					status: optionalTrimmedString(c.req.query('status')),
					limit: c.req.query('limit'),
				}) });
			});

			app.get('/v1/projects/:projectId/decisions/:decisionId', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				const decision = await store.getGovernanceDecision(c.req.param('decisionId'));
				if (!decision || decision.projectId !== access.details.project.id) return jsonError(c, 404, 'Unknown governance decision.');
				return c.json({ ok: true, payload: decision });
			});

			app.get('/v1/projects/:projectId/decisions/:decisionId/events', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				const decision = await store.getGovernanceDecision(c.req.param('decisionId'));
				if (!decision || decision.projectId !== access.details.project.id) return jsonError(c, 404, 'Unknown governance decision.');
				return c.json({ ok: true, payload: await store.listGovernanceEvents({ decisionId: decision.id, limit: c.req.query('limit') }) });
			});

			app.get('/v1/teams/:teamId/governance-delegations', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({ ok: true, payload: await store.listGovernanceDelegations({
					teamId: c.req.param('teamId'),
					scope: optionalTrimmedString(c.req.query('scope')),
					status: optionalTrimmedString(c.req.query('status')),
					limit: c.req.query('limit'),
				}) });
			});

			app.post('/v1/teams/:teamId/governance-delegations', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				const body = await readJsonOrFormBody(c);
				try {
					return c.json({ ok: true, payload: await store.createGovernanceDelegation(access.principal, {
						...body,
						teamId: c.req.param('teamId'),
					}) }, { status: 201 });
				} catch (error) {
					return jsonThrownError(c, error, 400);
				}
			});

			app.delete('/v1/teams/:teamId/governance-delegations/:delegationId', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				const body = await readJsonOrFormBody(c);
				try {
					const delegation = await store.revokeGovernanceDelegation(access.principal, c.req.param('delegationId'), body);
					if (!delegation || delegation.teamId !== c.req.param('teamId')) return jsonError(c, 404, 'Unknown governance delegation.');
					return c.json({ ok: true, payload: delegation });
				} catch (error) {
					return jsonThrownError(c, error, 400);
				}
			});

			app.get('/v1/projects/:projectId/governance-delegations', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({ ok: true, payload: await store.listGovernanceDelegations({
					teamId: access.details.project.teamId,
					scope: optionalTrimmedString(c.req.query('scope')) ?? 'project',
					status: optionalTrimmedString(c.req.query('status')),
					limit: c.req.query('limit'),
				}) });
			});

			app.get('/v1/projects/:projectId/approvals', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				const payload = await store.requestProjectRuntime(access.details.project.id, access.principal, '/v1/approvals');
				return c.json({
					ok: true,
					payload: payload ?? {
						projectId: access.details.project.id,
						items: [],
						warnings: ['Project runtime is not connected or unavailable.'],
					},
				});
			});

			app.get('/v1/projects/:projectId/approvals/:approvalId', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				const approvalId = c.req.param('approvalId');
				const delegated = await store.requestProjectRuntime(access.details.project.id, access.principal, `/v1/approvals/${encodeURIComponent(approvalId)}`);
				if (delegated) return c.json({ ok: true, payload: delegated });
				const summary = await store.getProjectAgentsSummary(access.details.project.id, access.principal);
				const approval = findById(summary?.approvals, approvalId);
				return approval
					? c.json({ ok: true, payload: { projectId: access.details.project.id, approval } })
					: jsonError(c, 404, 'Unknown approval request.');
			});

			app.get('/v1/projects/:projectId/operations/grants', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				const payload = await store.requestProjectRuntime(access.details.project.id, access.principal, '/v1/operations/grants');
				return c.json({
					ok: true,
					payload: payload ?? {
						projectId: access.details.project.id,
						items: [],
						warnings: ['Project runtime is not connected or unavailable.'],
					},
				});
			});

			app.get('/v1/projects/:projectId/operations/events', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				const payload = await store.requestProjectRuntime(access.details.project.id, access.principal, '/v1/operations/events');
				return c.json({
					ok: true,
					payload: payload ?? {
						projectId: access.details.project.id,
						items: [],
						lifecycle: {
							worktreeSnapshots: [],
							stagingMerges: [],
							mergeFailures: [],
							repairTasks: [],
							releaseApprovals: [],
							releaseResults: [],
							codexUsage: [],
						},
						warnings: ['Project runtime is not connected or unavailable.'],
					},
				});
			});

			app.post('/v1/projects/:projectId/operations/:operation/dry-run', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await readJsonOrFormBody(c);
				const payload = await store.requestProjectRuntime(
					access.details.project.id,
					access.principal,
					`/v1/operations/${encodeURIComponent(c.req.param('operation'))}/dry-run`,
					{
						method: 'POST',
						body,
					},
				);
				if (!payload) {
					return jsonError(c, 409, 'Project runtime is not connected or unavailable.', {
						payload: {
							projectId: access.details.project.id,
							operation: c.req.param('operation'),
							dryRun: true,
							warnings: ['Project runtime is not connected or unavailable.'],
						},
					});
				}
				return c.json({ ok: true, payload });
			});

			app.post('/v1/projects/:projectId/approvals/:approvalId/decision', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				if (c.get('actorType') === 'service') {
					return jsonError(c, 403, 'Service principals cannot decide agent approvals.');
				}
				const body = await readJsonOrFormBody(c);
				const decision = typeof body.decision === 'string' && body.decision.trim() ? body.decision.trim() : '';
				if (!decision) {
					return jsonError(c, 400, 'Approval decision is required.');
				}
				if (!AGENT_PROMOTION_APPROVAL_DECISIONS.has(decision)) {
					return jsonError(c, 400, 'Unsupported approval decision.');
				}
				const approvalId = c.req.param('approvalId');
				const payload = await store.requestProjectRuntime(
					access.details.project.id,
					access.principal,
					`/v1/approvals/${encodeURIComponent(approvalId)}/decision`,
					{
						method: 'POST',
						body: {
							decision,
							reason: typeof body.reason === 'string' ? body.reason : null,
						},
					},
				);
				if (!payload) {
					return jsonError(c, 409, 'Project runtime is not connected or unavailable.', {
						payload: {
							projectId: access.details.project.id,
							approvalId,
							warnings: ['Project runtime is not connected or unavailable.'],
							releaseAttempted: false,
							stagingAttempted: false,
						},
					});
				}
				return c.json({ ok: true, payload });
			});

			app.get('/v1/projects/:projectId/providers/codex/readiness', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				const payload = await store.requestProjectRuntime(access.details.project.id, access.principal, '/v1/providers/codex/readiness');
				return c.json({
					ok: true,
					payload: payload ?? {
						ok: false,
						providerSelected: false,
						sdkInstalled: false,
						nodeVersionOk: true,
						authDetected: false,
						subscriptionPlan: 'unknown',
						warnings: ['Project runtime is not connected or unavailable.'],
						blockingIssues: [],
					},
				});
			});

			app.post('/v1/projects/:projectId/share/export', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const delegated = await requireConnectedProjectRuntime(c, store, access.details.project.id, access.principal, '/v1/share/export', {
					method: 'POST',
					body,
				});
				if (delegated.response) return delegated.response;
				return c.json({ ok: true, payload: delegated.payload });
			});

			app.post('/v1/projects/:projectId/share/package-template', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const delegated = await requireConnectedProjectRuntime(c, store, access.details.project.id, access.principal, '/v1/share/package-template', {
					method: 'POST',
					body,
				});
				if (delegated.response) return delegated.response;
				return c.json({ ok: true, payload: delegated.payload });
			});

			app.post('/v1/projects/:projectId/share/package-knowledge-pack', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const delegated = await requireConnectedProjectRuntime(c, store, access.details.project.id, access.principal, '/v1/share/package-knowledge-pack', {
					method: 'POST',
					body,
				});
				if (delegated.response) return delegated.response;
				return c.json({ ok: true, payload: delegated.payload });
			});

			app.post('/v1/projects/:projectId/share/publish', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const href = await projectAppHref(store, access.details.project.teamId, access.details.project.slug, 'share');
				const job = await store.createJob({
					projectId: access.details.project.id,
					namespace: 'project',
					operation: 'publish_listing',
					status: 'waiting_for_approval',
					preferredMode: 'auto',
					selectedTarget: 'project_api',
					requestedByType: c.get('actorType') === 'service' ? 'service' : 'user',
					requestedById: typeof access.principal.id === 'string' ? access.principal.id : null,
					input: {
						actionPath: '/v1/share/publish',
						requestBody: body,
						teamId: access.details.project.teamId,
					},
				});
				await store.upsertTeamInboxItem(access.details.project.teamId, {
					id: `approval:${job.id}`,
					projectId: access.details.project.id,
					kind: 'approval',
					state: 'waiting_for_approval',
					title: `${access.details.project.name}: publish listing`,
					summary: 'A market listing is ready to publish and needs human approval.',
					href,
					itemKey: job.id,
					metadata: {
						jobId: job.id,
						action: 'publish_listing',
					},
				});
				return c.json({
					ok: true,
					payload: {
						job: decorateJob(normalizeBaseUrl(runtime.resolved.config.baseUrl ?? ''), job),
					},
				}, { status: 202 });
			});

			app.post('/v1/projects/:projectId/connection', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const mode = enumValue(body.mode, ['hosted', 'hybrid', 'self_hosted'], body.mode == null ? access.details.connection?.mode ?? 'self_hosted' : null);
				if (!mode) return jsonError(c, 400, 'Invalid connection mode.');
				const executionOwner = enumValue(body.executionOwner, ['project_api', 'project_runner'], body.executionOwner == null ? access.details.connection?.executionOwner ?? 'project_runner' : null);
				if (!executionOwner) return jsonError(c, 400, 'Invalid execution owner.');
				const result = await store.upsertProjectConnection(c.req.param('projectId'), {
					mode,
					projectApiBaseUrl: optionalTrimmedString(body.projectApiBaseUrl),
					executionOwner,
					metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
					rotateRunnerToken: body.rotateRunnerToken === true,
				});
				return c.json({
					ok: true,
					payload: {
						connection: result.connection,
						runnerToken: result.runnerToken,
					},
				});
			});

			app.get('/v1/projects/:projectId/hosting', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({
					ok: true,
					payload: access.details.hosting,
				});
			});

			app.put('/v1/projects/:projectId/hosting', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const kind = enumValue(body.kind, ['hosted_project', 'self_hosted_project']);
				if (!kind) return jsonError(c, 400, 'Invalid hosting kind.');
				const registration = enumValue(body.registration, ['none', 'optional', 'required'], 'none');
				const executionOwner = enumValue(body.executionOwner, ['project_api', 'project_runner'], null);
				if (body.executionOwner != null && !executionOwner) return jsonError(c, 400, 'Invalid execution owner.');
				const payload = await store.upsertProjectHosting(c.req.param('projectId'), {
					kind,
					registration,
					marketBaseUrl: optionalTrimmedString(body.marketBaseUrl),
					sourceRepoOwner: optionalTrimmedString(body.sourceRepoOwner),
					sourceRepoName: optionalTrimmedString(body.sourceRepoName),
					sourceRepoUrl: optionalTrimmedString(body.sourceRepoUrl),
					sourceRepoWorkflowPath: optionalTrimmedString(body.sourceRepoWorkflowPath),
					projectApiBaseUrl: optionalTrimmedString(body.projectApiBaseUrl),
					executionOwner,
					metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
				});
				return c.json({ ok: true, payload });
			});

			app.get('/v1/projects/:projectId/environments', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({
					ok: true,
					payload: await store.listProjectEnvironments(c.req.param('projectId')),
				});
			});

			app.put('/v1/projects/:projectId/environments/:environment', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				return c.json({
					ok: true,
					payload: await store.upsertProjectEnvironment(c.req.param('projectId'), {
						environment: c.req.param('environment'),
						deploymentProfile: typeof body.deploymentProfile === 'string' ? body.deploymentProfile : 'self_hosted_project',
						baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : null,
						cloudflareAccountId: typeof body.cloudflareAccountId === 'string' ? body.cloudflareAccountId : null,
						pagesProjectName: typeof body.pagesProjectName === 'string' ? body.pagesProjectName : null,
						workerName: typeof body.workerName === 'string' ? body.workerName : null,
						r2BucketName: typeof body.r2BucketName === 'string' ? body.r2BucketName : null,
						d1DatabaseName: typeof body.d1DatabaseName === 'string' ? body.d1DatabaseName : null,
						railwayProjectName: typeof body.railwayProjectName === 'string' ? body.railwayProjectName : null,
						metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
					}),
				});
			});

			app.get('/v1/projects/:projectId/resources', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				const environment = typeof c.req.query('environment') === 'string' ? c.req.query('environment') : null;
				return c.json({
					ok: true,
					payload: await store.listProjectInfrastructureResources(c.req.param('projectId'), environment),
				});
			});

			app.post('/v1/projects/:projectId/resources', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				if (!body.environment || !body.provider || !body.resourceKind || !body.logicalName) {
					return jsonError(c, 400, 'environment, provider, resourceKind, and logicalName are required.');
				}
				return c.json({
					ok: true,
					payload: await store.upsertProjectInfrastructureResource(c.req.param('projectId'), {
						id: typeof body.id === 'string' ? body.id : undefined,
						environment: String(body.environment),
						provider: String(body.provider),
						resourceKind: String(body.resourceKind),
						logicalName: String(body.logicalName),
						locator: typeof body.locator === 'string' ? body.locator : null,
						metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
					}),
				});
			});

			installProjectDeploymentRoutes(app, { store, requireProjectAccess });

			app.get('/v1/projects/:projectId/agent-pools', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				const environment = typeof c.req.query('environment') === 'string' ? c.req.query('environment') : null;
				return c.json({
					ok: true,
					payload: await store.listAgentPools(c.req.param('projectId'), environment),
				});
			});

			app.post('/v1/projects/:projectId/agent-pools', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				if (!body.teamId || !body.environment || !body.name) {
					return jsonError(c, 400, 'teamId, environment, and name are required.');
				}
				return c.json({
					ok: true,
					payload: await store.upsertAgentPool(c.req.param('projectId'), {
						id: typeof body.id === 'string' ? body.id : undefined,
						teamId: String(body.teamId),
						environment: String(body.environment),
						name: String(body.name),
						registrationIdentity: typeof body.registrationIdentity === 'string' ? body.registrationIdentity : null,
						serviceBaseUrl: typeof body.serviceBaseUrl === 'string' ? body.serviceBaseUrl : null,
						status: typeof body.status === 'string' ? body.status : 'active',
						autoscale: typeof body.autoscale === 'object' && body.autoscale
							? {
								minWorkers: Number(body.autoscale.minWorkers ?? 0),
								maxWorkers: Number(body.autoscale.maxWorkers ?? 1),
								targetQueueDepth: Number(body.autoscale.targetQueueDepth ?? 1),
								cooldownSeconds: Number(body.autoscale.cooldownSeconds ?? 60),
							}
							: undefined,
						metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
					}),
				});
			});

			app.get('/v1/projects/:projectId/agent-pools/:poolId/registrations', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({
					ok: true,
					payload: await store.listAgentPoolRegistrations(c.req.param('poolId')),
				});
			});

			app.get('/v1/projects/:projectId/agent-pools/:poolId/scale-decisions', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({
					ok: true,
					payload: await store.listAgentPoolScaleDecisions(c.req.param('poolId')),
				});
			});

			app.get('/v1/projects/:projectId/work-policy', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				const environment = typeof c.req.query('environment') === 'string' ? c.req.query('environment') : 'staging';
				return c.json({
					ok: true,
					payload: await store.getProjectWorkPolicy(c.req.param('projectId'), environment),
				});
			});

			app.get('/v1/projects/:projectId/workday-policy', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				const environment = typeof c.req.query('environment') === 'string' ? c.req.query('environment') : 'staging';
				return c.json({
					ok: true,
					payload: await store.getProjectWorkPolicy(c.req.param('projectId'), environment),
				});
			});

			app.put('/v1/projects/:projectId/work-policy', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				if (!body.environment || typeof body.schedule !== 'object' || !body.schedule) {
					return jsonError(c, 400, 'environment and schedule are required.');
				}
				return c.json({
					ok: true,
					payload: await store.upsertProjectWorkPolicy(c.req.param('projectId'), {
						environment: String(body.environment),
						schedule: body.schedule,
						dailyTaskCreditBudget: Number.isFinite(Number(body.dailyTaskCreditBudget)) ? Number(body.dailyTaskCreditBudget) : 0,
						maxQueuedTasks: Number.isFinite(Number(body.maxQueuedTasks)) ? Number(body.maxQueuedTasks) : 0,
						maxQueuedCredits: Number.isFinite(Number(body.maxQueuedCredits)) ? Number(body.maxQueuedCredits) : 0,
						autoscale: typeof body.autoscale === 'object' && body.autoscale ? body.autoscale : {},
						creditWeights: Array.isArray(body.creditWeights) ? body.creditWeights : [],
						metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
					}),
				});
			});

			app.put('/v1/projects/:projectId/workday-policy', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				if (!body.environment) {
					return jsonError(c, 400, 'environment is required.');
				}
				const dailyCreditBudget = Number.isFinite(Number(body.dailyCreditBudget ?? body.dailyTaskCreditBudget))
					? Number(body.dailyCreditBudget ?? body.dailyTaskCreditBudget)
					: 0;
				return c.json({
					ok: true,
					payload: await store.upsertProjectWorkPolicy(c.req.param('projectId'), {
						environment: String(body.environment),
						schedule: typeof body.schedule === 'object' && body.schedule ? body.schedule : {
							timezone: typeof body.timezone === 'string' ? body.timezone : 'UTC',
							windows: [],
						},
						enabled: body.enabled !== false,
						startCron: typeof body.startCron === 'string' ? body.startCron : '0 9 * * 1-5',
						durationMinutes: Number.isFinite(Number(body.durationMinutes)) ? Number(body.durationMinutes) : 480,
						maxRunners: Number.isFinite(Number(body.maxRunners)) ? Number(body.maxRunners) : 1,
						maxWorkersPerRunner: Number.isFinite(Number(body.maxWorkersPerRunner)) ? Number(body.maxWorkersPerRunner) : 4,
						dailyCreditBudget,
						dailyTaskCreditBudget: dailyCreditBudget,
						closeoutGraceMinutes: Number.isFinite(Number(body.closeoutGraceMinutes)) ? Number(body.closeoutGraceMinutes) : 15,
						maxQueuedTasks: Number.isFinite(Number(body.maxQueuedTasks)) ? Number(body.maxQueuedTasks) : 0,
						maxQueuedCredits: Number.isFinite(Number(body.maxQueuedCredits)) ? Number(body.maxQueuedCredits) : 0,
						autoscale: typeof body.autoscale === 'object' && body.autoscale ? body.autoscale : {
							minWorkers: 0,
							maxWorkers: Number.isFinite(Number(body.maxRunners)) ? Number(body.maxRunners) : 1,
							targetQueueDepth: 1,
							cooldownSeconds: 60,
						},
						creditWeights: Array.isArray(body.creditWeights) ? body.creditWeights : [],
						metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
					}),
				});
			});

			app.get('/v1/projects/:projectId/workday-status', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				const environment = typeof c.req.query('environment') === 'string' ? c.req.query('environment') : 'staging';
				const [policy, requests, runners, workdays, runnerScaleDecisions] = await Promise.all([
					store.getProjectWorkPolicy(c.req.param('projectId'), environment),
					store.listWorkdayRequests(c.req.param('projectId'), environment, 'pending'),
					store.listWorkerRunners(c.req.param('projectId'), environment),
					store.listProjectWorkdaySummaries(c.req.param('projectId'), environment),
					store.listRunnerScaleDecisions(c.req.param('projectId'), environment),
				]);
				return c.json({
					ok: true,
					payload: {
						environment,
						policy,
						pendingRequests: requests,
						runners,
						latestWorkday: workdays[0] ?? null,
						recentRunnerScaleDecisions: runnerScaleDecisions.slice(0, 10),
					},
				});
			});

			app.post('/v1/projects/:projectId/workday-requests', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await readJsonOrFormBody(c);
				const allowedTypes = new Set(['one_off_run', 'early_close', 'pause', 'retry_open']);
				const type = typeof body.type === 'string' && allowedTypes.has(body.type) ? body.type : null;
				if (!type || typeof body.environment !== 'string') {
					return jsonError(c, 400, 'environment and a supported request type are required.');
				}
				const request = await store.createWorkdayRequest(c.req.param('projectId'), {
					environment: body.environment,
					type,
					workDayId: typeof body.workDayId === 'string' ? body.workDayId : null,
					requestedBy: access.principal.id,
					reason: typeof body.reason === 'string' ? body.reason : null,
					payload: typeof body.payload === 'object' && body.payload ? body.payload : {},
					metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
				});
				let providerTask = null;
				if (type === 'one_off_run') {
					const providers = await store.listTeamCapacityProviders(access.details.project.teamId).catch(() => []);
					const requestedProviderId = typeof body.capacityProviderId === 'string' && body.capacityProviderId.trim()
						? body.capacityProviderId.trim()
						: null;
					const requestedProvider = requestedProviderId
						? providers.find((entry) => entry.id === requestedProviderId)
						: null;
					if (requestedProviderId && !requestedProvider) {
						return jsonError(c, 404, 'Unknown capacity provider for this project team.');
					}
					const provider = requestedProvider
						?? providers.find((entry) => ['connected', 'registered', 'online'].includes(String(entry.connectionState ?? entry.status ?? '').toLowerCase()))
						?? providers[0]
						?? null;
					if (provider) {
						const workDay = await store.startRuntimeWorkDay(c.req.param('projectId'), {
							id: typeof body.workDayId === 'string' ? body.workDayId : undefined,
							state: 'active',
							capacityBudget: 1,
							summary: {
								source: 'workday_request_ui',
								requestId: request.id,
								providerId: provider.id,
							},
						});
						providerTask = await store.createJob({
							projectId: c.req.param('projectId'),
							namespace: 'agent',
							operation: 'demo.live_codex_work',
							status: 'pending',
							preferredMode: 'provider',
							selectedTarget: 'capacity_provider',
							requestedByType: 'user',
							requestedById: access.principal.id,
							idempotencyKey: `demo-live-work:${request.id}`,
							input: {
								projectId: c.req.param('projectId'),
								workDayId: workDay.id,
								agentSlug: typeof body.agentSlug === 'string' ? body.agentSlug : 'treeseed-docs-planner',
								type: 'provider.live_codex',
								messageType: 'provider.live_codex',
								executionMode: body.executionMode === 'dry-run' ? 'dry-run' : 'live',
								prompt: typeof body.prompt === 'string' && body.prompt.trim()
									? body.prompt.trim()
									: 'Run a concise TreeSeed demo work cycle. Produce a short decision summary and a publishable artifact description.',
								...(typeof body.payload === 'object' && body.payload ? body.payload : {}),
								capacity: {
									...(typeof body.capacity === 'object' && body.capacity ? body.capacity : {}),
									providerId: provider.id,
									teamId: access.details.project.teamId,
									workDayId: workDay.id,
									nativeDailyUsageCapPercent: Number.isFinite(Number(body.capacity?.nativeDailyUsageCapPercent))
										? Number(body.capacity.nativeDailyUsageCapPercent)
										: 30,
								},
							},
						});
					}
				}
				return c.json({
					ok: true,
					payload: {
						request,
						providerTask,
					},
				}, 202);
			});

			app.get('/v1/projects/:projectId/priority-overrides', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({
					ok: true,
					payload: await store.listProjectPriorityOverrides(c.req.param('projectId')),
				});
			});

			app.post('/v1/projects/:projectId/priority-overrides', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				if (!body.model || !body.subjectId) {
					return jsonError(c, 400, 'model and subjectId are required.');
				}
				return c.json({
					ok: true,
					payload: await store.upsertProjectPriorityOverride(c.req.param('projectId'), {
						id: typeof body.id === 'string' ? body.id : undefined,
						model: String(body.model),
						subjectId: String(body.subjectId),
						priority: Number.isFinite(Number(body.priority)) ? Number(body.priority) : 0,
						estimatedCredits: Number.isFinite(Number(body.estimatedCredits)) ? Number(body.estimatedCredits) : null,
						metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
					}),
				});
			});

			app.get('/v1/projects/:projectId/priority-snapshots', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				const workDayId = typeof c.req.query('workDayId') === 'string' ? c.req.query('workDayId') : null;
				return c.json({
					ok: true,
					payload: await store.listProjectPrioritySnapshots(c.req.param('projectId'), workDayId),
				});
			});

			app.post('/v1/projects/:projectId/agent-pools/:poolId/registrations', async (c) => {
				const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
				if (runnerAccess.response) return runnerAccess.response;
				const body = await c.req.json().catch(() => ({}));
				return c.json({
					ok: true,
					payload: await store.recordAgentPoolRegistration(c.req.param('projectId'), {
						poolId: c.req.param('poolId'),
						id: typeof body.id === 'string' ? body.id : undefined,
						runnerId: typeof body.runnerId === 'string' ? body.runnerId : null,
						managerId: typeof body.managerId === 'string' ? body.managerId : null,
						serviceName: typeof body.serviceName === 'string' ? body.serviceName : null,
						heartbeatAt: typeof body.heartbeatAt === 'string' ? body.heartbeatAt : null,
						desiredWorkers: Number.isFinite(Number(body.desiredWorkers)) ? Number(body.desiredWorkers) : null,
						observedQueueDepth: Number.isFinite(Number(body.observedQueueDepth)) ? Number(body.observedQueueDepth) : null,
						observedActiveLeases: Number.isFinite(Number(body.observedActiveLeases)) ? Number(body.observedActiveLeases) : null,
						metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
					}),
				});
			});

			app.post('/v1/projects/:projectId/capabilities', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const grants = Array.isArray(body.grants) ? body.grants : [];
				return c.json({
					ok: true,
					payload: await store.replaceProjectCapabilities(c.req.param('projectId'), grants.map((grant) => ({
						namespace: String(grant.namespace ?? 'sdk'),
						operation: String(grant.operation ?? ''),
						label: typeof grant.label === 'string' ? grant.label : null,
						executionClass: String(grant.executionClass ?? 'remote_inline'),
						allowedTargets: Array.isArray(grant.allowedTargets) ? grant.allowedTargets.map(String) : [],
						defaultDispatchMode: String(grant.defaultDispatchMode ?? 'auto'),
						enabled: grant.enabled !== false,
						approvalPolicy: grant.approvalPolicy && typeof grant.approvalPolicy === 'object' ? grant.approvalPolicy : {},
						resourceScope: grant.resourceScope && typeof grant.resourceScope === 'object' ? grant.resourceScope : {},
						metadata: grant.metadata && typeof grant.metadata === 'object' ? grant.metadata : {},
					}))),
				});
			});

			app.get('/v1/projects/:projectId/workspace-links', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({ ok: true, payload: await store.listHubWorkspaceLinks(access.details.project.id) });
			});

			app.post('/v1/projects/:projectId/workspace-links', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const link = await store.upsertHubWorkspaceLink(access.details.project.id, {
					...body,
					teamId: access.details.project.teamId,
				});
				const job = await store.createJob({
					projectId: access.details.project.id,
					namespace: 'workspace',
					operation: 'attach_parent',
					status: 'pending',
					preferredMode: 'auto',
					selectedTarget: 'project_runner',
					requestedByType: isTeamApiPrincipal(access.principal) ? 'team_api_key' : c.get('actorType') === 'service' ? 'service' : 'user',
					requestedById: access.principal.id,
					input: {
						workspaceLinkId: link.id,
						workspace: link,
					},
				});
				return c.json({ ok: true, payload: { link, job: decorateJob(runtime.resolved.config.baseUrl, job) } }, { status: 202 });
			});

			app.get('/v1/projects/:projectId/update-plans', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({ ok: true, payload: await store.listProjectUpdatePlans(access.details.project.id) });
			});

			app.post('/v1/projects/:projectId/local-content/decisions/from-proposals', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await readJsonOrFormBody(c);
				const repository = resolvePlatformRepositoryDescriptor(runtime.resolved.config, access.details, body);
				const proposalSlugs = [...new Set(normalizeRepositoryRelationArray(body.proposalSlugs))];
				if (proposalSlugs.length === 0) return jsonError(c, 400, 'Select at least one proposal.');
				if (proposalSlugs.some((slug) => !slug || slugifyRepositoryContent(slug) !== slug)) return jsonError(c, 400, 'Unsafe proposal slug.');
				const decisionType = enumValue(body.decisionType, [...PROPOSAL_VERDICT_DECISION_TYPES], null);
				if (!decisionType) return jsonError(c, 400, 'Unsupported proposal verdict.');
				const reason = optionalTrimmedString(body.reason) ?? optionalTrimmedString(body.rationale);
				if (!reason) return jsonError(c, 400, 'A decision reason is required.');
				const title = optionalTrimmedString(body.title) ?? `Decision for ${proposalSlugs.length === 1 ? proposalSlugs[0] : `${proposalSlugs.length} proposals`}`;
				const decisionSlug = slugifyRepositoryContent(body.slug || title);
				if (!decisionSlug) return jsonError(c, 400, 'A safe decision slug is required.');
				const job = await store.createPlatformOperation({
					namespace: 'repository',
					operation: 'create_decision_from_proposals',
					target: 'market_operations_runner',
					idempotencyKey: optionalTrimmedString(body.idempotencyKey),
					requestedByType: isTeamApiPrincipal(access.principal) ? 'team_api_key' : c.get('actorType') === 'service' ? 'service' : 'user',
					requestedById: access.principal.id,
					input: {
						projectId: access.details.project.id,
						teamId: access.details.project.teamId,
						createdBy: access.principal.id,
						repository,
						proposalSlugs,
						decisionType,
						reason,
						title,
						slug: decisionSlug,
						payload: body,
					},
				});
				return c.json({ ok: true, job: decoratePlatformOperation(runtime.resolved.config.baseUrl, job) }, { status: 202 });
			});

			app.post('/v1/projects/:projectId/local-content/:collection', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const collection = String(c.req.param('collection') ?? '');
				const body = await readJsonOrFormBody(c);
				const repository = resolvePlatformRepositoryDescriptor(runtime.resolved.config, access.details, body);
				const normalized = normalizeRepositoryContentInput(collection, {
					...body,
					projectId: access.details.project.id,
					teamId: access.details.project.teamId,
					createdBy: access.principal.id,
				});
				if (normalized.error) return jsonError(c, 400, normalized.error);
				const job = await store.createPlatformOperation({
					namespace: 'repository',
					operation: 'write_content_record',
					target: 'market_operations_runner',
					idempotencyKey: optionalTrimmedString(body.idempotencyKey),
					requestedByType: isTeamApiPrincipal(access.principal) ? 'team_api_key' : c.get('actorType') === 'service' ? 'service' : 'user',
					requestedById: access.principal.id,
					input: {
						projectId: access.details.project.id,
						teamId: access.details.project.teamId,
						createdBy: access.principal.id,
						repository,
						collection,
						normalized,
						payload: body,
					},
				});
				return c.json({ ok: true, job: decoratePlatformOperation(runtime.resolved.config.baseUrl, job) }, { status: 202 });
			});

			app.post('/v1/projects/:projectId/local-content/:collection/related', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const routeCollection = String(c.req.param('collection') ?? '');
				const body = await readJsonOrFormBody(c);
				const parentCollection = optionalTrimmedString(body.parentCollection) ?? routeCollection;
				const targetCollection = optionalTrimmedString(body.targetCollection) ?? routeCollection;
				const parentSlug = optionalTrimmedString(body.parentSlug);
				if (!parentSlug) return jsonError(c, 400, 'parentSlug is required.');
				if (targetCollection !== routeCollection) {
					return jsonError(c, 400, 'Route collection must match targetCollection.');
				}
				const repository = resolvePlatformRepositoryDescriptor(runtime.resolved.config, access.details, body);
				const policy = repositoryContentRelationPolicy(parentCollection, targetCollection);
				if (!policy) return jsonError(c, 400, `Cannot create related ${targetCollection} from ${parentCollection}.`);
				const normalized = normalizeRepositoryContentInput(targetCollection, {
					...body,
					projectId: access.details.project.id,
					teamId: access.details.project.teamId,
					createdBy: access.principal.id,
				});
				if (normalized.error) return jsonError(c, 400, normalized.error);
				const job = await store.createPlatformOperation({
					namespace: 'repository',
					operation: 'create_related_content',
					target: 'market_operations_runner',
					idempotencyKey: optionalTrimmedString(body.idempotencyKey),
					requestedByType: isTeamApiPrincipal(access.principal) ? 'team_api_key' : c.get('actorType') === 'service' ? 'service' : 'user',
					requestedById: access.principal.id,
					input: {
						projectId: access.details.project.id,
						teamId: access.details.project.teamId,
						createdBy: access.principal.id,
						repository,
						parentCollection,
						parentSlug,
						targetCollection,
						normalized,
						relation: {
							parentField: policy.sourceField,
							childField: policy.targetField,
						},
						payload: body,
					},
				});
				return c.json({ ok: true, job: decoratePlatformOperation(runtime.resolved.config.baseUrl, job) }, { status: 202 });
			});

			app.post('/v1/projects/:projectId/update-plans', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const plan = await store.createProjectUpdatePlan(access.details.project.id, {
					...body,
					teamId: access.details.project.teamId,
					createdBy: access.principal.id,
				});
				const job = await store.createJob({
					projectId: access.details.project.id,
					namespace: 'hub',
					operation: 'execute_update',
					status: plan.requiresDecision ? 'waiting_for_approval' : 'pending',
					preferredMode: 'auto',
					selectedTarget: 'project_runner',
					requestedByType: isTeamApiPrincipal(access.principal) ? 'team_api_key' : c.get('actorType') === 'service' ? 'service' : 'user',
					requestedById: access.principal.id,
					input: {
						updatePlanId: plan.id,
						plan: plan.plan,
						decisionId: plan.decisionId,
					},
				});
				return c.json({ ok: true, payload: { plan, job: decorateJob(runtime.resolved.config.baseUrl, job) } }, { status: 202 });
			});

			app.post('/v1/projects/:projectId/ci/oidc/exchange', async (c) => {
				const projectId = c.req.param('projectId');
				const details = await store.getProjectDetails(projectId);
				if (!details) {
					return jsonError(c, 404, `Unknown project "${projectId}".`);
				}
				const body = await c.req.json().catch(() => ({}));
				const oidcToken = typeof body.oidcToken === 'string' ? body.oidcToken.trim() : '';
				if (!oidcToken) {
					return jsonError(c, 400, 'oidcToken is required.');
				}
				let claims;
				try {
					claims = await verifyGitHubOidcToken(oidcToken, `treeseed:${projectId}`, c.env?.fetch ?? fetch);
				} catch (error) {
					return jsonError(c, 401, 'GitHub OIDC token could not be verified.', {
						message: error instanceof Error ? error.message : String(error),
					});
				}
				const repository = normalizeRepositorySlug(claims.repository);
				const allowedRepositories = projectAllowedCiRepositories(details);
				if (!repository || !allowedRepositories.has(repository)) {
					return jsonError(c, 403, 'GitHub OIDC repository is not allowed to request operations for this project.', {
						repository,
					});
				}
				const environment = normalizeCiEnvironment(body.environment);
				if (!validateCiRefForEnvironment(environment, claims)) {
					return jsonError(c, 403, 'GitHub OIDC ref is not allowed for the requested environment.', {
						environment,
						ref: claims.ref ?? null,
					});
				}
				const workflowRef = String(claims.workflow_ref ?? '');
				if (
					!workflowRef.includes(`${repository}/.github/workflows/deploy-web.yml@`)
				) {
					return jsonError(c, 403, 'GitHub OIDC workflow_ref must come from the managed deploy workflow.');
				}
				const actionKind = typeof body.actionKind === 'string' ? body.actionKind : 'deploy_web';
				const operation = ciOperationForAction(actionKind);
				const baseCapability = findDispatchCapability(operation.namespace, operation.operation)
					?? fallbackRemoteCapability(operation.namespace, operation.operation);
				const override = await store.getEffectiveCapability(projectId, operation.namespace, operation.operation);
				if (override && override.enabled === false) {
					return jsonError(c, 403, 'Managed operation capability is disabled for this project.', operation);
				}
				const capability = mergeCapability(baseCapability, override);
				const approvalPolicy = capability.approvalPolicy && typeof capability.approvalPolicy === 'object'
					? capability.approvalPolicy
					: {};
				const requiresApproval = approvalPolicy.requiresApproval === true;
				const sha = typeof claims.sha === 'string' && claims.sha.trim()
					? claims.sha.trim()
					: typeof body.sha === 'string' ? body.sha.trim() : null;
				const input = {
					...(typeof body.input === 'object' && body.input ? body.input : {}),
					environment,
					ci: {
						provider: 'github_actions',
						repository,
						ref: claims.ref ?? null,
						refName: claims.ref_name ?? body.refName ?? null,
						sha,
						workflow: claims.workflow ?? body.workflow ?? null,
						workflowRef: claims.workflow_ref ?? body.workflowRef ?? null,
						runId: claims.run_id ?? body.runId ?? null,
						runAttempt: claims.run_attempt ?? body.runAttempt ?? null,
						actor: claims.actor ?? null,
						trigger: claims.event_name ?? null,
					},
					managedHostExecution: {
						mode: 'treeseed_managed',
						credentialExposure: 'none',
					},
					...(requiresApproval ? { approvalPolicy } : {}),
				};
				const job = await store.createJob({
					projectId,
					namespace: operation.namespace,
					operation: operation.operation,
					status: requiresApproval ? 'waiting_for_approval' : 'pending',
					input,
					preferredMode: 'auto',
					selectedTarget: 'project_runner',
					idempotencyKey: `ci:${projectId}:${actionKind}:${environment}:${sha ?? claims.run_id ?? randomBytes(6).toString('hex')}`,
					requestedByType: 'ci_oidc',
					requestedById: repository,
					capability,
				});
				await store.appendJobEvent(job.id, requiresApproval ? 'approval_required' : 'ci_operation_requested', {
					actionKind,
					environment,
					repository,
					ref: claims.ref ?? null,
					sha,
					approvalPolicy: requiresApproval ? approvalPolicy : null,
				});
				if (requiresApproval) {
					await store.upsertTeamInboxItem(details.project.teamId, {
						id: `job-approval:${job.id}`,
						projectId: details.project.id,
						kind: 'approval_required',
						state: 'open',
						title: `${capability.label ?? `${operation.namespace}.${operation.operation}`} needs approval`,
						summary: approvalPolicy.reason ?? 'This managed operation requires human approval before TreeSeed can run it.',
						href: await projectAppHref(store, details.project.teamId, details.project.slug, 'overview'),
						itemKey: job.id,
						metadata: {
							jobId: job.id,
							approvalPolicy,
							resourceScope: capability.resourceScope ?? {},
						},
					});
				}
				const operationToken = signOperationToken(runtime, {
					projectId,
					jobId: job.id,
					repository,
					operation: `${operation.namespace}.${operation.operation}`,
					exp: Math.floor(Date.now() / 1000) + 30 * 60,
				});
				return c.json({
					ok: true,
					payload: {
						job: decorateJob(runtime.resolved.config.baseUrl, job),
						operationToken,
					},
				}, { status: 202 });
			});

			app.get('/v1/projects/:projectId/ci/jobs/:jobId', async (c) => {
				const token = bearerTokenFromRequest(c.req.raw);
				if (!token) {
					return jsonError(c, 401, 'Authentication required.');
				}
				let payload;
				try {
					payload = verifyOperationToken(runtime, token);
				} catch (error) {
					return jsonError(c, 401, 'Invalid operation token.', {
						message: error instanceof Error ? error.message : String(error),
					});
				}
				const projectId = c.req.param('projectId');
				const jobId = c.req.param('jobId');
				if (payload.projectId !== projectId || payload.jobId !== jobId) {
					return jsonError(c, 403, 'Operation token is not scoped to this job.');
				}
				const job = await store.findJobById(jobId);
				if (!job || job.projectId !== projectId) {
					return jsonError(c, 404, `Unknown job "${jobId}".`);
				}
				return c.json({
					ok: true,
					payload: {
						job: decorateJob(runtime.resolved.config.baseUrl, job),
					},
				});
			});

			app.post('/v1/projects/:projectId/dispatch', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'dispatch:execute:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const namespace = typeof body.namespace === 'string' ? body.namespace : 'sdk';
				const operation = typeof body.operation === 'string' ? body.operation : '';
				const baseCapability = findDispatchCapability(namespace, operation);
				if (!baseCapability) {
					return jsonError(c, 400, `Unknown dispatch operation "${namespace}:${operation}".`);
				}
				const override = await store.getEffectiveCapability(access.details.project.id, namespace, operation);
				if (override && override.enabled === false) {
					return jsonError(c, 403, 'Dispatch capability disabled for project.', {
						namespace,
						operation,
					});
				}
				const capability = mergeCapability(baseCapability, override);
				const preferredMode = typeof body.preferredMode === 'string'
					? body.preferredMode
					: capability.defaultDispatchMode;
				const selectedTarget = selectDispatchTarget(runtime, access.details, capability, preferredMode);
				if (!selectedTarget) {
					return jsonError(c, 400, 'Unable to resolve a dispatch target for the requested operation.', {
						namespace,
						operation,
					});
				}

				if (selectedTarget === 'project_runner' && !access.details.connection) {
					return jsonError(c, 409, 'Project runner connection is not configured.', {
						projectId: access.details.project.id,
					});
				}

				if (selectedTarget === 'project_api' && !projectApiConnection(access.details) && access.details.project.id !== runtime.resolved.config.projectId) {
					return jsonError(c, 409, 'Project API dispatch requires a project API connection.', {
						projectId: access.details.project.id,
					});
				}

				const approvalPolicy = capability.approvalPolicy && typeof capability.approvalPolicy === 'object'
					? capability.approvalPolicy
					: {};
				const approvalReference = body.approvalReference && typeof body.approvalReference === 'object'
					? body.approvalReference
					: body.decisionId
						? { decisionId: String(body.decisionId) }
						: null;
				if (approvalPolicy.requiresApproval === true && !approvalReference) {
					const job = await store.createJob({
						projectId: access.details.project.id,
						namespace,
						operation,
						status: 'waiting_for_approval',
						input: {
							...(typeof body.input === 'object' && body.input ? body.input : {}),
							approvalPolicy,
						},
						preferredMode,
						selectedTarget,
						idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : null,
						requestedByType: isTeamApiPrincipal(access.principal) ? 'team_api_key' : c.get('actorType') === 'service' ? 'service' : 'user',
						requestedById: access.principal.id,
						capability,
					});
					await store.appendJobEvent(job.id, 'approval_required', {
						namespace,
						operation,
						approvalPolicy,
					});
					await store.upsertTeamInboxItem(access.details.project.teamId, {
						id: `job-approval:${job.id}`,
						projectId: access.details.project.id,
						kind: 'approval_required',
						state: 'open',
						title: `${capability.label ?? `${namespace}.${operation}`} needs approval`,
						summary: approvalPolicy.reason ?? 'This action requires human approval before TreeSeed can run it.',
						href: await projectAppHref(store, access.details.project.teamId, access.details.project.slug, 'overview'),
						itemKey: job.id,
						metadata: {
							jobId: job.id,
							approvalPolicy,
							resourceScope: capability.resourceScope ?? {},
						},
					});
					return c.json({
						ok: true,
						mode: 'job',
						namespace,
						operation,
						target: selectedTarget,
						capability,
						job: decorateJob(runtime.resolved.config.baseUrl, job),
					}, { status: 202 });
				}

				if (selectedTarget === 'local' || selectedTarget === 'project_api' || selectedTarget === 'market_catalog') {
					const request = {
						namespace,
						operation,
						input: typeof body.input === 'object' && body.input ? body.input : {},
					};
					const payload = selectedTarget === 'project_api' && access.details.project.id !== runtime.resolved.config.projectId
						? await executeProjectApi(options, access.details, request, runtime.internalPrefix)
						: await executeInline(runtime, request);
					return c.json({
						ok: true,
						mode: 'inline',
						namespace,
						operation,
						target: selectedTarget,
						capability,
						payload,
					});
				}

				const job = await store.createJob({
					projectId: access.details.project.id,
					namespace,
					operation,
					input: typeof body.input === 'object' && body.input ? body.input : {},
					preferredMode,
					selectedTarget,
					idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : null,
					requestedByType: isTeamApiPrincipal(access.principal) ? 'team_api_key' : c.get('actorType') === 'service' ? 'service' : 'user',
					requestedById: access.principal.id,
					capability,
				});
				return c.json({
					ok: true,
					mode: 'job',
					namespace,
					operation,
					target: selectedTarget,
					capability,
					job: decorateJob(runtime.resolved.config.baseUrl, job),
				});
			});

			app.get('/v1/jobs/:jobId', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const job = await store.findJobById(c.req.param('jobId'));
				if (!job) {
					return jsonError(c, 404, `Unknown job "${c.req.param('jobId')}".`);
				}
				const access = await requireProjectAccess(c, store, job.projectId, 'dispatch:execute:team');
				if (access.response) return access.response;
				return c.json({ ok: true, payload: decorateJob(runtime.resolved.config.baseUrl, job) });
			});

			app.post('/v1/jobs/:jobId/cancel', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const job = await store.findJobById(c.req.param('jobId'));
				if (!job) {
					return jsonError(c, 404, `Unknown job "${c.req.param('jobId')}".`);
				}
				const access = await requireProjectAccess(c, store, job.projectId, 'dispatch:execute:team');
				if (access.response) return access.response;
				return c.json({
					ok: true,
					payload: decorateJob(runtime.resolved.config.baseUrl, await store.cancelJob(job.id)),
				});
			});

			app.post('/v1/jobs/:jobId/retry', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const job = await store.findJobById(c.req.param('jobId'));
				if (!job) {
					return jsonError(c, 404, `Unknown job "${c.req.param('jobId')}".`);
				}
				const access = await requireProjectAccess(c, store, job.projectId, 'dispatch:execute:team');
				if (access.response) return access.response;
				if (!['failed', 'cancelled'].includes(job.status)) {
					return jsonError(c, 409, 'Only failed or cancelled jobs can be retried.', { status: job.status });
				}
				const body = await readJsonOrFormBody(c);
				if (job.namespace === 'workflow' && job.operation === 'launch_project' && job.selectedTarget === 'api') {
					const retried = await retryApiLaunchBootstrapFromRequest({
						c,
						store,
						runtime,
						job,
						access,
						body,
						resume: false,
						mockExternal: options.mockExternal === true,
					});
					return retried.response;
				}
				const retried = await store.retryJob(job.id, {
					status: 'pending',
					inputPatch: { resume: false },
					eventType: 'retry_queued',
				});
				if (job.namespace === 'workflow' && job.operation === 'launch_project') {
					const launch = await store.getHubLaunchByJobId(job.id);
					if (launch) {
						await store.updateHubLaunch(launch.id, {
							state: 'queued',
							currentPhase: 'launch_retry_queued',
							error: null,
						});
						await store.appendHubLaunchEvent(launch.id, {
							phase: 'launch_retry_queued',
							status: 'queued',
							title: 'Launch retry queued',
							summary: 'TreeSeed will rerun the launch job.',
							data: { jobId: job.id },
						});
					}
				}
				return c.json({
					ok: true,
					payload: decorateJob(runtime.resolved.config.baseUrl, retried),
				}, { status: 202 });
			});

			app.post('/v1/jobs/:jobId/resume', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const job = await store.findJobById(c.req.param('jobId'));
				if (!job) {
					return jsonError(c, 404, `Unknown job "${c.req.param('jobId')}".`);
				}
				const access = await requireProjectAccess(c, store, job.projectId, 'dispatch:execute:team');
				if (access.response) return access.response;
				if (!['failed', 'cancelled'].includes(job.status)) {
					return jsonError(c, 409, 'Only failed or cancelled jobs can be resumed.', { status: job.status });
				}
				const body = await readJsonOrFormBody(c);
				if (job.namespace === 'workflow' && job.operation === 'launch_project' && job.selectedTarget === 'api') {
					const resumed = await retryApiLaunchBootstrapFromRequest({
						c,
						store,
						runtime,
						job,
						access,
						body,
						resume: true,
						mockExternal: options.mockExternal === true,
					});
					return resumed.response;
				}
				const repositories = await store.listHubRepositories(job.projectId);
				const softwareRepository = repositories.find((repository) => repository.role === 'software') ?? null;
				const contentRepository = repositories.find((repository) => repository.role === 'content') ?? null;
				const existingLaunchIntent = job.input?.launchIntent && typeof job.input.launchIntent === 'object'
					? job.input.launchIntent
					: null;
				const resumedLaunchIntent = existingLaunchIntent
					? {
						...existingLaunchIntent,
						repository: {
							...(existingLaunchIntent.repository ?? {}),
							softwareRepository: softwareRepository
								? {
									owner: softwareRepository.owner,
									name: softwareRepository.name,
									url: softwareRepository.url,
									defaultBranch: softwareRepository.defaultBranch,
								}
								: existingLaunchIntent.repository?.softwareRepository ?? null,
							contentRepository: contentRepository
								? {
									owner: contentRepository.owner,
									name: contentRepository.name,
									url: contentRepository.url,
									defaultBranch: contentRepository.defaultBranch,
								}
								: existingLaunchIntent.repository?.contentRepository ?? null,
						},
					}
					: null;
				const resumed = await store.retryJob(job.id, {
					status: 'pending',
					inputPatch: {
						resume: true,
						...(resumedLaunchIntent ? { launchIntent: resumedLaunchIntent } : {}),
					},
					eventType: 'resume_queued',
				});
				if (job.namespace === 'workflow' && job.operation === 'launch_project') {
					const launch = await store.getHubLaunchByJobId(job.id);
					if (launch) {
						await store.updateHubLaunch(launch.id, {
							state: 'queued',
							currentPhase: 'launch_resume_queued',
							error: null,
						});
						await store.appendHubLaunchEvent(launch.id, {
							phase: 'launch_resume_queued',
							status: 'queued',
							title: 'Launch resume queued',
							summary: 'TreeSeed will resume from the last recorded launch phase when possible.',
							data: {
								jobId: job.id,
								lastSuccessfulPhase: launch.lastSuccessfulPhase ?? null,
							},
						});
					}
				}
				return c.json({
					ok: true,
					payload: decorateJob(runtime.resolved.config.baseUrl, resumed),
				}, { status: 202 });
			});

			app.post('/v1/jobs/:jobId/approve', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const job = await store.findJobById(c.req.param('jobId'));
				if (!job) {
					return jsonError(c, 404, `Unknown job "${c.req.param('jobId')}".`);
				}
				const access = await requireProjectAccess(c, store, job.projectId, 'projects:manage:team');
				if (access.response) return access.response;
				if (c.get('actorType') === 'service') {
					return jsonError(c, 403, 'Service principals cannot approve binding work.');
				}
				if (job.status !== 'waiting_for_approval') {
					return jsonError(c, 409, 'This job is not waiting for approval.', { status: job.status });
				}
				const body = await c.req.json().catch(() => ({}));
				const actionPath = typeof job.input?.actionPath === 'string' ? job.input.actionPath : null;
				if (!actionPath) {
					await store.appendJobEvent(job.id, 'approved', {
						approvedBy: access.principal.id,
						note: typeof body.note === 'string' ? body.note : null,
					});
					const approvedJob = await store.retryJob(job.id, {
						status: 'pending',
						inputPatch: {
							approvalReference: {
								approvedBy: access.principal.id,
								approvedAt: new Date().toISOString(),
								note: typeof body.note === 'string' ? body.note : null,
							},
						},
						eventType: 'approval_released',
					});
					const teamId = typeof job.input?.teamId === 'string' ? job.input.teamId : access.details.project.teamId;
					await store.deleteTeamInboxItemsByItemKey(teamId, job.id);
					return c.json({
						ok: true,
						payload: decorateJob(runtime.resolved.config.baseUrl, approvedJob),
					}, { status: 202 });
				}
				await store.appendJobEvent(job.id, 'approved', {
					approvedBy: access.principal.id,
					note: typeof body.note === 'string' ? body.note : null,
				});
				await store.recordJobProgress(job.id, {
					summary: 'Approval granted. Executing approved action.',
				});
				const delegated = await store.requestProjectRuntime(job.projectId, access.principal, actionPath, {
					method: 'POST',
					body: typeof job.input?.requestBody === 'object' && job.input.requestBody ? job.input.requestBody : {},
				});
				if (!delegated) {
					const failedJob = await store.failJob(job.id, {
						code: 'runtime_unavailable',
						message: 'Project runtime is not connected or unavailable for the approved action.',
					});
					return c.json({
						ok: false,
						payload: decorateJob(runtime.resolved.config.baseUrl, failedJob),
					}, { status: 409 });
				}
				const completed = await store.completeJob(job.id, {
					output: {
						approvedBy: access.principal.id,
						result: delegated,
					},
				});
				const teamId = typeof job.input?.teamId === 'string' ? job.input.teamId : access.details.project.teamId;
				await store.deleteTeamInboxItemsByItemKey(teamId, job.id);
				return c.json({
					ok: true,
					payload: {
						job: decorateJob(runtime.resolved.config.baseUrl, completed),
						result: delegated,
					},
				});
			});

			app.post('/v1/jobs/:jobId/reject', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const job = await store.findJobById(c.req.param('jobId'));
				if (!job) {
					return jsonError(c, 404, `Unknown job "${c.req.param('jobId')}".`);
				}
				const access = await requireProjectAccess(c, store, job.projectId, 'projects:manage:team');
				if (access.response) return access.response;
				if (c.get('actorType') === 'service') {
					return jsonError(c, 403, 'Service principals cannot decide approval requests.');
				}
				if (job.status !== 'waiting_for_approval') {
					return jsonError(c, 409, 'This job is not waiting for approval.', { status: job.status });
				}
				const body = await c.req.json().catch(() => ({}));
				const rejected = await store.failJob(job.id, {
					code: 'approval_rejected',
					message: typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'Approval rejected.',
				});
				const teamId = typeof job.input?.teamId === 'string' ? job.input.teamId : access.details.project.teamId;
				await store.deleteTeamInboxItemsByItemKey(teamId, job.id);
				return c.json({
					ok: true,
					payload: decorateJob(runtime.resolved.config.baseUrl, rejected),
				});
			});

			app.post('/v1/jobs/:jobId/provider-credential-sessions/:sessionId/consume', async (c) => {
				const job = await store.findJobById(c.req.param('jobId'));
				if (!job) {
					return jsonError(c, 404, `Unknown job "${c.req.param('jobId')}".`);
				}
				const runnerAccess = await requireProjectRunner(c, store, job.projectId);
				if (runnerAccess.response) return runnerAccess.response;
				const consumed = await store.consumeProviderCredentialSession(job.id, c.req.param('sessionId'));
				if (!consumed.ok) {
					return jsonError(c, consumed.error === 'expired' ? 410 : 404, consumed.error);
				}
				try {
					const sessionPayload = decryptCredentialSessionPayload(runtime, consumed.payload.encryptedPayload);
					return c.json({
						ok: true,
						payload: {
							id: consumed.payload.id,
							hostKind: consumed.payload.hostKind,
							hostId: consumed.payload.hostId,
							purpose: consumed.payload.purpose,
							provider: sessionPayload.provider ?? null,
							config: sessionPayload.config && typeof sessionPayload.config === 'object' ? sessionPayload.config : {},
						},
					});
				} catch (error) {
					return jsonError(c, 500, 'Unable to decrypt credential session payload.', {
						message: error instanceof Error ? error.message : String(error),
					});
				}
			});

			app.post('/v1/approval-requests/:approvalRequestId/decide', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const request = await store.getApprovalRequest(c.req.param('approvalRequestId'));
				if (!request) {
					return jsonError(c, 404, 'Unknown approval request.');
				}
				const access = await requireProjectAccess(c, store, request.projectId, 'projects:manage:team');
				if (access.response) return access.response;
				if (request.state !== 'pending') {
					return jsonError(c, 409, 'This approval request is not pending.', { state: request.state });
				}
				const body = await c.req.json().catch(() => ({}));
				const decided = await store.decideApprovalRequest(request.id, {
					state: body.state === 'rejected' ? 'rejected' : 'approved',
					decidedByType: c.get('actorType') === 'service' ? 'service' : 'user',
					decidedById: access.principal.id,
					decision: typeof body.decision === 'object' && body.decision ? body.decision : {
						optionId: typeof body.optionId === 'string' ? body.optionId : null,
						note: typeof body.note === 'string' ? body.note : null,
					},
				});
				await store.deleteTeamInboxItemsByItemKey(request.teamId, request.id);
				return c.json({ ok: true, payload: decided });
			});

			async function requireCommonsSteward(c) {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth;
				if (principalIsSeedAdmin(auth.principal)) return auth;
				const team = await store.ensureCommonsTreeSeedTeam();
				const access = await requireTeamAccess(c, store, team.id, 'teams:manage:team');
				return access.response ? access : auth;
			}

			function commonsErrorResponse(c, error) {
				const status = Number(error?.status ?? 400);
				return jsonError(c, Number.isInteger(status) && status >= 400 ? status : 400, error instanceof Error ? error.message : String(error));
			}

			app.get('/v1/commons/summary', async (c) => {
				return c.json({ ok: true, payload: await store.commonsSummary(c.get('principal') ?? null) });
			});

			app.get('/v1/commons/participants/me', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				try {
					return c.json({ ok: true, payload: await store.ensureCommonsParticipantForPrincipal(auth.principal) });
				} catch (error) {
					return commonsErrorResponse(c, error);
				}
			});

			app.get('/v1/commons/participants', async (c) => {
				const steward = await requireCommonsSteward(c);
				if (steward.response) return steward.response;
				return c.json({ ok: true, payload: await store.listCommonsParticipants({
					status: optionalTrimmedString(c.req.query('status')),
					limit: c.req.query('limit'),
				}) });
			});

			app.post('/v1/commons/participants/backfill', async (c) => {
				const steward = await requireCommonsSteward(c);
				if (steward.response) return steward.response;
				const users = await store.all(`SELECT * FROM users ORDER BY created_at ASC`);
				const participants = [];
				for (const user of users) {
					participants.push(await store.ensureCommonsParticipantForPrincipal({
						id: user.id,
						displayName: user.display_name,
						email: user.email,
						roles: [],
						permissions: [],
						metadata: parseJsonObject(user.metadata_json, {}),
					}, { metadata: { registrationSource: 'backfill' } }));
				}
				return c.json({ ok: true, payload: { participants, count: participants.length } });
			});

			app.get('/v1/commons/questions', async (c) => {
				return c.json({ ok: true, payload: await store.listCommonsQuestions({
					status: optionalTrimmedString(c.req.query('status')),
					limit: c.req.query('limit'),
				}) });
			});

			app.post('/v1/commons/questions', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const body = await c.req.json().catch(() => ({}));
				try {
					return c.json({ ok: true, payload: await store.createCommonsQuestion(auth.principal, {
						title: optionalTrimmedString(body.title),
						body: optionalTrimmedString(body.body),
						metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
					}) });
				} catch (error) {
					return commonsErrorResponse(c, error);
				}
			});

			app.get('/v1/commons/questions/:questionId', async (c) => {
				const question = await store.getCommonsQuestion(c.req.param('questionId'));
				return question ? c.json({ ok: true, payload: question }) : jsonError(c, 404, 'Unknown Commons question.');
			});

			app.post('/v1/commons/questions/:questionId/answer', async (c) => {
				const steward = await requireCommonsSteward(c);
				if (steward.response) return steward.response;
				const body = await c.req.json().catch(() => ({}));
				const question = await store.answerCommonsQuestion(c.req.param('questionId'), {
					answer: optionalTrimmedString(body.answer ?? body.message),
					actorType: 'user',
					actorId: steward.principal.id ?? null,
				});
				return question ? c.json({ ok: true, payload: question }) : jsonError(c, 404, 'Unknown Commons question.');
			});

			app.post('/v1/commons/questions/:questionId/convert-to-proposal', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const question = await store.getCommonsQuestion(c.req.param('questionId'));
				if (!question) return jsonError(c, 404, 'Unknown Commons question.');
				if (question.userId !== auth.principal.id && !principalIsSeedAdmin(auth.principal)) return jsonError(c, 403, 'Permission denied.');
				const body = await c.req.json().catch(() => ({}));
				try {
					const proposal = await store.createCommonsProposal(auth.principal, {
						status: 'submitted',
						title: optionalTrimmedString(body.title) ?? question.title,
						summary: optionalTrimmedString(body.summary) ?? question.body.slice(0, 240),
						body: optionalTrimmedString(body.body) ?? question.body,
						scope: optionalTrimmedString(body.scope, 'treeseed_commons'),
						decisionType: optionalTrimmedString(body.decisionType, 'advisory'),
						metadata: { convertedFromQuestionId: question.id },
					});
					await store.run(`UPDATE commons_questions SET status = 'converted_to_proposal', converted_proposal_id = ?, updated_at = ? WHERE id = ?`, [proposal.id, new Date().toISOString(), question.id]);
					await store.recordCommonsGovernanceEvent({
						eventType: 'question.converted_to_proposal',
						actorType: 'user',
						actorId: auth.principal.id,
						participantId: proposal.participantId,
						questionId: question.id,
						proposalId: proposal.id,
						priorState: question.status,
						nextState: 'converted_to_proposal',
					});
					return c.json({ ok: true, payload: proposal });
				} catch (error) {
					return commonsErrorResponse(c, error);
				}
			});

			app.get('/v1/commons/proposals', async (c) => {
				return c.json({ ok: true, payload: await store.listCommonsProposals({
					status: optionalTrimmedString(c.req.query('status')),
					scope: optionalTrimmedString(c.req.query('scope')),
					limit: c.req.query('limit'),
				}) });
			});

			app.post('/v1/commons/proposals', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const body = await c.req.json().catch(() => ({}));
				try {
					return c.json({ ok: true, payload: await store.createCommonsProposal(auth.principal, {
						title: optionalTrimmedString(body.title),
						summary: optionalTrimmedString(body.summary),
						body: optionalTrimmedString(body.body),
						scope: optionalTrimmedString(body.scope, 'treeseed_commons'),
						decisionType: optionalTrimmedString(body.decisionType, 'advisory'),
						metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
					}) });
				} catch (error) {
					return commonsErrorResponse(c, error);
				}
			});

			app.get('/v1/commons/proposals/:proposalId', async (c) => {
				const proposal = await store.getCommonsProposal(c.req.param('proposalId'));
				if (!proposal) return jsonError(c, 404, 'Unknown Commons proposal.');
				return c.json({ ok: true, payload: {
					...proposal,
					backings: await store.listCommonsProposalBackings(proposal.id),
					votes: await store.listCommonsProposalVotes(proposal.id),
					events: await store.listCommonsGovernanceEvents({ proposalId: proposal.id, limit: 50 }),
				} });
			});

			app.post('/v1/commons/proposals/:proposalId/submit', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const proposal = await store.getCommonsProposal(c.req.param('proposalId'));
				if (!proposal) return jsonError(c, 404, 'Unknown Commons proposal.');
				if (proposal.userId !== auth.principal.id && !principalIsSeedAdmin(auth.principal)) return jsonError(c, 403, 'Permission denied.');
				return c.json({ ok: true, payload: await store.submitCommonsProposal(proposal.id, { actorType: 'user', actorId: auth.principal.id }) });
			});

			app.post('/v1/commons/proposals/:proposalId/back', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const body = await c.req.json().catch(() => ({}));
				try {
					const proposal = await store.backCommonsProposal(auth.principal, c.req.param('proposalId'), { reason: optionalTrimmedString(body.reason) });
					return proposal ? c.json({ ok: true, payload: proposal }) : jsonError(c, 404, 'Unknown Commons proposal.');
				} catch (error) {
					return commonsErrorResponse(c, error);
				}
			});

			app.post('/v1/commons/proposals/:proposalId/vote', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const body = await c.req.json().catch(() => ({}));
				try {
					const proposal = await store.voteCommonsProposal(auth.principal, c.req.param('proposalId'), {
						vote: optionalTrimmedString(body.vote),
						reason: optionalTrimmedString(body.reason),
					});
					return proposal ? c.json({ ok: true, payload: proposal }) : jsonError(c, 404, 'Unknown Commons proposal.');
				} catch (error) {
					return commonsErrorResponse(c, error);
				}
			});

			async function stewardTransitionCommonsProposal(c, nextState) {
				const steward = await requireCommonsSteward(c);
				if (steward.response) return steward.response;
				const body = await c.req.json().catch(() => ({}));
				const proposal = await store.transitionCommonsProposal(c.req.param('proposalId'), nextState, {
					actorType: 'user',
					actorId: steward.principal.id ?? null,
					reason: optionalTrimmedString(body.reason),
					evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
					votingEndsAt: optionalTrimmedString(body.votingEndsAt),
				});
				return proposal ? c.json({ ok: true, payload: proposal }) : jsonError(c, 404, 'Unknown Commons proposal.');
			}

			app.post('/v1/commons/proposals/:proposalId/review', async (c) => stewardTransitionCommonsProposal(c, 'under_review'));
			app.post('/v1/commons/proposals/:proposalId/start-voting', async (c) => stewardTransitionCommonsProposal(c, 'voting'));
			app.post('/v1/commons/proposals/:proposalId/archive', async (c) => stewardTransitionCommonsProposal(c, 'archived'));

			app.post('/v1/commons/proposals/:proposalId/evaluate', async (c) => {
				const steward = await requireCommonsSteward(c);
				if (steward.response) return steward.response;
				const proposal = await store.getCommonsProposal(c.req.param('proposalId'));
				if (!proposal) return jsonError(c, 404, 'Unknown Commons proposal.');
				const target = proposal.backingCount >= 3 ? 'qualified' : proposal.status;
				return c.json({ ok: true, payload: target === proposal.status ? proposal : await store.transitionCommonsProposal(proposal.id, target, {
					actorType: 'user',
					actorId: steward.principal.id ?? null,
					reason: 'Steward evaluated proposal backing threshold.',
				}) });
			});

			app.post('/v1/commons/proposals/:proposalId/steward-decision', async (c) => {
				const steward = await requireCommonsSteward(c);
				if (steward.response) return steward.response;
				const body = await c.req.json().catch(() => ({}));
				const result = await store.stewardDecisionForCommonsProposal(c.req.param('proposalId'), {
					status: optionalTrimmedString(body.status),
					reason: optionalTrimmedString(body.reason),
					evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
					capacityBudget: optionalTrimmedString(body.capacityBudget),
					scheduledFor: optionalTrimmedString(body.scheduledFor),
					actorType: 'user',
					actorId: steward.principal.id ?? null,
				});
				return result ? c.json({ ok: true, payload: result }) : jsonError(c, 404, 'Unknown Commons proposal.');
			});

			app.get('/v1/commons/proposals/:proposalId/events', async (c) => {
				const proposal = await store.getCommonsProposal(c.req.param('proposalId'));
				if (!proposal) return jsonError(c, 404, 'Unknown Commons proposal.');
				return c.json({ ok: true, payload: await store.listCommonsGovernanceEvents({ proposalId: proposal.id, limit: c.req.query('limit') }) });
			});

			app.get('/v1/commons/decisions', async (c) => {
				return c.json({ ok: true, payload: await store.listCommonsDecisions({ limit: c.req.query('limit') }) });
			});

			app.get('/v1/commons/events', async (c) => {
				return c.json({ ok: true, payload: await store.listCommonsGovernanceEvents({ limit: c.req.query('limit') }) });
			});

			app.get('/v1/commons/delegations', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				return c.json({ ok: true, payload: await store.listCommonsDelegations(auth.principal) });
			});

			app.post('/v1/commons/delegations', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const body = await c.req.json().catch(() => ({}));
				try {
					return c.json({ ok: true, payload: await store.createCommonsDelegation(auth.principal, body) });
				} catch (error) {
					return commonsErrorResponse(c, error);
				}
			});

			app.post('/v1/commons/delegations/:delegationId/revoke', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const body = await c.req.json().catch(() => ({}));
				try {
					const delegation = await store.revokeCommonsDelegation(auth.principal, c.req.param('delegationId'), { reason: optionalTrimmedString(body.reason) });
					return delegation ? c.json({ ok: true, payload: delegation }) : jsonError(c, 404, 'Unknown Commons delegation.');
				} catch (error) {
					return commonsErrorResponse(c, error);
				}
			});

			app.get('/v1/jobs/:jobId/events', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const job = await store.findJobById(c.req.param('jobId'));
				if (!job) {
					return jsonError(c, 404, `Unknown job "${c.req.param('jobId')}".`);
				}
				const access = await requireProjectAccess(c, store, job.projectId, 'dispatch:execute:team');
				if (access.response) return access.response;
				return c.json({
					ok: true,
					payload: await store.listJobEvents(job.id),
				});
			});

			app.post('/v1/projects/:projectId/runner/jobs/pull', async (c) => {
				const token = bearerTokenFromRequest(c.req.raw);
				if (!token) {
					return jsonError(c, 401, 'Authentication required.');
				}
				const runner = await store.authenticateRunner(c.req.param('projectId'), token);
				if (!runner) {
					return jsonError(c, 401, 'Invalid project runner token.');
				}
				const body = await c.req.json().catch(() => ({}));
				const jobs = await store.pullJobsForRunner(c.req.param('projectId'), {
					limit: body.limit,
					runnerId: typeof body.runnerId === 'string' ? body.runnerId : null,
				});
				return c.json({
					ok: true,
					payload: jobs.map((job) => decorateJob(runtime.resolved.config.baseUrl, job)),
				});
			});

			app.put('/v1/projects/:projectId/runner/environments/:environment', async (c) => {
				const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
				if (runnerAccess.response) return runnerAccess.response;
				const body = await c.req.json().catch(() => ({}));
				return c.json({
					ok: true,
					payload: await store.upsertProjectEnvironment(c.req.param('projectId'), {
						environment: c.req.param('environment'),
						deploymentProfile: typeof body.deploymentProfile === 'string' ? body.deploymentProfile : 'self_hosted_project',
						baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : null,
						cloudflareAccountId: typeof body.cloudflareAccountId === 'string' ? body.cloudflareAccountId : null,
						pagesProjectName: typeof body.pagesProjectName === 'string' ? body.pagesProjectName : null,
						workerName: typeof body.workerName === 'string' ? body.workerName : null,
						r2BucketName: typeof body.r2BucketName === 'string' ? body.r2BucketName : null,
						d1DatabaseName: typeof body.d1DatabaseName === 'string' ? body.d1DatabaseName : null,
						railwayProjectName: typeof body.railwayProjectName === 'string' ? body.railwayProjectName : null,
						metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
					}),
				});
			});

			app.post('/v1/projects/:projectId/runner/resources', async (c) => {
				const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
				if (runnerAccess.response) return runnerAccess.response;
				const body = await c.req.json().catch(() => ({}));
				if (!body.environment || !body.provider || !body.resourceKind || !body.logicalName) {
					return jsonError(c, 400, 'environment, provider, resourceKind, and logicalName are required.');
				}
				return c.json({
					ok: true,
					payload: await store.upsertProjectInfrastructureResource(c.req.param('projectId'), {
						environment: String(body.environment),
						provider: String(body.provider),
						resourceKind: String(body.resourceKind),
						logicalName: String(body.logicalName),
						locator: typeof body.locator === 'string' ? body.locator : null,
						metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
					}),
				});
			});

			app.post('/v1/projects/:projectId/runner/deployments', async (c) => {
				const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
				if (runnerAccess.response) return runnerAccess.response;
				const body = await c.req.json().catch(() => ({}));
				if (!body.environment || !body.deploymentKind) {
					return jsonError(c, 400, 'environment and deploymentKind are required.');
				}
				return c.json({
					ok: true,
					payload: await store.createProjectDeployment(c.req.param('projectId'), {
						environment: String(body.environment),
						deploymentKind: String(body.deploymentKind),
						status: typeof body.status === 'string' ? body.status : 'pending',
						sourceRef: typeof body.sourceRef === 'string' ? body.sourceRef : null,
						releaseTag: typeof body.releaseTag === 'string' ? body.releaseTag : null,
						commitSha: typeof body.commitSha === 'string' ? body.commitSha : null,
						triggeredByType: typeof body.triggeredByType === 'string' ? body.triggeredByType : 'project_runner',
						triggeredById: typeof body.triggeredById === 'string' ? body.triggeredById : runnerAccess.runner.tokenDigest,
						metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
						startedAt: typeof body.startedAt === 'string' ? body.startedAt : null,
						finishedAt: typeof body.finishedAt === 'string' ? body.finishedAt : null,
					}),
				});
			});

			app.get('/v1/projects/:projectId/runner/deployments', async (c) => {
				const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
				if (runnerAccess.response) return runnerAccess.response;
				const environment = typeof c.req.query('environment') === 'string' ? c.req.query('environment') : null;
				return c.json({
					ok: true,
					payload: await store.listProjectDeployments(c.req.param('projectId'), environment),
				});
			});

			app.get('/v1/projects/:projectId/runner/health', async (c) => {
				const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
				if (runnerAccess.response) return runnerAccess.response;
				const environment = typeof c.req.query('environment') === 'string' ? c.req.query('environment') : 'staging';
				const [resources, deployments, pools, workdays, runners, runnerScaleDecisions] = await Promise.all([
					store.listProjectInfrastructureResources(c.req.param('projectId'), environment),
					store.listProjectDeployments(c.req.param('projectId'), environment),
					store.listAgentPools(c.req.param('projectId'), environment),
					store.listProjectWorkdaySummaries(c.req.param('projectId'), environment),
					store.listWorkerRunners(c.req.param('projectId'), environment),
					store.listRunnerScaleDecisions(c.req.param('projectId'), environment),
				]);
				const poolDetails = await Promise.all(pools.map(async (pool) => ({
					pool,
					latestRegistration: (await store.listAgentPoolRegistrations(pool.id))[0] ?? null,
					latestScaleDecision: (await store.listAgentPoolScaleDecisions(pool.id))[0] ?? null,
				})));
				return c.json({
					ok: true,
					payload: {
						environment,
						resources,
						deployments: deployments.slice(0, 10),
						pools: poolDetails,
						workdays: workdays.slice(0, 5),
						runners,
						runnerScaleDecisions: runnerScaleDecisions.slice(0, 10),
					},
				});
			});

			app.post('/v1/projects/:projectId/runner/workdays/start', async (c) => {
				const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
				if (runnerAccess.response) return runnerAccess.response;
				const body = await c.req.json().catch(() => ({}));
				return c.json({
					ok: true,
					payload: await store.startRuntimeWorkDay(c.req.param('projectId'), {
						id: typeof body.id === 'string' ? body.id : undefined,
						state: typeof body.state === 'string' ? body.state : 'active',
						capacityBudget: Number.isFinite(Number(body.capacityBudget)) ? Number(body.capacityBudget) : 0,
						graphVersion: typeof body.graphVersion === 'string' ? body.graphVersion : null,
						summary: body.summary && typeof body.summary === 'object' ? body.summary : {},
					}),
				}, { status: 201 });
			});

				app.get('/v1/projects/:projectId/runner/workdays/runtime', async (c) => {
					const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
					if (runnerAccess.response) return runnerAccess.response;
					return c.json({
					ok: true,
					payload: await store.listRuntimeWorkDays(c.req.param('projectId'), {
						state: typeof c.req.query('state') === 'string' ? c.req.query('state') : null,
						limit: Number.isFinite(Number(c.req.query('limit'))) ? Number(c.req.query('limit')) : 10,
					}),
					});
				});

				app.get('/v1/projects/:projectId/runner/tasks', async (c) => {
					const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
					if (runnerAccess.response) return runnerAccess.response;
					return c.json({
						ok: true,
						payload: await store.listRuntimeTasks(c.req.param('projectId'), {
							workDayId: typeof c.req.query('workDayId') === 'string' ? c.req.query('workDayId') : null,
							limit: Number.isFinite(Number(c.req.query('limit'))) ? Number(c.req.query('limit')) : 100,
						}),
					});
				});

				app.post('/v1/projects/:projectId/runner/tasks', async (c) => {
					const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
					if (runnerAccess.response) return runnerAccess.response;
					const body = await c.req.json().catch(() => ({}));
					if (!body.workDayId || !body.agentId || !body.type || !body.idempotencyKey) {
						return jsonError(c, 400, 'workDayId, agentId, type, and idempotencyKey are required.');
					}
					const payload = await store.createRuntimeTask(c.req.param('projectId'), {
						id: typeof body.id === 'string' ? body.id : undefined,
						workDayId: String(body.workDayId),
						agentId: String(body.agentId),
						type: String(body.type),
						idempotencyKey: String(body.idempotencyKey),
						payload: body.payload && typeof body.payload === 'object' ? body.payload : {},
						actor: typeof body.actor === 'string' ? body.actor : null,
					});
					return payload ? c.json({ ok: true, payload }, { status: 201 }) : jsonError(c, 404, 'Unknown workday.');
				});

				app.post('/v1/projects/:projectId/runner/tasks/:taskId/claim', async (c) => {
					const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
					if (runnerAccess.response) return runnerAccess.response;
					const body = await c.req.json().catch(() => ({}));
					if (!body.workerId) return jsonError(c, 400, 'workerId is required.');
					const payload = await store.claimRuntimeTask(c.req.param('projectId'), c.req.param('taskId'), {
						workerId: String(body.workerId),
						leaseSeconds: Number.isFinite(Number(body.leaseSeconds)) ? Number(body.leaseSeconds) : 300,
						actor: typeof body.actor === 'string' ? body.actor : null,
					});
					return payload ? c.json({ ok: true, payload }) : jsonError(c, 404, 'Unknown task.');
				});

				app.post('/v1/projects/:projectId/runner/tasks/:taskId/events', async (c) => {
					const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
					if (runnerAccess.response) return runnerAccess.response;
					const body = await c.req.json().catch(() => ({}));
					if (!body.kind) return jsonError(c, 400, 'kind is required.');
					const payload = await store.recordRuntimeTaskEvent(c.req.param('projectId'), c.req.param('taskId'), {
						kind: String(body.kind),
						data: body.data && typeof body.data === 'object' ? body.data : {},
						state: typeof body.state === 'string' ? body.state : null,
						actor: typeof body.actor === 'string' ? body.actor : null,
					});
					return payload ? c.json({ ok: true, payload }) : jsonError(c, 404, 'Unknown task.');
				});

				app.post('/v1/projects/:projectId/runner/tasks/:taskId/complete', async (c) => {
					const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
					if (runnerAccess.response) return runnerAccess.response;
					const body = await c.req.json().catch(() => ({}));
					const payload = await store.completeRuntimeTask(c.req.param('projectId'), c.req.param('taskId'), {
						output: body.output && typeof body.output === 'object' ? body.output : {},
						outputRef: typeof body.outputRef === 'string' ? body.outputRef : null,
						summary: body.summary && typeof body.summary === 'object' ? body.summary : null,
						actor: typeof body.actor === 'string' ? body.actor : null,
					});
					return payload ? c.json({ ok: true, payload }) : jsonError(c, 404, 'Unknown task.');
				});

				app.post('/v1/projects/:projectId/runner/artifacts', async (c) => {
					const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
					if (runnerAccess.response) return runnerAccess.response;
					const body = await c.req.json().catch(() => ({}));
					if (!body.objectKey) return jsonError(c, 400, 'objectKey is required.');
					const payload = await store.uploadRuntimeArtifact(c.req.param('projectId'), {
						objectKey: String(body.objectKey),
						content: typeof body.content === 'string' || (body.content && typeof body.content === 'object') ? body.content : null,
						contentBase64: typeof body.contentBase64 === 'string' ? body.contentBase64 : null,
						contentType: typeof body.contentType === 'string' ? body.contentType : null,
					});
					return payload ? c.json({ ok: true, payload }, { status: 201 }) : jsonError(c, 400, 'Invalid artifact upload.');
				});

				app.get('/v1/projects/:projectId/runner/tasks/:taskId/outputs', async (c) => {
					const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
					if (runnerAccess.response) return runnerAccess.response;
					const payload = await store.listRuntimeTaskOutputs(c.req.param('projectId'), c.req.param('taskId'));
					return payload ? c.json({ ok: true, payload }) : jsonError(c, 404, 'Unknown task.');
				});

				app.post('/v1/projects/:projectId/runner/workdays/:workDayId/close', async (c) => {
					const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
					if (runnerAccess.response) return runnerAccess.response;
				const body = await c.req.json().catch(() => ({}));
				const payload = await store.closeRuntimeWorkDay(c.req.param('projectId'), c.req.param('workDayId'), {
					state: typeof body.state === 'string' ? body.state : 'completed',
					summary: body.summary && typeof body.summary === 'object' ? body.summary : {},
				});
				return payload ? c.json({ ok: true, payload }) : jsonError(c, 404, 'Unknown workday.');
			});

			app.post('/v1/projects/:projectId/runner/manager-leases/claim', async (c) => {
				const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
				if (runnerAccess.response) return runnerAccess.response;
				const body = await c.req.json().catch(() => ({}));
				if (!body.environment || !body.managerId) return jsonError(c, 400, 'environment and managerId are required.');
				return c.json({
					ok: true,
					payload: await store.claimWorkdayManagerLease(c.req.param('projectId'), {
						id: typeof body.id === 'string' ? body.id : undefined,
						environment: String(body.environment),
						workDayId: typeof body.workDayId === 'string' ? body.workDayId : null,
						managerId: String(body.managerId),
						ttlSeconds: Number.isFinite(Number(body.ttlSeconds)) ? Number(body.ttlSeconds) : 60,
						staleAfterSeconds: Number.isFinite(Number(body.staleAfterSeconds)) ? Number(body.staleAfterSeconds) : undefined,
						now: typeof body.now === 'string' ? body.now : undefined,
						metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
					}),
				});
			});

			app.get('/v1/projects/:projectId/runner/manager-leases', async (c) => {
				const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
				if (runnerAccess.response) return runnerAccess.response;
				const environment = typeof c.req.query('environment') === 'string' ? c.req.query('environment') : 'staging';
				return c.json({
					ok: true,
					payload: await store.listWorkdayManagerLeases(c.req.param('projectId'), environment),
				});
			});

			app.post('/v1/projects/:projectId/runner/manager-leases/:leaseId/release', async (c) => {
				const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
				if (runnerAccess.response) return runnerAccess.response;
				const body = await c.req.json().catch(() => ({}));
				if (!body.managerId) return jsonError(c, 400, 'managerId is required.');
				return c.json({
					ok: true,
					payload: await store.releaseWorkdayManagerLease(c.req.param('projectId'), {
						id: c.req.param('leaseId'),
						managerId: String(body.managerId),
					}),
				});
			});

			app.post('/v1/projects/:projectId/runner/worker-runners', async (c) => {
				const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
				if (runnerAccess.response) return runnerAccess.response;
				const body = await c.req.json().catch(() => ({}));
				if (!body.environment || !body.runnerId || !body.runnerServiceName || !body.volumeIdentity) {
					return jsonError(c, 400, 'environment, runnerId, runnerServiceName, and volumeIdentity are required.');
				}
				return c.json({
					ok: true,
					payload: await store.recordWorkerRunner(c.req.param('projectId'), {
						id: typeof body.id === 'string' ? body.id : undefined,
						environment: String(body.environment),
						runnerId: String(body.runnerId),
						runnerServiceName: String(body.runnerServiceName),
						volumeIdentity: String(body.volumeIdentity),
						state: typeof body.state === 'string' ? body.state : 'active',
						maxLocalWorkers: Number.isFinite(Number(body.maxLocalWorkers)) ? Number(body.maxLocalWorkers) : 4,
						activeLocalWorkers: Number.isFinite(Number(body.activeLocalWorkers)) ? Number(body.activeLocalWorkers) : 0,
						claimedRepositoryIds: Array.isArray(body.claimedRepositoryIds) ? body.claimedRepositoryIds.map(String) : [],
						metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
					}),
				});
			});

			app.get('/v1/projects/:projectId/runner/worker-runners', async (c) => {
				const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
				if (runnerAccess.response) return runnerAccess.response;
				const environment = typeof c.req.query('environment') === 'string' ? c.req.query('environment') : 'staging';
				return c.json({
					ok: true,
					payload: await store.listWorkerRunners(c.req.param('projectId'), environment),
				});
			});

			app.post('/v1/projects/:projectId/runner/repository-claims', async (c) => {
				const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
				if (runnerAccess.response) return runnerAccess.response;
				const body = await c.req.json().catch(() => ({}));
				if (!body.repositoryId || !body.runnerId || !body.runnerServiceName || !body.volumeIdentity) {
					return jsonError(c, 400, 'repositoryId, runnerId, runnerServiceName, and volumeIdentity are required.');
				}
				return c.json({
					ok: true,
					payload: await store.recordRepositoryClaim(c.req.param('projectId'), {
						id: typeof body.id === 'string' ? body.id : undefined,
						repositoryId: String(body.repositoryId),
						runnerId: String(body.runnerId),
						runnerServiceName: String(body.runnerServiceName),
						volumeIdentity: String(body.volumeIdentity),
						lastSeenCommit: typeof body.lastSeenCommit === 'string' ? body.lastSeenCommit : null,
						lastTaskAt: typeof body.lastTaskAt === 'string' ? body.lastTaskAt : null,
						claimState: typeof body.claimState === 'string' ? body.claimState : 'active',
						metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
					}),
				});
			});

			app.get('/v1/projects/:projectId/runner/repository-claims', async (c) => {
				const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
				if (runnerAccess.response) return runnerAccess.response;
				const repositoryId = typeof c.req.query('repositoryId') === 'string' ? c.req.query('repositoryId') : null;
				return c.json({
					ok: true,
					payload: await store.listRepositoryClaims(c.req.param('projectId'), repositoryId),
				});
			});

			app.post('/v1/projects/:projectId/runner/runner-scale-decisions', async (c) => {
				const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
				if (runnerAccess.response) return runnerAccess.response;
				const body = await c.req.json().catch(() => ({}));
				if (!body.environment || !body.action || !body.reason) {
					return jsonError(c, 400, 'environment, action, and reason are required.');
				}
				return c.json({
					ok: true,
					payload: await store.recordRunnerScaleDecision(c.req.param('projectId'), {
						environment: String(body.environment),
						workDayId: typeof body.workDayId === 'string' ? body.workDayId : null,
						runnerId: typeof body.runnerId === 'string' ? body.runnerId : null,
						runnerServiceName: typeof body.runnerServiceName === 'string' ? body.runnerServiceName : null,
						action: String(body.action),
						reason: String(body.reason),
						metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
					}),
				});
			});

			app.post('/v1/projects/:projectId/runner/agent-pools/:poolName/register', async (c) => {
				const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
				if (runnerAccess.response) return runnerAccess.response;
				const project = await store.getProject(c.req.param('projectId'));
				if (!project) {
					return jsonError(c, 404, `Unknown project "${c.req.param('projectId')}".`);
				}
				const body = await c.req.json().catch(() => ({}));
				const environment = typeof body.environment === 'string' ? body.environment : 'local';
				const pool = await store.upsertAgentPool(c.req.param('projectId'), {
					teamId: typeof body.teamId === 'string' ? body.teamId : project.teamId,
					environment,
					name: c.req.param('poolName'),
					registrationIdentity: typeof body.registrationIdentity === 'string'
						? body.registrationIdentity
						: typeof body.managerId === 'string'
							? body.managerId
							: typeof body.runnerId === 'string'
								? body.runnerId
								: c.req.param('poolName'),
					serviceBaseUrl: typeof body.serviceBaseUrl === 'string' ? body.serviceBaseUrl : null,
					status: typeof body.status === 'string' ? body.status : 'active',
					autoscale: typeof body.autoscale === 'object' && body.autoscale
						? {
							minWorkers: Number(body.autoscale.minWorkers ?? 0),
							maxWorkers: Number(body.autoscale.maxWorkers ?? 1),
							targetQueueDepth: Number(body.autoscale.targetQueueDepth ?? 1),
							cooldownSeconds: Number(body.autoscale.cooldownSeconds ?? 60),
						}
						: undefined,
					metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
				});
				const registration = await store.recordAgentPoolRegistration(c.req.param('projectId'), {
					poolId: pool.id,
					runnerId: typeof body.runnerId === 'string' ? body.runnerId : null,
					managerId: typeof body.managerId === 'string' ? body.managerId : null,
					serviceName: typeof body.serviceName === 'string' ? body.serviceName : 'manager',
					heartbeatAt: typeof body.heartbeatAt === 'string' ? body.heartbeatAt : null,
					desiredWorkers: Number.isFinite(Number(body.desiredWorkers)) ? Number(body.desiredWorkers) : null,
					observedQueueDepth: Number.isFinite(Number(body.observedQueueDepth)) ? Number(body.observedQueueDepth) : null,
					observedActiveLeases: Number.isFinite(Number(body.observedActiveLeases)) ? Number(body.observedActiveLeases) : null,
					metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
				});
				return c.json({
					ok: true,
					payload: {
						pool,
						registration,
					},
				});
			});

			app.post('/v1/projects/:projectId/runner/agent-pools/:poolName/scale-decisions', async (c) => {
				const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
				if (runnerAccess.response) return runnerAccess.response;
				const poolName = c.req.param('poolName');
				const pools = await store.listAgentPools(c.req.param('projectId'));
				const pool = pools.find((entry) => entry.name === poolName);
				if (!pool) {
					return jsonError(c, 404, `Unknown agent pool "${poolName}".`);
				}
				const body = await c.req.json().catch(() => ({}));
				if (!Number.isFinite(Number(body.desiredWorkers))) {
					return jsonError(c, 400, 'desiredWorkers is required.');
				}
				return c.json({
					ok: true,
					payload: await store.recordAgentPoolScaleDecision(c.req.param('projectId'), {
						poolId: pool.id,
						environment: typeof body.environment === 'string' ? body.environment : pool.environment,
						workDayId: typeof body.workDayId === 'string' ? body.workDayId : null,
						desiredWorkers: Number(body.desiredWorkers),
						observedQueueDepth: Number.isFinite(Number(body.observedQueueDepth)) ? Number(body.observedQueueDepth) : 0,
						observedActiveLeases: Number.isFinite(Number(body.observedActiveLeases)) ? Number(body.observedActiveLeases) : 0,
						reason: typeof body.reason === 'string' ? body.reason : 'reconcile',
						metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
					}),
				});
			});

			app.get('/v1/projects/:projectId/capacity-plan', async (c) => {
				const token = bearerTokenFromRequest(c.req.raw);
				const runner = token ? await store.authenticateRunner(c.req.param('projectId'), token) : null;
				if (!runner) {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
					if (access.response) return access.response;
				}
				const environment = typeof c.req.query('environment') === 'string' ? c.req.query('environment') : 'staging';
				const payload = await store.getProjectCapacityPlan(c.req.param('projectId'), environment);
				return payload ? c.json({ ok: true, payload }) : jsonError(c, 404, 'Unknown project.');
			});

			app.get('/v1/projects/:projectId/agent-classes', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({ ok: true, payload: await store.listProjectAgentClasses(c.req.param('projectId')) });
			});

			app.post('/v1/projects/:projectId/agent-classes', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const agentClass = await store.upsertProjectAgentClass(c.req.param('projectId'), body);
				return agentClass ? c.json({ ok: true, payload: agentClass }, { status: 201 }) : jsonError(c, 404, 'Unknown project.');
			});

			app.get('/v1/projects/:projectId/agent-classes/:classId', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				const agentClass = await store.getProjectAgentClass(c.req.param('projectId'), c.req.param('classId'));
				return agentClass ? c.json({ ok: true, payload: agentClass }) : jsonError(c, 404, 'Unknown project agent class.');
			});

			app.patch('/v1/projects/:projectId/agent-classes/:classId', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const existing = await store.getProjectAgentClass(c.req.param('projectId'), c.req.param('classId'));
				if (!existing) return jsonError(c, 404, 'Unknown project agent class.');
				const body = await c.req.json().catch(() => ({}));
				const agentClass = await store.upsertProjectAgentClass(c.req.param('projectId'), {
					...body,
					id: c.req.param('classId'),
				});
				return agentClass ? c.json({ ok: true, payload: agentClass }) : jsonError(c, 404, 'Unknown project agent class.');
			});

			app.get('/v1/projects/:projectId/agent-mode-runs', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({
					ok: true,
					payload: await store.listAgentModeRuns(c.req.param('projectId'), {
						mode: typeof c.req.query('mode') === 'string' ? c.req.query('mode') : null,
						assignmentId: typeof c.req.query('assignmentId') === 'string' ? c.req.query('assignmentId') : null,
					}),
				});
			});

			app.get('/v1/projects/:projectId/assignments/:assignmentId/timeline', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				const projectId = c.req.param('projectId');
				const assignmentId = c.req.param('assignmentId');
				const assignment = await store.getProviderAssignment(access.details.project.teamId, assignmentId);
				if (!assignment || assignment.projectId !== projectId) return jsonError(c, 404, 'Unknown assignment.');
				const modeRuns = await store.listAgentModeRuns(projectId, { assignmentId });
				const items = [
					{
						type: 'assignment_created',
						id: `${assignment.id}:created`,
						assignmentId: assignment.id,
						status: assignment.status,
						createdAt: assignment.createdAt ?? assignment.created_at ?? null,
						payload: {
							assignment,
						},
					},
					...modeRuns.map((run, index) => ({
						type: run.outputs?.status === 'message_recorded'
							? 'assistant_message'
							: run.outputs?.status === 'tool_call'
								? 'tool_call'
								: run.outputs?.status === 'tool_result'
									? 'tool_result'
									: run.status === 'succeeded'
										? 'completed'
										: run.status === 'failed'
											? 'failed'
											: 'checkpoint',
						id: run.id,
						assignmentId,
						modeRunId: run.id,
						index,
						status: run.status,
						createdAt: run.startedAt ?? run.completedAt ?? run.failedAt ?? run.createdAt ?? null,
						payload: run,
					})),
				].sort((left, right) => String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? '')) || String(left.id).localeCompare(String(right.id)));
				return c.json({
					ok: true,
					payload: {
						assignment,
						items,
					},
				});
			});

			app.get('/v1/projects/:projectId/agent-fallback-outputs', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({
					ok: true,
					payload: await store.listAgentFallbackOutputs(c.req.param('projectId'), {
						mode: typeof c.req.query('mode') === 'string' ? c.req.query('mode') : null,
						status: typeof c.req.query('status') === 'string' ? c.req.query('status') : null,
						assignmentId: typeof c.req.query('assignmentId') === 'string' ? c.req.query('assignmentId') : null,
					}),
				});
			});

			app.get('/v1/projects/:projectId/treedx-proxy-audit', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({
					ok: true,
					payload: await store.listTreeDxProxyAudit(c.req.param('projectId'), {
						assignmentId: typeof c.req.query('assignmentId') === 'string' ? c.req.query('assignmentId') : null,
						actorType: typeof c.req.query('actorType') === 'string' ? c.req.query('actorType') : null,
					}),
				});
			});

			app.post('/v1/projects/:projectId/capacity/reservations', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const project = access.details?.project ?? await store.getProject(c.req.param('projectId'));
				if (!project) return jsonError(c, 404, 'Unknown project.');
				const body = await c.req.json().catch(() => ({}));
				if (!body.capacityProviderId || !body.laneId || !Number.isFinite(Number(body.reservedCredits))) {
					return jsonError(c, 400, 'capacityProviderId, laneId, and reservedCredits are required.');
				}
				return c.json({
					ok: true,
					payload: await store.createCapacityReservation({
						...body,
						teamId: typeof body.teamId === 'string' ? body.teamId : project.teamId,
						projectId: project.id,
					}),
				}, { status: 201 });
			});

			app.get('/v1/projects/:projectId/capacity-runtime-diagnostics', async (c) => {
				const requestedTeam = typeof c.req.query('teamId') === 'string' && c.req.query('teamId')
					? c.req.query('teamId')
					: null;
				const team = requestedTeam
					? await store.getTeam(requestedTeam).catch(() => null)
						?? await store.getTeamBySlug(requestedTeam).catch(() => null)
					: null;
				const requestedProject = c.req.param('projectId');
				let projectDetails = await store.getProjectDetails(requestedProject);
				if (!projectDetails && team) {
					const projectBySlug = await store.getProjectByTeamAndSlug(team.id, requestedProject).catch(() => null);
					projectDetails = projectBySlug ? await store.getProjectDetails(projectBySlug.id) : null;
				}
				if (!projectDetails) return jsonError(c, 404, 'Unknown project.');
				const teamId = team?.id ?? projectDetails.project.teamId;
				const token = bearerTokenFromRequest(c.req.raw);
				let providerReadPrincipal = null;
				if (token && typeof store.authenticateCapacityProviderApiKey === 'function') {
					const auth = await store.authenticateCapacityProviderApiKey(token, []).catch(() => ({ ok: false }));
					if (auth.ok && auth.principal?.teamId === projectDetails.project.teamId) {
						providerReadPrincipal = auth.principal;
					}
				}
				if (!providerReadPrincipal) {
					const access = await requireProjectAccess(c, store, projectDetails.project.id, 'projects:read:team');
					if (access.response) return access.response;
				}
				if (teamId !== projectDetails.project.teamId) return jsonError(c, 404, 'Unknown project or team.');
				const payload = teamId
					? await store.getProjectCapacityRuntimeDiagnostics(projectDetails.project.id, teamId)
					: null;
				return payload ? c.json({ ok: true, payload }) : jsonError(c, 404, 'Unknown project or team.');
			});

			app.get('/v1/decisions/:decisionId/planning-status', async (c) => {
				const status = await store.getDecisionPlanningStatus(c.req.param('decisionId'));
				if (!status) return jsonError(c, 404, 'Unknown decision planning status.');
				const access = await requireProjectAccess(c, store, status.projectId, 'projects:read:team');
				if (access.response) return access.response;
				return c.json({ ok: true, payload: status });
			});

			app.post('/v1/decisions/:decisionId/planning-input-requests', async (c) => {
				const body = await c.req.json().catch(() => ({}));
				const projectId = typeof body.projectId === 'string' ? body.projectId : null;
				if (!projectId) return jsonError(c, 400, 'projectId is required.');
				const access = await requireProjectAccess(c, store, projectId, 'projects:manage:team');
				if (access.response) return access.response;
				const request = await store.createPlanningInputRequest(c.req.param('decisionId'), body);
				return request ? c.json({ ok: true, payload: request }, { status: 201 }) : jsonError(c, 404, 'Unknown project.');
			});

			app.get('/v1/decisions/:decisionId/execution-inputs', async (c) => {
				const status = await store.getDecisionPlanningStatus(c.req.param('decisionId'));
				if (!status) return jsonError(c, 404, 'Unknown decision planning status.');
				const access = await requireProjectAccess(c, store, status.projectId, 'projects:read:team');
				if (access.response) return access.response;
				return c.json({
					ok: true,
					payload: await store.listDecisionExecutionInputs(c.req.param('decisionId'), {
						status: typeof c.req.query('status') === 'string' ? c.req.query('status') : null,
					}),
				});
			});

			app.post('/v1/decisions/:decisionId/execution-inputs', async (c) => {
				const body = await c.req.json().catch(() => ({}));
				const projectId = typeof body.projectId === 'string' ? body.projectId : null;
				if (!projectId) return jsonError(c, 400, 'projectId is required.');
				const access = await requireProjectAccess(c, store, projectId, 'projects:manage:team');
				if (access.response) return access.response;
				try {
					const input = await store.createDecisionExecutionInput(c.req.param('decisionId'), body);
					return input ? c.json({ ok: true, payload: input }, { status: 201 }) : jsonError(c, 404, 'Unknown project.');
				} catch (error) {
					return jsonError(c, 400, error instanceof Error ? error.message : String(error));
				}
			});

			app.post('/v1/decision-execution-inputs/:inputId/accept', async (c) => {
				const existing = await store.getDecisionExecutionInput(c.req.param('inputId'));
				if (!existing) return jsonError(c, 404, 'Unknown decision execution input.');
				const access = await requireProjectAccess(c, store, existing.projectId, 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				return c.json({ ok: true, payload: await store.updateDecisionExecutionInputStatus(existing.id, 'accepted', body) });
			});

			app.post('/v1/decision-execution-inputs/:inputId/request-revision', async (c) => {
				const existing = await store.getDecisionExecutionInput(c.req.param('inputId'));
				if (!existing) return jsonError(c, 404, 'Unknown decision execution input.');
				const access = await requireProjectAccess(c, store, existing.projectId, 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				return c.json({ ok: true, payload: await store.updateDecisionExecutionInputStatus(existing.id, 'revision_requested', body) });
			});

			app.get('/v1/decisions/:decisionId/capacity-plans', async (c) => {
				const status = await store.getDecisionPlanningStatus(c.req.param('decisionId'));
				if (!status) return jsonError(c, 404, 'Unknown decision planning status.');
				const access = await requireProjectAccess(c, store, status.projectId, 'projects:read:team');
				if (access.response) return access.response;
				return c.json({
					ok: true,
					payload: await store.listAgentCapacityPlans(c.req.param('decisionId'), {
						status: typeof c.req.query('status') === 'string' ? c.req.query('status') : null,
					}),
				});
			});

			app.post('/v1/decisions/:decisionId/capacity-plans', async (c) => {
				const body = await c.req.json().catch(() => ({}));
				const projectId = typeof body.projectId === 'string' ? body.projectId : null;
				if (!projectId) return jsonError(c, 400, 'projectId is required.');
				const access = await requireProjectAccess(c, store, projectId, 'projects:manage:team');
				if (access.response) return access.response;
				try {
					const plan = await store.createAgentCapacityPlan(c.req.param('decisionId'), body);
					return plan ? c.json({ ok: true, payload: plan }, { status: 201 }) : jsonError(c, 404, 'Unknown project.');
				} catch (error) {
					return jsonError(c, 400, error instanceof Error ? error.message : String(error));
				}
			});

			app.get('/v1/capacity-plans/:capacityPlanId', async (c) => {
				const plan = await store.getAgentCapacityPlan(c.req.param('capacityPlanId'));
				if (!plan) return jsonError(c, 404, 'Unknown capacity plan.');
				const access = await requireProjectAccess(c, store, plan.projectId, 'projects:read:team');
				if (access.response) return access.response;
				return c.json({ ok: true, payload: plan });
			});

			app.post('/v1/capacity-plans/:capacityPlanId/accept', async (c) => {
				const plan = await store.getAgentCapacityPlan(c.req.param('capacityPlanId'));
				if (!plan) return jsonError(c, 404, 'Unknown capacity plan.');
				const access = await requireProjectAccess(c, store, plan.projectId, 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				return c.json({ ok: true, payload: await store.updateAgentCapacityPlanStatus(plan.id, 'accepted', body) });
			});

			app.post('/v1/capacity-plans/:capacityPlanId/request-revision', async (c) => {
				const plan = await store.getAgentCapacityPlan(c.req.param('capacityPlanId'));
				if (!plan) return jsonError(c, 404, 'Unknown capacity plan.');
				const access = await requireProjectAccess(c, store, plan.projectId, 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				return c.json({ ok: true, payload: await store.updateAgentCapacityPlanStatus(plan.id, 'revision_requested', body) });
			});

			app.post('/v1/capacity-plans/:capacityPlanId/schedule', async (c) => {
				const plan = await store.getAgentCapacityPlan(c.req.param('capacityPlanId'));
				if (!plan) return jsonError(c, 404, 'Unknown capacity plan.');
				const access = await requireProjectAccess(c, store, plan.projectId, 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				return c.json({ ok: true, payload: await store.updateAgentCapacityPlanStatus(plan.id, 'scheduled', body) });
			});

			app.post('/v1/capacity-plans/:capacityPlanId/supersede', async (c) => {
				const plan = await store.getAgentCapacityPlan(c.req.param('capacityPlanId'));
				if (!plan) return jsonError(c, 404, 'Unknown capacity plan.');
				const access = await requireProjectAccess(c, store, plan.projectId, 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				return c.json({ ok: true, payload: await store.updateAgentCapacityPlanStatus(plan.id, 'superseded', body) });
			});

			app.post('/v1/workdays', async (c) => {
				const body = await c.req.json().catch(() => ({}));
				const projectId = typeof body.projectId === 'string' ? body.projectId : null;
				if (!projectId) return jsonError(c, 400, 'projectId is required.');
				const access = await requireProjectAccess(c, store, projectId, 'projects:manage:team');
				if (access.response) return access.response;
				const workday = await store.createWorkdayCapacityEnvelope(body);
				return workday ? c.json({ ok: true, payload: workday }, { status: 201 }) : jsonError(c, 404, 'Unknown project.');
			});

			app.get('/v1/workdays/:workdayId', async (c) => {
				const workday = await store.getWorkdayCapacityEnvelope(c.req.param('workdayId'));
				if (!workday) return jsonError(c, 404, 'Unknown workday.');
				const access = await requireProjectAccess(c, store, workday.projectId, 'projects:read:team');
				if (access.response) return access.response;
				return c.json({ ok: true, payload: workday });
			});

			app.post('/v1/workdays/:workdayId/start', async (c) => {
				const workday = await store.getWorkdayCapacityEnvelope(c.req.param('workdayId'));
				if (!workday) return jsonError(c, 404, 'Unknown workday.');
				const access = await requireProjectAccess(c, store, workday.projectId, 'projects:manage:team');
				if (access.response) return access.response;
				return c.json({ ok: true, payload: await store.updateWorkdayCapacityEnvelopeState(workday.id, 'active') });
			});

			app.post('/v1/workdays/:workdayId/pause', async (c) => {
				const workday = await store.getWorkdayCapacityEnvelope(c.req.param('workdayId'));
				if (!workday) return jsonError(c, 404, 'Unknown workday.');
				const access = await requireProjectAccess(c, store, workday.projectId, 'projects:manage:team');
				if (access.response) return access.response;
				return c.json({ ok: true, payload: await store.updateWorkdayCapacityEnvelopeState(workday.id, 'paused') });
			});

			app.post('/v1/workdays/:workdayId/complete', async (c) => {
				const workday = await store.getWorkdayCapacityEnvelope(c.req.param('workdayId'));
				if (!workday) return jsonError(c, 404, 'Unknown workday.');
				const access = await requireProjectAccess(c, store, workday.projectId, 'projects:manage:team');
				if (access.response) return access.response;
				return c.json({ ok: true, payload: await store.updateWorkdayCapacityEnvelopeState(workday.id, 'completed') });
			});

			app.get('/v1/workdays/:workdayId/summary', async (c) => {
				const summary = await store.getWorkdayCapacitySummary(c.req.param('workdayId'));
				if (!summary?.payload?.workday) return jsonError(c, 404, 'Unknown workday.');
				const access = await requireProjectAccess(c, store, summary.payload.workday.projectId, 'projects:read:team');
				if (access.response) return access.response;
				return c.json(summary);
			});

			app.post('/v1/provider/register', async (c) => {
				const auth = await requireCapacityProviderKey(c, store, ['provider:register', 'provider:capabilities:write']);
				if (auth.response) return auth.response;
				const body = await c.req.json().catch(() => ({}));
				const result = await store.recordCapacityProviderRegistration(auth.principal, body);
				if (!result?.provider) return jsonError(c, 404, 'Unknown capacity provider.');
				const session = typeof store.createCapacityProviderSessionToken === 'function'
					? await store.createCapacityProviderSessionToken(auth.principal.teamId, auth.principal.capacityProviderId, {
						rotatedFromKeyId: auth.principal.keyId,
						ttlSeconds: 3600,
					})
					: null;
				return c.json({
					ok: true,
					provider: {
						id: result.provider.id,
						teamId: result.provider.teamId ?? result.provider.ownerTeamId,
						name: result.provider.name,
						status: result.provider.status,
						connectionState: result.provider.connectionState,
					},
					portfolioManifestUrl: '/v1/provider/portfolio',
					heartbeatIntervalSeconds: 30,
					sessionToken: session?.plaintextKey ?? null,
					sessionExpiresAt: session?.key?.expiresAt ?? null,
				});
			});

			app.post('/v1/provider/heartbeat', async (c) => {
				const auth = await requireCapacityProviderKey(c, store, ['provider:heartbeat']);
				if (auth.response) return auth.response;
				const body = await c.req.json().catch(() => ({}));
				if (typeof body.providerId === 'string' && body.providerId !== auth.provider.id) {
					return jsonError(c, 403, 'Capacity provider API key does not match this provider.');
				}
				const provider = await store.recordCapacityProviderHeartbeat(auth.principal, body);
				return c.json({
					ok: true,
					provider: provider
						? {
							id: provider.id,
							teamId: provider.teamId ?? provider.ownerTeamId,
							name: provider.name,
							status: provider.status,
							connectionState: provider.connectionState,
						}
						: undefined,
					heartbeatIntervalSeconds: 30,
				});
			});

			app.post('/v1/provider/sessions', async (c) => {
				const auth = await requireCapacityProviderKey(c, store, ['provider:heartbeat', 'provider:capabilities:write']);
				if (auth.response) return auth.response;
				const body = await c.req.json().catch(() => ({}));
				const session = await store.createProviderAvailabilitySession(auth.principal, body);
				return session ? c.json({ ok: true, payload: session }, { status: 201 }) : jsonError(c, 404, 'Unknown capacity provider.');
			});

			app.post('/v1/provider/check-in', async (c) => {
				const auth = await requireCapacityProviderKey(c, store, ['provider:heartbeat', 'provider:capabilities:write']);
				if (auth.response) return auth.response;
				const body = await c.req.json().catch(() => ({}));
				const session = await store.recordProviderCheckIn(auth.principal, body);
				return session ? c.json({ ok: true, payload: session }, { status: 201 }) : jsonError(c, 404, 'Unknown capacity provider.');
			});

			app.post('/v1/provider/assignments/next', async (c) => {
				const auth = await requireCapacityProviderKey(c, store, ['provider:assignments:read']);
				if (auth.response) return auth.response;
				const body = await c.req.json().catch(() => ({}));
				const result = await store.leaseNextProviderAssignment(auth.principal, body);
				return c.json({
					ok: true,
					payload: result.assignment,
					assignment: result.assignment,
					leaseToken: result.leaseToken,
					leaseSeconds: result.leaseSeconds,
					diagnostics: result.diagnostics ?? null,
					leaseDiagnostics: result.diagnostics ?? null,
				});
			});

			app.get('/v1/provider/assignments/:assignmentId', async (c) => {
				const auth = await requireCapacityProviderKey(c, store, ['provider:assignments:read']);
				if (auth.response) return auth.response;
				const assignment = await store.getProviderAssignment(auth.principal.teamId, c.req.param('assignmentId'));
				if (!assignment) return jsonError(c, 404, 'Unknown assignment.');
				if (assignment.capacityProviderId !== auth.principal.capacityProviderId) return jsonError(c, 403, 'Provider cannot access this assignment.');
				return c.json({ ok: true, payload: assignment });
			});

			app.get('/v1/provider/assignments/:assignmentId/explanation', async (c) => {
				const auth = await requireCapacityProviderKey(c, store, ['provider:assignments:read']);
				if (auth.response) return auth.response;
				const assignment = await store.getProviderAssignment(auth.principal.teamId, c.req.param('assignmentId'));
				if (!assignment) return jsonError(c, 404, 'Unknown assignment.');
				if (assignment.capacityProviderId !== auth.principal.capacityProviderId) return jsonError(c, 403, 'Provider cannot access this assignment.');
				const explanation = await store.getProviderAssignmentExplanation(auth.principal.teamId, assignment.id);
				return c.json({ ok: true, payload: explanation ?? assignment.explanation ?? {} });
			});

			app.post('/v1/provider/assignments/:assignmentId/renew', async (c) => {
				const auth = await requireCapacityProviderKey(c, store, ['provider:assignments:read']);
				if (auth.response) return auth.response;
				const body = await c.req.json().catch(() => ({}));
				const result = await store.renewProviderAssignmentLease(auth.principal, c.req.param('assignmentId'), body);
				if (!result) return jsonError(c, 409, 'Assignment lease cannot be renewed.');
				return c.json({ ok: true, payload: result.assignment, assignment: result.assignment, leaseToken: result.leaseToken, leaseSeconds: result.leaseSeconds });
			});

			app.post('/v1/provider/assignments/:assignmentId/return', async (c) => {
				const auth = await requireCapacityProviderKey(c, store, ['provider:assignments:write']);
				if (auth.response) return auth.response;
				const body = await c.req.json().catch(() => ({}));
				const result = await store.returnProviderAssignment(auth.principal, c.req.param('assignmentId'), body);
				if (!result) return jsonError(c, 409, 'Assignment lease cannot be returned.');
				return c.json({ ok: true, payload: result.assignment, assignment: result.assignment });
			});

			app.post('/v1/provider/assignments/:assignmentId/complete', async (c) => {
				const body = await c.req.json().catch(() => ({}));
				const scopes = ['provider:assignments:write'];
				if (body.usageActualId || body.modeRunId || body.usageActual || body.usage) scopes.push('provider:usage:report');
				const auth = await requireCapacityProviderKey(c, store, scopes);
				if (auth.response) return auth.response;
				const result = await store.completeProviderAssignment(auth.principal, c.req.param('assignmentId'), body);
				if (!result) return jsonError(c, 409, 'Assignment lease cannot be completed.');
				return c.json({ ok: true, payload: result.assignment, assignment: result.assignment });
			});

			app.post('/v1/provider/assignments/:assignmentId/fail', async (c) => {
				const body = await c.req.json().catch(() => ({}));
				const scopes = ['provider:assignments:write'];
				if (body.usageActualId || body.modeRunId || body.usageActual || body.usage) scopes.push('provider:usage:report');
				const auth = await requireCapacityProviderKey(c, store, scopes);
				if (auth.response) return auth.response;
				const result = await store.failProviderAssignment(auth.principal, c.req.param('assignmentId'), body);
				if (!result) return jsonError(c, 409, 'Assignment lease cannot be failed.');
				return c.json({ ok: true, payload: result.assignment, assignment: result.assignment });
			});

			app.post('/v1/provider/assignments/:assignmentId/mode-runs', async (c) => {
				const auth = await requireCapacityProviderKey(c, store, ['provider:assignments:write', 'provider:usage:report']);
				if (auth.response) return auth.response;
				const assignment = await store.getProviderAssignment(auth.principal.teamId, c.req.param('assignmentId'));
				if (!assignment) return jsonError(c, 404, 'Unknown assignment.');
				if (assignment.capacityProviderId !== auth.principal.capacityProviderId) return jsonError(c, 403, 'Provider cannot update this assignment.');
				const body = await c.req.json().catch(() => ({}));
				const modeRun = await store.createAgentModeRun({
					...body,
					teamId: auth.principal.teamId,
					providerAssignmentId: assignment.id,
				});
				return modeRun ? c.json({ ok: true, payload: modeRun }, { status: 201 }) : jsonError(c, 404, 'Unknown assignment.');
			});

			app.post('/v1/provider/assignments/:assignmentId/workflow-operations/:operationId/dispatch', async (c) => {
				const auth = await requireCapacityProviderKey(c, store, ['provider:assignments:write']);
				if (auth.response) return auth.response;
				const assignment = await store.getProviderAssignment(auth.principal.teamId, c.req.param('assignmentId'));
				if (!assignment) return jsonError(c, 404, 'Unknown assignment.');
				if (assignment.capacityProviderId !== auth.principal.capacityProviderId) return jsonError(c, 403, 'Provider cannot update this assignment.');
				const body = await c.req.json().catch(() => ({}));
				if (assignment.leaseState === 'leased' && assignment.leaseToken !== body.leaseToken) {
					return jsonError(c, 409, 'Assignment lease token is required for workflow operation dispatch.', { code: 'assignment_lease_token_required' });
				}
				if (assignment.leaseExpiresAt && Date.parse(assignment.leaseExpiresAt) <= Date.now()) {
					return jsonError(c, 409, 'Assignment lease has expired.', { code: 'assignment_lease_expired' });
				}
				const capabilityHandles = assignment.capabilityHandles && typeof assignment.capabilityHandles === 'object' ? assignment.capabilityHandles : {};
				const workflowHandles = Array.isArray(capabilityHandles.workflowOperations) ? capabilityHandles.workflowOperations : [];
				const requestedHandleId = typeof body.handleId === 'string' ? body.handleId : null;
				const operationId = c.req.param('operationId');
				const handle = workflowHandles.find((entry) => entry && typeof entry === 'object'
					&& entry.operationId === operationId
					&& (!requestedHandleId || entry.id === requestedHandleId));
				if (!handle) {
					return jsonError(c, 403, 'Assignment does not include an active workflow operation handle for this operation.', { code: 'assignment_workflow_operation_denied' });
				}
				if (handle.status && !['active', 'issued'].includes(String(handle.status))) {
					return jsonError(c, 403, 'Assignment workflow operation handle is not active.', { code: 'assignment_workflow_operation_denied' });
				}
				if (handle.expiresAt && Date.parse(handle.expiresAt) <= Date.now()) {
					return jsonError(c, 403, 'Assignment workflow operation handle has expired.', { code: 'assignment_workflow_operation_denied' });
				}
				const operations = Array.isArray(handle.operations) ? handle.operations.map(String) : [];
				if (!operations.includes('dispatch_workflow')) {
					return jsonError(c, 403, 'Assignment workflow operation handle is not dispatch-capable.', { code: 'assignment_workflow_operation_denied' });
				}
				const extraFields = ['workflow', 'workflowFile', 'workflow_file', 'repository', 'ref', 'branch', 'command', 'commands', 'providerCommands']
					.filter((field) => Object.prototype.hasOwnProperty.call(body, field));
				if (extraFields.length) {
					return jsonError(c, 400, 'Provider workflow operation dispatch accepts only assignment handle inputs, not arbitrary workflow scope.', { code: 'arbitrary_secret_workflow_dispatch', fields: extraFields });
				}
				const enclave = createGitHubActionsSecretEnclave({
					store,
					config: runtime.resolved.config,
				});
				try {
					const payload = await enclave.dispatchWorkflowOperation({
						inputs: body.inputs && typeof body.inputs === 'object' && !Array.isArray(body.inputs) ? body.inputs : {},
						wait: body.wait === true,
						teamId: assignment.teamId,
						projectId: assignment.projectId,
						operationId,
						requester: {
							type: 'capacity_provider',
							id: auth.principal.capacityProviderId,
							assignmentId: assignment.id,
							handleId: handle.id,
						},
						metadata: {
							providerAssignmentId: assignment.id,
							capacityProviderId: auth.principal.capacityProviderId,
							workflowOperationHandleId: handle.id,
						},
					});
					await store.recordSecretCapabilityAudit('provider_assignment.workflow_operation_dispatched', {
						teamId: assignment.teamId,
						projectId: assignment.projectId,
						assignmentId: assignment.id,
						capacityProviderId: auth.principal.capacityProviderId,
						workflowOperationId: operationId,
						handleId: handle.id,
						dispatchId: payload?.dispatch?.id ?? null,
					}).catch(() => null);
					return c.json({ ok: true, payload }, { status: 202 });
				} catch (error) {
					return jsonThrownError(c, error, 403);
				}
			});

			app.get('/v1/provider/portfolio', async (c) => {
				const auth = await requireCapacityProviderKey(c, store, ['provider:portfolio:read']);
				if (auth.response) return auth.response;
				const manifest = await store.buildCapacityProviderPortfolio(auth.principal);
				if (!manifest) return jsonError(c, 404, 'Unknown provider team.');
				return c.json(manifest);
			});

			app.post('/v1/provider/workdays', async (c) => {
				const auth = await requireCapacityProviderKey(c, store, ['provider:assignments:write']);
				if (auth.response) return auth.response;
				const body = await c.req.json().catch(() => ({}));
				const projectId = typeof body.projectId === 'string' ? body.projectId : null;
				if (!projectId) return jsonError(c, 400, 'projectId is required.');
				const project = await store.getProject(projectId);
				if (!project || project.teamId !== auth.principal.teamId) return jsonError(c, 404, 'Unknown project.');
				const workDay = await store.startRuntimeWorkDay(projectId, {
					id: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined,
					state: 'active',
					capacityBudget: Number(body.summary?.capacityBudget ?? 0),
					summary: {
						...(body.summary && typeof body.summary === 'object' ? body.summary : {}),
						provider: {
							id: auth.provider.id,
							keyId: auth.principal.keyId,
						},
					},
				});
				await store.updateCapacityProviderStatus(auth.principal.teamId, auth.provider.id, {
					status: auth.provider.status,
					metadata: {
						latestProviderWorkday: {
							projectId,
							workDayId: workDay.id,
							environment: body.environment ?? null,
							updatedAt: new Date().toISOString(),
						},
					},
				});
				return c.json({ ok: true, workDay });
			});

			app.post('/v1/provider/usage', async (c) => {
				const auth = await requireCapacityProviderKey(c, store, ['provider:usage:report']);
				if (auth.response) return auth.response;
				const body = await c.req.json().catch(() => ({}));
				const job = typeof body.taskId === 'string' ? await store.findJobById(body.taskId) : null;
				const projectId = typeof body.projectId === 'string' ? body.projectId : job?.projectId;
				if (!projectId) return jsonError(c, 400, 'projectId or taskId is required.');
				const project = await store.getProject(projectId);
				if (!project || project.teamId !== auth.principal.teamId) return jsonError(c, 404, 'Unknown project.');
				const reportedNativeUsage = body.nativeUsage && typeof body.nativeUsage === 'object'
					? body.nativeUsage
					: body.usage && typeof body.usage === 'object'
						? body.usage
						: {};
				const hasNativeUsage = Object.keys(reportedNativeUsage).length > 0
					|| ['wallMinutes', 'quotaMinutes', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'actualUsd', 'usd', 'filesOpened', 'filesChanged', 'diffLinesAdded', 'diffLinesRemoved', 'testRuns', 'retryCount']
						.some((key) => Number.isFinite(Number(body[key])));
				if (!hasNativeUsage && !Number.isFinite(Number(body.actualCredits))) {
					return jsonError(c, 400, 'nativeUsage or legacy actualCredits is required.');
				}
				const usage = await store.createTaskUsageActual({
					...body,
					projectId,
					taskId: body.taskId ?? job?.id ?? null,
					workDayId: body.workDayId ?? null,
					taskSignature: body.taskSignature ?? job?.operation ?? 'capacity-provider.reported-usage',
					executionProfileId: body.executionProfileId ?? 'standard-code-model',
					capacityProviderId: auth.provider.id,
					executionProviderId: typeof body.executionProviderId === 'string' ? body.executionProviderId : null,
					laneId: body.laneId ?? null,
					actualCredits: Number.isFinite(Number(body.actualCredits)) ? Number(body.actualCredits) : null,
					actualCreditsOverride: body.actualCreditsOverride === true,
					actualUsd: Number.isFinite(Number(body.actualUsd ?? body.usd)) ? Number(body.actualUsd ?? body.usd) : null,
					nativeUsage: hasNativeUsage ? {
						...reportedNativeUsage,
						wallMinutes: body.wallMinutes ?? reportedNativeUsage.wallMinutes,
						quotaMinutes: body.quotaMinutes ?? reportedNativeUsage.quotaMinutes,
						inputTokens: body.inputTokens ?? reportedNativeUsage.inputTokens,
						outputTokens: body.outputTokens ?? reportedNativeUsage.outputTokens,
						cachedInputTokens: body.cachedInputTokens ?? reportedNativeUsage.cachedInputTokens,
						usd: body.actualUsd ?? body.usd ?? reportedNativeUsage.usd,
						filesOpened: body.filesOpened ?? reportedNativeUsage.filesOpened,
						filesChanged: body.filesChanged ?? reportedNativeUsage.filesChanged,
						diffLinesAdded: body.diffLinesAdded ?? reportedNativeUsage.diffLinesAdded,
						diffLinesRemoved: body.diffLinesRemoved ?? reportedNativeUsage.diffLinesRemoved,
						testRuns: body.testRuns ?? reportedNativeUsage.testRuns,
						retryCount: body.retryCount ?? reportedNativeUsage.retryCount,
						source: reportedNativeUsage.source ?? 'provider_report',
					} : null,
					metadata: {
						...(body.metadata && typeof body.metadata === 'object' ? body.metadata : {}),
						providerKeyId: auth.principal.keyId,
						legacyActualCreditsSupplied: Number.isFinite(Number(body.actualCredits)),
					},
				});
				return c.json({ ok: true, usage });
			});

			app.post('/v1/provider/reports', async (c) => {
				const auth = await requireCapacityProviderKey(c, store, ['provider:reports:write']);
				if (auth.response) return auth.response;
				const body = await c.req.json().catch(() => ({}));
				if (typeof body.workDayId !== 'string') return jsonError(c, 400, 'workDayId is required.');
				const report = await store.createRuntimeReport({
					workDayId: body.workDayId,
					kind: body.kind ?? 'capacity_provider_report',
					body: body.body ?? {},
					renderedRef: body.renderedRef ?? null,
				});
				if (!report) return jsonError(c, 404, 'Unknown workday.');
				await store.updateCapacityProviderStatus(auth.principal.teamId, auth.provider.id, {
					status: auth.provider.status,
					metadata: {
						latestProviderReport: {
							workDayId: body.workDayId,
							kind: body.kind ?? 'capacity_provider_report',
							summary: body.body?.summary ?? body.body?.status ?? null,
							reportId: report.id,
							createdAt: report.createdAt ?? new Date().toISOString(),
						},
					},
				});
				return c.json({ ok: true, report });
			});

			app.post('/v1/projects/:projectId/runner/capacity/estimates', async (c) => {
				const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
				if (runnerAccess.response) return runnerAccess.response;
				const body = await c.req.json().catch(() => ({}));
				const inputs = Array.isArray(body.estimates) ? body.estimates : [body];
				const payload = [];
				for (const input of inputs) {
					if (!input?.taskSignature || !input?.estimatePhase || !input?.confidence) {
						return jsonError(c, 400, 'taskSignature, estimatePhase, and confidence are required.');
					}
					payload.push(await store.createTaskEstimate({
						...input,
						projectId: c.req.param('projectId'),
					}));
				}
				return c.json({ ok: true, payload: Array.isArray(body.estimates) ? payload : payload[0] }, { status: 201 });
			});

			app.post('/v1/projects/:projectId/runner/capacity/reservations', async (c) => {
				const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
				if (runnerAccess.response) return runnerAccess.response;
				const project = await store.getProject(c.req.param('projectId'));
				if (!project) return jsonError(c, 404, 'Unknown project.');
				const body = await c.req.json().catch(() => ({}));
				if (!body.capacityProviderId || !body.laneId || !Number.isFinite(Number(body.reservedCredits))) {
					return jsonError(c, 400, 'capacityProviderId, laneId, and reservedCredits are required.');
				}
				return c.json({
					ok: true,
					payload: await store.createCapacityReservation({
						...body,
						teamId: typeof body.teamId === 'string' ? body.teamId : project.teamId,
						projectId: c.req.param('projectId'),
					}),
				}, { status: 201 });
			});

			app.post('/v1/projects/:projectId/runner/capacity/usage', async (c) => {
				const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
				if (runnerAccess.response) return runnerAccess.response;
				const project = await store.getProject(c.req.param('projectId'));
				if (!project) return jsonError(c, 404, 'Unknown project.');
				const body = await c.req.json().catch(() => ({}));
				const phase = body.phase ?? 'consume';
				const reportedNativeUsage = body.nativeUsage && typeof body.nativeUsage === 'object'
					? body.nativeUsage
					: body.usageActual?.nativeUsage && typeof body.usageActual.nativeUsage === 'object'
						? body.usageActual.nativeUsage
						: body.usage && typeof body.usage === 'object'
							? body.usage
							: {};
				const hasNativeUsage = Object.keys(reportedNativeUsage).length > 0
					|| ['wallMinutes', 'quotaMinutes', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'usd', 'actualUsd', 'filesOpened', 'filesChanged', 'diffLinesAdded', 'diffLinesRemoved', 'testRuns', 'retryCount']
						.some((key) => Number.isFinite(Number(body[key] ?? body.usageActual?.[key])));
				if (!body.capacityProviderId || (!Number.isFinite(Number(body.credits)) && !hasNativeUsage)) {
					return jsonError(c, 400, 'capacityProviderId and credits or nativeUsage are required.');
				}
				const nativeUsage = {
					...reportedNativeUsage,
					wallMinutes: body.usageActual?.wallMinutes ?? body.wallMinutes ?? reportedNativeUsage.wallMinutes,
					quotaMinutes: body.usageActual?.quotaMinutes ?? body.quotaMinutes ?? reportedNativeUsage.quotaMinutes,
					inputTokens: body.usageActual?.inputTokens ?? body.inputTokens ?? reportedNativeUsage.inputTokens,
					outputTokens: body.usageActual?.outputTokens ?? body.outputTokens ?? reportedNativeUsage.outputTokens,
					cachedInputTokens: body.usageActual?.cachedInputTokens ?? body.cachedInputTokens ?? reportedNativeUsage.cachedInputTokens,
					usd: body.usageActual?.actualUsd ?? body.actualUsd ?? body.usd ?? reportedNativeUsage.usd,
					filesOpened: body.usageActual?.filesOpened ?? body.filesOpened ?? reportedNativeUsage.filesOpened,
					filesChanged: body.usageActual?.filesChanged ?? body.filesChanged ?? reportedNativeUsage.filesChanged,
					diffLinesAdded: body.usageActual?.diffLinesAdded ?? body.diffLinesAdded ?? reportedNativeUsage.diffLinesAdded,
					diffLinesRemoved: body.usageActual?.diffLinesRemoved ?? body.diffLinesRemoved ?? reportedNativeUsage.diffLinesRemoved,
					testRuns: body.usageActual?.testRuns ?? body.testRuns ?? reportedNativeUsage.testRuns,
					retryCount: body.usageActual?.retryCount ?? body.retryCount ?? reportedNativeUsage.retryCount,
					partial: body.usageActual?.partial ?? reportedNativeUsage.partial,
					interrupted: body.usageActual?.interrupted ?? reportedNativeUsage.interrupted,
					source: reportedNativeUsage.source ?? body.source ?? 'runner',
				};
				const actualCreditCalculation = calculateActualCredits({
					nativeUsage,
					legacyActualCredits: Number.isFinite(Number(body.credits)) ? Number(body.credits) : Number.isFinite(Number(body.actualCredits)) ? Number(body.actualCredits) : null,
					actualCreditsOverride: body.actualCreditsOverride === true,
					reservedCredits: body.reservedCredits,
					actualUsd: Number.isFinite(Number(body.actualUsd ?? body.usd)) ? Number(body.actualUsd ?? body.usd) : null,
					source: typeof body.source === 'string' ? body.source : 'runner',
				});
				const effectiveCredits = hasNativeUsage || phase === 'task_completed_actual_settlement'
					? actualCreditCalculation.actualCredits
					: Number(body.credits);
				let entry = null;
				let settlement = null;
				if (body.reservationId && phase === 'task_completed_actual_settlement') {
					const reservation = await store.getCapacityReservation(String(body.reservationId));
					if (!reservation) return jsonError(c, 404, 'Unknown capacity reservation.');
					settlement = settleCapacityActuals({
						reservation,
						actualCredits: effectiveCredits,
						actualProviderUnits: Number.isFinite(Number(body.providerUnits)) ? Number(body.providerUnits) : null,
						actualUsd: Number.isFinite(Number(body.usd)) ? Number(body.usd) : null,
						taskId: typeof body.taskId === 'string' ? body.taskId : null,
						source: typeof body.source === 'string' ? body.source : 'runner',
						metadata: {
							...(body.metadata && typeof body.metadata === 'object' ? body.metadata : {}),
							actualCreditCalculation,
						},
					});
					entry = await store.recordCapacityUsage(settlement.consumeEntry);
					if (settlement.releaseEntry) await store.recordCapacityUsage(settlement.releaseEntry);
					if (settlement.overrunEntry) await store.recordCapacityUsage(settlement.overrunEntry);
				} else {
					entry = await store.recordCapacityUsage({
						...body,
						credits: effectiveCredits,
						teamId: typeof body.teamId === 'string' ? body.teamId : project.teamId,
						projectId: c.req.param('projectId'),
					});
				}
				if (body.workDayId && phase === 'consume') {
					await store.recordProjectTaskCredits(c.req.param('projectId'), {
						workDayId: String(body.workDayId),
						taskId: typeof body.taskId === 'string' ? body.taskId : null,
						phase: 'consume',
						credits: effectiveCredits,
						metadata: {
							capacityProviderId: body.capacityProviderId,
							laneId: body.laneId ?? null,
							reservationId: body.reservationId ?? null,
							providerUnits: body.providerUnits ?? null,
							usd: body.usd ?? null,
							actualCreditCalculation,
						},
					});
				}
				let usageActual = null;
				if (body.usageActual && typeof body.usageActual === 'object') {
					usageActual = await store.createTaskUsageActual({
						...body.usageActual,
						projectId: c.req.param('projectId'),
						taskId: body.usageActual.taskId ?? body.taskId ?? null,
						workDayId: body.usageActual.workDayId ?? body.workDayId ?? null,
						executionProfileId: body.usageActual.executionProfileId ?? body.executionProfileId ?? body.metadata?.executionProfileId ?? null,
						capacityProviderId: body.usageActual.capacityProviderId ?? body.capacityProviderId,
						executionProviderId: body.usageActual.executionProviderId ?? body.executionProviderId ?? null,
						laneId: body.usageActual.laneId ?? body.laneId ?? null,
						actualCredits: body.usageActual.actualCredits ?? body.credits ?? null,
						actualCreditsOverride: body.usageActual.actualCreditsOverride === true,
						nativeUsage: hasNativeUsage ? nativeUsage : null,
						metadata: {
							...(body.usageActual.metadata && typeof body.usageActual.metadata === 'object' ? body.usageActual.metadata : {}),
							actualCreditCalculation,
						},
					});
				}
				return c.json({ ok: true, payload: { entry, settlement, usageActual, actualCreditCalculation } }, { status: 201 });
			});

			app.post('/v1/projects/:projectId/runner/capacity/routing-decisions', async (c) => {
				const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
				if (runnerAccess.response) return runnerAccess.response;
				const body = await c.req.json().catch(() => ({}));
				if (!body.selectedProviderId || !body.selectedLaneId || !body.reason) {
					return jsonError(c, 400, 'selectedProviderId, selectedLaneId, and reason are required.');
				}
				return c.json({
					ok: true,
					payload: await store.createCapacityRoutingDecision({
						...body,
						projectId: c.req.param('projectId'),
					}),
				}, { status: 201 });
			});

			app.post('/v1/projects/:projectId/runner/approval-requests', async (c) => {
				const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
				if (runnerAccess.response) return runnerAccess.response;
				const project = await store.getProject(c.req.param('projectId'));
				if (!project) return jsonError(c, 404, 'Unknown project.');
				const body = await c.req.json().catch(() => ({}));
				if (!body.kind || !body.title || !body.summary) {
					return jsonError(c, 400, 'kind, title, and summary are required.');
				}
				const request = await store.createApprovalRequest({
					...body,
					teamId: typeof body.teamId === 'string' ? body.teamId : project.teamId,
					projectId: c.req.param('projectId'),
					requestedByType: typeof body.requestedByType === 'string' ? body.requestedByType : 'worker',
				});
				await store.upsertTeamInboxItem(request.teamId, {
					id: `approval-request:${request.id}`,
					projectId: request.projectId,
					kind: 'approval',
					state: 'waiting_for_approval',
					title: request.title,
					summary: request.summary,
					href: await projectAppHref(store, request.teamId, project.slug, 'workdays'),
					itemKey: request.id,
					metadata: {
						approvalRequestId: request.id,
						approvalKind: request.kind,
						workDayId: request.workDayId,
						taskId: request.taskId,
					},
				});
				return c.json({ ok: true, payload: request }, { status: 201 });
			});

			app.get('/v1/projects/:projectId/workdays', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				const environment = typeof c.req.query('environment') === 'string' ? c.req.query('environment') : null;
				const delegated = await store.requestProjectRuntime(access.details.project.id, access.principal, '/v1/workdays');
				if (delegated) return c.json({ ok: true, payload: delegated });
				const summaries = await store.listProjectWorkdaySummaries(c.req.param('projectId'), environment);
				if (summaries.length) {
					return c.json({ ok: true, payload: summaries });
				}
				return c.json({
					ok: true,
					payload: await store.listRuntimeWorkDays(c.req.param('projectId'), { limit: 100 }),
				});
			});

				app.get('/v1/projects/:projectId/workdays/:workDayId', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
					if (access.response) return access.response;
				const workDayId = c.req.param('workDayId');
				const delegated = await store.requestProjectRuntime(access.details.project.id, access.principal, `/v1/workdays/${encodeURIComponent(workDayId)}`);
				if (delegated) return c.json({ ok: true, payload: delegated });
				const runtime = (await store.listRuntimeWorkDays(access.details.project.id, { limit: 1000 })).find((item) => item.id === workDayId || item.workDayId === workDayId);
				if (runtime) return c.json({ ok: true, payload: runtime });
				const summaries = await store.listProjectWorkdaySummaries(access.details.project.id, null);
				const summary = summaries.find((item) => item.workDayId === workDayId || item.id === workDayId);
				return summary
					? c.json({ ok: true, payload: summary })
						: jsonError(c, 404, 'Unknown workday.');
				});

				app.get('/v1/projects/:projectId/tasks', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
					if (access.response) return access.response;
					const delegated = await store.requestProjectRuntime(access.details.project.id, access.principal, '/v1/tasks');
					if (delegated) return c.json({ ok: true, payload: delegated });
					return c.json({
						ok: true,
						payload: await store.listRuntimeTasks(access.details.project.id, {
							workDayId: typeof c.req.query('workDayId') === 'string' ? c.req.query('workDayId') : null,
							limit: Number.isFinite(Number(c.req.query('limit'))) ? Number(c.req.query('limit')) : 100,
						}),
					});
				});

				app.get('/v1/projects/:projectId/tasks/:taskId', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
					if (access.response) return access.response;
					const taskId = c.req.param('taskId');
					const delegated = await store.requestProjectRuntime(access.details.project.id, access.principal, `/v1/tasks/${encodeURIComponent(taskId)}`);
					if (delegated) return c.json({ ok: true, payload: delegated });
					const payload = await store.getRuntimeTask(access.details.project.id, taskId);
					return payload ? c.json({ ok: true, payload }) : jsonError(c, 404, 'Unknown task.');
				});

				app.get('/v1/projects/:projectId/tasks/:taskId/events', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
					if (access.response) return access.response;
					const taskId = c.req.param('taskId');
					const delegated = await store.requestProjectRuntime(access.details.project.id, access.principal, `/v1/tasks/${encodeURIComponent(taskId)}/events`);
					if (delegated) return c.json({ ok: true, payload: delegated });
					const payload = await store.listRuntimeTaskEvents(access.details.project.id, taskId);
					return payload ? c.json({ ok: true, payload }) : jsonError(c, 404, 'Unknown task.');
				});

				app.post('/v1/projects/:projectId/workdays/start', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
				const body = await readJsonOrFormBody(c);
				const environment = typeof body.environment === 'string' && body.environment.trim() ? body.environment.trim() : 'local';
				const payload = await store.createWorkdayRequest(c.req.param('projectId'), {
					environment,
					type: 'one_off_run',
					workDayId: typeof body.workDayId === 'string' ? body.workDayId : null,
					requestedBy: access.principal.id,
					reason: typeof body.reason === 'string' ? body.reason : 'Start requested from workday compatibility route.',
					payload: typeof body.payload === 'object' && body.payload ? body.payload : {},
					metadata: { compatibilityRoute: true },
				});
				return c.json({ ok: true, payload }, 202);
			});

			app.post('/v1/projects/:projectId/workdays/:workDayId/close', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await readJsonOrFormBody(c);
				const environment = typeof body.environment === 'string' && body.environment.trim() ? body.environment.trim() : 'local';
				const payload = await store.createWorkdayRequest(c.req.param('projectId'), {
					environment,
					type: 'early_close',
					workDayId: c.req.param('workDayId'),
					requestedBy: access.principal.id,
					reason: typeof body.reason === 'string' ? body.reason : 'Close requested from workday compatibility route.',
					payload: typeof body.payload === 'object' && body.payload ? body.payload : {},
					metadata: { compatibilityRoute: true },
				});
				return c.json({ ok: true, payload }, 202);
			});

			app.post('/v1/projects/:projectId/runner/workdays', async (c) => {
				const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
				if (runnerAccess.response) return runnerAccess.response;
				const body = await c.req.json().catch(() => ({}));
				if (!body.environment || !body.workDayId || !body.summary || typeof body.summary !== 'object') {
					return jsonError(c, 400, 'environment, workDayId, and summary are required.');
				}
				const project = await store.getProject(c.req.param('projectId'));
				if (!project) {
					return jsonError(c, 404, `Unknown project "${c.req.param('projectId')}".`);
				}
				const reportState = typeof body.state === 'string' ? body.state : null;
				const docsAutomation = body.summary.docsAutomation && typeof body.summary.docsAutomation === 'object'
					? body.summary.docsAutomation
					: {};
				const contentSnapshot = body.summary.contentSnapshot && typeof body.summary.contentSnapshot === 'object'
					? body.summary.contentSnapshot
					: body.metadata?.contentSnapshot && typeof body.metadata.contentSnapshot === 'object'
						? body.metadata.contentSnapshot
						: null;
				const verificationFailureCount = Number(docsAutomation.verificationFailureCount ?? 0);
				const pendingApprovalCount = Number(docsAutomation.pendingApprovalCount ?? 0);
				const state = reportState === 'failed' || verificationFailureCount > 0
					? 'failed'
					: reportState === 'completed' && pendingApprovalCount === 0
						? 'completed'
						: 'partial';
				const created = await store.createProjectWorkdaySummary(project.id, {
					environment: String(body.environment),
					workDayId: String(body.workDayId),
					kind: typeof body.kind === 'string' ? body.kind : 'workday_summary',
					state,
					startedAt: typeof body.startedAt === 'string' ? body.startedAt : null,
					endedAt: typeof body.endedAt === 'string' ? body.endedAt : null,
					summary: body.summary,
					metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
				});
				const existingSnapshot = await store.getProjectSummarySnapshot(project.id);
				const latestWorkdayReport = {
					workDayId: String(body.workDayId),
					reportId: body.metadata?.reportId ?? created?.id ?? null,
					state,
					environment: String(body.environment),
					contentSnapshot,
					generatedAt: body.summary.generatedAt ?? created?.createdAt ?? new Date().toISOString(),
					generatedArtifactCount: Number(docsAutomation.researchNoteCount ?? 0)
						+ Number(docsAutomation.knowledgeDraftCount ?? 0)
						+ Number(docsAutomation.optimizationReportCount ?? 0)
						+ Number(docsAutomation.docsMutationCount ?? 0),
					pendingApprovalCount,
					verificationFailureCount,
				};
				await store.upsertProjectSummarySnapshot(project.id, project.teamId, {
					...(existingSnapshot?.summary ?? {}),
					docsAutomation: {
						...((existingSnapshot?.summary?.docsAutomation && typeof existingSnapshot.summary.docsAutomation === 'object')
							? existingSnapshot.summary.docsAutomation
							: {}),
						latestWorkdayReport,
					},
				});
				const workdayHref = `/app/projects/${encodeURIComponent(project.id)}#development`;
				await store.upsertTeamInboxItem(project.teamId, {
					id: `workday-summary:${project.id}:${String(body.workDayId)}`,
					projectId: project.id,
					kind: 'workday_summary',
					state,
					title: `${project.name}: documentation workday ${state}`,
					summary: `Generated ${latestWorkdayReport.generatedArtifactCount} artifact(s), ${pendingApprovalCount} pending approval(s), and ${verificationFailureCount} verification issue(s).`,
					href: `${workdayHref}#workday-report-timeline`,
					itemKey: `workday-summary:${String(body.workDayId)}`,
					metadata: {
						workDayId: String(body.workDayId),
						reportId: latestWorkdayReport.reportId,
						contentSnapshot,
						generatedArtifactCount: latestWorkdayReport.generatedArtifactCount,
						pendingApprovalCount,
						verificationFailureCount,
					},
				});
				return c.json({
					ok: true,
					payload: created,
				});
			});

			app.get('/v1/projects/:projectId/workdays/:workDayId/task-credits', async (c) => {
				const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({
					ok: true,
					payload: await store.listProjectTaskCredits(c.req.param('projectId'), c.req.param('workDayId')),
				});
			});

			app.post('/v1/projects/:projectId/runner/priority-snapshots', async (c) => {
				const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
				if (runnerAccess.response) return runnerAccess.response;
				const body = await c.req.json().catch(() => ({}));
				if (!body.snapshot || typeof body.snapshot !== 'object') {
					return jsonError(c, 400, 'snapshot is required.');
				}
				return c.json({
					ok: true,
					payload: await store.createProjectPrioritySnapshot(c.req.param('projectId'), {
						id: typeof body.id === 'string' ? body.id : undefined,
						workDayId: typeof body.workDayId === 'string' ? body.workDayId : null,
						snapshot: body.snapshot,
						metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
						generatedAt: typeof body.generatedAt === 'string' ? body.generatedAt : null,
					}),
				});
			});

			app.post('/v1/projects/:projectId/runner/task-credits', async (c) => {
				const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
				if (runnerAccess.response) return runnerAccess.response;
				const body = await c.req.json().catch(() => ({}));
				if (!body.workDayId || !body.phase || !Number.isFinite(Number(body.credits))) {
					return jsonError(c, 400, 'workDayId, phase, and credits are required.');
				}
				return c.json({
					ok: true,
					payload: await store.recordProjectTaskCredits(c.req.param('projectId'), {
						id: typeof body.id === 'string' ? body.id : undefined,
						workDayId: String(body.workDayId),
						taskId: typeof body.taskId === 'string' ? body.taskId : null,
						phase: String(body.phase),
						credits: Number(body.credits),
						metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
					}),
				});
			});

			app.post('/v1/jobs/:jobId/progress', async (c) => {
				const token = bearerTokenFromRequest(c.req.raw);
				if (!token) {
					return jsonError(c, 401, 'Authentication required.');
				}
				const job = await store.findJobById(c.req.param('jobId'));
				if (!job) {
					return jsonError(c, 404, `Unknown job "${c.req.param('jobId')}".`);
				}
				const runner = await store.authenticateRunner(job.projectId, token);
				if (!runner) {
					return jsonError(c, 401, 'Invalid project runner token.');
				}
				const body = await c.req.json().catch(() => ({}));
				if (job.namespace === 'workflow' && job.operation === 'launch_project' && body.data && typeof body.data === 'object' && typeof body.data.phase === 'string') {
					const launch = await store.getHubLaunchByJobId(job.id);
					if (launch) {
						await appendLaunchPhaseProjection(store, launch.id, job.id, {
							...body.data,
							phase: body.data.phase,
							status: typeof body.data.status === 'string' ? body.data.status : 'running',
							title: typeof body.data.title === 'string' ? body.data.title : String(body.data.phase).replace(/_/gu, ' '),
							summary: typeof body.summary === 'string' ? body.summary : typeof body.data.summary === 'string' ? body.data.summary : null,
							data: body.data,
						});
					}
				}
				return c.json({
					ok: true,
					payload: decorateJob(runtime.resolved.config.baseUrl, await store.recordJobProgress(job.id, {
						summary: typeof body.summary === 'string' ? body.summary : null,
						data: typeof body.data === 'object' && body.data ? body.data : {},
					})),
				});
			});

			app.post('/v1/jobs/:jobId/complete', async (c) => {
				const token = bearerTokenFromRequest(c.req.raw);
				if (!token) {
					return jsonError(c, 401, 'Authentication required.');
				}
				const job = await store.findJobById(c.req.param('jobId'));
				if (!job) {
					return jsonError(c, 404, `Unknown job "${c.req.param('jobId')}".`);
				}
				const runner = await store.authenticateRunner(job.projectId, token);
				if (!runner) {
					return jsonError(c, 401, 'Invalid project runner token.');
				}
				const body = await c.req.json().catch(() => ({}));
				if (job.namespace === 'workflow' && job.operation === 'launch_project') {
					await applyHubLaunchResult(store, runtime, job, body.output, runner);
				}
				if (job.namespace === 'content' && job.operation === 'publish') {
					await applyContentPublishResult(store, job, body.output);
					const project = await store.getProject(job.projectId);
					if (project) {
						await store.deleteTeamInboxItemsByItemKey(project.teamId, job.id);
					}
				}
				return c.json({
					ok: true,
					payload: decorateJob(runtime.resolved.config.baseUrl, await store.completeJob(job.id, {
						output: body.output,
					})),
				});
			});

			app.post('/v1/jobs/:jobId/fail', async (c) => {
				const token = bearerTokenFromRequest(c.req.raw);
				if (!token) {
					return jsonError(c, 401, 'Authentication required.');
				}
				const job = await store.findJobById(c.req.param('jobId'));
				if (!job) {
					return jsonError(c, 404, `Unknown job "${c.req.param('jobId')}".`);
				}
				const runner = await store.authenticateRunner(job.projectId, token);
				if (!runner) {
					return jsonError(c, 401, 'Invalid project runner token.');
				}
				const body = await c.req.json().catch(() => ({}));
				if (!body.message) {
					return jsonError(c, 400, 'message is required.');
				}
				if (job.namespace === 'workflow' && job.operation === 'launch_project') {
					await applyHubLaunchFailure(store, job, {
						code: typeof body.code === 'string' ? body.code : null,
						message: String(body.message),
					});
				}
				if (job.namespace === 'content' && job.operation === 'publish') {
					const project = await store.getProject(job.projectId);
					if (project) {
						await store.upsertTeamInboxItem(project.teamId, {
							id: `content-publish-failure:${job.id}`,
							projectId: project.id,
							kind: 'content_publish_failure',
							state: 'open',
							title: `${project.name}: content publish failed`,
							summary: String(body.message),
							severity: 'medium',
							actionHref: await projectAppHref(store, project.teamId, project.slug, 'overview'),
							itemKey: job.id,
							metadata: {
								code: typeof body.code === 'string' ? body.code : null,
								jobId: job.id,
							},
						});
					}
				}
				return c.json({
					ok: true,
					payload: decorateJob(runtime.resolved.config.baseUrl, await store.failJob(job.id, {
						code: typeof body.code === 'string' ? body.code : null,
						message: String(body.message),
					})),
				});
			});

			app.get('/v1/commerce/vendors/:teamId', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({ ok: true, payload: await store.getCommerceVendorForTeam(c.req.param('teamId')) });
			});

			app.post('/v1/commerce/vendors/:teamId/request', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				try {
					return c.json({
						ok: true,
						payload: await store.requestCommerceVendor(c.req.param('teamId'), {
							id: optionalTrimmedString(body.id),
							displayName: optionalTrimmedString(body.displayName),
							slug: optionalTrimmedString(body.slug),
							professionalEntitlementId: optionalTrimmedString(body.professionalEntitlementId),
							metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
							reason: optionalTrimmedString(body.reason),
							evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
							actorType: 'user',
							actorId: access.principal.id ?? null,
						}),
					});
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.post('/v1/commerce/vendors/:vendorId/approve', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				if (!principalIsSeedAdmin(auth.principal)) {
					return jsonError(c, 403, 'Permission denied.', { permission: 'commerce:approve:global' });
				}
				const body = await c.req.json().catch(() => ({}));
				try {
					const vendor = await store.approveCommerceVendor(c.req.param('vendorId'), {
						trustLevel: optionalTrimmedString(body.trustLevel),
						salesEnabled: body.salesEnabled !== false,
						serviceSalesEnabled: body.serviceSalesEnabled === true,
						capacityListingsEnabled: body.capacityListingsEnabled === true,
						reason: optionalTrimmedString(body.reason),
						evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
						actorType: 'operator',
						actorId: auth.principal.id ?? null,
					});
					if (!vendor) return jsonError(c, 404, `Unknown commerce vendor "${c.req.param('vendorId')}".`);
					return c.json({ ok: true, payload: vendor });
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.post('/v1/commerce/vendors/:teamId/stripe/onboarding', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				try {
					if (!await stripeConnectService.isConfigured()) throw stripeConfiguredError();
					const vendor = await requireCommerceVendorForStripe(store, c.req.param('teamId'));
					const environment = stripeConnectService.environment ?? resolveStripeEnvironment(runtime.resolved.config);
					let account = await store.getCommerceVendorStripeAccount(vendor.id, environment);
					if (!account) {
						const team = await store.getTeam(vendor.teamId).catch(() => null);
						const stripeAccount = await stripeConnectService.createExpressAccount({ vendor, team });
						if (!stripeAccount?.id) throw stripeConfiguredError();
						account = await store.createCommerceVendorStripeAccount(vendor.id, {
							...stripeAccountToConnectedAccountPatch(stripeAccount, environment),
							actorType: 'user',
							actorId: access.principal.id ?? null,
							evidence: { environment, provider: 'stripe_connect_express' },
						});
					}
					const returnUrl = optionalTrimmedString(body.returnUrl)
						?? stripeCommerceUrl(runtime.resolved.config, vendor.teamId, 'returned');
					const refreshUrl = optionalTrimmedString(body.refreshUrl)
						?? stripeCommerceUrl(runtime.resolved.config, vendor.teamId, 'refresh');
					const link = await stripeConnectService.createOnboardingLink({
						stripeAccountId: account.stripeAccountId,
						returnUrl,
						refreshUrl,
					});
					if (!link?.url) throw stripeConfiguredError();
					account = await store.markCommerceStripeOnboardingStarted(account.id, {
						actorType: 'user',
						actorId: access.principal.id ?? null,
						evidence: { environment },
					});
					return c.json({ ok: true, payload: { account, onboardingUrl: link.url } });
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.get('/v1/commerce/vendors/:teamId/stripe/status', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				try {
					const vendor = await store.getCommerceVendorForTeam(c.req.param('teamId'));
					if (!vendor) return c.json({ ok: true, payload: null });
					const environment = stripeConnectService.environment ?? resolveStripeEnvironment(runtime.resolved.config);
					let account = await store.getCommerceVendorStripeAccount(vendor.id, environment);
					if (account && c.req.query('refresh') === '1') {
						account = await refreshCommerceStripeAccount({
							store,
							stripeConnectService,
							account,
							actorType: 'user',
							actorId: access.principal.id ?? null,
						});
					}
					return c.json({ ok: true, payload: account });
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.post('/v1/commerce/vendors/:teamId/stripe/return', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				try {
					const vendor = await requireCommerceVendorForStripe(store, c.req.param('teamId'));
					const environment = stripeConnectService.environment ?? resolveStripeEnvironment(runtime.resolved.config);
					let account = await store.getCommerceVendorStripeAccount(vendor.id, environment);
					if (!account) throw stripeAccountMissingError();
					account = await store.markCommerceStripeOnboardingReturned(account.id, {
						actorType: 'user',
						actorId: access.principal.id ?? null,
						evidence: { environment },
					});
					account = await refreshCommerceStripeAccount({
						store,
						stripeConnectService,
						account,
						actorType: 'user',
						actorId: access.principal.id ?? null,
					});
					return c.json({ ok: true, payload: account });
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.post('/v1/commerce/vendors/:teamId/stripe/login-link', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				try {
					if (!await stripeConnectService.isConfigured()) throw stripeConfiguredError();
					const vendor = await requireCommerceVendorForStripe(store, c.req.param('teamId'));
					const environment = stripeConnectService.environment ?? resolveStripeEnvironment(runtime.resolved.config);
					const account = await store.getCommerceVendorStripeAccount(vendor.id, environment);
					if (!account) throw stripeAccountMissingError();
					const link = await stripeConnectService.createLoginLink(account.stripeAccountId);
					if (!link?.url) throw stripeConfiguredError();
					await store.recordCommerceGovernanceEvent({
						actorType: 'user',
						actorId: access.principal.id ?? null,
						action: 'commerce_vendor.stripe_login_link.created',
						objectType: 'commerce_vendor',
						objectId: vendor.id,
						priorState: account.accountStatus,
						nextState: account.accountStatus,
						evidence: { environment },
						relatedTeamId: vendor.teamId,
					});
					return c.json({ ok: true, payload: { account, loginUrl: link.url } });
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.get('/v1/commerce/stripe/config', async (c) => {
				const publishableKey = resolveStripePublishableKey(runtime.resolved.config);
				try {
					if (!publishableKey || !await stripeConnectService.isConfigured()) {
						return jsonError(c, 409, 'Stripe checkout is not configured for this market.');
					}
					return c.json({
						ok: true,
						payload: {
							publishableKey,
							environment: stripeConnectService.environment ?? resolveStripeEnvironment(runtime.resolved.config),
						},
					});
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.post('/v1/commerce/cart', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const body = await c.req.json().catch(() => ({}));
				const buyerTeamId = optionalTrimmedString(body.buyerTeamId);
				if (buyerTeamId) {
					const access = await requireTeamAccess(c, store, buyerTeamId, 'projects:read:team');
					if (access.response) return access.response;
				}
				try {
					return c.json({ ok: true, payload: await store.createCommerceCart(auth.principal, {
						buyerTeamId,
						buyerUserId: auth.principal.id ?? null,
						currency: optionalTrimmedString(body.currency),
						metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
					}) });
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.get('/v1/commerce/cart/:cartId', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const cart = await store.getCommerceCart(c.req.param('cartId'));
				if (!cart) return jsonError(c, 404, `Unknown commerce cart "${c.req.param('cartId')}".`);
				if (cart.buyerTeamId) {
					const access = await requireTeamAccess(c, store, cart.buyerTeamId, 'projects:read:team');
					if (access.response && !principalIsSeedAdmin(auth.principal)) return access.response;
				} else if (cart.buyerUserId && cart.buyerUserId !== auth.principal.id && !principalIsSeedAdmin(auth.principal)) {
					return jsonError(c, 403, 'Permission denied.', { cartId: cart.id });
				}
				return c.json({ ok: true, payload: { cart, items: await store.listCommerceCartItems(cart.id) } });
			});

			app.post('/v1/commerce/cart/:cartId/items', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const cart = await store.getCommerceCart(c.req.param('cartId'));
				if (!cart) return jsonError(c, 404, `Unknown commerce cart "${c.req.param('cartId')}".`);
				if (cart.buyerTeamId) {
					const access = await requireTeamAccess(c, store, cart.buyerTeamId, 'projects:read:team');
					if (access.response && !principalIsSeedAdmin(auth.principal)) return access.response;
				} else if (cart.buyerUserId && cart.buyerUserId !== auth.principal.id && !principalIsSeedAdmin(auth.principal)) {
					return jsonError(c, 403, 'Permission denied.', { cartId: cart.id });
				}
				const body = await c.req.json().catch(() => ({}));
				try {
					return c.json({ ok: true, payload: await store.addCommerceCartItem(cart.id, {
						offerId: optionalTrimmedString(body.offerId),
						priceId: optionalTrimmedString(body.priceId),
						quantity: normalizeCheckoutQuantity(body.quantity),
						metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
						actorType: 'user',
						actorId: auth.principal.id ?? null,
					}) });
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.delete('/v1/commerce/cart/:cartId/items/:itemId', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const cart = await store.getCommerceCart(c.req.param('cartId'));
				if (!cart) return jsonError(c, 404, `Unknown commerce cart "${c.req.param('cartId')}".`);
				if (cart.buyerUserId && cart.buyerUserId !== auth.principal.id && !principalIsSeedAdmin(auth.principal)) {
					return jsonError(c, 403, 'Permission denied.', { cartId: cart.id });
				}
				return c.json({ ok: true, payload: await store.removeCommerceCartItem(c.req.param('itemId')) });
			});

			app.post('/v1/commerce/checkout', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const body = await c.req.json().catch(() => ({}));
				if (body.buyerTeamId) {
					const access = await requireTeamAccess(c, store, body.buyerTeamId, 'projects:read:team');
					if (access.response) return access.response;
				}
				try {
					const payload = await createCommerceCheckoutRun({
						store,
						stripeConnectService,
						principal: auth.principal,
						input: body,
					});
					return c.json({ ok: true, payload });
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.get('/v1/commerce/checkouts/:checkoutId', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const checkout = await store.getCommerceCheckout(c.req.param('checkoutId'));
				if (!checkout) return jsonError(c, 404, `Unknown commerce checkout "${c.req.param('checkoutId')}".`);
				if (checkout.buyerTeamId) {
					const access = await requireTeamAccess(c, store, checkout.buyerTeamId, 'projects:read:team');
					if (access.response && !principalIsSeedAdmin(auth.principal)) return access.response;
				} else if (checkout.buyerUserId && checkout.buyerUserId !== auth.principal.id && !principalIsSeedAdmin(auth.principal)) {
					return jsonError(c, 403, 'Permission denied.', { checkoutId: checkout.id });
				}
				const orders = await store.listCommerceCheckoutOrders(checkout.id);
				const paymentGroups = [];
				const entitlements = [];
				for (const order of orders) {
					const groups = await store.all?.(`SELECT * FROM commerce_payment_groups WHERE order_id = ?`, [order.id]).catch(() => []);
					paymentGroups.push(...groups.map((row) => {
						const group = {
							id: row.id,
							checkoutId: row.checkout_id,
							orderId: row.order_id,
							vendorId: row.vendor_id,
							sellerTeamId: row.seller_team_id,
							connectedAccountId: row.connected_account_id,
							groupKind: row.group_kind,
							billingInterval: row.billing_interval,
							status: row.status,
							currency: row.currency,
							subtotalAmount: Number(row.subtotal_amount ?? 0),
							totalAmount: Number(row.total_amount ?? 0),
							stripePaymentIntentId: row.stripe_payment_intent_id,
							stripeSubscriptionId: row.stripe_subscription_id,
							stripeCustomerId: row.stripe_customer_id,
							clientSecret: null,
							metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
							createdAt: row.created_at,
							updatedAt: row.updated_at,
						};
						return group;
					}));
					entitlements.push(...await store.listCommerceEntitlements(auth.principal, { orderId: order.id }));
				}
				return c.json({ ok: true, payload: { checkout, orders, paymentGroups, entitlements } });
			});

			app.post('/v1/commerce/payment-groups/:groupId/refresh', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				try {
					const group = await store.getCommercePaymentGroup(c.req.param('groupId'));
					if (!group) return jsonError(c, 404, `Unknown commerce payment group "${c.req.param('groupId')}".`);
					const order = await store.getCommerceOrder(group.orderId);
					if (!order) return jsonError(c, 404, `Unknown commerce order "${group.orderId}".`);
					if (order.buyerTeamId) {
						const access = await requireTeamAccess(c, store, order.buyerTeamId, 'projects:read:team');
						if (access.response && !principalIsSeedAdmin(auth.principal)) return access.response;
					} else if (order.buyerUserId && order.buyerUserId !== auth.principal.id && !principalIsSeedAdmin(auth.principal)) {
						return jsonError(c, 403, 'Permission denied.', { orderId: order.id });
					}
					const payload = await refreshCommercePaymentGroupState({ store, stripeConnectService, group });
					await updateCheckoutCompletionFromGroup(store, payload.group);
					const publicGroup = publicPaymentGroups([payload.group])[0];
					return c.json({
						ok: true,
						payload: {
							...payload,
							group: publicGroup,
							paymentGroup: publicGroup,
							clientSecret: payload.clientSecret ?? null,
						},
					});
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.post('/v1/commerce/services/requests', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const body = await c.req.json().catch(() => ({}));
				const buyerTeamId = optionalTrimmedString(body.buyerTeamId);
				if (buyerTeamId) {
					const access = await requireTeamAccess(c, store, buyerTeamId, 'projects:read:team');
					if (access.response) return access.response;
				}
				try {
					const request = await store.createCommerceServiceRequest(auth.principal, {
						buyerTeamId,
						offerId: optionalTrimmedString(body.offerId),
						requestedScope: optionalTrimmedString(body.requestedScope),
						accessNeeds: body.accessNeeds && typeof body.accessNeeds === 'object' ? body.accessNeeds : {},
						relatedProjectId: optionalTrimmedString(body.relatedProjectId),
						relatedWorkdayId: optionalTrimmedString(body.relatedWorkdayId),
						metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
						actorType: 'user',
						actorId: auth.principal.id ?? null,
					});
					return c.json({ ok: true, payload: request }, { status: 201 });
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.get('/v1/commerce/services/requests', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const sellerTeamId = optionalTrimmedString(c.req.query('sellerTeamId'));
				const buyerTeamId = optionalTrimmedString(c.req.query('buyerTeamId'));
				const filters = {
					sellerTeamId,
					buyerTeamId,
					status: optionalTrimmedString(c.req.query('status')),
					offerId: optionalTrimmedString(c.req.query('offerId')),
					relatedProjectId: optionalTrimmedString(c.req.query('relatedProjectId')),
					relatedWorkdayId: optionalTrimmedString(c.req.query('relatedWorkdayId')),
				};
				if (sellerTeamId && !principalIsSeedAdmin(auth.principal)) {
					const access = await requireTeamAccess(c, store, sellerTeamId, 'projects:read:team');
					if (access.response) return access.response;
				} else if (buyerTeamId && !principalIsSeedAdmin(auth.principal)) {
					const access = await requireTeamAccess(c, store, buyerTeamId, 'projects:read:team');
					if (access.response) return access.response;
				} else if (!principalIsSeedAdmin(auth.principal)) {
					filters.buyerUserId = auth.principal.id;
				}
				const requests = await store.listCommerceServiceRequests(auth.principal, filters);
				return c.json({ ok: true, payload: sellerTeamId ? requests : requests.map(redactCommerceServiceRequestForBuyer) });
			});

			app.get('/v1/commerce/services/requests/:requestId', async (c) => {
				const request = await store.getCommerceServiceRequest(c.req.param('requestId'));
				if (!request) return jsonError(c, 404, `Unknown commerce service request "${c.req.param('requestId')}".`);
				const access = await requireServiceParticipantAccess(c, store, request, 'projects:read:team');
				if (access.response) return access.response;
				const sellerAccess = principalIsSeedAdmin(access.principal)
					? { response: null }
					: await requireTeamAccess(c, store, request.sellerTeamId, 'projects:read:team');
				const sellerVisible = principalIsSeedAdmin(access.principal) || !sellerAccess.response;
				const quotes = await store.listCommerceServiceQuotes(request.id);
				const contract = request.contractId ? await store.getCommerceServiceContract(request.contractId) : null;
				const events = await store.listCommerceServiceEvents({ requestId: request.id });
				return c.json({
					ok: true,
					payload: {
						request: sellerVisible ? request : redactCommerceServiceRequestForBuyer(request),
						quotes,
						contract,
						events: sellerVisible ? events : events.map((event) => ({ ...event, evidence: {} })),
					},
				});
			});

			app.post('/v1/commerce/services/requests/:requestId/cancel', async (c) => {
				const request = await store.getCommerceServiceRequest(c.req.param('requestId'));
				if (!request) return jsonError(c, 404, `Unknown commerce service request "${c.req.param('requestId')}".`);
				const access = await requireServiceParticipantAccess(c, store, request, 'teams:manage:team');
				if (access.response) return access.response;
				if (['active', 'fulfilled'].includes(request.status)) return jsonError(c, 409, 'Active or fulfilled service requests cannot be canceled through request cancellation.');
				const body = await c.req.json().catch(() => ({}));
				const updated = await store.transitionCommerceServiceRequest(request.id, 'canceled', {
					eventType: 'canceled',
					action: 'commerce_service.canceled',
					reason: optionalTrimmedString(body.reason),
					evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
					actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
					actorId: access.principal.id ?? null,
				});
				return c.json({ ok: true, payload: updated });
			});

			app.post('/v1/commerce/services/requests/:requestId/scoping', async (c) => {
				const request = await store.getCommerceServiceRequest(c.req.param('requestId'));
				if (!request) return jsonError(c, 404, `Unknown commerce service request "${c.req.param('requestId')}".`);
				const access = await requireServiceSellerAccess(c, store, request, 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const updated = await store.updateCommerceServiceRequest(request.id, {
					status: 'scoping',
					approvedScope: optionalTrimmedString(body.approvedScope) ?? request.approvedScope,
					vendorPrivateNotes: optionalTrimmedString(body.vendorPrivateNotes) ?? request.vendorPrivateNotes,
					eventType: 'scoping_started',
					action: 'commerce_service.scoping_started',
					evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
					actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
					actorId: access.principal.id ?? null,
				});
				return c.json({ ok: true, payload: updated });
			});

			app.patch('/v1/commerce/services/requests/:requestId', async (c) => {
				const request = await store.getCommerceServiceRequest(c.req.param('requestId'));
				if (!request) return jsonError(c, 404, `Unknown commerce service request "${c.req.param('requestId')}".`);
				const access = await requireServiceSellerAccess(c, store, request, 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const updated = await store.updateCommerceServiceRequest(request.id, {
					approvedScope: body.approvedScope === undefined ? request.approvedScope : optionalTrimmedString(body.approvedScope),
					accessNeeds: body.accessNeeds && typeof body.accessNeeds === 'object' ? body.accessNeeds : request.accessNeeds,
					buyerVisibleSummary: body.buyerVisibleSummary === undefined ? request.buyerVisibleSummary : optionalTrimmedString(body.buyerVisibleSummary),
					vendorPrivateNotes: body.vendorPrivateNotes === undefined ? request.vendorPrivateNotes : optionalTrimmedString(body.vendorPrivateNotes),
					relatedProjectId: body.relatedProjectId === undefined ? request.relatedProjectId : optionalTrimmedString(body.relatedProjectId),
					relatedWorkdayId: body.relatedWorkdayId === undefined ? request.relatedWorkdayId : optionalTrimmedString(body.relatedWorkdayId),
					eventType: 'scope_updated',
					action: 'commerce_service.scope_updated',
					actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
					actorId: access.principal.id ?? null,
				});
				return c.json({ ok: true, payload: updated });
			});

			app.post('/v1/commerce/services/requests/:requestId/quotes', async (c) => {
				const request = await store.getCommerceServiceRequest(c.req.param('requestId'));
				if (!request) return jsonError(c, 404, `Unknown commerce service request "${c.req.param('requestId')}".`);
				const access = await requireServiceSellerAccess(c, store, request, 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				try {
					const quote = await store.createCommerceServiceQuote(request.id, {
						title: optionalTrimmedString(body.title),
						scopeSummary: optionalTrimmedString(body.scopeSummary),
						deliverables: Array.isArray(body.deliverables) ? body.deliverables : [],
						assumptions: Array.isArray(body.assumptions) ? body.assumptions : [],
						accessRequirements: body.accessRequirements && typeof body.accessRequirements === 'object' ? body.accessRequirements : {},
						governanceRequirements: body.governanceRequirements && typeof body.governanceRequirements === 'object' ? body.governanceRequirements : {},
						amount: body.amount,
						currency: optionalTrimmedString(body.currency),
						expiresAt: optionalTrimmedString(body.expiresAt),
						status: body.submit === true ? 'submitted' : 'draft',
						metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
						actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
						actorId: access.principal.id ?? null,
					});
					return c.json({ ok: true, payload: quote }, { status: 201 });
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.get('/v1/commerce/services/requests/:requestId/quotes', async (c) => {
				const request = await store.getCommerceServiceRequest(c.req.param('requestId'));
				if (!request) return jsonError(c, 404, `Unknown commerce service request "${c.req.param('requestId')}".`);
				const access = await requireServiceParticipantAccess(c, store, request, 'projects:read:team');
				if (access.response) return access.response;
				return c.json({ ok: true, payload: await store.listCommerceServiceQuotes(request.id) });
			});

			app.post('/v1/commerce/services/quotes/:quoteId/submit', async (c) => {
				const quote = await store.getCommerceServiceQuote(c.req.param('quoteId'));
				if (!quote) return jsonError(c, 404, `Unknown commerce service quote "${c.req.param('quoteId')}".`);
				const request = await store.getCommerceServiceRequest(quote.requestId);
				const access = await requireServiceSellerAccess(c, store, request, 'teams:manage:team');
				if (access.response) return access.response;
				try {
					return c.json({ ok: true, payload: await store.submitCommerceServiceQuote(quote.id, {
						actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
						actorId: access.principal.id ?? null,
					}) });
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.post('/v1/commerce/services/quotes/:quoteId/buyer-approve', async (c) => {
				const quote = await store.getCommerceServiceQuote(c.req.param('quoteId'));
				if (!quote) return jsonError(c, 404, `Unknown commerce service quote "${c.req.param('quoteId')}".`);
				const request = await store.getCommerceServiceRequest(quote.requestId);
				const access = await requireServiceBuyerAccess(c, store, request);
				if (access.response) return access.response;
				try {
					return c.json({ ok: true, payload: await store.approveCommerceServiceQuoteByBuyer(quote.id, {
						actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
						actorId: access.principal.id ?? null,
					}) });
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.post('/v1/commerce/services/quotes/:quoteId/vendor-approve', async (c) => {
				const quote = await store.getCommerceServiceQuote(c.req.param('quoteId'));
				if (!quote) return jsonError(c, 404, `Unknown commerce service quote "${c.req.param('quoteId')}".`);
				const request = await store.getCommerceServiceRequest(quote.requestId);
				const access = await requireServiceSellerAccess(c, store, request, 'teams:manage:team');
				if (access.response) return access.response;
				try {
					return c.json({ ok: true, payload: {
						quote: await store.approveCommerceServiceQuoteByVendor(quote.id, {
							actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
							actorId: access.principal.id ?? null,
						}),
						contract: await store.getCommerceServiceContractForRequest(request.id),
					} });
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.post('/v1/commerce/services/quotes/:quoteId/reject', async (c) => {
				const quote = await store.getCommerceServiceQuote(c.req.param('quoteId'));
				if (!quote) return jsonError(c, 404, `Unknown commerce service quote "${c.req.param('quoteId')}".`);
				const request = await store.getCommerceServiceRequest(quote.requestId);
				const access = await requireServiceParticipantAccess(c, store, request, 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				try {
					return c.json({ ok: true, payload: await store.rejectCommerceServiceQuote(quote.id, {
						reason: optionalTrimmedString(body.reason),
						evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
						actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
						actorId: access.principal.id ?? null,
					}) });
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.get('/v1/commerce/services/contracts/:contractId', async (c) => {
				const contract = await store.getCommerceServiceContract(c.req.param('contractId'));
				if (!contract) return jsonError(c, 404, `Unknown commerce service contract "${c.req.param('contractId')}".`);
				const request = await store.getCommerceServiceRequest(contract.requestId);
				const access = await requireServiceParticipantAccess(c, store, request, 'projects:read:team');
				if (access.response) return access.response;
				return c.json({ ok: true, payload: contract });
			});

			app.post('/v1/commerce/services/contracts/:contractId/checkout', async (c) => {
				const contract = await store.getCommerceServiceContract(c.req.param('contractId'));
				if (!contract) return jsonError(c, 404, `Unknown commerce service contract "${c.req.param('contractId')}".`);
				const request = await store.getCommerceServiceRequest(contract.requestId);
				const access = await requireServiceBuyerAccess(c, store, request);
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				try {
					return c.json({ ok: true, payload: await createCommerceCheckoutRunForServiceContract({
						store,
						stripeConnectService,
						principal: access.principal,
						contractId: contract.id,
						input: body,
					}) });
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.post('/v1/commerce/services/contracts/:contractId/link-work', async (c) => {
				const contract = await store.getCommerceServiceContract(c.req.param('contractId'));
				if (!contract) return jsonError(c, 404, `Unknown commerce service contract "${c.req.param('contractId')}".`);
				const request = await store.getCommerceServiceRequest(contract.requestId);
				const access = await requireServiceSellerAccess(c, store, request, 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				return c.json({ ok: true, payload: await store.linkCommerceServiceContractWork(contract.id, {
					relatedProjectId: optionalTrimmedString(body.relatedProjectId),
					relatedWorkdayId: optionalTrimmedString(body.relatedWorkdayId),
					metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : contract.metadata,
					actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
					actorId: access.principal.id ?? null,
				}) });
			});

			app.post('/v1/commerce/services/contracts/:contractId/fulfill', async (c) => {
				const contract = await store.getCommerceServiceContract(c.req.param('contractId'));
				if (!contract) return jsonError(c, 404, `Unknown commerce service contract "${c.req.param('contractId')}".`);
				if (contract.status !== 'active') return jsonError(c, 409, 'Only active scoped service contracts can be fulfilled.');
				const request = await store.getCommerceServiceRequest(contract.requestId);
				const access = await requireServiceSellerAccess(c, store, request, 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const event = await store.createCommerceFulfillmentEvent({
					orderId: contract.orderId,
					orderItemId: contract.orderItemId,
					entitlementId: contract.entitlementId,
					vendorId: contract.vendorId,
					sellerTeamId: contract.sellerTeamId,
					productId: contract.productId,
					productVersionId: null,
					catalogItemId: null,
					eventType: Array.isArray(body.deliveryRefs) && body.deliveryRefs.length ? 'artifact_delivered' : 'manual_status',
					status: 'delivered',
					artifactRefs: Array.isArray(body.artifactRefs) ? body.artifactRefs : [],
					deliveryRefs: Array.isArray(body.deliveryRefs) ? body.deliveryRefs : [],
					message: optionalTrimmedString(body.summary),
					metadata: { serviceRequestId: contract.requestId, serviceContractId: contract.id, ...(body.metadata && typeof body.metadata === 'object' ? body.metadata : {}) },
					actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
					actorId: access.principal.id ?? 'system',
				});
				const updated = await store.fulfillCommerceServiceContract(contract.id, {
					summary: optionalTrimmedString(body.summary),
					metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : contract.metadata,
					actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
					actorId: access.principal.id ?? null,
				});
				if (contract.orderItemId) await store.updateCommerceOrderItemStatus(contract.orderItemId, { status: 'fulfilled' });
				if (contract.entitlementId) {
					const entitlement = await store.getCommerceEntitlement(contract.entitlementId);
					if (entitlement) {
						await store.updateCommerceEntitlementFulfillment(entitlement.id, {
							fulfillmentArtifactRefs: [
								...(entitlement.fulfillmentArtifactRefs ?? []),
								...(Array.isArray(body.deliveryRefs) ? body.deliveryRefs.map((entry) => entry.path ?? entry.url ?? JSON.stringify(entry)) : []),
							],
							metadata: entitlement.metadata,
						});
					}
				}
				return c.json({ ok: true, payload: { contract: updated, event } });
			});

			app.post('/v1/commerce/services/contracts/:contractId/cancel', async (c) => {
				const contract = await store.getCommerceServiceContract(c.req.param('contractId'));
				if (!contract) return jsonError(c, 404, `Unknown commerce service contract "${c.req.param('contractId')}".`);
				const request = await store.getCommerceServiceRequest(contract.requestId);
				const access = await requireServiceParticipantAccess(c, store, request, 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				return c.json({ ok: true, payload: await store.cancelCommerceServiceContract(contract.id, {
					reason: optionalTrimmedString(body.reason),
					evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
					actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
					actorId: access.principal.id ?? null,
				}) });
			});

			app.get('/v1/commerce/services/events', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const requestId = optionalTrimmedString(c.req.query('requestId'));
				if (!requestId && !principalIsSeedAdmin(auth.principal)) return jsonError(c, 400, 'requestId is required.');
				if (requestId) {
					const request = await store.getCommerceServiceRequest(requestId);
					if (!request) return jsonError(c, 404, `Unknown commerce service request "${requestId}".`);
					const access = await requireServiceParticipantAccess(c, store, request, 'projects:read:team');
					if (access.response) return access.response;
					const sellerAccess = principalIsSeedAdmin(access.principal)
						? { response: null }
						: await requireTeamAccess(c, store, request.sellerTeamId, 'projects:read:team');
					const events = await store.listCommerceServiceEvents({ requestId });
					return c.json({ ok: true, payload: sellerAccess.response ? events.map((event) => ({ ...event, evidence: {} })) : events });
				}
				return c.json({ ok: true, payload: await store.listCommerceServiceEvents({
					eventType: optionalTrimmedString(c.req.query('eventType')),
				}) });
			});

			app.get('/v1/commerce/orders', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const filters = {
					buyerTeamId: optionalTrimmedString(c.req.query('buyerTeamId')),
					vendorId: optionalTrimmedString(c.req.query('vendorId')),
					status: optionalTrimmedString(c.req.query('status')),
					checkoutId: optionalTrimmedString(c.req.query('checkoutId')),
				};
				if (filters.buyerTeamId && !principalIsSeedAdmin(auth.principal)) {
					const access = await requireTeamAccess(c, store, filters.buyerTeamId, 'projects:read:team');
					if (access.response) return access.response;
				}
				if (!filters.buyerTeamId && !filters.vendorId && !principalIsSeedAdmin(auth.principal)) {
					filters.buyerUserId = auth.principal.id;
				}
				return c.json({ ok: true, payload: await store.listCommerceOrders(auth.principal, filters) });
			});

			app.get('/v1/commerce/orders/:orderId', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const order = await store.getCommerceOrder(c.req.param('orderId'));
				if (!order) return jsonError(c, 404, `Unknown commerce order "${c.req.param('orderId')}".`);
				if (order.buyerTeamId && !principalIsSeedAdmin(auth.principal)) {
					const access = await requireTeamAccess(c, store, order.buyerTeamId, 'projects:read:team');
					if (access.response && order.buyerUserId !== auth.principal.id) return access.response;
				} else if (order.buyerUserId && order.buyerUserId !== auth.principal.id && !principalIsSeedAdmin(auth.principal)) {
					return jsonError(c, 403, 'Permission denied.', { orderId: order.id });
				}
				return c.json({ ok: true, payload: { order, items: await store.listCommerceOrderItems(order.id) } });
			});

			app.get('/v1/commerce/vendors/:teamId/sales/summary', async (c) => {
				const access = await requireSellerTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({ ok: true, payload: await store.getCommerceVendorSalesSummary(c.req.param('teamId'), {}) });
			});

			app.get('/v1/commerce/vendors/:teamId/monitoring', async (c) => {
				const access = await requireSellerTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({ ok: true, payload: await store.getCommerceVendorCommerceMonitor(c.req.param('teamId'), {}) });
			});

			app.get('/v1/commerce/vendors/:teamId/sales/orders', async (c) => {
				const access = await requireSellerTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({ ok: true, payload: await store.listCommerceVendorSalesOrders(c.req.param('teamId'), {
					status: optionalTrimmedString(c.req.query('status')),
				}) });
			});

			app.get('/v1/commerce/vendors/:teamId/sales/subscriptions', async (c) => {
				const access = await requireSellerTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({ ok: true, payload: await store.listCommerceVendorSalesSubscriptions(c.req.param('teamId'), {}) });
			});

			app.get('/v1/commerce/vendors/:teamId/sales/entitlements', async (c) => {
				const access = await requireSellerTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({ ok: true, payload: await store.listCommerceVendorSalesEntitlements(c.req.param('teamId'), {
					status: optionalTrimmedString(c.req.query('status')),
				}) });
			});

			app.get('/v1/commerce/vendors/:teamId/sales/refunds', async (c) => {
				const access = await requireSellerTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({ ok: true, payload: await store.listCommerceRefunds(access.principal, {
					sellerTeamId: c.req.param('teamId'),
					status: optionalTrimmedString(c.req.query('status')),
				}) });
			});

			app.get('/v1/commerce/vendors/:teamId/sales/fulfillment-events', async (c) => {
				const access = await requireSellerTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
				if (access.response) return access.response;
				return c.json({ ok: true, payload: await store.listCommerceFulfillmentEvents({
					sellerTeamId: c.req.param('teamId'),
					status: optionalTrimmedString(c.req.query('status')),
				}) });
			});

			app.get('/v1/commerce/orders/:orderId/refunds', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const order = await store.getCommerceOrder(c.req.param('orderId'));
				if (!order) return jsonError(c, 404, `Unknown commerce order "${c.req.param('orderId')}".`);
				if (order.sellerTeamId) {
					const sellerAccess = await requireSellerTeamAccess(c, store, order.sellerTeamId, 'projects:read:team');
					if (!sellerAccess.response || principalIsSeedAdmin(auth.principal)) {
						return c.json({ ok: true, payload: await store.listCommerceRefunds(auth.principal, { orderId: order.id }) });
					}
				}
				if (order.buyerTeamId) {
					const access = await requireTeamAccess(c, store, order.buyerTeamId, 'projects:read:team');
					if (access.response && order.buyerUserId !== auth.principal.id) return access.response;
				} else if (order.buyerUserId && order.buyerUserId !== auth.principal.id && !principalIsSeedAdmin(auth.principal)) {
					return jsonError(c, 403, 'Permission denied.', { orderId: order.id });
				}
				return c.json({ ok: true, payload: await store.listCommerceRefunds(auth.principal, { orderId: order.id }) });
			});

			app.post('/v1/commerce/orders/:orderId/refunds', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const order = await store.getCommerceOrder(c.req.param('orderId'));
				if (!order) return jsonError(c, 404, `Unknown commerce order "${c.req.param('orderId')}".`);
				const access = await requireVendorOrderManager(c, store, order);
				if (access.response) return access.response;
				const vendor = order.sellerTeamId ? await store.getCommerceVendorForTeam(order.sellerTeamId) : null;
				if (!vendor || vendor.status !== 'approved') return jsonError(c, 409, 'Approved vendor status is required before refunds.');
				const body = await c.req.json().catch(() => ({}));
				const idempotencyKey = optionalTrimmedString(body.idempotencyKey) ?? null;
				if (idempotencyKey) {
					const existingRefund = await store.getCommerceRefundByIdempotencyKey(idempotencyKey);
					if (existingRefund) return c.json({ ok: true, payload: existingRefund });
				}
				if (!['paid', 'partially_refunded'].includes(order.status)) return jsonError(c, 409, 'Only paid commerce orders can be refunded.');
				if (!order.stripePaymentIntentId || !order.stripeConnectedAccountId) return jsonError(c, 409, 'Only PaymentIntent-backed one-time orders can be refunded in Phase 6.');
				if (order.stripeSubscriptionId) return jsonError(c, 409, 'Subscription invoice refunds are deferred until invoice payment mapping is modeled.');
				try {
					const orderItem = await resolveOrderItemForRefund(store, order, optionalTrimmedString(body.orderItemId));
					const remaining = remainingRefundableAmount(order, orderItem);
					const amount = body.amount === undefined || body.amount === null ? remaining : Number(body.amount);
					if (!Number.isFinite(amount) || amount <= 0) return jsonError(c, 400, 'Refund amount must be positive.');
					if (amount > remaining) return jsonError(c, 409, 'Refund amount exceeds remaining refundable amount.');
					const finalIdempotencyKey = idempotencyKey ?? `commerce-refund-${order.id}-${orderItem?.id ?? 'order'}-${amount}-${randomUUID()}`;
					let refund = await store.createCommerceRefund({
						orderId: order.id,
						orderItemId: orderItem?.id ?? null,
						vendorId: order.vendorId,
						sellerTeamId: order.sellerTeamId,
						buyerTeamId: order.buyerTeamId,
						buyerUserId: order.buyerUserId,
						amount,
						currency: order.currency,
						status: 'processing',
						reason: optionalTrimmedString(body.reason),
						stripePaymentIntentId: order.stripePaymentIntentId,
						stripeConnectedAccountId: order.stripeConnectedAccountId,
						idempotencyKey: finalIdempotencyKey,
						requestedByType: principalIsSeedAdmin(auth.principal) ? 'operator' : 'user',
						requestedById: auth.principal.id ?? 'system',
						metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
						actorType: principalIsSeedAdmin(auth.principal) ? 'operator' : 'user',
						actorId: auth.principal.id ?? null,
					});
					const stripeRefund = await stripeConnectService.createRefund({
						connectedAccountId: order.stripeConnectedAccountId,
						idempotencyKey: finalIdempotencyKey,
						params: {
							payment_intent: order.stripePaymentIntentId,
							amount,
							metadata: {
								treeseed_refund_id: refund.id,
								treeseed_order_id: order.id,
								treeseed_order_item_id: orderItem?.id ?? '',
								treeseed_vendor_id: order.vendorId ?? '',
								treeseed_seller_team_id: order.sellerTeamId ?? '',
							},
						},
					});
					if (!stripeRefund) return jsonError(c, 409, 'Stripe is not configured for refunds.');
					refund = await store.updateCommerceRefundFromStripe(refund.id, {
						status: stripeRefundStatus(stripeRefund.status),
						stripeRefundId: stripeRefund.id,
						metadata: { ...refund.metadata, stripeStatus: stripeRefund.status },
						actorType: principalIsSeedAdmin(auth.principal) ? 'operator' : 'user',
						actorId: auth.principal.id ?? null,
					});
					if (refund.status === 'succeeded') {
						await applyCommerceRefundState({
							store,
							order,
							orderItem,
							amount,
							fullRefund: amount >= remainingRefundableAmount(order, null),
						});
					}
					return c.json({ ok: true, payload: { refund, order: await store.getCommerceOrder(order.id), items: await store.listCommerceOrderItems(order.id) } });
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.post('/v1/commerce/order-items/:orderItemId/fulfillment/artifact', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const orderItem = await store.first?.(`SELECT * FROM commerce_order_items WHERE id = ? LIMIT 1`, [c.req.param('orderItemId')]).then((row) => row ? {
					id: row.id,
					orderId: row.order_id,
					vendorId: row.vendor_id,
					sellerTeamId: row.seller_team_id,
					productId: row.product_id,
					productVersionId: row.product_version_id,
					entitlementId: row.entitlement_id,
					status: row.status,
					metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
				} : null);
				if (!orderItem) return jsonError(c, 404, `Unknown commerce order item "${c.req.param('orderItemId')}".`);
				const access = await requireTeamAccess(c, store, orderItem.sellerTeamId, 'teams:manage:team');
				if (access.response && !principalIsSeedAdmin(auth.principal)) return access.response;
				if (orderItem.status !== 'paid' && orderItem.status !== 'fulfilled') return jsonError(c, 409, 'Only paid commerce order items can be fulfilled.');
				if (!orderItem.entitlementId) return jsonError(c, 409, 'An active entitlement is required before fulfillment.');
				const entitlement = await store.getCommerceEntitlement(orderItem.entitlementId);
				if (!entitlement || entitlement.status !== 'active') return jsonError(c, 409, 'An active entitlement is required before fulfillment.');
				const body = await c.req.json().catch(() => ({}));
				const resolved = await resolveFulfillmentArtifact({ store, orderItem, body });
				const event = await store.createCommerceFulfillmentEvent({
					orderId: orderItem.orderId,
					orderItemId: orderItem.id,
					entitlementId: entitlement.id,
					vendorId: orderItem.vendorId,
					sellerTeamId: orderItem.sellerTeamId,
					productId: orderItem.productId,
					productVersionId: orderItem.productVersionId,
					catalogItemId: resolved.catalogItemId,
					catalogArtifactVersionId: resolved.artifact?.id ?? optionalTrimmedString(body.catalogArtifactVersionId),
					eventType: 'artifact_delivered',
					status: 'delivered',
					artifactRefs: resolved.artifactRefs,
					deliveryRefs: resolved.deliveryRefs,
					message: optionalTrimmedString(body.message),
					actorType: principalIsSeedAdmin(auth.principal) ? 'operator' : 'user',
					actorId: auth.principal.id ?? 'system',
				});
				await store.markCommerceOrderItemFulfilled(orderItem.id, { metadata: orderItem.metadata });
				const refs = [...(entitlement.fulfillmentArtifactRefs ?? []), ...resolved.deliveryRefs.map((entry) => entry.path ?? entry.url ?? JSON.stringify(entry))];
				const updatedEntitlement = await store.updateCommerceEntitlementFulfillment(entitlement.id, {
					fulfillmentArtifactRefs: refs,
					metadata: entitlement.metadata,
				});
				return c.json({ ok: true, payload: { event, entitlement: updatedEntitlement } });
			});

			app.post('/v1/commerce/entitlements/:entitlementId/revoke', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const entitlement = await store.getCommerceEntitlement(c.req.param('entitlementId'));
				if (!entitlement) return jsonError(c, 404, `Unknown commerce entitlement "${c.req.param('entitlementId')}".`);
				const access = await requireTeamAccess(c, store, entitlement.sellerTeamId, 'teams:manage:team');
				if (access.response && !principalIsSeedAdmin(auth.principal)) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const updated = await store.revokeCommerceEntitlement(entitlement.id, {
					reason: optionalTrimmedString(body.reason),
					renewalState: 'canceled',
					actorType: principalIsSeedAdmin(auth.principal) ? 'operator' : 'user',
					actorId: auth.principal.id ?? null,
				});
				if (entitlement.orderItemId) {
					await store.updateCommerceOrderItemStatus(entitlement.orderItemId, { status: 'revoked' });
				}
				return c.json({ ok: true, payload: updated });
			});

			app.get('/v1/commerce/entitlements', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const filters = {
					buyerTeamId: optionalTrimmedString(c.req.query('buyerTeamId')),
					productId: optionalTrimmedString(c.req.query('productId')),
					offerId: optionalTrimmedString(c.req.query('offerId')),
					status: optionalTrimmedString(c.req.query('status')),
				};
				if (filters.buyerTeamId && !principalIsSeedAdmin(auth.principal)) {
					const access = await requireTeamAccess(c, store, filters.buyerTeamId, 'projects:read:team');
					if (access.response) return access.response;
				}
				if (!filters.buyerTeamId && !principalIsSeedAdmin(auth.principal)) {
					filters.buyerUserId = auth.principal.id;
				}
				return c.json({ ok: true, payload: await store.listCommerceEntitlements(auth.principal, filters) });
			});

			app.get('/v1/commerce/entitlements/:entitlementId', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const entitlement = await store.getCommerceEntitlement(c.req.param('entitlementId'));
				if (!entitlement) return jsonError(c, 404, `Unknown commerce entitlement "${c.req.param('entitlementId')}".`);
				if (entitlement.buyerTeamId && !principalIsSeedAdmin(auth.principal)) {
					const access = await requireTeamAccess(c, store, entitlement.buyerTeamId, 'projects:read:team');
					if (access.response && entitlement.buyerUserId !== auth.principal.id) return access.response;
				} else if (entitlement.buyerUserId && entitlement.buyerUserId !== auth.principal.id && !principalIsSeedAdmin(auth.principal)) {
					return jsonError(c, 403, 'Permission denied.', { entitlementId: entitlement.id });
				}
				return c.json({ ok: true, payload: entitlement });
			});

			app.post('/v1/commerce/webhooks/stripe', async (c) => {
				const webhookSecret = resolveStripeWebhookSecret(runtime.resolved.config);
				if (!webhookSecret) return jsonError(c, 409, 'Stripe webhook verification is not configured for this market.');
				const signature = c.req.header('stripe-signature');
				if (!signature) return jsonError(c, 400, 'Stripe-Signature header is required.');
				const payload = await c.req.text();
				try {
					const event = await stripeConnectService.constructWebhookEvent({ payload, signature, webhookSecret });
					const environment = stripeConnectService.environment ?? resolveStripeEnvironment(runtime.resolved.config);
					const object = event?.data?.object ?? {};
					const webhook = await store.recordCommerceWebhookEvent({
						provider: 'stripe',
						environment,
						eventId: event.id,
						eventType: event.type,
						connectedAccountId: optionalTrimmedString(event.account) ?? optionalTrimmedString(event.context) ?? null,
						status: 'received',
						objectType: object.object ?? null,
						objectId: object.id ?? null,
						payloadHash: createHash('sha256').update(payload).digest('hex'),
					});
					if (webhook.status === 'processed' || webhook.status === 'ignored') {
						return c.json({ ok: true, payload: webhook });
					}
					const claimed = await store.claimCommerceWebhookEvent(webhook.id);
					if (!claimed || claimed.status === 'processed') return c.json({ ok: true, payload: claimed ?? webhook });
					const result = await processCommerceStripeWebhook({ store, stripeConnectService, event });
					const updated = result.ignored
						? await store.markCommerceWebhookEventIgnored(webhook.id, {
							processingError: result.reason,
							relatedOrderId: result.relatedOrderId,
							relatedSubscriptionId: result.relatedSubscriptionId,
						})
						: await store.markCommerceWebhookEventProcessed(webhook.id, {
							relatedOrderId: result.relatedOrderId,
							relatedSubscriptionId: result.relatedSubscriptionId,
						});
					return c.json({ ok: true, payload: updated });
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.get('/v1/commerce/products', async (c) => {
				return c.json({
					ok: true,
					payload: await store.listCommerceProducts(c.get('principal'), {
						teamId: optionalTrimmedString(c.req.query('teamId')),
						vendorId: optionalTrimmedString(c.req.query('vendorId')),
						kind: optionalTrimmedString(c.req.query('kind')),
						status: optionalTrimmedString(c.req.query('status')),
						slug: optionalTrimmedString(c.req.query('slug')),
					}),
				});
			});

			app.post('/v1/commerce/products', async (c) => {
				const body = await c.req.json().catch(() => ({}));
				const sellerTeamId = optionalTrimmedString(body.sellerTeamId);
				if (!sellerTeamId) return jsonError(c, 400, 'sellerTeamId is required.');
				const access = await requireTeamAccess(c, store, sellerTeamId, 'teams:manage:team');
				if (access.response) return access.response;
				try {
					return c.json({
						ok: true,
						payload: await store.createCommerceProductDraft(sellerTeamId, {
							id: optionalTrimmedString(body.id),
							kind: optionalTrimmedString(body.kind),
							slug: optionalTrimmedString(body.slug),
							title: optionalTrimmedString(body.title),
							summary: optionalTrimmedString(body.summary),
							description: optionalTrimmedString(body.description),
							visibility: optionalTrimmedString(body.visibility),
							ownershipModel: optionalTrimmedString(body.ownershipModel),
							ownership: body.ownership && typeof body.ownership === 'object' ? body.ownership : undefined,
							supportPolicy: optionalTrimmedString(body.supportPolicy),
							license: optionalTrimmedString(body.license),
							metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
						}),
					});
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.get('/v1/commerce/products/:productId', async (c) => {
				const access = await requireCommerceProductAccess(c, store, c.req.param('productId'));
				if (access.response) return access.response;
				return c.json({ ok: true, payload: access.product });
			});

			app.patch('/v1/commerce/products/:productId', async (c) => {
				const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				try {
					return c.json({
						ok: true,
						payload: await store.updateCommerceProduct(access.product.id, {
							kind: optionalTrimmedString(body.kind),
							slug: optionalTrimmedString(body.slug),
							title: optionalTrimmedString(body.title),
							summary: body.summary === undefined ? undefined : optionalTrimmedString(body.summary),
							description: body.description === undefined ? undefined : optionalTrimmedString(body.description),
							visibility: optionalTrimmedString(body.visibility),
							ownershipModel: optionalTrimmedString(body.ownershipModel),
							supportPolicy: body.supportPolicy === undefined ? undefined : optionalTrimmedString(body.supportPolicy),
							license: body.license === undefined ? undefined : optionalTrimmedString(body.license),
							metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
						}),
					});
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.post('/v1/commerce/products/:productId/submit', async (c) => {
				const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				try {
					return c.json({ ok: true, payload: await store.submitCommerceProduct(access.product.id, {
						reason: optionalTrimmedString(body.reason),
						evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
						actorType: 'user',
						actorId: access.principal.id ?? null,
					}) });
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.post('/v1/commerce/products/:productId/approve', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				if (!principalIsSeedAdmin(auth.principal)) return jsonError(c, 403, 'Permission denied.', { permission: 'commerce:approve:global' });
				const body = await c.req.json().catch(() => ({}));
				try {
					const product = await store.approveCommerceProduct(c.req.param('productId'), {
						reason: optionalTrimmedString(body.reason),
						evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
						actorType: 'operator',
						actorId: auth.principal.id ?? null,
					});
					if (!product) return jsonError(c, 404, `Unknown commerce product "${c.req.param('productId')}".`);
					return c.json({ ok: true, payload: product });
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.post('/v1/commerce/products/:productId/ownership', async (c) => {
				const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				const ownership = await store.createCommerceOwnershipRecord(access.product.id, body);
				await store.setCurrentCommerceOwnershipRecord(access.product.id, ownership.id);
				return c.json({ ok: true, payload: ownership });
			});

			app.get('/v1/commerce/products/:productId/ownership', async (c) => {
				const access = await requireCommerceProductAccess(c, store, c.req.param('productId'));
				if (access.response) return access.response;
				return c.json({ ok: true, payload: await store.listCommerceOwnershipRecords(access.product.id) });
			});

			app.patch('/v1/commerce/products/:productId/ownership/:ownershipRecordId', async (c) => {
				const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				return c.json({ ok: true, payload: await store.updateCommerceOwnershipRecord(c.req.param('ownershipRecordId'), {
					publicSummary: body.publicSummary === undefined ? undefined : optionalTrimmedString(body.publicSummary),
					buyerVisible: body.buyerVisible,
					metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
					reason: optionalTrimmedString(body.reason),
					evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
					actorType: 'user',
					actorId: access.principal.id ?? null,
				}) });
			});

			app.post('/v1/commerce/products/:productId/stewards', async (c) => {
				const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				try {
					return c.json({ ok: true, payload: await store.createCommerceStewardshipAssignment(access.product.id, body) });
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.get('/v1/commerce/products/:productId/stewards', async (c) => {
				const access = await requireCommerceProductAccess(c, store, c.req.param('productId'));
				if (access.response) return access.response;
				return c.json({ ok: true, payload: await store.listCommerceStewardshipAssignments(access.product.id) });
			});

			app.patch('/v1/commerce/products/:productId/stewards/:assignmentId', async (c) => {
				const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				return c.json({ ok: true, payload: await store.updateCommerceStewardshipAssignment(c.req.param('assignmentId'), {
					displayName: body.displayName === undefined ? undefined : optionalTrimmedString(body.displayName),
					responsibilities: body.responsibilities,
					visibleToBuyers: body.visibleToBuyers,
					endsAt: body.endsAt === undefined ? undefined : optionalTrimmedString(body.endsAt),
					metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
					reason: optionalTrimmedString(body.reason),
					evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
					actorType: 'user',
					actorId: access.principal.id ?? null,
				}) });
			});

			app.post('/v1/commerce/products/:productId/stewards/:assignmentId/end', async (c) => {
				const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				return c.json({ ok: true, payload: await store.endCommerceStewardshipAssignment(c.req.param('assignmentId'), {
					endsAt: optionalTrimmedString(body.endsAt),
					reason: optionalTrimmedString(body.reason),
					evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
					actorType: 'user',
					actorId: access.principal.id ?? null,
				}) });
			});

			app.post('/v1/commerce/products/:productId/contributions', async (c) => {
				const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				return c.json({ ok: true, payload: await store.createCommerceContribution(access.product.id, body) });
			});

			app.get('/v1/commerce/products/:productId/contributions', async (c) => {
				const access = await requireCommerceProductAccess(c, store, c.req.param('productId'));
				if (access.response) return access.response;
				return c.json({ ok: true, payload: await store.listCommerceContributions(access.product.id) });
			});

			app.patch('/v1/commerce/products/:productId/contributions/:contributionId', async (c) => {
				const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				return c.json({ ok: true, payload: await store.updateCommerceContribution(c.req.param('contributionId'), {
					summary: body.summary === undefined ? undefined : optionalTrimmedString(body.summary),
					attributionVisibility: optionalTrimmedString(body.attributionVisibility),
					benefitWeight: body.benefitWeight,
					metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
					reason: optionalTrimmedString(body.reason),
					evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
					actorType: 'user',
					actorId: access.principal.id ?? null,
				}) });
			});

			app.post('/v1/commerce/products/:productId/governance-policy', async (c) => {
				const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				return c.json({ ok: true, payload: await store.createCommerceGovernancePolicy({
					...body,
					productId: access.product.id,
					teamId: access.product.sellerTeamId,
				}) });
			});

			app.get('/v1/commerce/products/:productId/governance-policy', async (c) => {
				const access = await requireCommerceProductAccess(c, store, c.req.param('productId'));
				if (access.response) return access.response;
				return c.json({ ok: true, payload: await store.listCommerceGovernancePolicies({ productId: access.product.id }) });
			});

			app.patch('/v1/commerce/products/:productId/governance-policy/:policyId', async (c) => {
				const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				return c.json({ ok: true, payload: await store.updateCommerceGovernancePolicy(c.req.param('policyId'), {
					title: body.title === undefined ? undefined : optionalTrimmedString(body.title),
					approvalRules: body.approvalRules,
					quorumRules: body.quorumRules,
					buyerVisibleSummary: body.buyerVisibleSummary === undefined ? undefined : optionalTrimmedString(body.buyerVisibleSummary),
					status: optionalTrimmedString(body.status),
					reason: optionalTrimmedString(body.reason),
					evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
					actorType: 'user',
					actorId: access.principal.id ?? null,
				}) });
			});

			app.post('/v1/commerce/products/:productId/ownership-transfer', async (c) => {
				const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				return c.json({ ok: true, payload: await store.createCommerceOwnershipTransfer(access.product.id, {
					...body,
					actorType: 'user',
					actorId: access.principal.id ?? null,
					requestedByType: 'user',
					requestedById: access.principal.id ?? null,
				}) });
			});

			app.post('/v1/commerce/products/:productId/ownership-transfer/:transferId/submit', async (c) => {
				const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				return c.json({ ok: true, payload: await store.submitCommerceOwnershipTransfer(c.req.param('transferId'), {
					reason: optionalTrimmedString(body.reason),
					evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
					actorType: 'user',
					actorId: access.principal.id ?? null,
				}) });
			});

			app.post('/v1/commerce/products/:productId/ownership-transfer/:transferId/approve', async (c) => {
				const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				return c.json({ ok: true, payload: await store.approveCommerceOwnershipTransfer(c.req.param('transferId'), {
					reason: optionalTrimmedString(body.reason),
					evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
					actorType: 'user',
					actorId: access.principal.id ?? null,
				}) });
			});

			app.post('/v1/commerce/products/:productId/ownership-transfer/:transferId/reject', async (c) => {
				const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				return c.json({ ok: true, payload: await store.rejectCommerceOwnershipTransfer(c.req.param('transferId'), {
					reason: optionalTrimmedString(body.reason),
					evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
					actorType: 'user',
					actorId: access.principal.id ?? null,
				}) });
			});

			app.post('/v1/commerce/products/:productId/ownership-transfer/:transferId/cancel', async (c) => {
				const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				return c.json({ ok: true, payload: await store.cancelCommerceOwnershipTransfer(c.req.param('transferId'), {
					reason: optionalTrimmedString(body.reason),
					evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
					actorType: 'user',
					actorId: access.principal.id ?? null,
				}) });
			});

			app.post('/v1/commerce/products/:productId/succession-events', async (c) => {
				const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				return c.json({ ok: true, payload: await store.createCommerceSuccessionEvent(access.product.id, {
					...body,
					actorType: 'user',
					actorId: access.principal.id ?? null,
					createdByType: 'user',
					createdById: access.principal.id ?? null,
				}) });
			});

			app.get('/v1/commerce/products/:productId/succession-events', async (c) => {
				const access = await requireCommerceProductAccess(c, store, c.req.param('productId'));
				if (access.response) return access.response;
				const canManage = await principalCanManageCommerceProduct(store, access.principal, access.product);
				const events = await store.listCommerceSuccessionEvents(access.product.id);
				return c.json({ ok: true, payload: canManage ? events : [] });
			});

			app.get('/v1/commerce/products/:productId/ownership-workflow', async (c) => {
				const access = await requireCommerceProductAccess(c, store, c.req.param('productId'));
				if (access.response) return access.response;
				const workflow = await store.getCommerceOwnershipWorkflowSummary(access.product.id);
				const canManage = await principalCanManageCommerceProduct(store, access.principal, access.product);
				return c.json({ ok: true, payload: canManage ? workflow : redactCommerceOwnershipWorkflow(workflow) });
			});

			app.get('/v1/commerce/marketplace', async (c) => {
				return c.json({
					ok: true,
					payload: await store.listCommerceMarketplaceProducts(c.get('principal'), {
						kind: optionalTrimmedString(c.req.query('kind')),
					}),
				});
			});

			app.get('/v1/commerce/marketplace/products/:productId', async (c) => {
				const product = await store.getCommerceMarketplaceProduct(c.req.param('productId'), c.get('principal'));
				if (!product) return jsonError(c, 404, `Unknown marketplace product "${c.req.param('productId')}".`);
				return c.json({ ok: true, payload: product });
			});

			app.get('/v1/commerce/capacity-listings', async (c) => {
				return c.json({
					ok: true,
					payload: await store.listCommerceCapacityListings(c.get('principal'), {
						productId: optionalTrimmedString(c.req.query('productId')),
						vendorId: optionalTrimmedString(c.req.query('vendorId')),
						sellerTeamId: optionalTrimmedString(c.req.query('sellerTeamId')),
						status: optionalTrimmedString(c.req.query('status')),
						accessLevel: optionalTrimmedString(c.req.query('accessLevel')),
					}),
				});
			});

			app.get('/v1/commerce/capacity-listings/:listingId', async (c) => {
				const access = await requireCommerceCapacityListingAccess(c, store, c.req.param('listingId'), null);
				if (access.response) return access.response;
				return c.json({ ok: true, payload: access.listing });
			});

			app.post('/v1/commerce/products/:productId/capacity-listing', async (c) => {
				const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				try {
					const listing = await store.createCommerceCapacityListing(access.product.id, {
						capacityProviderId: optionalTrimmedString(body.capacityProviderId),
						capacityProviderLaneId: optionalTrimmedString(body.capacityProviderLaneId),
						accessLevel: optionalTrimmedString(body.accessLevel),
						runtimeIsolationLevel: optionalTrimmedString(body.runtimeIsolationLevel),
						humanInvolvementLevel: optionalTrimmedString(body.humanInvolvementLevel),
						aiInvolvementLevel: optionalTrimmedString(body.aiInvolvementLevel),
						dataAccessLevel: optionalTrimmedString(body.dataAccessLevel),
						secretAccessLevel: optionalTrimmedString(body.secretAccessLevel),
						supportedServiceTypes: Array.isArray(body.supportedServiceTypes) ? body.supportedServiceTypes : [],
						supportedRegions: Array.isArray(body.supportedRegions) ? body.supportedRegions : [],
						runtimeRequirements: body.runtimeRequirements && typeof body.runtimeRequirements === 'object' ? body.runtimeRequirements : {},
						dataHandlingSummary: optionalTrimmedString(body.dataHandlingSummary),
						buyerVisibleRiskSummary: optionalTrimmedString(body.buyerVisibleRiskSummary),
						governanceRequirements: body.governanceRequirements && typeof body.governanceRequirements === 'object' ? body.governanceRequirements : {},
						supportPolicy: optionalTrimmedString(body.supportPolicy),
						availabilitySummary: optionalTrimmedString(body.availabilitySummary),
						metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
						marketAdmin: principalIsSeedAdmin(access.principal),
						actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
						actorId: access.principal.id ?? null,
					});
					return c.json({ ok: true, payload: listing }, { status: 201 });
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.get('/v1/commerce/products/:productId/capacity-listing', async (c) => {
				const access = await requireCommerceProductAccess(c, store, c.req.param('productId'));
				if (access.response) return access.response;
				const canManage = await principalCanManageCommerceProduct(store, access.principal, access.product);
				const listing = await store.getCommerceCapacityListingForProduct(access.product.id, { publicSafe: !canManage });
				if (!listing) return jsonError(c, 404, `Unknown commerce capacity listing for product "${access.product.id}".`);
				if (!canManage && (listing.status !== 'approved' || listing.accessLevel !== 'public_summary')) return jsonError(c, 403, 'Permission denied.', { productId: access.product.id });
				return c.json({ ok: true, payload: listing });
			});

			app.patch('/v1/commerce/capacity-listings/:listingId', async (c) => {
				const access = await requireCommerceCapacityListingAccess(c, store, c.req.param('listingId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				try {
					return c.json({ ok: true, payload: await store.updateCommerceCapacityListing(access.listing.id, {
						capacityProviderId: body.capacityProviderId === undefined ? undefined : optionalTrimmedString(body.capacityProviderId),
						capacityProviderLaneId: body.capacityProviderLaneId === undefined ? undefined : optionalTrimmedString(body.capacityProviderLaneId),
						accessLevel: optionalTrimmedString(body.accessLevel),
						runtimeIsolationLevel: optionalTrimmedString(body.runtimeIsolationLevel),
						humanInvolvementLevel: optionalTrimmedString(body.humanInvolvementLevel),
						aiInvolvementLevel: optionalTrimmedString(body.aiInvolvementLevel),
						dataAccessLevel: optionalTrimmedString(body.dataAccessLevel),
						secretAccessLevel: optionalTrimmedString(body.secretAccessLevel),
						supportedServiceTypes: body.supportedServiceTypes,
						supportedRegions: body.supportedRegions,
						runtimeRequirements: body.runtimeRequirements,
						dataHandlingSummary: body.dataHandlingSummary === undefined ? undefined : optionalTrimmedString(body.dataHandlingSummary),
						buyerVisibleRiskSummary: body.buyerVisibleRiskSummary === undefined ? undefined : optionalTrimmedString(body.buyerVisibleRiskSummary),
						governanceRequirements: body.governanceRequirements,
						supportPolicy: body.supportPolicy === undefined ? undefined : optionalTrimmedString(body.supportPolicy),
						availabilitySummary: body.availabilitySummary === undefined ? undefined : optionalTrimmedString(body.availabilitySummary),
						metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
						marketAdmin: principalIsSeedAdmin(access.principal),
						reason: optionalTrimmedString(body.reason),
						evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
						actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
						actorId: access.principal.id ?? null,
					}) });
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.post('/v1/commerce/capacity-listings/:listingId/submit', async (c) => {
				const access = await requireCommerceCapacityListingAccess(c, store, c.req.param('listingId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				try {
					return c.json({ ok: true, payload: await store.submitCommerceCapacityListing(access.listing.id, {
						marketAdmin: principalIsSeedAdmin(access.principal),
						reason: optionalTrimmedString(body.reason),
						evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
						actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
						actorId: access.principal.id ?? null,
					}) });
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.post('/v1/commerce/capacity-listings/:listingId/approve', async (c) => {
				const access = await requireCommerceCapacityListingAccess(c, store, c.req.param('listingId'), 'teams:manage:team');
				if (access.response) return access.response;
				if (!principalIsSeedAdmin(access.principal)) return jsonError(c, 403, 'Permission denied.', { permission: 'commerce:capacity:approve' });
				const body = await c.req.json().catch(() => ({}));
				try {
					return c.json({ ok: true, payload: await store.approveCommerceCapacityListing(access.listing.id, {
						marketAdmin: true,
						reason: optionalTrimmedString(body.reason),
						evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
						actorType: 'operator',
						actorId: access.principal.id ?? null,
					}) });
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.post('/v1/commerce/capacity-listings/:listingId/reject', async (c) => {
				const access = await requireCommerceCapacityListingAccess(c, store, c.req.param('listingId'), 'teams:manage:team');
				if (access.response) return access.response;
				if (!principalIsSeedAdmin(access.principal)) return jsonError(c, 403, 'Permission denied.', { permission: 'commerce:capacity:approve' });
				const body = await c.req.json().catch(() => ({}));
				try {
					return c.json({ ok: true, payload: await store.rejectCommerceCapacityListing(access.listing.id, {
						marketAdmin: true,
						reason: optionalTrimmedString(body.reason),
						evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
						actorType: 'operator',
						actorId: access.principal.id ?? null,
					}) });
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.post('/v1/commerce/capacity-listings/:listingId/suspend', async (c) => {
				const access = await requireCommerceCapacityListingAccess(c, store, c.req.param('listingId'), 'teams:manage:team');
				if (access.response) return access.response;
				if (!principalIsSeedAdmin(access.principal)) return jsonError(c, 403, 'Permission denied.', { permission: 'commerce:capacity:approve' });
				const body = await c.req.json().catch(() => ({}));
				try {
					return c.json({ ok: true, payload: await store.suspendCommerceCapacityListing(access.listing.id, {
						marketAdmin: true,
						reason: optionalTrimmedString(body.reason),
						evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
						actorType: 'operator',
						actorId: access.principal.id ?? null,
					}) });
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.post('/v1/commerce/capacity-listings/:listingId/archive', async (c) => {
				const access = await requireCommerceCapacityListingAccess(c, store, c.req.param('listingId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				try {
					return c.json({ ok: true, payload: await store.archiveCommerceCapacityListing(access.listing.id, {
						marketAdmin: principalIsSeedAdmin(access.principal),
						reason: optionalTrimmedString(body.reason),
						evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
						actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
						actorId: access.principal.id ?? null,
					}) });
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.post('/v1/commerce/capacity-listings/:listingId/inquiries', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const body = await c.req.json().catch(() => ({}));
				const buyerTeamId = optionalTrimmedString(body.buyerTeamId);
				if (buyerTeamId) {
					const access = await requireTeamAccess(c, store, buyerTeamId, 'projects:read:team');
					if (access.response) return access.response;
				}
				try {
					return c.json({ ok: true, payload: await store.createCommerceCapacityListingInquiry(auth.principal, c.req.param('listingId'), {
						buyerTeamId,
						requestedServiceType: optionalTrimmedString(body.requestedServiceType),
						requestedScope: optionalTrimmedString(body.requestedScope),
						dataAccessRequested: body.dataAccessRequested && typeof body.dataAccessRequested === 'object' ? body.dataAccessRequested : {},
						secretAccessRequested: body.secretAccessRequested && typeof body.secretAccessRequested === 'object' ? body.secretAccessRequested : {},
						relatedProjectId: optionalTrimmedString(body.relatedProjectId),
						relatedWorkdayId: optionalTrimmedString(body.relatedWorkdayId),
						metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
						actorType: 'user',
						actorId: auth.principal.id ?? null,
					}) }, { status: 201 });
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.get('/v1/commerce/capacity-listing-inquiries', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const sellerTeamId = optionalTrimmedString(c.req.query('sellerTeamId'));
				const buyerTeamId = optionalTrimmedString(c.req.query('buyerTeamId'));
				if (sellerTeamId && !principalIsSeedAdmin(auth.principal)) {
					const access = await requireTeamAccess(c, store, sellerTeamId, 'projects:read:team');
					if (access.response) return access.response;
				}
				if (buyerTeamId && !principalIsSeedAdmin(auth.principal)) {
					const access = await requireTeamAccess(c, store, buyerTeamId, 'projects:read:team');
					if (access.response) return access.response;
				}
				return c.json({ ok: true, payload: await store.listCommerceCapacityListingInquiries(auth.principal, {
					listingId: optionalTrimmedString(c.req.query('listingId')),
					productId: optionalTrimmedString(c.req.query('productId')),
					vendorId: optionalTrimmedString(c.req.query('vendorId')),
					sellerTeamId,
					buyerTeamId,
					buyerUserId: optionalTrimmedString(c.req.query('buyerUserId')) ?? (!sellerTeamId && !buyerTeamId && !principalIsSeedAdmin(auth.principal) ? auth.principal.id : null),
					status: optionalTrimmedString(c.req.query('status')),
				}) });
			});

			app.get('/v1/commerce/capacity-listing-inquiries/:inquiryId', async (c) => {
				const access = await requireCommerceCapacityInquiryAccess(c, store, c.req.param('inquiryId'));
				if (access.response) return access.response;
				return c.json({ ok: true, payload: access.inquiry });
			});

			app.post('/v1/commerce/capacity-listing-inquiries/:inquiryId/review', async (c) => {
				const access = await requireCommerceCapacityInquiryAccess(c, store, c.req.param('inquiryId'), 'teams:manage:team');
				if (access.response) return access.response;
				const sellerAccess = principalIsSeedAdmin(access.principal) ? { response: null } : await requireTeamAccess(c, store, access.inquiry.sellerTeamId, 'teams:manage:team');
				if (sellerAccess.response) return sellerAccess.response;
				const body = await c.req.json().catch(() => ({}));
				return c.json({ ok: true, payload: await store.markCommerceCapacityInquiryReviewing(access.inquiry.id, {
					reason: optionalTrimmedString(body.reason),
					evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
					metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
					actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
					actorId: access.principal.id ?? null,
				}) });
			});

			app.post('/v1/commerce/capacity-listing-inquiries/:inquiryId/approve-for-scoping', async (c) => {
				const access = await requireCommerceCapacityInquiryAccess(c, store, c.req.param('inquiryId'), 'teams:manage:team');
				if (access.response) return access.response;
				const sellerAccess = principalIsSeedAdmin(access.principal) ? { response: null } : await requireTeamAccess(c, store, access.inquiry.sellerTeamId, 'teams:manage:team');
				if (sellerAccess.response) return sellerAccess.response;
				const body = await c.req.json().catch(() => ({}));
				return c.json({ ok: true, payload: await store.approveCommerceCapacityInquiryForScoping(access.inquiry.id, {
					reason: optionalTrimmedString(body.reason),
					evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
					metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
					actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
					actorId: access.principal.id ?? null,
				}) });
			});

			app.post('/v1/commerce/capacity-listing-inquiries/:inquiryId/decline', async (c) => {
				const access = await requireCommerceCapacityInquiryAccess(c, store, c.req.param('inquiryId'), 'teams:manage:team');
				if (access.response) return access.response;
				const sellerAccess = principalIsSeedAdmin(access.principal) ? { response: null } : await requireTeamAccess(c, store, access.inquiry.sellerTeamId, 'teams:manage:team');
				if (sellerAccess.response) return sellerAccess.response;
				const body = await c.req.json().catch(() => ({}));
				return c.json({ ok: true, payload: await store.declineCommerceCapacityInquiry(access.inquiry.id, {
					reason: optionalTrimmedString(body.reason),
					evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
					metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
					actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
					actorId: access.principal.id ?? null,
				}) });
			});

			app.post('/v1/commerce/capacity-listing-inquiries/:inquiryId/cancel', async (c) => {
				const access = await requireCommerceCapacityInquiryAccess(c, store, c.req.param('inquiryId'), 'projects:read:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				try {
					return c.json({ ok: true, payload: await store.cancelCommerceCapacityInquiry(access.inquiry.id, {
						reason: optionalTrimmedString(body.reason),
						evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
						metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
						actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
						actorId: access.principal.id ?? null,
					}) });
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.post('/v1/commerce/products/:productId/versions', async (c) => {
				const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				try {
					return c.json({ ok: true, payload: await store.createCommerceProductVersion(access.product.id, body) });
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.get('/v1/commerce/products/:productId/versions', async (c) => {
				const access = await requireCommerceProductAccess(c, store, c.req.param('productId'));
				if (access.response) return access.response;
				return c.json({ ok: true, payload: await store.listCommerceProductVersions(access.product.id) });
			});

			app.post('/v1/commerce/products/:productId/versions/:versionId/submit', async (c) => {
				const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				return c.json({ ok: true, payload: await store.submitCommerceProductVersion(c.req.param('versionId'), {
					reason: optionalTrimmedString(body.reason),
					evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
					actorType: 'user',
					actorId: access.principal.id ?? null,
				}) });
			});

			app.post('/v1/commerce/products/:productId/versions/:versionId/approve', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				if (!principalIsSeedAdmin(auth.principal)) return jsonError(c, 403, 'Permission denied.', { permission: 'commerce:approve:global' });
				const body = await c.req.json().catch(() => ({}));
				try {
					return c.json({ ok: true, payload: await store.approveCommerceProductVersion(c.req.param('versionId'), {
						publishedAt: optionalTrimmedString(body.publishedAt),
						reason: optionalTrimmedString(body.reason),
						evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
						actorType: 'operator',
						actorId: auth.principal.id ?? null,
					}) });
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.post('/v1/commerce/offers', async (c) => {
				const body = await c.req.json().catch(() => ({}));
				const productId = optionalTrimmedString(body.productId);
				if (!productId) return jsonError(c, 400, 'productId is required.');
				const access = await requireCommerceProductAccess(c, store, productId, 'teams:manage:team');
				if (access.response) return access.response;
				try {
					return c.json({ ok: true, payload: await store.createCommerceOffer(body) });
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.get('/v1/commerce/offers', async (c) => {
				return c.json({ ok: true, payload: await store.listCommerceOffers({
					productId: optionalTrimmedString(c.req.query('productId')),
					vendorId: optionalTrimmedString(c.req.query('vendorId')),
					sellerTeamId: optionalTrimmedString(c.req.query('sellerTeamId')),
					status: optionalTrimmedString(c.req.query('status')),
					mode: optionalTrimmedString(c.req.query('mode')),
				}) });
			});

			app.get('/v1/commerce/offers/:offerId', async (c) => {
				const access = await requireCommerceOfferAccess(c, store, c.req.param('offerId'));
				if (access.response) return access.response;
				return c.json({ ok: true, payload: access.offer });
			});

			app.patch('/v1/commerce/offers/:offerId', async (c) => {
				const access = await requireCommerceOfferAccess(c, store, c.req.param('offerId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				try {
					return c.json({ ok: true, payload: await store.updateCommerceOffer(access.offer.id, body) });
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.post('/v1/commerce/offers/:offerId/submit', async (c) => {
				const access = await requireCommerceOfferAccess(c, store, c.req.param('offerId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				return c.json({ ok: true, payload: await store.submitCommerceOffer(access.offer.id, {
					reason: optionalTrimmedString(body.reason),
					evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
					actorType: 'user',
					actorId: access.principal.id ?? null,
				}) });
			});

			app.post('/v1/commerce/offers/:offerId/approve', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				if (!principalIsSeedAdmin(auth.principal)) return jsonError(c, 403, 'Permission denied.', { permission: 'commerce:approve:global' });
				const body = await c.req.json().catch(() => ({}));
				try {
					const offer = await store.approveCommerceOffer(c.req.param('offerId'), {
						reason: optionalTrimmedString(body.reason),
						evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
						actorType: 'operator',
						actorId: auth.principal.id ?? null,
					});
					if (!offer) return jsonError(c, 404, `Unknown commerce offer "${c.req.param('offerId')}".`);
					const syncResult = await syncCommerceOfferStripeProduct({
						store,
						stripeConnectService,
						offer,
						actorType: 'operator',
						actorId: auth.principal.id ?? null,
					});
					const syncedOffer = syncResult.offer ?? offer;
					if (syncedOffer.activePriceId) {
						const activePrice = await store.getCommercePrice(syncedOffer.activePriceId);
						if (activePrice) {
							await syncCommercePriceStripePrice({
								store,
								stripeConnectService,
								price: activePrice,
								actorType: 'operator',
								actorId: auth.principal.id ?? null,
							});
						}
					}
					return c.json({ ok: true, payload: await store.getCommerceOffer(offer.id) });
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.get('/v1/commerce/offers/:offerId/stripe/status', async (c) => {
				const access = await requireCommerceOfferAccess(c, store, c.req.param('offerId'), 'projects:read:team');
				if (access.response) return access.response;
				const prices = await store.listCommercePrices(access.offer.id);
				return c.json({
					ok: true,
					payload: {
						offer: access.offer,
						prices,
					},
				});
			});

			app.post('/v1/commerce/offers/:offerId/stripe/reconcile', async (c) => {
				const access = await requireCommerceOfferAccess(c, store, c.req.param('offerId'), 'teams:manage:team');
				if (access.response) return access.response;
				try {
					const result = await syncCommerceOfferStripeProduct({
						store,
						stripeConnectService,
						offer: access.offer,
						actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
						actorId: access.principal.id ?? null,
						reconcile: true,
						throwOnBlocked: true,
					});
					return c.json({ ok: true, payload: result });
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.post('/v1/commerce/offers/:offerId/prices', async (c) => {
				const access = await requireCommerceOfferAccess(c, store, c.req.param('offerId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				try {
					return c.json({ ok: true, payload: await store.createCommercePrice(access.offer.id, body) });
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.get('/v1/commerce/offers/:offerId/prices', async (c) => {
				const access = await requireCommerceOfferAccess(c, store, c.req.param('offerId'));
				if (access.response) return access.response;
				return c.json({ ok: true, payload: await store.listCommercePrices(access.offer.id) });
			});

			app.post('/v1/commerce/prices/:priceId/activate', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const body = await c.req.json().catch(() => ({}));
				try {
					const existing = await store.getCommercePrice(c.req.param('priceId'));
					if (!existing) return jsonError(c, 404, `Unknown commerce price "${c.req.param('priceId')}".`);
					const offer = await store.getCommerceOffer(existing.offerId);
					const access = await requireTeamAccess(c, store, offer.sellerTeamId, 'teams:manage:team');
					if (access.response) return access.response;
					const price = await store.activateCommercePrice(c.req.param('priceId'), {
						reason: optionalTrimmedString(body.reason),
						evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
						actorType: principalIsSeedAdmin(auth.principal) ? 'operator' : 'user',
						actorId: auth.principal.id ?? null,
					});
					const refreshedOffer = await store.getCommerceOffer(existing.offerId);
					if (refreshedOffer?.status === 'approved') {
						const syncResult = await syncCommercePriceStripePrice({
							store,
							stripeConnectService,
							price,
							actorType: principalIsSeedAdmin(auth.principal) ? 'operator' : 'user',
							actorId: auth.principal.id ?? null,
						});
						return c.json({ ok: true, payload: syncResult.price ?? price });
					}
					return c.json({ ok: true, payload: price });
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.post('/v1/commerce/prices/:priceId/stripe/reconcile', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				try {
					const price = await store.getCommercePrice(c.req.param('priceId'));
					if (!price) return jsonError(c, 404, `Unknown commerce price "${c.req.param('priceId')}".`);
					const offer = await store.getCommerceOffer(price.offerId);
					const access = await requireTeamAccess(c, store, offer.sellerTeamId, 'teams:manage:team');
					if (access.response) return access.response;
					const result = await syncCommercePriceStripePrice({
						store,
						stripeConnectService,
						price,
						actorType: principalIsSeedAdmin(auth.principal) ? 'operator' : 'user',
						actorId: auth.principal.id ?? null,
						reconcile: true,
						throwOnBlocked: true,
					});
					return c.json({ ok: true, payload: result });
				} catch (error) {
					return commerceErrorResponse(c, error);
				}
			});

			app.get('/v1/commerce/governance-events', async (c) => {
				const auth = await ensurePrincipal(c);
				if (auth.response) return auth.response;
				const teamId = optionalTrimmedString(c.req.query('teamId'));
				if (teamId && !principalIsSeedAdmin(auth.principal)) {
					const access = await requireTeamAccess(c, store, teamId, 'projects:read:team');
					if (access.response) return access.response;
				}
				return c.json({ ok: true, payload: await store.listCommerceGovernanceEvents({
					objectType: optionalTrimmedString(c.req.query('objectType')),
					objectId: optionalTrimmedString(c.req.query('objectId')),
					productId: optionalTrimmedString(c.req.query('productId')),
					offerId: optionalTrimmedString(c.req.query('offerId')),
					teamId,
				}) });
			});

			app.get('/v1/catalog', async (c) => {
				const kind = typeof c.req.query('kind') === 'string' ? c.req.query('kind') : undefined;
				const teamId = typeof c.req.query('teamId') === 'string' ? c.req.query('teamId') : undefined;
				const slug = typeof c.req.query('slug') === 'string' ? c.req.query('slug') : undefined;
				return c.json({
					ok: true,
					payload: await store.listCatalogItems(c.get('principal'), {
						kind,
						teamId,
						slug,
					}),
				});
			});

			app.get('/v1/catalog/:itemId', async (c) => {
				const item = await store.getCatalogItem(c.req.param('itemId'));
				if (!item) {
					return jsonError(c, 404, `Unknown catalog item "${c.req.param('itemId')}".`);
				}
				const canAccess = await store.principalCanAccessCatalogItem(c.get('principal'), item);
				if (!canAccess) {
					return jsonError(c, 404, `Unknown catalog item "${c.req.param('itemId')}".`);
				}
				return c.json({ ok: true, payload: item });
			});

			app.get('/v1/catalog/:itemId/artifacts', async (c) => {
				const item = await store.getCatalogItem(c.req.param('itemId'));
				if (!item) {
					return jsonError(c, 404, `Unknown catalog item "${c.req.param('itemId')}".`);
				}
				const canAccess = await store.principalCanAccessCatalogItem(c.get('principal'), item);
				if (!canAccess) {
					return jsonError(c, 404, `Unknown catalog item "${c.req.param('itemId')}".`);
				}
				return c.json({
					ok: true,
					payload: await store.listCatalogArtifactVersions(item.id),
				});
			});

			app.get('/v1/catalog/:itemId/artifacts/:version/download', async (c) => {
				const item = await store.getCatalogItem(c.req.param('itemId'));
				if (!item) {
					return jsonError(c, 404, `Unknown catalog item "${c.req.param('itemId')}".`);
				}
				const canAccess = await store.principalCanAccessCatalogItem(c.get('principal'), item);
				if (!canAccess) {
					return jsonError(c, 404, `Unknown catalog item "${c.req.param('itemId')}".`);
				}
				const artifact = await store.getCatalogArtifactVersion(item.id, c.req.param('version'));
				if (!artifact) {
					return jsonError(c, 404, `Unknown catalog artifact version "${c.req.param('version')}".`);
				}
				return c.json({
					ok: true,
					payload: artifactDownloadPayload(runtime.resolved.config.baseUrl, item, artifact),
				});
			});

			app.post('/v1/teams/:teamId/catalog-items', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				if (!body.kind || !body.slug || !body.title) {
					return jsonError(c, 400, 'kind, slug, and title are required.');
				}
				return c.json({
					ok: true,
					payload: await store.upsertCatalogItem(c.req.param('teamId'), {
						id: typeof body.id === 'string' ? body.id : undefined,
						kind: String(body.kind),
						slug: String(body.slug),
						title: String(body.title),
						summary: typeof body.summary === 'string' ? body.summary : null,
						visibility: typeof body.visibility === 'string' ? body.visibility : 'private',
						listingEnabled: body.listingEnabled === true,
						offerMode: typeof body.offerMode === 'string' ? body.offerMode : 'private',
						manifestKey: typeof body.manifestKey === 'string' ? body.manifestKey : null,
						artifactKey: typeof body.artifactKey === 'string' ? body.artifactKey : null,
						searchText: typeof body.searchText === 'string' ? body.searchText : null,
						metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
					}),
				});
			});

			app.post('/v1/catalog/:itemId/artifacts', async (c) => {
				const access = await requireCatalogItemAccess(c, store, c.req.param('itemId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				if (!body.kind || !body.version || !body.contentKey) {
					return jsonError(c, 400, 'kind, version, and contentKey are required.');
				}
				return c.json({
					ok: true,
					payload: await store.upsertCatalogArtifactVersion(access.item.teamId, access.item.id, {
						id: typeof body.id === 'string' ? body.id : undefined,
						kind: String(body.kind),
						version: String(body.version),
						contentKey: String(body.contentKey),
						manifestKey: typeof body.manifestKey === 'string' ? body.manifestKey : null,
						metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
						publishedAt: typeof body.publishedAt === 'string' ? body.publishedAt : null,
					}),
				});
			});

			app.get('/v1/teams/:teamId/storage', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				return c.json({
					ok: true,
					payload: await store.getTeamStorageLocator(c.req.param('teamId')),
				});
			});

			app.put('/v1/teams/:teamId/storage', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				if (!body.bucketName || !body.manifestKeyTemplate || !body.previewRootTemplate) {
					return jsonError(c, 400, 'bucketName, manifestKeyTemplate, and previewRootTemplate are required.');
				}
				return c.json({
					ok: true,
					payload: await store.upsertTeamStorageLocator(c.req.param('teamId'), {
						bucketName: String(body.bucketName),
						manifestKeyTemplate: String(body.manifestKeyTemplate),
						previewRootTemplate: String(body.previewRootTemplate),
						publicBaseUrl: typeof body.publicBaseUrl === 'string' ? body.publicBaseUrl : null,
						metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
					}),
				});
			});

			app.post('/v1/teams/:teamId/content-previews', async (c) => {
				const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:manage:team');
				if (access.response) return access.response;
				const body = await c.req.json().catch(() => ({}));
				if (!body.previewId) {
					return jsonError(c, 400, 'previewId is required.');
				}
				const expiresAt = typeof body.expiresAt === 'string'
					? body.expiresAt
					: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
				const secret = String(runtime.env?.TREESEED_EDITORIAL_PREVIEW_SECRET ?? runtime.resolved.config.authSecret ?? '');
				if (!secret) {
					return jsonError(c, 500, 'Editorial preview secret is not configured.');
				}
				const token = signEditorialPreviewToken({
					teamId: c.req.param('teamId'),
					previewId: String(body.previewId),
					expiresAt,
				}, secret);
				return c.json({
					ok: true,
					payload: {
						teamId: c.req.param('teamId'),
						previewId: String(body.previewId),
						expiresAt,
						token,
						previewUrl: `${runtime.resolved.config.baseUrl ?? ''}?preview=${encodeURIComponent(token)}`,
					},
				});
			});

			app.get('/v1/templates', async (c) => {
				const catalog = await store.listCatalogItems(c.get('principal'), { kind: 'template' });
				if (catalog.length > 0) {
					return c.json({ ok: true, payload: { items: catalog } });
				}
				return c.json({
					ok: true,
					payload: loadTemplateCatalog(runtime.resolved.config),
				});
			});

			app.get('/v1/knowledge-packs', async (c) => {
				const catalog = await store.listCatalogItems(c.get('principal'), { kind: 'knowledge_pack' });
				if (catalog.length > 0) {
					return c.json({ ok: true, payload: catalog });
				}
				return c.json({
					ok: true,
					payload: await store.listKnowledgePacks(c.get('principal')),
				});
			});

			app.post('/v1/knowledge-packs', async (c) => {
				const body = await c.req.json().catch(() => ({}));
				if (!body.teamId || !body.slug || !body.name) {
					return jsonError(c, 400, 'teamId, slug, and name are required.');
				}
				const access = await requireTeamAccess(c, store, String(body.teamId), 'knowledge_packs:manage:team');
				if (access.response) return access.response;
				return c.json({
					ok: true,
					payload: await store.createKnowledgePack(String(body.teamId), {
						id: typeof body.id === 'string' ? body.id : undefined,
						slug: String(body.slug),
						name: String(body.name),
						summary: typeof body.summary === 'string' ? body.summary : null,
						sourceKind: typeof body.sourceKind === 'string' ? body.sourceKind : 'market_import',
						sourceRef: typeof body.sourceRef === 'string' ? body.sourceRef : null,
						installStrategy: typeof body.installStrategy === 'string' ? body.installStrategy : 'import_export',
						visibility: typeof body.visibility === 'string' ? body.visibility : 'private',
						metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
					}),
				});
			});

			options.extendApp?.(app, runtime);
				},
			}),
			...(options.extensions ?? []),
		],
	});
}

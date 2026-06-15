import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
	buildCreditConversionProfileFromActuals,
	calculateActualCredits,
	deriveAvailableCredits,
	nativeUsageUnit,
} from '@treeseed/sdk/capacity';
import { redactDeploymentValue } from '../market/deployment-actions.ts';
import { projectDeploymentAuditPayload } from '../market/deployment-governance.ts';

function getNodeBuiltin(name) {
	return globalThis.process?.getBuiltinModule?.(name) ?? null;
}

function safeStoragePathSegment(value) {
	return String(value ?? '')
		.split('/')
		.map((part) => part.trim())
		.filter((part) => part && part !== '.' && part !== '..')
		.join('/');
}

function safeIdPart(value, fallback = 'item') {
	return String(value ?? fallback)
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/gu, '-')
		.replace(/^-+|-+$/gu, '')
		|| fallback;
}

function artifactStorageRoot(config) {
	const path = getNodeBuiltin('path');
	if (!path) return null;
	const root = String(config.agentArtifactStorageRoot ?? config.repoRoot ?? process.cwd()).trim();
	return path.resolve(root, '.treeseed/generated/hosted-artifacts');
}

function isoNow() {
	return new Date().toISOString();
}

function parseJson(value, fallback) {
	if (!value) return fallback;
	try {
		return JSON.parse(value);
	} catch {
		return fallback;
	}
}

function objectValue(value, fallback = {}) {
	return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function arrayValue(value) {
	return Array.isArray(value) ? value : [];
}

function stringValue(value, fallback = '') {
	const next = typeof value === 'string' ? value.trim() : '';
	return next || fallback;
}

function numberValue(value, fallback = null) {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

function stableHash(value, secret) {
	return createHash('sha256').update(`${secret}:${value}`).digest('hex');
}

function equalHash(left, right) {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function tokenPrefix(token) {
	return token.slice(0, 16);
}

function normalizeOperationCapabilities(capabilities) {
	return Array.isArray(capabilities)
		? capabilities.map((entry) => String(entry ?? '').trim()).filter(Boolean)
		: [];
}

const PHASE4_CAPACITY_PROVIDER_SCOPES = [
	'provider:register',
	'provider:heartbeat',
	'provider:portfolio:read',
	'provider:tasks:claim',
	'provider:tasks:update',
	'provider:usage:report',
	'provider:reports:write',
	'provider:capabilities:write',
];

const CAPACITY_PROVIDER_BOOTSTRAP_SCOPES = [
	'provider:register',
	'provider:heartbeat',
	'provider:capabilities:write',
];

const CAPACITY_PROVIDER_SESSION_SCOPES = [
	'provider:heartbeat',
	'provider:portfolio:read',
	'provider:tasks:claim',
	'provider:tasks:update',
	'provider:usage:report',
	'provider:reports:write',
	'provider:capabilities:write',
];

const CAPACITY_PROVIDER_LAUNCH_MODES = new Set(['self_hosted', 'managed_market_host', 'connected_host']);

function providerLaunchMode(value) {
	const mode = typeof value === 'string' ? value.trim() : '';
	return CAPACITY_PROVIDER_LAUNCH_MODES.has(mode) ? mode : null;
}

function sumNumbers(values) {
	return values.reduce((total, value) => total + (Number.isFinite(Number(value)) ? Number(value) : 0), 0);
}

const defaultExecutionProfileId = 'standard-code-model';

function executionProfileId(value) {
	return typeof value === 'string' && value.trim() ? value.trim() : defaultExecutionProfileId;
}

function finiteMetric(value) {
	if (Number.isFinite(Number(value))) return Number(value);
	return null;
}

function pressureNumber(primary = {}, secondary = {}, key) {
	const primaryValue = finiteMetric(primary[key]);
	if (primaryValue !== null) return primaryValue;
	const secondaryValue = finiteMetric(secondary[key]);
	if (secondaryValue !== null) return secondaryValue;
	const primaryPressure = primary.pressure && typeof primary.pressure === 'object' ? primary.pressure : {};
	const secondaryPressure = secondary.pressure && typeof secondary.pressure === 'object' ? secondary.pressure : {};
	return finiteMetric(primaryPressure[key]) ?? finiteMetric(secondaryPressure[key]);
}

function pressureBoolean(primary = {}, secondary = {}, key) {
	const values = [
		primary[key],
		secondary[key],
		primary.pressure && typeof primary.pressure === 'object' ? primary.pressure[key] : undefined,
		secondary.pressure && typeof secondary.pressure === 'object' ? secondary.pressure[key] : undefined,
	];
	return values.some((value) => value === true || value === 'true');
}

function pressureLimit(lane, provider, ...keys) {
	for (const key of keys) {
		const value = finiteMetric(lane.hardLimits?.[key])
			?? finiteMetric(lane.routingPolicy?.[key])
			?? finiteMetric(provider.capacityModel?.[key])
			?? finiteMetric(provider.metadata?.[key]);
		if (value !== null && value >= 0) return value;
	}
	return null;
}

function capacityPressure(provider, lane, reservations) {
	const scopedReservations = reservations.filter((reservation) =>
		reservation.capacityProviderId === provider.id
		&& (!lane || reservation.laneId === lane.id)
		&& ['reserved', 'consuming'].includes(reservation.state)
	);
	const activeReservations = scopedReservations.length;
	const maxActiveReservations = lane
		? pressureLimit(lane, provider, 'maxActiveReservations', 'maxConcurrentTasks', 'maxConcurrentWorkers') ?? (provider.maxConcurrentWorkers > 0 ? provider.maxConcurrentWorkers : null)
		: (provider.maxConcurrentWorkers > 0 ? provider.maxConcurrentWorkers : null);
	const laneMetadata = lane?.metadata ?? {};
	const providerMetadata = provider.metadata ?? {};
	const activeAttentionLoad = scopedReservations.reduce((total, reservation) => {
		const metadata = reservation.metadata ?? {};
		const estimate = metadata.attentionEstimate && typeof metadata.attentionEstimate === 'object' ? metadata.attentionEstimate : {};
		return total + Math.max(0, finiteMetric(metadata.totalAttentionWeight) ?? finiteMetric(metadata.attentionWeight) ?? finiteMetric(estimate.totalAttentionWeight) ?? finiteMetric(estimate.attentionWeight) ?? 0);
	}, 0);
	const maxAttentionLoad = lane
		? pressureLimit(lane, provider, 'maxAttentionLoad')
		: finiteMetric(provider.capacityModel?.maxAttentionLoad) ?? finiteMetric(provider.metadata?.maxAttentionLoad);
	const activeContextTokens = scopedReservations.reduce((total, reservation) => {
		const metadata = reservation.metadata ?? {};
		const estimate = metadata.attentionEstimate && typeof metadata.attentionEstimate === 'object' ? metadata.attentionEstimate : {};
		return total + Math.max(0, finiteMetric(metadata.estimatedContextTokens) ?? finiteMetric(metadata.contextTokens) ?? finiteMetric(estimate.estimatedContextTokens) ?? finiteMetric(estimate.requiredContextTokens) ?? 0);
	}, 0);
	const maxContextTokens = lane
		? pressureLimit(lane, provider, 'maxContextTokens')
		: finiteMetric(provider.capacityModel?.maxContextTokens) ?? finiteMetric(provider.metadata?.maxContextTokens);
	return {
		activeReservations,
		maxActiveReservations,
		congestionRatio: maxActiveReservations && maxActiveReservations > 0 ? activeReservations / maxActiveReservations : 0,
		quotaRemainingPercent: pressureNumber(laneMetadata, providerMetadata, 'quotaRemainingPercent'),
		sessionRemainingMinutes: pressureNumber(laneMetadata, providerMetadata, 'sessionRemainingMinutes'),
		subscriptionSaturationPercent: pressureNumber(laneMetadata, providerMetadata, 'subscriptionSaturationPercent'),
		providerUnavailable: pressureBoolean(laneMetadata, providerMetadata, 'providerUnavailable'),
		activeAttentionLoad,
		maxAttentionLoad,
		attentionSaturationPercent: maxAttentionLoad && maxAttentionLoad > 0 ? (activeAttentionLoad / maxAttentionLoad) * 100 : null,
		activeContextTokens,
		maxContextTokens,
		contextSaturationPercent: maxContextTokens && maxContextTokens > 0 ? (activeContextTokens / maxContextTokens) * 100 : null,
		cooperative: {
			priceHint: finiteMetric(laneMetadata.priceHint) ?? finiteMetric(providerMetadata.priceHint) ?? null,
			latencyHint: finiteMetric(laneMetadata.latencyHint) ?? finiteMetric(providerMetadata.latencyHint) ?? null,
			trustScore: finiteMetric(laneMetadata.trustScore) ?? finiteMetric(providerMetadata.trustScore) ?? null,
			availabilityScore: finiteMetric(laneMetadata.availabilityScore) ?? finiteMetric(providerMetadata.availabilityScore) ?? null,
			successProbability: finiteMetric(laneMetadata.successProbability) ?? finiteMetric(providerMetadata.successProbability) ?? null,
			spilloverEligible: laneMetadata.spilloverEligible === true || providerMetadata.spilloverEligible === true,
			utilityAcceptancePolicy: laneMetadata.utilityAcceptancePolicy ?? providerMetadata.utilityAcceptancePolicy ?? null,
		},
	};
}

function sortedMetrics(values) {
	return values
		.map(finiteMetric)
		.filter((value) => value !== null && value >= 0)
		.sort((left, right) => left - right);
}

function percentile(values, target) {
	const sorted = sortedMetrics(values);
	if (sorted.length === 0) return null;
	const index = Math.ceil((Math.min(100, Math.max(0, target)) / 100) * sorted.length) - 1;
	return sorted[Math.max(0, Math.min(sorted.length - 1, index))] ?? null;
}

function variance(values) {
	const sorted = sortedMetrics(values);
	if (sorted.length <= 1) return 0;
	const mean = sorted.reduce((total, value) => total + value, 0) / sorted.length;
	return sorted.reduce((total, value) => total + ((value - mean) ** 2), 0) / sorted.length;
}

function interruptedActual(actual) {
	const metadata = actual.metadata ?? {};
	return metadata.interrupted === true || metadata.partial === true || metadata.interrupted === 'true' || metadata.partial === 'true';
}

function confidenceScore({ sampleCount, creditsVariance, creditsP50, lastSampleAt }) {
	const count = Math.max(0, Number(sampleCount ?? 0));
	const sampleScore = Math.min(1, count / 20);
	const p50 = Math.max(1, Number(creditsP50 ?? 1));
	const spreadScore = 1 / (1 + (Math.sqrt(Math.max(0, Number(creditsVariance ?? 0))) / p50));
	let ageScore = 1;
	if (lastSampleAt) {
		const ageDays = Math.max(0, (Date.now() - new Date(lastSampleAt).valueOf()) / 86_400_000);
		ageScore = ageDays > 90 ? 0.35 : ageDays > 30 ? 0.7 : 1;
	}
	return Math.max(0, Math.min(1, sampleScore * spreadScore * ageScore));
}

function principalIsAdmin(principal) {
	return Boolean(
		principal
		&& (
			principal.permissions?.includes?.('*:*:*')
			|| principal.roles?.includes?.('platform_admin')
			|| principal.roles?.includes?.('market_admin')
		),
	);
}

const TEAM_ROLE_CAPABILITIES = {
	team_owner: [
		'launch_projects',
		'edit_direct',
		'manage_workstreams',
		'stage_releases',
		'publish_releases',
		'publish_market_listings',
		'manage_products',
		'manage_billing',
		'approve_remote_execution',
	],
	market_steward: ['manage_products', 'publish_market_listings'],
	project_lead: ['launch_projects', 'edit_direct', 'manage_workstreams', 'stage_releases', 'publish_releases', 'approve_remote_execution'],
	contributor: ['edit_direct', 'manage_workstreams'],
	reviewer: ['stage_releases', 'approve_remote_execution'],
	finance: ['manage_billing', 'manage_products'],
};

const TEAM_ROLE_DESCRIPTIONS = {
	team_owner: 'Own the team portfolio and all project capabilities.',
	market_steward: 'Manage market products and publish listings.',
	project_lead: 'Lead projects, workstreams, and release promotion.',
	contributor: 'Edit direction and move workstreams forward.',
	reviewer: 'Review staged work and approve remote execution.',
	finance: 'Manage billing and commercial product settings.',
};

const ALL_TEAM_CAPABILITIES = [...new Set(Object.values(TEAM_ROLE_CAPABILITIES).flat())];
const CAPABILITY_PERMISSIONS = {
	launch_projects: 'project:create',
	edit_direct: 'project:edit',
	manage_workstreams: 'project:workstream:manage',
	stage_releases: 'project:stage:admin',
	publish_releases: 'project:production:admin',
	publish_market_listings: 'catalog:publish',
	manage_products: 'catalog:manage',
	manage_billing: 'billing:manage',
	approve_remote_execution: 'remote:execution:approve',
};
const TEAM_DELETION_CONFIRMATION_PREFIX = 'DELETE ';
const TEAM_MANAGEMENT_ROLES = new Set(['team_owner', 'project_lead']);
const TEAM_RESERVED_NAMES = new Set([
	'app',
	'api',
	'auth',
	'market',
	'templates',
	'admin',
	'settings',
	'u',
	't',
	'users',
	'teams',
	'new',
	'me',
	'account',
	'login',
	'logout',
	'signup',
]);

export function normalizeTeamName(value) {
	return String(value ?? '').trim().toLowerCase();
}

export function validateTeamName(value) {
	const name = normalizeTeamName(value);
	if (!name) {
		return { ok: false, code: 'missing', message: 'Team name is required.' };
	}
	if (TEAM_RESERVED_NAMES.has(name)) {
		return { ok: false, code: 'reserved', message: 'That team name is reserved.' };
	}
	if (
		name.length > 39
		|| !/^[a-z0-9-]+$/u.test(name)
		|| name.startsWith('-')
		|| name.endsWith('-')
		|| name.includes('--')
	) {
		return {
			ok: false,
			code: 'format',
			message: 'Team names can use 1-39 letters, numbers, or single hyphens, with no leading or trailing hyphen.',
		};
	}
	return { ok: true, name };
}

export function teamDeletionConfirmationMatches(value, teamName) {
	return String(value ?? '') === `${TEAM_DELETION_CONFIRMATION_PREFIX}${normalizeTeamName(teamName)}`;
}

export function projectDeletionConfirmationMatches(value, projectSlug) {
	return String(value ?? '') === `${TEAM_DELETION_CONFIRMATION_PREFIX}${String(projectSlug ?? '').trim().toLowerCase()}`;
}

export function normalizeProjectSlug(value) {
	return String(value ?? '').trim().toLowerCase();
}

export function validateProjectSlug(value) {
	const slug = normalizeProjectSlug(value);
	if (!slug) {
		return { ok: false, code: 'missing', message: 'Project slug is required.' };
	}
	if (
		slug.length > 80
		|| !/^[a-z0-9-]+$/u.test(slug)
		|| slug.startsWith('-')
		|| slug.endsWith('-')
		|| slug.includes('--')
	) {
		return {
			ok: false,
			code: 'format',
			message: 'Project slugs can use 1-80 letters, numbers, or single hyphens, with no leading or trailing hyphen.',
		};
	}
	return { ok: true, slug };
}

function normalizeBaseUrl(baseUrl) {
	return String(baseUrl ?? '').trim().replace(/\/+$/u, '');
}

function signAssertionPayload(payload, secret) {
	return createHmac('sha256', secret).update(payload).digest('base64url');
}

function uniqueCapabilities(roles = []) {
	const capabilities = roles.flatMap((role) => TEAM_ROLE_CAPABILITIES[role] ?? []);
	return [...new Set(capabilities)];
}

function normalizeTeamRoleKey(value, fallback = 'contributor') {
	const key = String(value ?? '').trim();
	if (key === 'owner') return 'team_owner';
	return TEAM_ROLE_CAPABILITIES[key] ? key : fallback;
}

function primaryTeamRole(roles = []) {
	const preferredOrder = ['team_owner', 'project_lead', 'market_steward', 'contributor', 'reviewer', 'finance'];
	return preferredOrder.find((role) => roles.includes(role)) ?? roles[0] ?? null;
}

function projectConnectionModeFromHosting(kind, registration = 'none') {
	if (kind === 'hosted_project') {
		return 'hosted';
	}
	if (kind === 'self_hosted_project') {
		return registration === 'optional' ? 'hybrid' : 'self_hosted';
	}
	return 'hosted';
}

function serializeTeam(row) {
	if (!row) return null;
	const metadata = parseJson(row.metadata_json, {});
	const handle = row.name ?? row.slug;
	return {
		id: row.id,
		slug: row.slug ?? handle,
		name: handle,
		displayName: row.display_name ?? metadata.displayName ?? row.name ?? row.slug,
		logoUrl: row.logo_url ?? metadata.logoUrl ?? null,
		profileSummary: row.profile_summary ?? metadata.profileSummary ?? metadata.description ?? null,
		metadata,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function teamIsPrivate(team) {
	const visibility = String(team?.metadata?.visibility ?? team?.metadata?.access ?? 'private').toLowerCase();
	return team?.metadata?.privateTreeDx !== false && visibility !== 'public' && team?.metadata?.publicTeam !== true;
}

function centralTreeDxRegistryUrl(config = {}) {
	return normalizeBaseUrl(
		process.env.TREESEED_PUBLIC_TREEDX_REGISTRY_URL
		?? process.env.TREESEED_CENTRAL_TREEDX_REGISTRY_URL
		?? config.publicTreeDxRegistryUrl
		?? config.treedxRegistryUrl
		?? 'https://api.treeseed.ai/treedx',
	);
}

function normalizeAllocationSlices(value, fallback = []) {
	const raw = Array.isArray(value) ? value : fallback;
	return raw
		.map((slice) => ({
			id: String(slice?.id ?? '').trim(),
			name: String(slice?.name ?? slice?.label ?? slice?.id ?? '').trim(),
			percentage: numberValue(slice?.percentage ?? slice?.allocationPercent, null),
		}))
		.filter((slice) => slice.id && slice.name && slice.percentage !== null)
		.map((slice) => ({
			...slice,
			percentage: Math.max(0, Math.min(100, slice.percentage)),
		}));
}

function serializeTeamMember(row, roles = []) {
	if (!row) return null;
	const roleKey = primaryTeamRole(roles);
	return {
		id: row.id,
		teamId: row.team_id,
		userId: row.user_id,
		status: row.status,
		displayName: row.display_name,
		email: row.email,
		roleKey,
		role: roleKey,
		roles,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeTeamWebHost(row) {
	if (!row) return null;
	return {
		id: row.id,
		teamId: row.team_id,
		provider: row.provider,
		ownership: row.ownership,
		name: row.name,
		accountLabel: row.account_label,
		allowedEnvironments: parseJson(row.allowed_environments_json, []),
		status: row.status,
		encryptedPayload: parseJson(row.encrypted_payload_json, null),
		metadata: parseJson(row.metadata_json, {}),
		createdById: row.created_by_id,
		updatedById: row.updated_by_id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

const SUPPORTED_TEAM_HOST_PROVIDERS = new Set(['cloudflare', 'railway', 'smtp', 'openai', 'github_copilot', 'openrouter', 'custom']);

function defaultCapacityLaneDefinitions(providerId) {
	return [
		{
			id: `${providerId}:background-summary`,
			name: 'Background summaries',
			businessModel: 'subscription_quota',
			modelClass: 'small',
			scarcityLevel: 'low',
			routingPolicy: {
				taskKinds: ['question.summarize', 'release.summary', 'workday.report'],
				requiredCapabilities: ['agent_execution'],
				allowedEnvironments: ['local', 'staging', 'prod'],
				defaultPriorityClass: 'background',
				maxCreditsPerTask: 50,
				reserveAt: 'p90',
				requiresApprovalAboveCredits: 50,
				repositoryMutationAllowed: false,
				productionAllowed: true,
			},
		},
		{
			id: `${providerId}:proposal-drafting`,
			name: 'Proposal drafting',
			businessModel: 'subscription_quota',
			modelClass: 'medium',
			scarcityLevel: 'medium',
			routingPolicy: {
				taskKinds: ['proposal.draft', 'proposal.compare', 'market.description.draft'],
				requiredCapabilities: ['agent_execution'],
				allowedEnvironments: ['local', 'staging', 'prod'],
				defaultPriorityClass: 'interactive',
				maxCreditsPerTask: 30,
				reserveAt: 'p90',
				requiresApprovalAboveCredits: 50,
				repositoryMutationAllowed: false,
				productionAllowed: true,
			},
		},
		{
			id: `${providerId}:review-and-release-summary`,
			name: 'Review and release summaries',
			businessModel: 'subscription_quota',
			modelClass: 'medium',
			scarcityLevel: 'medium',
			routingPolicy: {
				taskKinds: ['decision.summary', 'release.summary', 'verification.run'],
				requiredCapabilities: ['agent_execution', 'reporting'],
				allowedEnvironments: ['local', 'staging', 'prod'],
				defaultPriorityClass: 'background',
				maxCreditsPerTask: 30,
				reserveAt: 'p90',
				requiresApprovalAboveCredits: 50,
				repositoryMutationAllowed: false,
				productionAllowed: true,
			},
		},
		{
			id: `${providerId}:repository-work`,
			name: 'Repository work',
			businessModel: 'infrastructure_runtime',
			modelClass: 'coding',
			scarcityLevel: 'high',
			routingPolicy: {
				taskKinds: ['repository.change.apply', 'verification.run'],
				requiredCapabilities: ['agent_execution', 'repository_work'],
				allowedEnvironments: ['local', 'staging'],
				defaultPriorityClass: 'interactive',
				maxCreditsPerTask: 25,
				reserveAt: 'p90',
				requiresApprovalAboveCredits: 10,
				repositoryMutationAllowed: true,
				productionAllowed: false,
			},
		},
	];
}

function serializeCapacityProvider(row) {
	if (!row) return null;
	const metadata = parseJson(row.metadata_json, {});
	const creditBudgetMode = normalizeCreditBudgetMode(row.credit_budget_mode, 'derived');
	return {
		id: row.id,
		teamId: row.team_id,
		ownerTeamId: row.owner_team_id,
		name: row.name,
		kind: row.kind,
		status: row.status,
		provider: row.provider,
		billingScope: row.billing_scope,
		monthlyCreditBudget: Number(row.monthly_credit_budget ?? 0),
		dailyCreditBudget: Number(row.daily_credit_budget ?? 0),
		creditBudgetMode,
		maxConcurrentWorkdays: Number(row.max_concurrent_workdays ?? 1),
		maxConcurrentWorkers: Number(row.max_concurrent_workers ?? 1),
		capacityModel: parseJson(row.capacity_model_json, {}),
		launchMode: metadata.launchMode ?? 'self_hosted',
		connectionState: metadata.connectionState ?? 'waiting_for_provider',
		lastSeenAt: metadata.lastSeenAt ?? metadata.lastHealth?.checkedAt ?? metadata.apiKey?.lastUsedAt ?? null,
		activeKeyPrefix: metadata.apiKey?.activeKeyPrefix ?? null,
		lastRotatedAt: metadata.apiKey?.lastRotatedAt ?? null,
		rotationRequired: metadata.apiKey?.rotationRequired === true,
		capabilities: Array.isArray(metadata.capabilities) ? metadata.capabilities : [],
		budgets: metadata.budgets && typeof metadata.budgets === 'object' ? metadata.budgets : {},
		deployment: metadata.deployment && typeof metadata.deployment === 'object'
			? metadata.deployment
			: {
				launchMode: metadata.launchMode ?? 'self_hosted',
				status: 'not_deployed',
			},
		metadata,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function normalizeCreditBudgetMode(value, fallback = 'derived') {
	const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
	if (!raw) return fallback;
	if (raw === 'static' || raw === 'hybrid' || raw === 'derived') return raw;
	throw new Error('creditBudgetMode must be static, hybrid, or derived.');
}

function serializeExecutionProvider(row, extras = {}) {
	if (!row) return null;
	return {
		id: row.id,
		teamId: row.team_id,
		capacityProviderId: row.capacity_provider_id,
		name: row.name,
		kind: row.kind,
		status: row.status,
		nativeUnit: row.native_unit,
		quotaVisibility: row.quota_visibility,
		maxConcurrentWorkers: Number(row.max_concurrent_workers ?? 1),
		resetCadence: row.reset_cadence,
		config: parseJson(row.config_json, {}),
		metadata: parseJson(row.metadata_json, {}),
		nativeLimits: extras.nativeLimits ?? [],
		latestObservation: extras.latestObservation ?? null,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeExecutionProviderNativeLimit(row) {
	if (!row) return null;
	const metadata = parseJson(row.metadata_json, {});
	return {
		id: row.id,
		executionProviderId: row.execution_provider_id,
		scope: row.scope,
		nativeUnit: row.native_unit,
		limitAmount: Number(row.limit_amount ?? 0),
		reserveBufferPercent: Number(row.reserve_buffer_percent ?? 0),
		resetCadence: row.reset_cadence,
		resetAt: row.reset_at,
		confidence: row.confidence,
		source: row.source,
		dailyUsageCapPercent: numberValue(metadata.dailyUsageCapPercent ?? metadata.maxDailyUsagePercent, null),
		metadata,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeExecutionProviderObservation(row) {
	if (!row) return null;
	return {
		id: row.id,
		executionProviderId: row.execution_provider_id,
		observedAt: row.observed_at,
		health: row.health,
		activeWorkers: row.active_workers == null ? null : Number(row.active_workers),
		queuedTasks: row.queued_tasks == null ? null : Number(row.queued_tasks),
		throttleState: row.throttle_state,
		nativeRemaining: parseJson(row.native_remaining_json, {}),
		resetAt: row.reset_at,
		confidence: row.confidence,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
	};
}

function serializeCapacityProviderApiKey(row) {
	if (!row) return null;
	return {
		id: row.id,
		capacityProviderId: row.capacity_provider_id,
		teamId: row.team_id,
		name: row.name,
		keyPrefix: row.key_prefix,
		scopes: parseJson(row.scopes_json, []),
		status: row.status,
		lastUsedAt: row.last_used_at,
		rotatedFromKeyId: row.rotated_from_key_id,
		expiresAt: row.expires_at,
		revokedAt: row.revoked_at,
		createdById: row.created_by_id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeCapacityProviderRegistration(row) {
	if (!row) return null;
	return {
		id: row.id,
		capacityProviderId: row.capacity_provider_id,
		teamId: row.team_id,
		runtimeVersion: row.runtime_version,
		marketId: row.market_id,
		capabilities: parseJson(row.capabilities_json, []),
		budgets: parseJson(row.budgets_json, {}),
		health: parseJson(row.health_json, {}),
		status: row.status,
		registeredAt: row.registered_at,
		lastSeenAt: row.last_seen_at,
		disconnectedAt: row.disconnected_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeCapacityProviderDeployment(row) {
	if (!row) return null;
	return {
		id: row.id,
		teamId: row.team_id,
		capacityProviderId: row.capacity_provider_id,
		launchMode: row.launch_mode,
		hostKind: row.host_kind,
		hostId: row.host_id,
		status: row.status,
		imageRef: row.image_ref,
		serviceRefs: parseJson(row.service_refs_json, {}),
		envRefs: parseJson(row.env_refs_json, {}),
		result: parseJson(row.result_json, {}),
		error: parseJson(row.error_json, null),
		createdById: row.created_by_id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		completedAt: row.completed_at,
	};
}

function serializeCapacityProviderHost(row) {
	if (!row) return null;
	return {
		id: row.id,
		capacityProviderId: row.capacity_provider_id,
		hostId: row.host_id,
		role: row.role,
		required: Number(row.required ?? 1) === 1,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeCapacityProviderLane(row) {
	if (!row) return null;
	return {
		id: row.id,
		capacityProviderId: row.capacity_provider_id,
		name: row.name,
		businessModel: row.business_model,
		modelFamily: row.model_family,
		modelClass: row.model_class,
		regionPolicy: row.region_policy,
		unit: row.unit,
		scarcityLevel: row.scarcity_level,
		hardLimits: parseJson(row.hard_limits_json, {}),
		routingPolicy: parseJson(row.routing_policy_json, {}),
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeCapacityGrant(row) {
	if (!row) return null;
	const metadata = parseJson(row.metadata_json, {});
	return {
		id: row.id,
		capacityProviderId: row.capacity_provider_id,
		laneId: row.lane_id,
		grantScope: row.grant_scope,
		teamId: row.team_id,
		projectId: row.project_id,
		environment: row.environment,
		state: row.state,
		dailyCreditLimit: row.daily_credit_limit == null ? null : Number(row.daily_credit_limit),
		weeklyCreditLimit: row.weekly_credit_limit == null ? null : Number(row.weekly_credit_limit),
		monthlyCreditLimit: row.monthly_credit_limit == null ? null : Number(row.monthly_credit_limit),
		dailyUsdLimit: row.daily_usd_limit == null ? null : Number(row.daily_usd_limit),
		weeklyQuotaMinutes: row.weekly_quota_minutes == null ? null : Number(row.weekly_quota_minutes),
		monthlyProviderUnits: row.monthly_provider_units == null ? null : Number(row.monthly_provider_units),
		portfolioAllocationPercent: numberValue(metadata.portfolioAllocationPercent ?? metadata.allocationPercent ?? metadata.derivedAllocationPercent, null),
		reservePoolPercent: numberValue(metadata.reservePoolPercent ?? metadata.minimumReservePercent, null),
		maxDailyProjectCredits: numberValue(metadata.maxDailyProjectCredits ?? metadata.dailyProjectCreditCap, null),
		emergencyOverride: metadata.emergencyOverride === true || metadata.emergencyOverrideEnabled === true,
		priorityWeight: Number(row.priority_weight ?? 1),
		overflowPolicy: row.overflow_policy,
		metadata,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeCapacityReservation(row) {
	if (!row) return null;
	return {
		id: row.id,
		capacityProviderId: row.capacity_provider_id,
		executionProviderId: row.execution_provider_id,
		laneId: row.lane_id,
		teamId: row.team_id,
		projectId: row.project_id,
		workDayId: row.work_day_id,
		taskId: row.task_id,
		state: row.state,
		reservedCredits: Number(row.reserved_credits ?? 0),
		consumedCredits: Number(row.consumed_credits ?? 0),
		nativeUnit: row.native_unit,
		reservedNativeAmount: row.reserved_native_amount == null ? null : Number(row.reserved_native_amount),
		consumedNativeAmount: row.consumed_native_amount == null ? null : Number(row.consumed_native_amount),
		reservedProviderUnits: row.reserved_provider_units == null ? null : Number(row.reserved_provider_units),
		consumedProviderUnits: row.consumed_provider_units == null ? null : Number(row.consumed_provider_units),
		reservedUsd: row.reserved_usd == null ? null : Number(row.reserved_usd),
		consumedUsd: row.consumed_usd == null ? null : Number(row.consumed_usd),
		expiresAt: row.expires_at,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeCapacityLedgerEntry(row) {
	if (!row) return null;
	return {
		id: row.id,
		capacityProviderId: row.capacity_provider_id,
		laneId: row.lane_id,
		reservationId: row.reservation_id,
		teamId: row.team_id,
		projectId: row.project_id,
		workDayId: row.work_day_id,
		taskId: row.task_id,
		phase: row.phase,
		credits: Number(row.credits ?? 0),
		providerUnits: row.provider_units == null ? null : Number(row.provider_units),
		usd: row.usd == null ? null : Number(row.usd),
		source: row.source,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
	};
}

function serializeCapacityRoutingDecision(row) {
	if (!row) return null;
	return {
		id: row.id,
		taskId: row.task_id,
		workDayId: row.work_day_id,
		projectId: row.project_id,
		selectedProviderId: row.selected_provider_id,
		selectedLaneId: row.selected_lane_id,
		selectedModel: row.selected_model,
		decision: row.decision,
		reason: row.reason,
		candidates: parseJson(row.candidate_json, []),
		scores: parseJson(row.score_json, {}),
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
	};
}

function serializeTaskEstimate(row) {
	if (!row) return null;
	return {
		id: row.id,
		taskId: row.task_id,
		workDayId: row.work_day_id,
		projectId: row.project_id,
		estimatePhase: row.estimate_phase,
		taskSignature: row.task_signature,
		executionProfileId: executionProfileId(row.execution_profile_id),
		confidence: row.confidence,
		estimatedCreditsP50: Number(row.estimated_credits_p50 ?? 0),
		estimatedCreditsP90: Number(row.estimated_credits_p90 ?? 0),
		reservedCredits: Number(row.reserved_credits ?? 0),
		estimatedInputTokensP50: row.estimated_input_tokens_p50 == null ? null : Number(row.estimated_input_tokens_p50),
		estimatedInputTokensP90: row.estimated_input_tokens_p90 == null ? null : Number(row.estimated_input_tokens_p90),
		estimatedOutputTokensP50: row.estimated_output_tokens_p50 == null ? null : Number(row.estimated_output_tokens_p50),
		estimatedOutputTokensP90: row.estimated_output_tokens_p90 == null ? null : Number(row.estimated_output_tokens_p90),
		estimatedQuotaMinutesP50: row.estimated_quota_minutes_p50 == null ? null : Number(row.estimated_quota_minutes_p50),
		estimatedQuotaMinutesP90: row.estimated_quota_minutes_p90 == null ? null : Number(row.estimated_quota_minutes_p90),
		features: parseJson(row.features_json, {}),
		createdAt: row.created_at,
	};
}

function serializeTaskUsageActual(row) {
	if (!row) return null;
	return {
		id: row.id,
		taskId: row.task_id,
		workDayId: row.work_day_id,
		projectId: row.project_id,
		taskSignature: row.task_signature,
		executionProfileId: executionProfileId(row.execution_profile_id),
		capacityProviderId: row.capacity_provider_id,
		executionProviderId: row.execution_provider_id,
		laneId: row.lane_id,
		businessModel: row.business_model,
		modelName: row.model_name,
		inputTokens: row.input_tokens == null ? null : Number(row.input_tokens),
		outputTokens: row.output_tokens == null ? null : Number(row.output_tokens),
		cachedInputTokens: row.cached_input_tokens == null ? null : Number(row.cached_input_tokens),
		quotaMinutes: row.quota_minutes == null ? null : Number(row.quota_minutes),
		wallMinutes: row.wall_minutes == null ? null : Number(row.wall_minutes),
		filesOpened: row.files_opened == null ? null : Number(row.files_opened),
		filesChanged: row.files_changed == null ? null : Number(row.files_changed),
		diffLinesAdded: row.diff_lines_added == null ? null : Number(row.diff_lines_added),
		diffLinesRemoved: row.diff_lines_removed == null ? null : Number(row.diff_lines_removed),
		testRuns: row.test_runs == null ? null : Number(row.test_runs),
		retryCount: row.retry_count == null ? null : Number(row.retry_count),
		actualCredits: Number(row.actual_credits ?? 0),
		actualUsd: row.actual_usd == null ? null : Number(row.actual_usd),
		creditFormulaVersion: row.credit_formula_version,
		actualCreditSource: row.actual_credit_source,
		nativeUsage: parseJson(row.native_usage_json, {}),
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
	};
}

function serializeTaskEstimateProfile(row) {
	if (!row) return null;
	return {
		taskSignature: row.task_signature,
		executionProfileId: executionProfileId(row.execution_profile_id),
		sampleCount: Number(row.sample_count ?? 0),
		completedSampleCount: Number(row.completed_sample_count ?? row.sample_count ?? 0),
		interruptedSampleCount: Number(row.interrupted_sample_count ?? 0),
		inputTokensP50: row.input_tokens_p50 == null ? null : Number(row.input_tokens_p50),
		inputTokensP90: row.input_tokens_p90 == null ? null : Number(row.input_tokens_p90),
		outputTokensP50: row.output_tokens_p50 == null ? null : Number(row.output_tokens_p50),
		outputTokensP90: row.output_tokens_p90 == null ? null : Number(row.output_tokens_p90),
		quotaMinutesP50: row.quota_minutes_p50 == null ? null : Number(row.quota_minutes_p50),
		quotaMinutesP90: row.quota_minutes_p90 == null ? null : Number(row.quota_minutes_p90),
		filesChangedP50: row.files_changed_p50 == null ? null : Number(row.files_changed_p50),
		filesChangedP90: row.files_changed_p90 == null ? null : Number(row.files_changed_p90),
		creditsP50: row.credits_p50 == null ? null : Number(row.credits_p50),
		creditsP90: row.credits_p90 == null ? null : Number(row.credits_p90),
		creditsVariance: row.credits_variance == null ? null : Number(row.credits_variance),
		confidenceScore: row.confidence_score == null ? null : Number(row.confidence_score),
		outlierCount: Number(row.outlier_count ?? 0),
		partialCredits: row.partial_credits == null ? null : Number(row.partial_credits),
		firstSampleAt: row.first_sample_at,
		lastSampleAt: row.last_sample_at,
		updatedAt: row.updated_at,
	};
}

function serializeCreditConversionProfile(row) {
	if (!row) return null;
	return {
		id: row.id,
		taskSignature: row.task_signature,
		executionProfileId: executionProfileId(row.execution_profile_id),
		executionProviderKind: row.execution_provider_kind,
		nativeUnit: row.native_unit,
		sampleCount: Number(row.sample_count ?? 0),
		completedSampleCount: Number(row.completed_sample_count ?? 0),
		interruptedSampleCount: Number(row.interrupted_sample_count ?? 0),
		nativeUnitsPerCreditP50: row.native_units_per_credit_p50 == null ? null : Number(row.native_units_per_credit_p50),
		nativeUnitsPerCreditP90: row.native_units_per_credit_p90 == null ? null : Number(row.native_units_per_credit_p90),
		creditsPerNativeUnitP50: row.credits_per_native_unit_p50 == null ? null : Number(row.credits_per_native_unit_p50),
		creditsPerNativeUnitP90: row.credits_per_native_unit_p90 == null ? null : Number(row.credits_per_native_unit_p90),
		actualCreditsP50: row.actual_credits_p50 == null ? null : Number(row.actual_credits_p50),
		actualCreditsP90: row.actual_credits_p90 == null ? null : Number(row.actual_credits_p90),
		confidence: row.confidence,
		formulaVersion: row.formula_version,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeApprovalRequest(row) {
	if (!row) return null;
	return {
		id: row.id,
		teamId: row.team_id,
		projectId: row.project_id,
		workDayId: row.work_day_id,
		taskId: row.task_id,
		kind: row.kind,
		state: row.state,
		severity: row.severity,
		requestedByType: row.requested_by_type,
		requestedById: row.requested_by_id,
		title: row.title,
		summary: row.summary,
		options: parseJson(row.options_json, []),
		recommendation: parseJson(row.recommendation_json, {}),
		policySnapshot: parseJson(row.policy_snapshot_json, {}),
		expiresAt: row.expires_at,
		decidedByType: row.decided_by_type,
		decidedById: row.decided_by_id,
		decidedAt: row.decided_at,
		decision: parseJson(row.decision_json, null),
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeSeedRun(row) {
	if (!row) return null;
	return {
		id: row.id,
		seedName: row.seed_name,
		seedVersion: Number(row.seed_version ?? 1),
		environments: parseJson(row.environments_json, []),
		mode: row.mode,
		state: row.state,
		actorType: row.actor_type,
		actorId: row.actor_id,
		manifestHash: row.manifest_hash,
		plan: redactDeploymentValue(parseJson(row.plan_json, null)),
		result: redactDeploymentValue(parseJson(row.result_json, null)),
		error: redactDeploymentValue(parseJson(row.error_json, null)),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		completedAt: row.completed_at,
	};
}

function serializeRuntimeWorkDay(row) {
	if (!row) return null;
	return {
		id: row.id,
		projectId: row.project_id,
		state: row.state,
		capacityBudget: Number(row.capacity_budget ?? 0),
		capacityUsed: Number(row.capacity_used ?? 0),
		graphVersion: row.graph_version,
		summary: parseJson(row.summary_json, {}),
		summaryJson: row.summary_json,
		startedAt: row.started_at,
		endedAt: row.ended_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeRuntimeTask(row) {
	if (!row) return null;
	return {
		id: row.id,
		workDayId: row.work_day_id,
		agentId: row.agent_id,
		type: row.type,
		state: row.state,
		priority: Number(row.priority ?? 0),
		idempotencyKey: row.idempotency_key,
		payloadJson: row.payload_json,
		payloadHash: row.payload_hash,
		attemptCount: Number(row.attempt_count ?? 0),
		maxAttempts: Number(row.max_attempts ?? 3),
		claimedBy: row.claimed_by,
		leaseExpiresAt: row.lease_expires_at,
		availableAt: row.available_at,
		lastErrorCode: row.last_error_code,
		lastErrorMessage: row.last_error_message,
		graphVersion: row.graph_version,
		parentTaskId: row.parent_task_id,
		createdAt: row.created_at,
		startedAt: row.started_at,
		completedAt: row.completed_at,
		updatedAt: row.updated_at,
	};
}

function serializeRuntimeTaskEvent(row) {
	if (!row) return null;
	return {
		id: row.id,
		taskId: row.task_id,
		seq: Number(row.seq ?? 0),
		kind: row.kind,
		dataJson: row.data_json,
		createdAt: row.created_at,
	};
}

function serializeRuntimeTaskOutput(row) {
	if (!row) return null;
	return {
		id: row.id,
		taskId: row.task_id,
		outputJson: row.output_json,
		outputRef: row.output_ref,
		createdAt: row.created_at,
	};
}

function serializeRuntimeReport(row) {
	if (!row) return null;
	return {
		id: row.id,
		workDayId: row.work_day_id,
		kind: row.kind,
		body: parseJson(row.body_json, {}),
		renderedRef: row.rendered_ref,
		sentAt: row.sent_at,
		createdAt: row.created_at,
	};
}

function serializeTeamInvite(row) {
	if (!row) return null;
	return {
		id: row.id,
		teamId: row.team_id,
		email: row.email,
		roleKey: row.role_key,
		status: row.status,
		invitedByUserId: row.invited_by_user_id,
		acceptedByUserId: row.accepted_by_user_id,
		acceptedAt: row.accepted_at,
		expiresAt: row.expires_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeProject(row) {
	if (!row) return null;
	return {
		id: row.id,
		teamId: row.team_id,
		slug: row.slug,
		name: row.name,
		description: row.description,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function isoDate(value) {
	if (typeof value !== 'string' || !value.trim()) {
		return null;
	}
	const parsed = new Date(value);
	return Number.isFinite(parsed.valueOf()) ? parsed.toISOString() : null;
}

function compareDatesDesc(left, right) {
	const leftTime = isoDate(left) ? new Date(left).getTime() : 0;
	const rightTime = isoDate(right) ? new Date(right).getTime() : 0;
	return rightTime - leftTime;
}

function latestDate(...values) {
	return values
		.map((value) => isoDate(value))
		.filter(Boolean)
		.sort(compareDatesDesc)[0] ?? null;
}

function uniqueStrings(values) {
	return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))];
}

const PROJECT_DEPLOYMENT_TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);
const PROJECT_DEPLOYMENT_ACTIVE_STATUSES = new Set(['queued', 'claimed', 'dispatching', 'running', 'monitoring']);

function normalizeProjectDeploymentStatus(value, fallback = 'queued') {
	const status = typeof value === 'string' ? value.trim() : '';
	if (status === 'success') return 'succeeded';
	if (status === 'pending') return 'queued';
	return status || fallback;
}

function deploymentKindForAction(action) {
	if (action === 'publish_content') return 'content';
	if (action === 'monitor') return 'mixed';
	return 'code';
}

function summarizeProjectHealth({ hosting, connection, deployments, jobs }) {
	const failedDeployment = deployments.find((deployment) => deployment.status === 'failed');
	if (failedDeployment) {
		return {
			state: 'verification_failing',
			label: 'Verification failing',
			reason: `Latest ${failedDeployment.environment} deployment failed.`,
		};
	}

	const failedJob = jobs.find((job) => job.status === 'failed');
	if (failedJob) {
		return {
			state: 'action_required',
			label: 'Action required',
			reason: `Workflow ${failedJob.operation} failed.`,
		};
	}

	if (!hosting || !connection) {
		return {
			state: 'setup_needed',
			label: 'Setup needed',
			reason: 'Hosting and runtime connection still need configuration.',
		};
	}

	const readyRelease = deployments.find((deployment) => deployment.environment === 'staging' && deployment.status === 'succeeded');
	if (readyRelease) {
		return {
			state: 'release_ready',
			label: 'Release ready',
			reason: 'A verified staging candidate is ready for human review.',
		};
	}

	return {
		state: 'working_normally',
		label: 'Working normally',
		reason: 'This project has a healthy runtime surface and no active failures.',
	};
}

function summarizeDeploymentStatus(deployment) {
	if (!deployment) {
		return null;
	}
	return {
		id: deployment.id,
		environment: deployment.environment,
		status: deployment.status,
		deploymentKind: deployment.deploymentKind,
		releaseTag: deployment.releaseTag,
		commitSha: deployment.commitSha,
		sourceRef: deployment.sourceRef,
		finishedAt: deployment.finishedAt,
		startedAt: deployment.startedAt,
	};
}

function toActivityItem(kind, input) {
	return {
		kind,
		id: input.id,
		title: input.title,
		status: input.status,
		timestamp: input.timestamp,
		href: input.href ?? null,
		summary: input.summary ?? null,
		metadata: input.metadata ?? {},
	};
}

function serializeConnection(row) {
	if (!row) return null;
	return {
		id: row.id,
		projectId: row.project_id,
		mode: row.mode,
		projectApiBaseUrl: row.project_api_base_url,
		runnerRegistrationState: row.runner_registration_state,
		executionOwner: row.execution_owner,
		runnerRegisteredAt: row.runner_registered_at,
		runnerLastSeenAt: row.runner_last_seen_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		metadata: parseJson(row.metadata_json, {}),
	};
}

function serializeRepositoryHost(row) {
	if (!row) return null;
	return {
		id: row.id,
		teamId: row.team_id,
		provider: row.provider,
		ownership: row.ownership,
		name: row.name,
		accountLabel: row.account_label,
		organizationOrOwner: row.organization_or_owner,
		defaultVisibility: row.default_visibility,
		softwareRepositoryNameTemplate: row.software_repository_name_template,
		contentRepositoryNameTemplate: row.content_repository_name_template,
		branchPolicy: parseJson(row.branch_policy_json, {}),
		workflowPolicy: parseJson(row.workflow_policy_json, {}),
		encryptedPayload: parseJson(row.encrypted_payload_json, null),
		allowedProjectKinds: parseJson(row.allowed_project_kinds_json, []),
		status: row.status,
		metadata: parseJson(row.metadata_json, {}),
		createdById: row.created_by_id,
		updatedById: row.updated_by_id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeHubRepository(row) {
	if (!row) return null;
	return {
		id: row.id,
		hubId: row.hub_id,
		teamId: row.team_id,
		role: row.role,
		repositoryHostId: row.repository_host_id,
		provider: row.provider,
		owner: row.owner,
		name: row.name,
		url: row.url,
		defaultBranch: row.default_branch,
		currentBranch: row.current_branch,
		status: row.status,
		accessPolicy: parseJson(row.access_policy_json, {}),
		releasePolicy: parseJson(row.release_policy_json, {}),
		publishPolicy: parseJson(row.publish_policy_json, {}),
		submodulePath: row.submodule_path,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeHubContentSource(row) {
	if (!row) return null;
	return {
		id: row.id,
		hubId: row.hub_id,
		teamId: row.team_id,
		contentRepositoryId: row.content_repository_id,
		productionSource: row.production_source,
		overlayPolicy: row.overlay_policy,
		r2BucketName: row.r2_bucket_name,
		r2ManifestKey: row.r2_manifest_key,
		r2PublicBaseUrl: row.r2_public_base_url,
		latestPublishId: row.latest_publish_id,
		latestContentVersion: row.latest_content_version,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeTreeDxInstance(row) {
	if (!row) return null;
	return {
		id: row.id,
		teamId: row.team_id,
		kind: row.kind,
		provider: row.provider,
		name: row.name,
		baseUrl: row.base_url,
		registryUrl: row.registry_url,
		publicRead: Boolean(row.public_read),
		primary: Boolean(row.primary),
		status: row.status,
		imageRef: row.image_ref,
		railwayProjectId: row.railway_project_id,
		railwayServiceId: row.railway_service_id,
		railwayEnvironmentId: row.railway_environment_id,
		volumeMountPath: row.volume_mount_path,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeTreeDxProjectLibrary(row) {
	if (!row) return null;
	return {
		id: row.id,
		teamId: row.team_id,
		projectId: row.project_id,
		instanceId: row.instance_id,
		libraryId: row.library_id,
		repositoryId: row.repository_id,
		contentPath: row.content_path,
		contentRepositoryUrl: row.content_repository_url,
		contentRepositoryDefaultBranch: row.content_repository_default_branch,
		contentRepositoryRef: row.content_repository_ref,
		r2BucketName: row.r2_bucket_name,
		r2ManifestKey: row.r2_manifest_key,
		topology: parseJson(row.topology_json, {}),
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeTreeDxMirror(row) {
	if (!row) return null;
	return {
		id: row.id,
		teamId: row.team_id,
		instanceId: row.instance_id,
		name: row.name,
		direction: row.direction,
		targetKind: row.target_kind,
		targetUrl: row.target_url,
		status: row.status,
		instructions: row.instructions,
		lastSyncAt: row.last_sync_at,
		lastSyncStatus: row.last_sync_status,
		lastSyncMetadata: parseJson(row.last_sync_metadata_json, {}),
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeTreeDxShare(row) {
	if (!row) return null;
	return {
		id: row.id,
		teamId: row.team_id,
		instanceId: row.instance_id,
		projectId: row.project_id,
		libraryId: row.library_id,
		scope: row.scope,
		targetTeamId: row.target_team_id,
		trustGrant: parseJson(row.trust_grant_json, {}),
		publicRead: Boolean(row.public_read),
		status: row.status,
		expiresAt: row.expires_at,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		revokedAt: row.revoked_at,
	};
}

function serializeTreeDxDeployment(row) {
	if (!row) return null;
	return {
		id: row.id,
		teamId: row.team_id,
		instanceId: row.instance_id,
		provider: row.provider,
		status: row.status,
		imageRef: row.image_ref,
		volumeMountPath: row.volume_mount_path,
		serviceRefs: parseJson(row.service_refs_json, {}),
		result: parseJson(row.result_json, {}),
		error: parseJson(row.error_json, null),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		completedAt: row.completed_at,
	};
}

function serializeHubLaunch(row) {
	if (!row) return null;
	return {
		id: row.id,
		hubId: row.hub_id,
		teamId: row.team_id,
		jobId: row.job_id,
		intent: parseJson(row.intent_json, {}),
		plan: parseJson(row.plan_json, {}),
		state: row.state,
		currentPhase: row.current_phase,
		lastSuccessfulPhase: row.last_successful_phase,
		result: parseJson(row.result_json, null),
		error: parseJson(row.error_json, null),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		completedAt: row.completed_at,
	};
}

function serializeHubLaunchEvent(row) {
	if (!row) return null;
	return {
		id: row.id,
		launchId: row.launch_id,
		seq: Number(row.seq ?? 0),
		phase: row.phase,
		status: row.status,
		title: row.title,
		summary: row.summary,
		startedAt: row.started_at,
		finishedAt: row.finished_at,
		error: parseJson(row.error_json, null),
		data: parseJson(row.data_json, {}),
		createdAt: row.created_at,
	};
}

function serializeHubWorkspaceLink(row) {
	if (!row) return null;
	return {
		id: row.id,
		hubId: row.hub_id,
		teamId: row.team_id,
		parentRepositoryHostId: row.parent_repository_host_id,
		parentOwner: row.parent_owner,
		parentName: row.parent_name,
		parentUrl: row.parent_url,
		parentBranch: row.parent_branch,
		hubMountPath: row.hub_mount_path,
		softwareSubmodulePath: row.software_submodule_path,
		contentSubmodulePath: row.content_submodule_path,
		updateSubmodulePointersEnabled: Boolean(row.update_submodule_pointers_enabled),
		accessPolicy: parseJson(row.access_policy_json, {}),
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeProjectUpdatePlan(row) {
	if (!row) return null;
	return {
		id: row.id,
		hubId: row.hub_id,
		teamId: row.team_id,
		sourceKind: row.source_kind,
		sourceRef: row.source_ref,
		sourceVersion: row.source_version,
		plan: parseJson(row.plan_json, {}),
		state: row.state,
		requiresDecision: Boolean(row.requires_decision),
		decisionId: row.decision_id,
		createdBy: row.created_by,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeProviderCredentialSession(row, { includeEncryptedPayload = false } = {}) {
	if (!row) return null;
	const payload = {
		id: row.id,
		teamId: row.team_id,
		projectId: row.project_id,
		jobId: row.job_id,
		hostKind: row.host_kind,
		hostId: row.host_id,
		purpose: row.purpose,
		status: row.status,
		expiresAt: row.expires_at,
		consumedAt: row.consumed_at,
		createdById: row.created_by_id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		metadata: parseJson(row.metadata_json, {}),
	};
	if (includeEncryptedPayload) {
		payload.encryptedPayload = parseJson(row.encrypted_payload_json, null);
	}
	return payload;
}

function serializeCapability(row) {
	if (!row) return null;
	return {
		id: row.id,
		projectId: row.project_id,
		namespace: row.namespace,
		operation: row.operation,
		label: row.label ?? null,
		executionClass: row.execution_class,
		allowedTargets: parseJson(row.allowed_targets_json, []),
		defaultDispatchMode: row.default_dispatch_mode,
		enabled: Boolean(row.enabled),
		approvalPolicy: parseJson(row.approval_policy_json, {}),
		resourceScope: parseJson(row.resource_scope_json, {}),
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeEntitlement(row) {
	if (!row) return null;
	return {
		id: row.id,
		teamId: row.team_id,
		projectId: row.project_id,
		tier: row.tier,
		status: row.status,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeJob(row) {
	if (!row) return null;
	return {
		id: row.id,
		projectId: row.project_id,
		namespace: row.namespace,
		operation: row.operation,
		status: row.status,
		preferredMode: row.preferred_mode,
		selectedTarget: row.selected_target,
		input: parseJson(row.input_json, {}),
		output: parseJson(row.output_json, null),
		error: parseJson(row.error_json, null),
		requestedByType: row.requested_by_type,
		requestedById: row.requested_by_id,
		assignedRunnerId: row.assigned_runner_id,
		idempotencyKey: row.idempotency_key,
		capability: parseJson(row.capability_json, null),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		startedAt: row.started_at,
		finishedAt: row.finished_at,
		cancelledAt: row.cancelled_at,
	};
}

function serializeJobEvent(row) {
	if (!row) return null;
	return {
		id: row.id,
		jobId: row.job_id,
		seq: Number(row.seq),
		kind: row.kind,
		data: parseJson(row.data_json, {}),
		createdAt: row.created_at,
	};
}

function serializePlatformOperation(row) {
	if (!row) return null;
	return {
		id: row.id,
		namespace: row.namespace,
		operation: row.operation,
		status: row.status,
		target: row.target,
		idempotencyKey: row.idempotency_key,
		input: parseJson(row.input_json, {}),
		output: parseJson(row.output_json, null),
		error: parseJson(row.error_json, null),
		requestedByType: row.requested_by_type,
		requestedById: row.requested_by_id,
		assignedRunnerId: row.assigned_runner_id,
		leaseExpiresAt: row.lease_expires_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		startedAt: row.started_at,
		finishedAt: row.finished_at,
		cancelledAt: row.cancelled_at,
	};
}

function serializePlatformOperationEvent(row) {
	if (!row) return null;
	return {
		id: row.id,
		operationId: row.operation_id,
		seq: Number(row.seq),
		kind: row.kind,
		data: parseJson(row.data_json, {}),
		createdAt: row.created_at,
	};
}

function serializeMarketOperationRunner(row) {
	if (!row) return null;
	return {
		id: row.id,
		runnerKey: row.runner_key,
		name: row.name,
		environment: row.environment,
		status: row.status,
		version: row.version,
		capabilities: parseJson(row.capabilities_json, []),
		activeJobCount: Number(row.active_job_count ?? 0),
		maxConcurrentJobs: Number(row.max_concurrent_jobs ?? 1),
		heartbeatAt: row.heartbeat_at,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializePlatformRepositoryClaim(row) {
	if (!row) return null;
	return {
		id: row.id,
		repositoryKey: row.repository_key,
		runnerId: row.runner_id,
		workspacePath: row.workspace_path,
		branch: row.branch,
		commitSha: row.commit_sha,
		claimState: row.claim_state,
		leaseExpiresAt: row.lease_expires_at,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function platformRepositoryKey(repository = {}) {
	return [repository.provider ?? 'git', repository.owner ?? 'local', repository.name ?? 'repository']
		.join('-')
		.toLowerCase()
		.replace(/[^a-z0-9.-]+/gu, '-')
		.replace(/^-+|-+$/gu, '') || 'repository';
}

function platformRepositoryWorkspacePath(workspaceRoot, repository = {}) {
	const root = String(workspaceRoot ?? '/data').replace(/\/+$/u, '') || '/data';
	return `${root}/repositories/${platformRepositoryKey(repository)}/repo`;
}

function serializeAuditEvent(row) {
	if (!row) return null;
	return {
		id: row.id,
		actorType: row.actor_type,
		actorId: row.actor_id,
		eventType: row.event_type,
		targetType: row.target_type,
		targetId: row.target_id,
		data: redactDeploymentValue(parseJson(row.data_json, {})),
		createdAt: row.created_at,
	};
}

function serializeKnowledgePack(row) {
	if (!row) return null;
	return {
		id: row.id,
		teamId: row.team_id,
		slug: row.slug,
		name: row.name,
		summary: row.summary,
		sourceKind: row.source_kind,
		sourceRef: row.source_ref,
		installStrategy: row.install_strategy,
		visibility: row.visibility,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeTeamStorageLocator(row) {
	if (!row) return null;
	return {
		id: row.id,
		teamId: row.team_id,
		bucketName: row.bucket_name,
		manifestKeyTemplate: row.manifest_key_template,
		previewRootTemplate: row.preview_root_template,
		publicBaseUrl: row.public_base_url,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeCatalogItem(row) {
	if (!row) return null;
	return {
		id: row.id,
		teamId: row.team_id,
		kind: row.kind,
		slug: row.slug,
		title: row.title,
		summary: row.summary,
		visibility: row.visibility,
		listingEnabled: Boolean(row.listing_enabled),
		offerMode: row.offer_mode,
		manifestKey: row.manifest_key,
		artifactKey: row.artifact_key,
		searchText: row.search_text,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeCatalogArtifactVersion(row) {
	if (!row) return null;
	return {
		id: row.id,
		itemId: row.item_id,
		teamId: row.team_id,
		kind: row.kind,
		version: row.version,
		contentKey: row.content_key,
		manifestKey: row.manifest_key,
		metadata: parseJson(row.metadata_json, {}),
		publishedAt: row.published_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeProjectHosting(row) {
	if (!row) return null;
	return {
		id: row.id,
		projectId: row.project_id,
		kind: row.hosting_kind,
		registration: row.registration,
		marketBaseUrl: row.market_base_url,
		sourceRepoOwner: row.source_repo_owner,
		sourceRepoName: row.source_repo_name,
		sourceRepoUrl: row.source_repo_url,
		sourceRepoWorkflowPath: row.source_repo_workflow_path,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeProjectEnvironment(row) {
	if (!row) return null;
	return {
		id: row.id,
		projectId: row.project_id,
		environment: row.environment,
		deploymentProfile: row.deployment_profile,
		baseUrl: row.base_url,
		cloudflareAccountId: row.cloudflare_account_id,
		pagesProjectName: row.pages_project_name,
		workerName: row.worker_name,
		r2BucketName: row.r2_bucket_name,
		d1DatabaseName: row.d1_database_name,
		queueName: row.queue_name,
		railwayProjectName: row.railway_project_name,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeProjectInfrastructureResource(row) {
	if (!row) return null;
	return {
		id: row.id,
		projectId: row.project_id,
		environment: row.environment,
		provider: row.provider,
		resourceKind: row.resource_kind,
		logicalName: row.logical_name,
		locator: row.locator,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeProjectDeployment(row) {
	if (!row) return null;
	const metadata = redactDeploymentValue(parseJson(row.metadata_json, {}));
	return {
		id: row.id,
		teamId: row.team_id ?? metadata.teamId ?? null,
		projectId: row.project_id,
		environment: row.environment,
		deploymentKind: row.deployment_kind,
		action: row.action ?? metadata.action ?? (row.deployment_kind === 'content' ? 'publish_content' : 'deploy_web'),
		status: row.status,
		platformOperationId: row.platform_operation_id ?? null,
		retryOfDeploymentId: row.retry_of_deployment_id ?? null,
		resumedFromDeploymentId: row.resumed_from_deployment_id ?? null,
		idempotencyKey: row.idempotency_key ?? null,
		requestedByUserId: row.requested_by_user_id ?? null,
		sourceRef: row.source_ref,
		releaseTag: row.release_tag,
		commitSha: row.commit_sha,
		triggeredByType: row.triggered_by_type,
		triggeredById: row.triggered_by_id,
		repository: redactDeploymentValue(parseJson(row.repository_json, metadata.repository ?? {})),
		externalWorkflow: redactDeploymentValue(parseJson(row.external_workflow_json, metadata.externalWorkflow ?? {})),
		target: redactDeploymentValue(parseJson(row.target_json, metadata.target ?? {})),
		monitor: redactDeploymentValue(parseJson(row.monitor_json, metadata.monitor ?? {})),
		summary: row.summary ?? metadata.summary ?? null,
		error: redactDeploymentValue(parseJson(row.error_json, metadata.error ?? {})),
		metadata,
		startedAt: row.started_at,
		finishedAt: row.finished_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		completedAt: row.completed_at ?? row.finished_at ?? null,
	};
}

function serializeProjectDeploymentEvent(row) {
	if (!row) return null;
	return {
		id: row.id,
		deploymentId: row.deployment_id,
		projectId: row.project_id,
		teamId: row.team_id,
		operationId: row.operation_id ?? null,
		kind: row.kind,
		message: row.message,
		status: row.status ?? null,
		severity: row.severity ?? 'info',
		sequence: Number(row.sequence ?? 0),
		payload: redactDeploymentValue(parseJson(row.payload_json, {})),
		createdAt: row.created_at,
	};
}

function serializeAgentPool(row) {
	if (!row) return null;
	return {
		id: row.id,
		projectId: row.project_id,
		teamId: row.team_id,
		environment: row.environment,
		name: row.name,
		registrationIdentity: row.registration_identity,
		serviceBaseUrl: row.service_base_url,
		status: row.status,
		autoscale: {
			minWorkers: Number(row.min_workers ?? 0),
			maxWorkers: Number(row.max_workers ?? 1),
			targetQueueDepth: Number(row.target_queue_depth ?? 1),
			cooldownSeconds: Number(row.cooldown_seconds ?? 60),
		},
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeAgentPoolRegistration(row) {
	if (!row) return null;
	return {
		id: row.id,
		poolId: row.pool_id,
		projectId: row.project_id,
		runnerId: row.runner_id,
		managerId: row.manager_id,
		serviceName: row.service_name,
		heartbeatAt: row.heartbeat_at,
		desiredWorkers: row.desired_workers === null || row.desired_workers === undefined ? null : Number(row.desired_workers),
		observedQueueDepth: row.observed_queue_depth === null || row.observed_queue_depth === undefined ? null : Number(row.observed_queue_depth),
		observedActiveLeases: row.observed_active_leases === null || row.observed_active_leases === undefined ? null : Number(row.observed_active_leases),
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeAgentPoolScaleDecision(row) {
	if (!row) return null;
	return {
		id: row.id,
		poolId: row.pool_id,
		projectId: row.project_id,
		environment: row.environment,
		desiredWorkers: Number(row.desired_workers ?? 0),
		observedQueueDepth: Number(row.observed_queue_depth ?? 0),
		observedActiveLeases: Number(row.observed_active_leases ?? 0),
		workDayId: row.work_day_id,
		reason: row.reason,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeProjectWorkdaySummary(row) {
	if (!row) return null;
	return {
		id: row.id,
		projectId: row.project_id,
		environment: row.environment,
		workDayId: row.work_day_id,
		kind: row.kind,
		state: row.state,
		startedAt: row.started_at,
		endedAt: row.ended_at,
		summary: parseJson(row.summary_json, {}),
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeWorkPolicy(row) {
	if (!row) return null;
	const metadata = parseJson(row.metadata_json, {});
	const autoscale = parseJson(row.autoscale_json, {});
	const dailyCreditBudget = Number(row.daily_credit_budget ?? row.daily_task_credit_budget ?? 0);
	return {
		projectId: row.project_id,
		environment: row.environment,
		schedule: parseJson(row.schedule_json, { timezone: 'UTC', windows: [] }),
		enabled: row.enabled === undefined || row.enabled === null ? metadata.enabled !== false : Number(row.enabled) !== 0,
		startCron: row.start_cron ?? metadata.startCron ?? '0 9 * * 1-5',
		durationMinutes: Number(row.duration_minutes ?? metadata.durationMinutes ?? 480),
		maxRunners: Number(row.max_runners ?? metadata.maxRunners ?? autoscale.maxWorkers ?? 1),
		maxWorkersPerRunner: Number(row.max_workers_per_runner ?? metadata.maxWorkersPerRunner ?? 4),
		dailyCreditBudget,
		closeoutGraceMinutes: Number(row.closeout_grace_minutes ?? metadata.closeoutGraceMinutes ?? 15),
		dailyTaskCreditBudget: dailyCreditBudget,
		maxQueuedTasks: Number(row.max_queued_tasks ?? 0),
		maxQueuedCredits: Number(row.max_queued_credits ?? 0),
		autoscale,
		creditWeights: parseJson(row.credit_weights_json, []),
		metadata,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeWorkdayRequest(row) {
	if (!row) return null;
	return {
		id: row.id,
		projectId: row.project_id,
		environment: row.environment,
		type: row.type,
		state: row.state,
		workDayId: row.work_day_id,
		requestedBy: row.requested_by,
		reason: row.reason,
		payload: parseJson(row.payload_json, {}),
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeWorkdayManagerLease(row) {
	if (!row) return null;
	return {
		id: row.id,
		projectId: row.project_id,
		environment: row.environment,
		workDayId: row.work_day_id,
		managerId: row.manager_id,
		state: row.state,
		heartbeatAt: row.heartbeat_at,
		expiresAt: row.expires_at,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeWorkerRunner(row) {
	if (!row) return null;
	return {
		id: row.id,
		projectId: row.project_id,
		environment: row.environment,
		runnerId: row.runner_id,
		runnerServiceName: row.runner_service_name,
		volumeIdentity: row.volume_identity,
		state: row.state,
		maxLocalWorkers: Number(row.max_local_workers ?? 4),
		activeLocalWorkers: Number(row.active_local_workers ?? 0),
		availableCapacity: Number(row.available_capacity ?? 0),
		lastHeartbeatAt: row.last_heartbeat_at,
		claimedRepositoryIds: parseJson(row.claimed_repository_ids_json, []),
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeRepositoryClaim(row) {
	if (!row) return null;
	return {
		id: row.id,
		projectId: row.project_id,
		repositoryId: row.repository_id,
		runnerId: row.runner_id,
		runnerServiceName: row.runner_service_name,
		volumeIdentity: row.volume_identity,
		lastSeenCommit: row.last_seen_commit,
		lastTaskAt: row.last_task_at,
		claimState: row.claim_state,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeRunnerScaleDecision(row) {
	if (!row) return null;
	return {
		id: row.id,
		projectId: row.project_id,
		environment: row.environment,
		workDayId: row.work_day_id,
		runnerId: row.runner_id,
		runnerServiceName: row.runner_service_name,
		action: row.action,
		reason: row.reason,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
	};
}

function serializePriorityOverride(row) {
	if (!row) return null;
	return {
		id: row.id,
		projectId: row.project_id,
		model: row.model,
		subjectId: row.subject_id,
		priority: Number(row.priority ?? 0),
		estimatedCredits: row.estimated_credits === null || row.estimated_credits === undefined ? null : Number(row.estimated_credits),
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializePrioritySnapshot(row) {
	if (!row) return null;
	const snapshot = parseJson(row.snapshot_json, {});
	return {
		...snapshot,
		id: row.id,
		projectId: row.project_id,
		workDayId: row.work_day_id,
		metadata: parseJson(row.metadata_json, {}),
		generatedAt: row.generated_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeTaskCreditLedgerEntry(row) {
	if (!row) return null;
	return {
		id: row.id,
		projectId: row.project_id,
		workDayId: row.work_day_id,
		taskId: row.task_id,
		phase: row.phase,
		credits: Number(row.credits ?? 0),
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
	};
}

function serializeTeamInboxItem(row) {
	if (!row) return null;
	return {
		id: row.id,
		teamId: row.team_id,
		projectId: row.project_id,
		kind: row.kind,
		state: row.state,
		title: row.title,
		summary: row.summary,
		href: row.href,
		itemKey: row.item_key,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeProjectSummarySnapshot(row) {
	if (!row) return null;
	return {
		projectId: row.project_id,
		teamId: row.team_id,
		summary: parseJson(row.summary_json, {}),
		generatedAt: row.generated_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export class MarketControlPlaneStore {
	constructor(config, db) {
		this.config = config;
		this.db = db;
		this.initializationPromise = null;
		this.artifactBucket = null;
	}

	setArtifactBucket(bucket) {
		this.artifactBucket = bucket && typeof bucket === 'object' ? bucket : null;
	}

	async run(query, params = []) {
		await this.db.prepare(query).bind(...params).run();
	}

	async first(query, params = []) {
		return this.db.prepare(query).bind(...params).first();
	}

	async all(query, params = []) {
		const result = await this.db.prepare(query).bind(...params).all();
		return result.results ?? [];
	}

	ensureInitialized() {
		if (!this.initializationPromise) {
			this.initializationPromise = Promise.resolve()
				.then(() => this.db.migrate?.())
				.then(() => this.seedTeamRoles());
		}
		return this.initializationPromise;
	}

	async seedTeamRoles() {
		const timestamp = isoNow();
		for (const [key, description] of Object.entries(TEAM_ROLE_DESCRIPTIONS)) {
			await this.run(
				`INSERT OR IGNORE INTO roles (id, key, description, created_at)
				 VALUES (?, ?, ?, ?)`,
				[randomUUID(), key, description, timestamp],
			);
		}
	}

	async roleIdForKey(key) {
		await this.ensureInitialized();
		const row = await this.first(`SELECT id FROM roles WHERE key = ? LIMIT 1`, [key]);
		return typeof row?.id === 'string' ? row.id : null;
	}

	async bindRoleToMembership(teamMembershipId, roleKey) {
		await this.ensureInitialized();
		const roleId = await this.roleIdForKey(roleKey);
		if (!roleId) return;
		await this.run(
			`INSERT OR IGNORE INTO team_role_bindings (team_membership_id, role_id, created_at)
			 VALUES (?, ?, ?)`,
			[teamMembershipId, roleId, isoNow()],
		);
	}

	async listRoleKeysForMembership(teamMembershipId) {
		await this.ensureInitialized();
		const rows = await this.all(
			`SELECT roles.key
			 FROM team_role_bindings
			 INNER JOIN roles ON roles.id = team_role_bindings.role_id
			 WHERE team_role_bindings.team_membership_id = ?
			 ORDER BY roles.key ASC`,
			[teamMembershipId],
		);
		return uniqueStrings(rows.map((row) => row.key));
	}

	async resolvePrincipalTeamContext(teamId, principal) {
		await this.ensureInitialized();
		if (!principal) return null;
		if (principalIsAdmin(principal)) {
			return {
				membershipId: null,
				roles: ['team_owner'],
				capabilities: [...ALL_TEAM_CAPABILITIES],
			};
		}
		if (principal.roles?.includes?.('team_api_key') && principal.metadata?.teamId === teamId) {
			return {
				membershipId: null,
				roles: ['team_owner'],
				capabilities: [...ALL_TEAM_CAPABILITIES],
			};
		}
		const userId = typeof principal.id === 'string' ? principal.id : '';
		if (!userId) return null;
		const membership = await this.first(
			`SELECT * FROM team_memberships WHERE team_id = ? AND user_id = ? AND status = 'active' LIMIT 1`,
			[teamId, userId],
		);
		if (!membership?.id) {
			return null;
		}
		const roles = await this.listRoleKeysForMembership(membership.id);
		const effectiveRoles = roles.length > 0 ? roles : ['team_owner'];
		return {
			membershipId: membership.id,
			roles: effectiveRoles,
			capabilities: uniqueCapabilities(effectiveRoles),
		};
	}

	async getTeamAccessSummary(teamId, principal) {
		await this.ensureInitialized();
		const context = await this.resolvePrincipalTeamContext(teamId, principal);
		const roles = context?.roles ?? [];
		const capabilities = context?.capabilities ?? [];
		const permissions = uniqueStrings([
			...capabilities.map((capability) => CAPABILITY_PERMISSIONS[capability]).filter(Boolean),
			...(principal?.permissions ?? []),
		]);
		return {
			teamId,
			roles,
			permissions,
			summary: {
				canAdminStaging: capabilities.includes('stage_releases') || capabilities.includes('publish_releases'),
				canAdminProduction: capabilities.includes('publish_releases'),
				canDownloadTemplates: Boolean(context) || principalIsAdmin(principal),
				canDownloadKnowledgePacks: Boolean(context) || principalIsAdmin(principal),
			},
		};
	}

	async getProjectAccessSummary(projectId, principal) {
		await this.ensureInitialized();
		const details = await this.getProjectDetails(projectId);
		if (!details) return null;
		const team = await this.getTeamAccessSummary(details.project.teamId, principal);
		const context = await this.resolvePrincipalTeamContext(details.project.teamId, principal);
		const roles = context?.roles ?? [];
		const subjectId = typeof principal?.id === 'string' && principal.id ? principal.id : details.project.teamId;
		const subjectType = principal?.roles?.includes?.('team_api_key') ? 'api_key' : 'user';
		const environmentRole = (environment) => {
			if (team.summary.canAdminProduction || (environment === 'staging' && team.summary.canAdminStaging)) return 'admin';
			if (roles.includes('contributor') || roles.includes('reviewer')) return 'operator';
			return 'viewer';
		};
		const environments = ['staging', 'prod'].map((environment) => ({
			projectId,
			environment,
			subjectType,
			subjectId,
			role: environmentRole(environment),
		}));
		return {
			projectId,
			team,
			environments,
		};
	}

	createTrustedUserAssertion(claims) {
		const secret = typeof this.config.assertionSecret === 'string' ? this.config.assertionSecret.trim() : '';
		if (!secret) return null;
		const encodedPayload = Buffer.from(JSON.stringify(claims)).toString('base64url');
		return `${encodedPayload}.${signAssertionPayload(encodedPayload, secret)}`;
	}

	async requestProjectRuntime(projectId, principal, path, input = {}) {
		await this.ensureInitialized();
		const fetchImpl = this.config.fetchImpl ?? fetch;
		const serviceId = typeof this.config.serviceId === 'string' ? this.config.serviceId.trim() : '';
		const serviceSecret = typeof this.config.serviceSecret === 'string' ? this.config.serviceSecret.trim() : '';
		if (!principal || !serviceId || !serviceSecret) {
			return null;
		}
		const details = await this.getProjectDetails(projectId);
		const baseUrl = normalizeBaseUrl(details?.connection?.projectApiBaseUrl);
		if (!details?.project || !baseUrl) {
			return null;
		}
		const teamContext = await this.resolvePrincipalTeamContext(details.project.teamId, principal);
		if (!teamContext) {
			return null;
		}
		const assertion = this.createTrustedUserAssertion({
			userId: principal.id,
			sessionId: principal.metadata?.sessionId ?? null,
			identityId: principal.metadata?.identityId ?? null,
			authTime: principal.metadata?.authTime ?? principal.metadata?.authenticatedAt ?? isoNow(),
			expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
			nonce: randomUUID(),
			teamId: details.project.teamId,
			projectId,
			membershipId: teamContext.membershipId,
			teamRoles: teamContext.roles,
			teamCapabilities: teamContext.capabilities,
		});
		if (!assertion) {
			return null;
		}

		const headers = new Headers({
			accept: 'application/json',
			'x-treeseed-service-id': serviceId,
			'x-treeseed-service-secret': serviceSecret,
			'x-treeseed-user-assertion': assertion,
		});
		if (input.body !== undefined) {
			headers.set('content-type', 'application/json');
		}
		try {
			const response = await fetchImpl(`${baseUrl}${path}`, {
				method: input.method ?? 'GET',
				headers,
				body: input.body === undefined ? undefined : JSON.stringify(input.body),
			});
			if (!response.ok) {
				return null;
			}
			const envelope = await response.json().catch(() => null);
			if (!envelope?.ok) {
				return null;
			}
			return envelope.payload ?? null;
		} catch {
			return null;
		}
	}

	async teamIdsForPrincipal(principal) {
		await this.ensureInitialized();
		if (!principal) return [];
		if (principalIsAdmin(principal)) {
			const teams = await this.all(`SELECT id FROM teams ORDER BY created_at ASC`);
			return teams.map((row) => row.id);
		}
		const directTeamId = principal.metadata?.teamId;
		if (typeof directTeamId === 'string' && directTeamId) {
			return [directTeamId];
		}
		const userId = typeof principal.id === 'string' ? principal.id : '';
		if (!userId) return [];
		const memberships = await this.all(
			`SELECT team_id
			 FROM team_memberships
			 WHERE user_id = ? AND status = 'active'
			 ORDER BY created_at ASC`,
			[userId],
		);
		return memberships.map((row) => row.team_id);
	}

	async principalCanAccessTeam(principal, teamId) {
		if (!principal) return false;
		if (principalIsAdmin(principal)) return true;
		const teamIds = await this.teamIdsForPrincipal(principal);
		return teamIds.includes(teamId);
	}

	async principalCanManageTeam(principal, teamId) {
		if (!principal) return false;
		if (principalIsAdmin(principal)) return true;
		const context = await this.resolvePrincipalTeamContext(teamId, principal);
		return Boolean(context?.roles?.some((role) => TEAM_MANAGEMENT_ROLES.has(role)));
	}

	async principalCanAccessCatalogItem(principal, item) {
		if (!item) return false;
		if (item.visibility === 'public') {
			return item.listingEnabled !== false;
		}
		return this.principalCanAccessTeam(principal, item.teamId);
	}

	async authenticateTeamApiKey(token) {
		await this.ensureInitialized();
		const prefix = tokenPrefix(token);
		const rows = await this.all(
			`SELECT team_api_keys.*, teams.name AS team_name, teams.display_name AS team_display_name
			 FROM team_api_keys
			 INNER JOIN teams ON teams.id = team_api_keys.team_id
			 WHERE team_api_keys.key_prefix = ? AND team_api_keys.revoked_at IS NULL`,
			[prefix],
		);
		for (const row of rows) {
			if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
				continue;
			}
			const expected = stableHash(token, this.config.authSecret);
			if (!equalHash(expected, row.key_hash)) {
				continue;
			}
			await this.run(
				`UPDATE team_api_keys SET last_used_at = ?, updated_at = ? WHERE id = ?`,
				[isoNow(), isoNow(), row.id],
			);
			return {
				teamId: row.team_id,
				keyId: row.id,
				principal: {
					id: `team-key:${row.id}`,
					displayName: row.name,
					roles: ['team_api_key'],
					permissions: parseJson(row.permissions_json, []),
					scopes: ['auth:me'],
					metadata: {
						teamId: row.team_id,
						teamName: row.team_name,
						teamDisplayName: row.team_display_name ?? row.team_name,
					},
				},
			};
		}
		return null;
	}

	async createTeam(input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		const validation = validateTeamName(input.name ?? input.slug);
		if (!validation.ok) {
			throw new Error(validation.message);
		}
		if (await this.publicUsernameExists(validation.name, input.allowUserNamespaceOwnerId ?? null)) {
			throw new Error('That team name is already taken by a user.');
		}
		const displayName = String(input.displayName ?? input.display_name ?? input.label ?? input.name ?? validation.name).trim() || validation.name;
		const metadata = {
			visibility: 'private',
			privateTreeDx: true,
			...(typeof input.metadata === 'object' && input.metadata ? input.metadata : {}),
		};
		await this.run(
			`INSERT INTO teams (id, slug, name, display_name, logo_url, profile_summary, metadata_json, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				validation.name,
				validation.name,
				displayName,
				typeof input.logoUrl === 'string' && input.logoUrl.trim() ? input.logoUrl.trim() : null,
				typeof input.profileSummary === 'string' && input.profileSummary.trim()
					? input.profileSummary.trim()
					: typeof input.description === 'string' && input.description.trim()
						? input.description.trim()
						: null,
				JSON.stringify(metadata),
				timestamp,
				timestamp,
			],
		);
		if (input.ownerUserId) {
			await this.upsertTeamMember(id, input.ownerUserId, 'team_owner');
		}
		const team = await this.getTeam(id);
		if (teamIsPrivate(team)) {
			await this.provisionTeamTreeDx(id, {
				metadata: {
					automaticPrivateTeamTreeDx: true,
					createdFrom: 'private_team_creation',
				},
			});
		}
		return this.getTeam(id);
	}

	async getTeam(teamId) {
		await this.ensureInitialized();
		return serializeTeam(await this.first(`SELECT * FROM teams WHERE id = ?`, [teamId]));
	}

	async getTeamBySlug(slug) {
		await this.ensureInitialized();
		const value = normalizeTeamName(slug);
		return serializeTeam(await this.first(`SELECT * FROM teams WHERE LOWER(name) = LOWER(?) OR LOWER(slug) = LOWER(?) LIMIT 1`, [value, value]));
	}

	async getTeamByName(name) {
		return this.getTeamBySlug(name);
	}

	async isTeamNameAvailable(name, excludeTeamId = null) {
		await this.ensureInitialized();
		const validation = validateTeamName(name);
		if (!validation.ok) return false;
		const row = await this.first(
			`SELECT id FROM teams WHERE LOWER(name) = LOWER(?) ${excludeTeamId ? 'AND id != ?' : ''} LIMIT 1`,
			excludeTeamId ? [validation.name, excludeTeamId] : [validation.name],
		);
		if (row?.id) return false;
		return !(await this.publicUsernameExists(validation.name));
	}

	async publicUsernameExists(username, excludeUserId = null) {
		await this.ensureInitialized();
		const value = String(username ?? '').trim().toLowerCase();
		if (!value) return false;
		const row = await this.first(
			`SELECT id FROM users WHERE LOWER(username) = LOWER(?) ${excludeUserId ? 'AND id != ?' : ''} LIMIT 1`,
			excludeUserId ? [value, excludeUserId] : [value],
		);
		return Boolean(row?.id);
	}

	async teamPublicNameExists(name, excludeTeamId = null) {
		await this.ensureInitialized();
		const value = normalizeTeamName(name);
		if (!value) return false;
		const row = await this.first(
			`SELECT id FROM teams WHERE (LOWER(name) = LOWER(?) OR LOWER(slug) = LOWER(?)) ${excludeTeamId ? 'AND id != ?' : ''} LIMIT 1`,
			excludeTeamId ? [value, value, excludeTeamId] : [value, value],
		);
		return Boolean(row?.id);
	}

	async ensurePersonalResearchTeamForUser(userId) {
		await this.ensureInitialized();
		const user = await this.first(`SELECT id, username, display_name FROM users WHERE id = ? LIMIT 1`, [userId]);
		const validation = validateTeamName(user?.username);
		if (!user?.id || !validation.ok) {
			return { ok: false, code: 'missing_username', message: 'A valid username is required before creating a personal research team.' };
		}
		const existing = await this.getTeamBySlug(validation.name);
		if (existing) {
			const memberships = await this.all(
				`SELECT id FROM team_memberships WHERE team_id = ? AND user_id = ? AND status = 'active' LIMIT 1`,
				[existing.id, user.id],
			);
			if (memberships.length > 0 && existing.metadata?.kind === 'personal_research' && existing.metadata?.ownerUserId === user.id) {
				return { ok: true, team: existing, created: false };
			}
			return { ok: false, code: 'namespace_conflict', message: 'That username is already used by a team.' };
		}
		const team = await this.createTeam({
			name: validation.name,
			displayName: String(user.display_name ?? '').trim() || `${validation.name}'s Research`,
			metadata: {
				kind: 'personal_research',
				ownerUserId: user.id,
			},
			ownerUserId: user.id,
			allowUserNamespaceOwnerId: user.id,
		});
		return { ok: true, team, created: true };
	}

	async updateTeamSettings(teamId, input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const existing = await this.getTeam(teamId);
		if (!existing) return null;
		const requestedName = input.name === undefined || input.name === null || String(input.name).trim() === ''
			? existing.name
			: String(input.name);
		const validation = validateTeamName(requestedName);
		if (!validation.ok) {
			return { ok: false, code: validation.code, message: validation.message };
		}
		if (validation.name !== existing.name && !(await this.isTeamNameAvailable(validation.name, teamId))) {
			return { ok: false, code: 'taken', message: 'That team name is already taken.' };
		}
		const displayName = String(input.displayName ?? existing.displayName ?? existing.name).trim() || existing.name;
		const logoUrl = typeof input.logoUrl === 'string' && input.logoUrl.trim() ? input.logoUrl.trim() : null;
		const profileSummary = typeof input.profileSummary === 'string' && input.profileSummary.trim()
			? input.profileSummary.trim()
			: typeof input.description === 'string' && input.description.trim()
				? input.description.trim()
				: null;
		const metadata = {
			...(existing.metadata ?? {}),
			...(typeof input.metadata === 'object' && input.metadata ? input.metadata : {}),
		};
		await this.run(
			`UPDATE teams
			 SET slug = ?, name = ?, display_name = ?, logo_url = ?, profile_summary = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`,
			[validation.name, validation.name, displayName, logoUrl, profileSummary, JSON.stringify(metadata), timestamp, teamId],
		);
		return { ok: true, team: await this.getTeam(teamId) };
	}

	async listTeamsForPrincipal(principal) {
		await this.ensureInitialized();
		const teamIds = await this.teamIdsForPrincipal(principal);
		if (teamIds.length === 0) {
			return [];
		}
		const placeholders = teamIds.map(() => '?').join(', ');
		const rows = await this.all(
			`SELECT * FROM teams WHERE id IN (${placeholders}) ORDER BY created_at ASC`,
			teamIds,
		);
		return rows.map(serializeTeam);
	}

	async listTeamMembers(teamId) {
		await this.ensureInitialized();
		const rows = await this.all(
			`SELECT team_memberships.*, users.display_name, users.email
			 FROM team_memberships
			 INNER JOIN users ON users.id = team_memberships.user_id
			 WHERE team_memberships.team_id = ?
			 ORDER BY team_memberships.created_at ASC`,
			[teamId],
		);
		if (rows.length === 0) {
			return [];
		}
		const membershipIds = rows.map((row) => row.id);
		const placeholders = membershipIds.map(() => '?').join(', ');
		const roleRows = await this.all(
			`SELECT team_role_bindings.team_membership_id, roles.key
			 FROM team_role_bindings
			 INNER JOIN roles ON roles.id = team_role_bindings.role_id
			 WHERE team_role_bindings.team_membership_id IN (${placeholders})`,
			membershipIds,
		);
		const rolesByMembership = new Map();
		for (const row of roleRows) {
			const existing = rolesByMembership.get(row.team_membership_id) ?? [];
			existing.push(row.key);
			rolesByMembership.set(row.team_membership_id, uniqueStrings(existing));
		}
		return rows.map((row) => serializeTeamMember(row, rolesByMembership.get(row.id) ?? []));
	}

	async listTeamWebHosts(teamId) {
		await this.ensureInitialized();
		const rows = await this.all(
			`SELECT * FROM team_web_hosts WHERE team_id = ? ORDER BY created_at ASC`,
			[teamId],
		);
		return rows.map(serializeTeamWebHost);
	}

	async getTeamWebHost(teamId, hostId) {
		await this.ensureInitialized();
		const row = await this.first(
			`SELECT * FROM team_web_hosts WHERE team_id = ? AND id = ? LIMIT 1`,
			[teamId, hostId],
		);
		return serializeTeamWebHost(row);
	}

	async createTeamWebHost(teamId, input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		const provider = String(input.provider ?? 'cloudflare');
		const ownership = String(input.ownership ?? 'team_owned');
		const name = String(input.name ?? '').trim();
		if (!name) {
			throw new Error('name is required.');
		}
		if (!SUPPORTED_TEAM_HOST_PROVIDERS.has(provider)) {
			throw new Error(`Unsupported host provider "${provider}".`);
		}
		if (!['team_owned', 'treeseed_managed'].includes(ownership)) {
			throw new Error(`Unsupported web host ownership "${ownership}".`);
		}
		const encryptedPayload = ownership === 'team_owned' ? input.encryptedPayload ?? null : null;
		if (ownership === 'team_owned' && (!encryptedPayload || typeof encryptedPayload !== 'object')) {
			throw new Error('encryptedPayload is required for team-owned hosts.');
		}
		await this.run(
			`INSERT INTO team_web_hosts (
				id, team_id, provider, ownership, name, account_label, allowed_environments_json, status,
				encrypted_payload_json, metadata_json, created_by_id, updated_by_id, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				teamId,
				provider,
				ownership,
				name,
				typeof input.accountLabel === 'string' && input.accountLabel.trim() ? input.accountLabel.trim() : null,
				JSON.stringify(Array.isArray(input.allowedEnvironments) && input.allowedEnvironments.length > 0
					? input.allowedEnvironments.map(String)
					: ['staging', 'prod']),
				typeof input.status === 'string' ? input.status : 'active',
				encryptedPayload ? JSON.stringify(encryptedPayload) : null,
				JSON.stringify(typeof input.metadata === 'object' && input.metadata ? input.metadata : {}),
				typeof input.createdById === 'string' ? input.createdById : null,
				typeof input.updatedById === 'string' ? input.updatedById : typeof input.createdById === 'string' ? input.createdById : null,
				timestamp,
				timestamp,
			],
		);
		return this.getTeamWebHost(teamId, id);
	}

	async updateTeamWebHost(teamId, hostId, input) {
		await this.ensureInitialized();
		const existing = await this.getTeamWebHost(teamId, hostId);
		if (!existing) return null;
		const timestamp = isoNow();
		const ownership = String(input.ownership ?? existing.ownership);
		if (!['team_owned', 'treeseed_managed'].includes(ownership)) {
			throw new Error(`Unsupported web host ownership "${ownership}".`);
		}
		const encryptedPayload = ownership === 'team_owned'
			? input.encryptedPayload === undefined ? existing.encryptedPayload : input.encryptedPayload
			: null;
		if (ownership === 'team_owned' && (!encryptedPayload || typeof encryptedPayload !== 'object')) {
			throw new Error('encryptedPayload is required for team-owned hosts.');
		}
		const metadata = input.metadata === undefined
			? existing.metadata
			: typeof input.metadata === 'object' && input.metadata
				? { ...(existing.metadata ?? {}), ...input.metadata }
				: {};
		await this.run(
			`UPDATE team_web_hosts
			 SET ownership = ?, name = ?, account_label = ?, allowed_environments_json = ?, status = ?,
			     encrypted_payload_json = ?, metadata_json = ?, updated_by_id = ?, updated_at = ?
			 WHERE team_id = ? AND id = ?`,
			[
				ownership,
				typeof input.name === 'string' && input.name.trim() ? input.name.trim() : existing.name,
				input.accountLabel === undefined
					? existing.accountLabel
					: typeof input.accountLabel === 'string' && input.accountLabel.trim()
						? input.accountLabel.trim()
						: null,
				JSON.stringify(Array.isArray(input.allowedEnvironments) ? input.allowedEnvironments.map(String) : existing.allowedEnvironments),
				typeof input.status === 'string' ? input.status : existing.status,
				encryptedPayload ? JSON.stringify(encryptedPayload) : null,
				JSON.stringify(metadata),
				typeof input.updatedById === 'string' ? input.updatedById : existing.updatedById,
				timestamp,
				teamId,
				hostId,
			],
		);
		return this.getTeamWebHost(teamId, hostId);
	}

	async listRepositoryHosts(teamId, { includePlatform = true } = {}) {
		await this.ensureInitialized();
		const rows = includePlatform
			? await this.all(
				`SELECT * FROM repository_hosts WHERE (team_id = ? OR team_id IS NULL) ORDER BY team_id IS NULL DESC, created_at ASC`,
				[teamId],
			)
			: await this.all(
				`SELECT * FROM repository_hosts WHERE team_id = ? ORDER BY created_at ASC`,
				[teamId],
			);
		return rows.map(serializeRepositoryHost);
	}

	async getRepositoryHost(teamId, hostId) {
		await this.ensureInitialized();
		const row = await this.first(
			`SELECT * FROM repository_hosts WHERE id = ? AND (team_id = ? OR team_id IS NULL) LIMIT 1`,
			[hostId, teamId],
		);
		return serializeRepositoryHost(row);
	}

	async upsertRepositoryHost(teamId, input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		const provider = String(input.provider ?? 'github');
		if (provider !== 'github') {
			throw new Error(`Unsupported repository host provider "${provider}".`);
		}
		const ownership = String(input.ownership ?? 'team_owned');
		if (!['team_owned', 'treeseed_managed'].includes(ownership)) {
			throw new Error(`Unsupported repository host ownership "${ownership}".`);
		}
		const name = String(input.name ?? '').trim();
		const organizationOrOwner = String(input.organizationOrOwner ?? input.organization_or_owner ?? '').trim();
		if (!name) throw new Error('name is required.');
		if (!organizationOrOwner) throw new Error('organizationOrOwner is required.');
		const hostTeamId = input.platformOwner === true || input.teamId === null ? null : teamId;
		const existing = await this.first(`SELECT * FROM repository_hosts WHERE id = ? LIMIT 1`, [id]);
		const encryptedPayload = input.encryptedPayload && typeof input.encryptedPayload === 'object'
			? input.encryptedPayload
			: existing?.encrypted_payload_json
				? parseJson(existing.encrypted_payload_json, null)
				: null;
		if (ownership === 'team_owned' && !encryptedPayload) {
			throw new Error('encryptedPayload is required for team-owned repository hosts.');
		}
		const values = [
			hostTeamId,
			provider,
			ownership,
			name,
			typeof input.accountLabel === 'string' && input.accountLabel.trim() ? input.accountLabel.trim() : null,
			organizationOrOwner,
			typeof input.defaultVisibility === 'string' ? input.defaultVisibility : 'private',
			typeof input.softwareRepositoryNameTemplate === 'string' && input.softwareRepositoryNameTemplate.trim() ? input.softwareRepositoryNameTemplate.trim() : '{hub}-site',
			typeof input.contentRepositoryNameTemplate === 'string' && input.contentRepositoryNameTemplate.trim() ? input.contentRepositoryNameTemplate.trim() : '{hub}-content',
			JSON.stringify(input.branchPolicy && typeof input.branchPolicy === 'object' ? input.branchPolicy : {}),
			JSON.stringify(input.workflowPolicy && typeof input.workflowPolicy === 'object' ? input.workflowPolicy : {}),
			encryptedPayload ? JSON.stringify(encryptedPayload) : null,
			JSON.stringify(Array.isArray(input.allowedProjectKinds) ? input.allowedProjectKinds.map(String) : ['knowledge_hub']),
			typeof input.status === 'string' ? input.status : 'active',
			JSON.stringify(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
			typeof input.createdById === 'string' ? input.createdById : null,
			typeof input.updatedById === 'string' ? input.updatedById : typeof input.createdById === 'string' ? input.createdById : null,
		];
		if (existing) {
			await this.run(
				`UPDATE repository_hosts
				 SET team_id = ?, provider = ?, ownership = ?, name = ?, account_label = ?, organization_or_owner = ?,
				     default_visibility = ?, software_repository_name_template = ?, content_repository_name_template = ?,
				     branch_policy_json = ?, workflow_policy_json = ?, encrypted_payload_json = ?, allowed_project_kinds_json = ?,
				     status = ?, metadata_json = ?, created_by_id = COALESCE(created_by_id, ?), updated_by_id = ?, updated_at = ?
				 WHERE id = ?`,
				[...values, timestamp, id],
			);
		} else {
			await this.run(
				`INSERT INTO repository_hosts (
					id, team_id, provider, ownership, name, account_label, organization_or_owner, default_visibility,
					software_repository_name_template, content_repository_name_template, branch_policy_json, workflow_policy_json,
					encrypted_payload_json, allowed_project_kinds_json, status, metadata_json, created_by_id, updated_by_id, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[id, ...values, timestamp, timestamp],
			);
		}
		return serializeRepositoryHost(await this.first(`SELECT * FROM repository_hosts WHERE id = ?`, [id]));
	}

	async listProjectsUsingRepositoryHost(teamId, hostId) {
		await this.ensureInitialized();
		const rows = await this.all(
			`SELECT DISTINCT p.*
			 FROM projects p
			 JOIN hub_repositories r ON r.hub_id = p.id
			 WHERE p.team_id = ? AND r.repository_host_id = ?
			 ORDER BY p.created_at DESC`,
			[teamId, hostId],
		);
		return rows.map(serializeProject);
	}

	async deleteRepositoryHost(teamId, hostId) {
		await this.ensureInitialized();
		const existing = await this.getRepositoryHost(teamId, hostId);
		if (!existing || existing.teamId === null) return { ok: false, error: 'not_found' };
		const projects = await this.listProjectsUsingRepositoryHost(teamId, hostId);
		if (projects.length > 0) {
			return {
				ok: false,
				error: 'in_use',
				projects: projects.map((project) => ({
					id: project.id,
					slug: project.slug,
					name: project.name,
				})),
			};
		}
		await this.run(`DELETE FROM repository_hosts WHERE team_id = ? AND id = ?`, [teamId, hostId]);
		return { ok: true, payload: existing };
	}

	async createProviderCredentialSession(teamId, input) {
		await this.ensureInitialized();
		await this.markExpiredProviderCredentialSessions();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		const hostKind = String(input.hostKind ?? '');
		const hostId = String(input.hostId ?? '');
		const purpose = String(input.purpose ?? 'launch_project');
		if (!['repository_host', 'web_host', 'capacity_provider_host', 'email_host'].includes(hostKind)) {
			throw new Error(`Unsupported credential session hostKind "${hostKind}".`);
		}
		if (!hostId) {
			throw new Error('hostId is required.');
		}
		if (!input.encryptedPayload || typeof input.encryptedPayload !== 'object') {
			throw new Error('encryptedPayload is required.');
		}
		if (!input.expiresAt) {
			throw new Error('expiresAt is required.');
		}
		await this.run(
			`INSERT INTO provider_credential_sessions (
				id, team_id, project_id, job_id, host_kind, host_id, purpose, encrypted_payload_json, status,
				expires_at, consumed_at, created_by_id, created_at, updated_at, metadata_json
			) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, 'active', ?, NULL, ?, ?, ?, ?)`,
			[
				id,
				teamId,
				hostKind,
				hostId,
				purpose,
				JSON.stringify(input.encryptedPayload),
				input.expiresAt,
				typeof input.createdById === 'string' ? input.createdById : null,
				timestamp,
				timestamp,
				JSON.stringify(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
			],
		);
		return this.getProviderCredentialSession(teamId, id);
	}

	async getProviderCredentialSession(teamId, sessionId, options = {}) {
		await this.ensureInitialized();
		await this.markExpiredProviderCredentialSessions();
		const row = await this.first(
			`SELECT * FROM provider_credential_sessions WHERE id = ? AND team_id = ? LIMIT 1`,
			[sessionId, teamId],
		);
		return serializeProviderCredentialSession(row, options);
	}

	async findProviderCredentialSession(sessionId, options = {}) {
		await this.ensureInitialized();
		await this.markExpiredProviderCredentialSessions();
		return serializeProviderCredentialSession(
			await this.first(`SELECT * FROM provider_credential_sessions WHERE id = ? LIMIT 1`, [sessionId]),
			options,
		);
	}

	async bindProviderCredentialSession(teamId, sessionId, input) {
		await this.ensureInitialized();
		await this.markExpiredProviderCredentialSessions();
		const existing = await this.getProviderCredentialSession(teamId, sessionId);
		if (!existing) return null;
		if (existing.status !== 'active') return null;
		if (new Date(existing.expiresAt).getTime() <= Date.now()) return null;
		const timestamp = isoNow();
		await this.run(
			`UPDATE provider_credential_sessions
			 SET project_id = ?, job_id = ?, updated_at = ?, metadata_json = ?
			 WHERE id = ? AND team_id = ?`,
			[
				input.projectId ?? existing.projectId ?? null,
				input.jobId ?? existing.jobId ?? null,
				timestamp,
				JSON.stringify({
					...existing.metadata,
					...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
				}),
				sessionId,
				teamId,
			],
		);
		return this.getProviderCredentialSession(teamId, sessionId);
	}

	async consumeProviderCredentialSession(jobId, sessionId) {
		await this.ensureInitialized();
		await this.markExpiredProviderCredentialSessions();
		const existing = await this.findProviderCredentialSession(sessionId, { includeEncryptedPayload: true });
		if (!existing || existing.jobId !== jobId) {
			return { ok: false, error: 'not_found' };
		}
		if (existing.status !== 'active') {
			return { ok: false, error: 'already_consumed' };
		}
		if (new Date(existing.expiresAt).getTime() <= Date.now()) {
			await this.run(
				`UPDATE provider_credential_sessions SET status = 'expired', updated_at = ? WHERE id = ?`,
				[isoNow(), sessionId],
			);
			return { ok: false, error: 'expired' };
		}
		const timestamp = isoNow();
		await this.run(
			`UPDATE provider_credential_sessions
			 SET status = 'consumed', consumed_at = ?, updated_at = ?
			 WHERE id = ? AND job_id = ? AND status = 'active'`,
			[timestamp, timestamp, sessionId, jobId],
		);
		return {
			ok: true,
			payload: await this.findProviderCredentialSession(sessionId, { includeEncryptedPayload: true }),
		};
	}

	async consumeTeamProviderCredentialSession(teamId, sessionId, input = {}) {
		await this.ensureInitialized();
		await this.markExpiredProviderCredentialSessions();
		const existing = await this.getProviderCredentialSession(teamId, sessionId, { includeEncryptedPayload: true });
		if (!existing) {
			return { ok: false, error: 'not_found' };
		}
		if (input.hostKind && existing.hostKind !== input.hostKind) {
			return { ok: false, error: 'wrong_host_kind' };
		}
		if (input.purpose && existing.purpose !== input.purpose) {
			return { ok: false, error: 'wrong_purpose' };
		}
		if (existing.status !== 'active') {
			return { ok: false, error: 'already_consumed' };
		}
		if (new Date(existing.expiresAt).getTime() <= Date.now()) {
			await this.run(
				`UPDATE provider_credential_sessions SET status = 'expired', updated_at = ? WHERE id = ? AND team_id = ?`,
				[isoNow(), sessionId, teamId],
			);
			return { ok: false, error: 'expired' };
		}
		const timestamp = isoNow();
		await this.run(
			`UPDATE provider_credential_sessions
			 SET status = 'consumed', consumed_at = ?, updated_at = ?, metadata_json = ?
			 WHERE id = ? AND team_id = ? AND status = 'active'`,
			[
				timestamp,
				timestamp,
				JSON.stringify({
					...existing.metadata,
					...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
				}),
				sessionId,
				teamId,
			],
		);
		return {
			ok: true,
			payload: await this.getProviderCredentialSession(teamId, sessionId, { includeEncryptedPayload: true }),
		};
	}

	async markExpiredProviderCredentialSessions(now = isoNow()) {
		await this.run(
			`UPDATE provider_credential_sessions
			 SET status = 'expired', updated_at = ?
			 WHERE status = 'active' AND expires_at <= ?`,
			[now, now],
		);
	}

	async cleanupProviderCredentialSessions(input = {}) {
		await this.ensureInitialized();
		const now = input.now ?? isoNow();
		await this.markExpiredProviderCredentialSessions(now);
		if (input.deleteBefore) {
			await this.run(
				`DELETE FROM provider_credential_sessions
				 WHERE status IN ('expired', 'consumed') AND updated_at < ?`,
				[input.deleteBefore],
			);
		}
		return {
			ok: true,
			checkedAt: now,
		};
	}

	async listProjectsUsingTeamWebHost(teamId, hostId) {
		const projects = await this.listTeamProjects(teamId);
		return projects.filter((project) => {
			const host = project.metadata?.cloudflareHost;
			return host?.mode === 'team_owned' && host.hostId === hostId;
		});
	}

	async deleteTeamWebHost(teamId, hostId) {
		await this.ensureInitialized();
		const existing = await this.getTeamWebHost(teamId, hostId);
		if (!existing) return { ok: false, error: 'not_found' };
		const projects = await this.listProjectsUsingTeamWebHost(teamId, hostId);
		if (projects.length > 0) {
			return {
				ok: false,
				error: 'in_use',
				projects: projects.map((project) => ({
					id: project.id,
					slug: project.slug,
					name: project.name,
				})),
			};
		}
		await this.run(`DELETE FROM team_web_hosts WHERE team_id = ? AND id = ?`, [teamId, hostId]);
		return { ok: true, payload: existing };
	}

	async listTeamCapacityProviders(teamId) {
		await this.ensureInitialized();
		const rows = await this.all(
			`SELECT * FROM capacity_providers
			 WHERE team_id = ? OR owner_team_id = ?
			 ORDER BY created_at ASC`,
			[teamId, teamId],
		);
		return rows.map(serializeCapacityProvider);
	}

	async getCapacityProvider(teamId, providerId) {
		await this.ensureInitialized();
		return serializeCapacityProvider(await this.first(
			`SELECT * FROM capacity_providers
			 WHERE id = ? AND (team_id = ? OR owner_team_id = ?)
			 LIMIT 1`,
			[providerId, teamId, teamId],
		));
	}

	async getCapacityProviderById(providerId) {
		await this.ensureInitialized();
		return serializeCapacityProvider(await this.first(
			`SELECT * FROM capacity_providers WHERE id = ? LIMIT 1`,
			[providerId],
		));
	}

	async upsertCapacityProvider(teamId, input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		const existing = await this.first(`SELECT * FROM capacity_providers WHERE id = ? LIMIT 1`, [id]);
		const creditBudgetMode = normalizeCreditBudgetMode(input.creditBudgetMode ?? input.credit_budget_mode, existing?.credit_budget_mode ?? 'derived');
		const values = [
			input.teamId ?? teamId,
			input.ownerTeamId ?? input.teamId ?? teamId,
			String(input.name ?? existing?.name ?? '').trim(),
			String(input.kind ?? existing?.kind ?? 'team_owned'),
			String(input.status ?? existing?.status ?? 'active'),
			String(input.provider ?? existing?.provider ?? 'custom'),
			String(input.billingScope ?? existing?.billing_scope ?? 'team'),
			Number(input.monthlyCreditBudget ?? existing?.monthly_credit_budget ?? 0),
			Number(input.dailyCreditBudget ?? existing?.daily_credit_budget ?? 0),
			creditBudgetMode,
			Number(input.maxConcurrentWorkdays ?? existing?.max_concurrent_workdays ?? 1),
			Number(input.maxConcurrentWorkers ?? existing?.max_concurrent_workers ?? 1),
			JSON.stringify(input.capacityModel ?? parseJson(existing?.capacity_model_json, {})),
			JSON.stringify(input.metadata ?? parseJson(existing?.metadata_json, {})),
			timestamp,
			id,
		];
		if (!values[2]) {
			throw new Error('name is required.');
		}
		if (existing) {
			await this.run(
				`UPDATE capacity_providers
				 SET team_id = ?, owner_team_id = ?, name = ?, kind = ?, status = ?, provider = ?, billing_scope = ?,
				     monthly_credit_budget = ?, daily_credit_budget = ?, credit_budget_mode = ?, max_concurrent_workdays = ?, max_concurrent_workers = ?,
				     capacity_model_json = ?, metadata_json = ?, updated_at = ?
				 WHERE id = ?`,
				values,
			);
		} else {
			await this.run(
				`INSERT INTO capacity_providers (
					id, team_id, owner_team_id, name, kind, status, provider, billing_scope,
					monthly_credit_budget, daily_credit_budget, credit_budget_mode, max_concurrent_workdays, max_concurrent_workers,
					capacity_model_json, metadata_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					id,
					input.teamId ?? teamId,
					input.ownerTeamId ?? input.teamId ?? teamId,
					String(input.name).trim(),
					String(input.kind ?? 'team_owned'),
					String(input.status ?? 'active'),
					String(input.provider ?? 'custom'),
					String(input.billingScope ?? 'team'),
					Number(input.monthlyCreditBudget ?? 0),
					Number(input.dailyCreditBudget ?? 0),
					creditBudgetMode,
					Number(input.maxConcurrentWorkdays ?? 1),
					Number(input.maxConcurrentWorkers ?? 1),
					JSON.stringify(input.capacityModel ?? {}),
					JSON.stringify(input.metadata ?? {}),
					timestamp,
					timestamp,
				],
			);
		}
		return this.getCapacityProvider(teamId, id);
	}

	async createStandaloneCapacityProvider(teamId, input = {}) {
		await this.ensureInitialized();
		const name = typeof input.name === 'string' ? input.name.trim() : '';
		const launchMode = providerLaunchMode(input.launchMode);
		if (!name) throw new Error('name is required.');
		if (!launchMode) throw new Error('launchMode must be self_hosted, managed_market_host, or connected_host.');
		return this.upsertCapacityProvider(teamId, {
			teamId,
			ownerTeamId: teamId,
			name,
			kind: 'team_owned',
			status: 'pending',
			provider: '@treeseed/agent',
			billingScope: 'team',
			monthlyCreditBudget: 0,
			dailyCreditBudget: 0,
			creditBudgetMode: normalizeCreditBudgetMode(input.creditBudgetMode ?? input.credit_budget_mode, 'derived'),
			maxConcurrentWorkdays: 1,
			maxConcurrentWorkers: 1,
			capacityModel: {},
			metadata: {
				launchMode,
				connectionState: 'waiting_for_provider',
				rotationRequired: false,
				capabilities: [],
				budgets: {},
				deployment: {
					launchMode,
					status: 'not_deployed',
				},
				createdById: input.createdById ?? null,
			},
		});
	}

	async renameCapacityProvider(teamId, providerId, name) {
		await this.ensureInitialized();
		const provider = await this.getCapacityProvider(teamId, providerId);
		if (!provider) return null;
		const trimmed = typeof name === 'string' ? name.trim() : '';
		if (!trimmed) throw new Error('name is required.');
		await this.run(
			`UPDATE capacity_providers SET name = ?, updated_at = ? WHERE id = ? AND (team_id = ? OR owner_team_id = ?)`,
			[trimmed, isoNow(), providerId, teamId, teamId],
		);
		return this.getCapacityProvider(teamId, providerId);
	}

	async updateCapacityProvider(teamId, providerId, input = {}) {
		await this.ensureInitialized();
		const provider = await this.getCapacityProvider(teamId, providerId);
		if (!provider) return null;
		const trimmed = input.name === undefined ? provider.name : typeof input.name === 'string' ? input.name.trim() : '';
		if (!trimmed) throw new Error('name is required.');
		const creditBudgetMode = normalizeCreditBudgetMode(input.creditBudgetMode ?? input.credit_budget_mode, provider.creditBudgetMode ?? 'derived');
		await this.run(
			`UPDATE capacity_providers SET name = ?, credit_budget_mode = ?, updated_at = ? WHERE id = ? AND (team_id = ? OR owner_team_id = ?)`,
			[trimmed, creditBudgetMode, isoNow(), providerId, teamId, teamId],
		);
		return this.getCapacityProvider(teamId, providerId);
	}

	async updateCapacityProviderStatus(teamId, providerId, input = {}) {
		await this.ensureInitialized();
		const provider = await this.getCapacityProvider(teamId, providerId);
		if (!provider) return null;
		const timestamp = isoNow();
		const metadata = {
			...(provider.metadata ?? {}),
			...(input.metadata ?? {}),
		};
		await this.run(
			`UPDATE capacity_providers
			 SET status = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`,
			[
				input.status ?? provider.status,
				JSON.stringify(metadata),
				timestamp,
				providerId,
			],
		);
		return this.getCapacityProvider(teamId, providerId);
	}

	async recordProviderHeartbeat(input) {
		await this.ensureInitialized();
		const provider = serializeCapacityProvider(await this.first(
			`SELECT * FROM capacity_providers WHERE id = ? LIMIT 1`,
			[input.providerId],
		));
		if (!provider) return null;
		const timestamp = isoNow();
		const draining = input.draining === true;
		const ok = input.ok !== false && !draining && String(input.status ?? 'active') !== 'failed';
		const status = draining
			? 'draining'
			: ok
				? 'active'
				: String(input.status ?? 'degraded');
		const metadata = {
			...(provider.metadata ?? {}),
			lastHealth: {
				ok,
				checkedAt: input.heartbeatAt ?? timestamp,
				queueDepth: Number(input.queueDepth ?? 0),
				activeWorkers: Number(input.activeWorkers ?? 0),
				maxWorkers: input.maxWorkers == null ? null : Number(input.maxWorkers),
				draining,
				capabilities: Array.isArray(input.capabilities) ? input.capabilities.map(String) : [],
				environments: Array.isArray(input.environments) ? input.environments.map(String) : [],
			},
		};
		await this.run(
			`UPDATE capacity_providers
			 SET status = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`,
			[status, JSON.stringify(metadata), timestamp, provider.id],
		);
		await this.updateCapacityProviderApiKeyMetadata(provider.teamId ?? provider.ownerTeamId, provider.id, {
			lastUsedAt: timestamp,
			rotationRequired: false,
		}).catch(() => null);
		return this.getCapacityProvider(provider.teamId ?? provider.ownerTeamId, provider.id);
	}

	async getCapacityReservation(reservationId) {
		await this.ensureInitialized();
		return serializeCapacityReservation(await this.first(`SELECT * FROM capacity_reservations WHERE id = ? LIMIT 1`, [reservationId]));
	}

	async updateCapacityReservation(reservationId, patch = {}) {
		await this.ensureInitialized();
		const existing = await this.getCapacityReservation(reservationId);
		if (!existing) return null;
		const timestamp = isoNow();
		await this.run(
			`UPDATE capacity_reservations
			 SET state = COALESCE(?, state),
			     task_id = COALESCE(?, task_id),
			     consumed_credits = COALESCE(?, consumed_credits),
			     consumed_provider_units = COALESCE(?, consumed_provider_units),
			     consumed_usd = COALESCE(?, consumed_usd),
			     metadata_json = ?,
			     updated_at = ?
			 WHERE id = ?`,
			[
				patch.state ?? null,
				patch.taskId ?? null,
				patch.consumedCredits == null ? null : Number(patch.consumedCredits),
				patch.consumedProviderUnits == null ? null : Number(patch.consumedProviderUnits),
				patch.consumedUsd == null ? null : Number(patch.consumedUsd),
				JSON.stringify({
					...(existing.metadata ?? {}),
					...(patch.metadata ?? {}),
				}),
				timestamp,
				reservationId,
			],
		);
		return this.getCapacityReservation(reservationId);
	}

	async attachCapacityReservationTask(reservationId, taskId) {
		return this.updateCapacityReservation(reservationId, { taskId });
	}

	async listCapacityProviderApiKeys(teamId, providerId) {
		await this.ensureInitialized();
		if (!(await this.getCapacityProvider(teamId, providerId))) return [];
		const rows = await this.all(
			`SELECT * FROM capacity_provider_api_keys
			 WHERE capacity_provider_id = ? AND team_id = ?
			 ORDER BY created_at DESC`,
			[providerId, teamId],
		);
		return rows.map(serializeCapacityProviderApiKey);
	}

	async updateCapacityProviderApiKeyMetadata(teamId, providerId, patch) {
		const provider = await this.getCapacityProvider(teamId, providerId);
		if (!provider) return null;
		const timestamp = isoNow();
		const metadata = {
			...(provider.metadata ?? {}),
			apiKey: {
				...(provider.metadata?.apiKey ?? {}),
				...patch,
			},
		};
		await this.run(
			`UPDATE capacity_providers SET metadata_json = ?, updated_at = ? WHERE id = ?`,
			[JSON.stringify(metadata), timestamp, providerId],
		);
		return this.getCapacityProvider(teamId, providerId);
	}

	async createCapacityProviderApiKey(teamId, providerId, input = {}) {
		await this.ensureInitialized();
		const provider = await this.getCapacityProvider(teamId, providerId);
		if (!provider) return null;
		const token = typeof input.plaintextKey === 'string' && input.plaintextKey.trim()
			? input.plaintextKey.trim()
			: `tsp_${randomUUID().replaceAll('-', '')}`;
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		const scopes = input.scopes ?? PHASE4_CAPACITY_PROVIDER_SCOPES;
		await this.run(
			`INSERT INTO capacity_provider_api_keys (
				id, capacity_provider_id, team_id, name, key_prefix, key_hash, scopes_json, status,
				last_used_at, rotated_from_key_id, expires_at, revoked_at, created_by_id, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, NULL, ?, ?, ?)`,
			[
				id,
				providerId,
				teamId,
				String(input.name ?? 'Default provider security code'),
				tokenPrefix(token),
				stableHash(token, this.config.authSecret),
				JSON.stringify(scopes),
				input.rotatedFromKeyId ?? null,
				input.expiresAt ?? null,
				input.createdById ?? null,
				timestamp,
				timestamp,
			],
		);
		await this.updateCapacityProviderApiKeyMetadata(teamId, providerId, {
			activeKeyPrefix: tokenPrefix(token),
			lastRotatedAt: timestamp,
			rotationRequired: false,
		});
		return {
			key: serializeCapacityProviderApiKey(await this.first(`SELECT * FROM capacity_provider_api_keys WHERE id = ? LIMIT 1`, [id])),
			plaintextKey: token,
		};
	}

	async createCapacityProviderBootstrapKey(teamId, providerId, input = {}) {
		return this.createCapacityProviderApiKey(teamId, providerId, {
			...input,
			name: input.name ?? 'Capacity provider bootstrap key',
			scopes: input.scopes ?? CAPACITY_PROVIDER_BOOTSTRAP_SCOPES,
		});
	}

	async createCapacityProviderSessionToken(teamId, providerId, input = {}) {
		const ttlSeconds = Number.isFinite(Number(input.ttlSeconds)) ? Number(input.ttlSeconds) : 3600;
		const expiresAt = input.expiresAt ?? new Date(Date.now() + Math.max(300, ttlSeconds) * 1000).toISOString();
		return this.createCapacityProviderApiKey(teamId, providerId, {
			...input,
			name: input.name ?? 'Capacity provider session token',
			scopes: input.scopes ?? CAPACITY_PROVIDER_SESSION_SCOPES,
			expiresAt,
		});
	}

	async resetCapacityProviderApiKey(teamId, providerId, input = {}) {
		await this.ensureInitialized();
		if (!(await this.getCapacityProvider(teamId, providerId))) return null;
		const timestamp = isoNow();
		const previous = await this.first(
			`SELECT * FROM capacity_provider_api_keys
			 WHERE capacity_provider_id = ? AND team_id = ? AND status = 'active' AND revoked_at IS NULL
			 ORDER BY created_at DESC LIMIT 1`,
			[providerId, teamId],
		);
		await this.run(
			`UPDATE capacity_provider_api_keys
			 SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?), updated_at = ?
			 WHERE capacity_provider_id = ? AND team_id = ? AND status = 'active' AND revoked_at IS NULL`,
			[timestamp, timestamp, providerId, teamId],
		);
		const result = await this.createCapacityProviderApiKey(teamId, providerId, {
			...input,
			name: input.name ?? previous?.name ?? 'Default provider security code',
			scopes: input.scopes ?? parseJson(previous?.scopes_json, null) ?? undefined,
			rotatedFromKeyId: previous?.id ?? null,
		});
		await this.updateCapacityProviderApiKeyMetadata(teamId, providerId, {
			activeKeyPrefix: result?.key?.keyPrefix ?? null,
			lastRotatedAt: timestamp,
			lastUsedAt: null,
			rotationRequired: true,
		});
		return result;
	}

	async rotateCapacityProviderApiKey(teamId, providerId, input = {}) {
		return this.resetCapacityProviderApiKey(teamId, providerId, {
			name: input.name ?? 'Capacity provider bootstrap key',
			scopes: input.scopes ?? CAPACITY_PROVIDER_BOOTSTRAP_SCOPES,
			expiresAt: input.expiresAt ?? null,
			createdById: input.createdById ?? null,
		});
	}

	async revokeCapacityProviderApiKey(teamId, keyId, providerId = null) {
		await this.ensureInitialized();
		const row = await this.first(
			`SELECT * FROM capacity_provider_api_keys
			 WHERE id = ? AND team_id = ? AND (? IS NULL OR capacity_provider_id = ?)
			 LIMIT 1`,
			[keyId, teamId, providerId, providerId],
		);
		if (!row) return null;
		const timestamp = isoNow();
		await this.run(
			`UPDATE capacity_provider_api_keys
			 SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?), updated_at = ?
			 WHERE id = ?`,
			[timestamp, timestamp, keyId],
		);
		await this.updateCapacityProviderApiKeyMetadata(teamId, row.capacity_provider_id, {
			rotationRequired: true,
		});
		return serializeCapacityProviderApiKey(await this.first(`SELECT * FROM capacity_provider_api_keys WHERE id = ? LIMIT 1`, [keyId]));
	}

	async verifyCapacityProviderApiKey(presentedKey, requiredScopes = []) {
		await this.ensureInitialized();
		const auth = await this.authenticateCapacityProviderApiKey(presentedKey, requiredScopes);
		return auth.ok ? auth.principal : null;
	}

	async authenticateCapacityProviderApiKey(presentedKey, requiredScopes = []) {
		await this.ensureInitialized();
		const token = String(presentedKey ?? '');
		const prefix = tokenPrefix(token);
		const rows = await this.all(
			`SELECT * FROM capacity_provider_api_keys
			 WHERE key_prefix = ?`,
			[prefix],
		);
		let matchedInactive = false;
		for (const row of rows) {
			if (!equalHash(stableHash(token, this.config.authSecret), row.key_hash)) continue;
			if (row.status !== 'active' || row.revoked_at) {
				matchedInactive = true;
				continue;
			}
			if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
				return { ok: false, reason: 'expired' };
			}
			const scopes = parseJson(row.scopes_json, []);
			const hasScopes = requiredScopes.every((scope) => scopes.includes(scope));
			if (!hasScopes) return { ok: false, reason: 'insufficient_scope', scopes };
			const timestamp = isoNow();
			await this.run(
				`UPDATE capacity_provider_api_keys
				 SET last_used_at = ?, updated_at = ?
				 WHERE id = ?`,
				[timestamp, timestamp, row.id],
			);
			await this.updateCapacityProviderApiKeyMetadata(row.team_id, row.capacity_provider_id, {
				activeKeyPrefix: row.key_prefix,
				lastUsedAt: timestamp,
				rotationRequired: false,
			});
			return {
				ok: true,
				principal: {
					keyId: row.id,
					capacityProviderId: row.capacity_provider_id,
					teamId: row.team_id,
					scopes,
				},
			};
		}
		return { ok: false, reason: matchedInactive ? 'revoked' : 'invalid' };
	}

	async latestCapacityProviderRegistration(providerId) {
		await this.ensureInitialized();
		return serializeCapacityProviderRegistration(await this.first(
			`SELECT * FROM capacity_provider_registrations
			 WHERE capacity_provider_id = ?
			 ORDER BY last_seen_at DESC LIMIT 1`,
			[providerId],
		));
	}

	async recordCapacityProviderRegistration(principal, input = {}) {
		await this.ensureInitialized();
		const provider = await this.getCapacityProvider(principal.teamId, principal.capacityProviderId);
		if (!provider) return null;
		const timestamp = isoNow();
		const runtime = input.runtime && typeof input.runtime === 'object' ? input.runtime : {};
		const capabilities = Array.isArray(input.capabilities) ? input.capabilities : [];
		const budgets = input.budgets && typeof input.budgets === 'object' ? input.budgets : {};
		const health = input.health && typeof input.health === 'object' ? input.health : {};
		const marketId = typeof input.marketId === 'string' && input.marketId.trim() ? input.marketId.trim() : 'local';
		const registrationId = randomUUID();
		await this.run(
			`INSERT INTO capacity_provider_registrations (
				id, capacity_provider_id, team_id, runtime_version, market_id, capabilities_json, budgets_json,
				health_json, status, registered_at, last_seen_at, disconnected_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'online', ?, ?, NULL, ?, ?)`,
			[
				registrationId,
				provider.id,
				principal.teamId,
				typeof runtime.version === 'string' ? runtime.version : 'unknown',
				marketId,
				JSON.stringify(capabilities),
				JSON.stringify(budgets),
				JSON.stringify(health),
				timestamp,
				timestamp,
				timestamp,
				timestamp,
			],
		);
		const metadata = {
			...(provider.metadata ?? {}),
			marketId,
			runtime,
			capabilities,
			budgets,
			health,
			connectionState: 'connected',
			lastSeenAt: timestamp,
			lastRegisteredAt: timestamp,
			lastRegistrationId: registrationId,
			deployment: {
				launchMode: provider.metadata?.deployment?.launchMode ?? provider.metadata?.launchMode ?? 'self_hosted',
				status: provider.metadata?.deployment?.status ?? 'not_deployed',
			},
		};
		await this.run(
			`UPDATE capacity_providers
			 SET status = 'online',
			     monthly_credit_budget = ?,
			     daily_credit_budget = ?,
			     max_concurrent_workdays = ?,
			     max_concurrent_workers = ?,
			     metadata_json = ?,
			     updated_at = ?
			 WHERE id = ?`,
			[
				Number(budgets.monthlyCreditBudget ?? provider.monthlyCreditBudget ?? 0),
				Number(budgets.dailyCreditBudget ?? provider.dailyCreditBudget ?? 0),
				Number(budgets.maxConcurrentWorkdays ?? provider.maxConcurrentWorkdays ?? 1),
				Number(budgets.maxConcurrentRunners ?? provider.maxConcurrentWorkers ?? 1),
				JSON.stringify(metadata),
				timestamp,
				provider.id,
			],
		);
		await this.updateCapacityProviderApiKeyMetadata(principal.teamId, provider.id, {
			lastUsedAt: timestamp,
			rotationRequired: false,
		});
		await this.syncProviderNativeCapacity(principal.teamId, provider.id, budgets);
		return {
			provider: await this.getCapacityProvider(principal.teamId, provider.id),
			registration: await this.latestCapacityProviderRegistration(provider.id),
		};
	}

	async recordCapacityProviderHeartbeat(principal, input = {}) {
		await this.ensureInitialized();
		const provider = await this.getCapacityProvider(principal.teamId, principal.capacityProviderId);
		if (!provider) return null;
		const timestamp = isoNow();
		const health = input.health && typeof input.health === 'object' ? input.health : {};
		const capabilities = Array.isArray(input.capabilities) ? input.capabilities : provider.capabilities ?? [];
		const budgets = input.budgets && typeof input.budgets === 'object' ? input.budgets : provider.budgets ?? {};
		const latest = await this.latestCapacityProviderRegistration(provider.id);
		if (latest) {
			await this.run(
				`UPDATE capacity_provider_registrations
				 SET health_json = ?, capabilities_json = ?, budgets_json = ?, status = ?, last_seen_at = ?, updated_at = ?
				 WHERE id = ?`,
				[
					JSON.stringify({ ...(latest.health ?? {}), ...health }),
					JSON.stringify(capabilities),
					JSON.stringify(budgets),
					'online',
					timestamp,
					timestamp,
					latest.id,
				],
			);
		}
		const metadata = {
			...(provider.metadata ?? {}),
			health: {
				...(provider.metadata?.health ?? {}),
				...health,
			},
			capabilities,
			budgets,
			connectionState: 'connected',
			lastSeenAt: timestamp,
			lastHealth: {
				ok: input.status !== 'offline',
				checkedAt: timestamp,
				...(health ?? {}),
			},
		};
		await this.run(
			`UPDATE capacity_providers
			 SET status = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`,
			[input.status === 'offline' ? 'offline' : 'online', JSON.stringify(metadata), timestamp, provider.id],
		);
		await this.updateCapacityProviderApiKeyMetadata(principal.teamId, provider.id, {
			lastUsedAt: timestamp,
			rotationRequired: false,
		});
		await this.syncProviderNativeCapacity(principal.teamId, provider.id, budgets);
		return this.getCapacityProvider(principal.teamId, provider.id);
	}

	async updateCapacityProviderCreditBudgetMode(teamId, providerId) {
		const provider = await this.getCapacityProvider(teamId, providerId);
		if (!provider) return null;
		const mode = normalizeCreditBudgetMode(provider.creditBudgetMode, 'derived');
		await this.run(
			`UPDATE capacity_providers SET credit_budget_mode = ?, updated_at = ? WHERE id = ?`,
			[mode, isoNow(), providerId],
		);
		return this.getCapacityProvider(teamId, providerId);
	}

	async listExecutionProviders(teamId, providerId) {
		await this.ensureInitialized();
		if (!(await this.getCapacityProvider(teamId, providerId))) return [];
		const rows = await this.all(
			`SELECT * FROM execution_providers
			 WHERE team_id = ? AND capacity_provider_id = ?
			 ORDER BY created_at ASC`,
			[teamId, providerId],
		);
		const providers = [];
		for (const row of rows) {
			const limits = (await this.all(
				`SELECT * FROM execution_provider_native_limits
				 WHERE execution_provider_id = ?
				 ORDER BY scope ASC, native_unit ASC, created_at ASC`,
				[row.id],
			)).map(serializeExecutionProviderNativeLimit);
			const latestObservation = serializeExecutionProviderObservation(await this.first(
				`SELECT * FROM execution_provider_observations
				 WHERE execution_provider_id = ?
				 ORDER BY observed_at DESC, created_at DESC LIMIT 1`,
				[row.id],
			));
			providers.push(serializeExecutionProvider(row, {
				nativeLimits: limits,
				latestObservation,
			}));
		}
		return providers;
	}

	async getExecutionProvider(teamId, providerId, executionProviderId) {
		await this.ensureInitialized();
		const row = await this.first(
			`SELECT * FROM execution_providers
			 WHERE id = ? AND team_id = ? AND capacity_provider_id = ?
			 LIMIT 1`,
			[executionProviderId, teamId, providerId],
		);
		if (!row) return null;
		const [provider] = await this.listExecutionProviders(teamId, providerId).then((items) => items.filter((item) => item.id === executionProviderId));
		return provider ?? null;
	}

	async upsertExecutionProvider(teamId, providerId, input = {}) {
		await this.ensureInitialized();
		const provider = await this.getCapacityProvider(teamId, providerId);
		if (!provider) return null;
		const firstLimit = arrayValue(input.nativeLimits ?? input.limits)[0] ?? {};
		const nativeUnit = stringValue(input.nativeUnit ?? input.native_unit ?? firstLimit.nativeUnit ?? firstLimit.native_unit, 'wall_minute');
		const kind = stringValue(input.kind, provider.provider === '@treeseed/agent' ? 'codex_subscription' : 'custom');
		const name = stringValue(input.name, `${kind.replaceAll('_', ' ')} capacity`);
		const id = stringValue(input.id, `${providerId}:${safeIdPart(kind)}:${safeIdPart(name)}`);
		const existing = await this.first(
			`SELECT * FROM execution_providers
			 WHERE id = ? AND team_id = ? AND capacity_provider_id = ?
			 LIMIT 1`,
			[id, teamId, providerId],
		);
		const timestamp = isoNow();
		const values = [
			teamId,
			providerId,
			name,
			kind,
			stringValue(input.status, existing?.status ?? 'active'),
			nativeUnit,
			stringValue(input.quotaVisibility ?? input.quota_visibility, existing?.quota_visibility ?? 'opaque'),
			Math.max(1, Math.floor(numberValue(input.maxConcurrentWorkers ?? input.max_concurrent_workers, existing?.max_concurrent_workers ?? provider.maxConcurrentWorkers ?? 1))),
			stringValue(input.resetCadence ?? input.reset_cadence, existing?.reset_cadence ?? '') || null,
			JSON.stringify(objectValue(input.config ?? input.configJson ?? parseJson(existing?.config_json, {}))),
			JSON.stringify(objectValue(input.metadata ?? input.metadataJson ?? parseJson(existing?.metadata_json, {}))),
			timestamp,
			id,
		];
		if (existing) {
			await this.run(
				`UPDATE execution_providers
				 SET team_id = ?, capacity_provider_id = ?, name = ?, kind = ?, status = ?, native_unit = ?,
				     quota_visibility = ?, max_concurrent_workers = ?, reset_cadence = ?, config_json = ?,
				     metadata_json = ?, updated_at = ?
				 WHERE id = ?`,
				values,
			);
		} else {
			await this.run(
				`INSERT INTO execution_providers (
					id, team_id, capacity_provider_id, name, kind, status, native_unit, quota_visibility,
					max_concurrent_workers, reset_cadence, config_json, metadata_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					id,
					teamId,
					providerId,
					name,
					kind,
					stringValue(input.status, 'active'),
					nativeUnit,
					stringValue(input.quotaVisibility ?? input.quota_visibility, 'opaque'),
					Math.max(1, Math.floor(numberValue(input.maxConcurrentWorkers ?? input.max_concurrent_workers, provider.maxConcurrentWorkers ?? 1))),
					stringValue(input.resetCadence ?? input.reset_cadence, '') || null,
					JSON.stringify(objectValue(input.config ?? input.configJson)),
					JSON.stringify(objectValue(input.metadata ?? input.metadataJson)),
					timestamp,
					timestamp,
				],
			);
		}
		for (const limit of arrayValue(input.nativeLimits ?? input.limits)) {
			await this.upsertExecutionProviderNativeLimit(teamId, providerId, id, limit);
		}
		if (input.observation && typeof input.observation === 'object') {
			await this.recordExecutionProviderObservation(teamId, providerId, id, input.observation);
		}
		return this.getExecutionProvider(teamId, providerId, id);
	}

	async upsertExecutionProviderNativeLimit(teamId, providerId, executionProviderId, input = {}) {
		await this.ensureInitialized();
		const executionProvider = await this.first(
			`SELECT * FROM execution_providers
			 WHERE id = ? AND team_id = ? AND capacity_provider_id = ?
			 LIMIT 1`,
			[executionProviderId, teamId, providerId],
		);
		if (!executionProvider) return null;
		const scope = stringValue(input.scope ?? input.limitScope ?? input.limit_scope, 'daily');
		const nativeUnit = stringValue(input.nativeUnit ?? input.native_unit, executionProvider.native_unit);
		const limitAmount = numberValue(input.limitAmount ?? input.limit_amount, null);
		if (limitAmount === null || limitAmount < 0) {
			throw new Error('limitAmount must be a non-negative number.');
		}
		const id = stringValue(input.id, `${executionProviderId}:${safeIdPart(scope)}:${safeIdPart(nativeUnit)}`);
		const existing = await this.first(
			`SELECT * FROM execution_provider_native_limits
			 WHERE id = ? AND execution_provider_id = ?
			 LIMIT 1`,
			[id, executionProviderId],
		);
		const timestamp = isoNow();
		const metadata = objectValue(input.metadata ?? input.metadataJson ?? parseJson(existing?.metadata_json, {}));
		const dailyUsageCapPercent = numberValue(input.dailyUsageCapPercent ?? input.maxDailyUsagePercent, null);
		if (dailyUsageCapPercent !== null) {
			metadata.dailyUsageCapPercent = Math.max(0, Math.min(100, dailyUsageCapPercent));
		}
		const values = [
			executionProviderId,
			scope,
			nativeUnit,
			limitAmount,
			Math.max(0, numberValue(input.reserveBufferPercent ?? input.reserve_buffer_percent, existing?.reserve_buffer_percent ?? 0)),
			stringValue(input.resetCadence ?? input.reset_cadence, existing?.reset_cadence ?? executionProvider.reset_cadence ?? '') || null,
			stringValue(input.resetAt ?? input.reset_at, existing?.reset_at ?? '') || null,
			stringValue(input.confidence, existing?.confidence ?? 'estimated'),
			stringValue(input.source, existing?.source ?? 'configured'),
			JSON.stringify(metadata),
			timestamp,
			id,
		];
		if (existing) {
			await this.run(
				`UPDATE execution_provider_native_limits
				 SET execution_provider_id = ?, scope = ?, native_unit = ?, limit_amount = ?, reserve_buffer_percent = ?,
				     reset_cadence = ?, reset_at = ?, confidence = ?, source = ?, metadata_json = ?, updated_at = ?
				 WHERE id = ?`,
				values,
			);
		} else {
			await this.run(
				`INSERT INTO execution_provider_native_limits (
					id, execution_provider_id, scope, native_unit, limit_amount, reserve_buffer_percent,
					reset_cadence, reset_at, confidence, source, metadata_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					id,
					executionProviderId,
					scope,
					nativeUnit,
					limitAmount,
					Math.max(0, numberValue(input.reserveBufferPercent ?? input.reserve_buffer_percent, 0)),
					stringValue(input.resetCadence ?? input.reset_cadence, executionProvider.reset_cadence ?? '') || null,
					stringValue(input.resetAt ?? input.reset_at, '') || null,
					stringValue(input.confidence, 'estimated'),
					stringValue(input.source, 'configured'),
					JSON.stringify(metadata),
					timestamp,
					timestamp,
				],
			);
		}
		return serializeExecutionProviderNativeLimit(await this.first(`SELECT * FROM execution_provider_native_limits WHERE id = ? LIMIT 1`, [id]));
	}

	async recordExecutionProviderObservation(teamId, providerId, executionProviderId, input = {}) {
		await this.ensureInitialized();
		const executionProvider = await this.first(
			`SELECT * FROM execution_providers
			 WHERE id = ? AND team_id = ? AND capacity_provider_id = ?
			 LIMIT 1`,
			[executionProviderId, teamId, providerId],
		);
		if (!executionProvider) return null;
		const timestamp = isoNow();
		const id = stringValue(input.id, randomUUID());
		await this.run(
			`INSERT INTO execution_provider_observations (
				id, execution_provider_id, observed_at, health, active_workers, queued_tasks, throttle_state,
				native_remaining_json, reset_at, confidence, metadata_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				executionProviderId,
				stringValue(input.observedAt ?? input.observed_at, timestamp),
				stringValue(input.health, 'unknown'),
				numberValue(input.activeWorkers ?? input.active_workers, null),
				numberValue(input.queuedTasks ?? input.queued_tasks, null),
				stringValue(input.throttleState ?? input.throttle_state, '') || null,
				JSON.stringify(objectValue(input.nativeRemaining ?? input.native_remaining ?? input.nativeRemainingJson)),
				stringValue(input.resetAt ?? input.reset_at, '') || null,
				stringValue(input.confidence, 'estimated'),
				JSON.stringify(objectValue(input.metadata ?? input.metadataJson)),
				timestamp,
			],
		);
		return serializeExecutionProviderObservation(await this.first(`SELECT * FROM execution_provider_observations WHERE id = ? LIMIT 1`, [id]));
	}

	async syncProviderNativeCapacity(teamId, providerId, budgets = {}) {
		const nativeCapacity = budgets?.nativeCapacity ?? budgets?.native_capacity ?? null;
		const executionProviderInputs = arrayValue(
			nativeCapacity?.executionProviders
				?? nativeCapacity?.execution_providers
				?? budgets?.executionProviders
				?? budgets?.execution_providers
				?? (Array.isArray(nativeCapacity) ? nativeCapacity : []),
		);
		const synced = [];
		for (const input of executionProviderInputs) {
			if (!input || typeof input !== 'object' || Array.isArray(input)) continue;
			const executionProvider = await this.upsertExecutionProvider(teamId, providerId, input);
			if (executionProvider) synced.push(executionProvider);
		}
		return synced;
	}

	async listCapacityProviderDeployments(teamId, providerId) {
		await this.ensureInitialized();
		if (!(await this.getCapacityProvider(teamId, providerId))) return [];
		const rows = await this.all(
			`SELECT * FROM capacity_provider_deployments
			 WHERE team_id = ? AND capacity_provider_id = ?
			 ORDER BY created_at DESC`,
			[teamId, providerId],
		);
		return rows.map(serializeCapacityProviderDeployment);
	}

	async createCapacityProviderDeployment(teamId, providerId, input = {}) {
		await this.ensureInitialized();
		const provider = await this.getCapacityProvider(teamId, providerId);
		if (!provider) return null;
		const launchMode = providerLaunchMode(input.launchMode) ?? provider.metadata?.launchMode ?? 'self_hosted';
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		const status = input.status ?? (launchMode === 'self_hosted' ? 'not_deployed' : 'deploying');
		await this.run(
			`INSERT INTO capacity_provider_deployments (
				id, team_id, capacity_provider_id, launch_mode, host_kind, host_id, status, image_ref,
				service_refs_json, env_refs_json, result_json, error_json, created_by_id, created_at, updated_at, completed_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				teamId,
				providerId,
				launchMode,
				String(input.hostKind ?? (launchMode === 'self_hosted' ? 'self_hosted' : 'managed')),
				input.hostId ?? null,
				status,
				input.imageRef ?? null,
				JSON.stringify(input.serviceRefs ?? {}),
				JSON.stringify(input.envRefs ?? {}),
				JSON.stringify(input.result ?? {}),
				input.error ? JSON.stringify(input.error) : null,
				input.createdById ?? null,
				timestamp,
				timestamp,
				input.completedAt ?? null,
			],
		);
		const deployment = serializeCapacityProviderDeployment(await this.first(`SELECT * FROM capacity_provider_deployments WHERE id = ? LIMIT 1`, [id]));
		await this.updateCapacityProviderStatus(teamId, providerId, {
			status: provider.status,
			metadata: {
				deployment: {
					launchMode,
					status,
				},
			},
		});
		return deployment;
	}

	async updateCapacityProviderDeployment(teamId, deploymentId, input = {}) {
		await this.ensureInitialized();
		const existing = serializeCapacityProviderDeployment(await this.first(
			`SELECT * FROM capacity_provider_deployments WHERE id = ? AND team_id = ? LIMIT 1`,
			[deploymentId, teamId],
		));
		if (!existing) return null;
		const timestamp = isoNow();
		const status = input.status ?? existing.status;
		const serviceRefs = input.serviceRefs ?? existing.serviceRefs ?? {};
		const envRefs = input.envRefs ?? existing.envRefs ?? {};
		const result = input.result ?? existing.result ?? {};
		const error = input.error === undefined ? existing.error : input.error;
		const completedAt = input.completedAt === undefined ? existing.completedAt : input.completedAt;
		await this.run(
			`UPDATE capacity_provider_deployments
			 SET status = ?, service_refs_json = ?, env_refs_json = ?, result_json = ?, error_json = ?, updated_at = ?, completed_at = ?
			 WHERE id = ? AND team_id = ?`,
			[
				status,
				JSON.stringify(serviceRefs),
				JSON.stringify(envRefs),
				JSON.stringify(result),
				error ? JSON.stringify(error) : null,
				timestamp,
				completedAt ?? null,
				deploymentId,
				teamId,
			],
		);
		const deployment = serializeCapacityProviderDeployment(await this.first(
			`SELECT * FROM capacity_provider_deployments WHERE id = ? AND team_id = ? LIMIT 1`,
			[deploymentId, teamId],
		));
		const provider = await this.getCapacityProvider(teamId, deployment.capacityProviderId);
		await this.updateCapacityProviderStatus(teamId, deployment.capacityProviderId, {
			status: provider?.status ?? 'pending',
			metadata: {
				deployment: {
					launchMode: deployment.launchMode,
					status: deployment.status,
					serviceRefs: deployment.serviceRefs,
					updatedAt: deployment.updatedAt,
				},
			},
		});
		return deployment;
	}

	async getPrimaryTreeDxInstance(teamId) {
		await this.ensureInitialized();
		const primary = serializeTreeDxInstance(await this.first(
			`SELECT * FROM treedx_instances WHERE team_id = ? AND COALESCE("primary", 1) != 0 AND status != 'disabled' ORDER BY updated_at DESC LIMIT 1`,
			[teamId],
		));
		if (primary) return primary;
		const rows = await this.all(`SELECT * FROM treedx_instances ORDER BY updated_at DESC`);
		return rows
			.map(serializeTreeDxInstance)
			.find((instance) => instance?.teamId === teamId && instance.primary && instance.status !== 'disabled') ?? null;
	}

	async getTeamTreeDx(teamId) {
		await this.ensureInitialized();
		const instance = await this.getPrimaryTreeDxInstance(teamId);
		return {
			instance,
			mirrors: instance ? await this.listTreeDxMirrors(teamId, instance.id) : [],
			shares: await this.listTreeDxShares(teamId),
			deployments: instance ? await this.listTreeDxDeployments(teamId, instance.id) : [],
		};
	}

	async upsertTeamTreeDx(teamId, input = {}) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const existing = await this.getPrimaryTreeDxInstance(teamId);
		const id = input.id ?? existing?.id ?? randomUUID();
		const kind = String(input.kind ?? existing?.kind ?? (input.publicRead ? 'managed_public_federation' : 'managed_private'));
		const provider = String(input.provider ?? existing?.provider ?? (kind === 'managed_public_federation' ? 'public_federation' : kind === 'self_hosted' ? 'self_hosted' : 'railway'));
		const status = String(input.status ?? existing?.status ?? (input.baseUrl ? 'active' : 'pending'));
		if (status === 'active') {
			await this.run(
				`UPDATE treedx_instances SET status = 'disabled', updated_at = ? WHERE team_id = ? AND COALESCE("primary", 1) != 0 AND id != ? AND status = 'active'`,
				[timestamp, teamId, id],
			);
		}
		await this.run(
			`INSERT INTO treedx_instances (
				id, team_id, kind, provider, name, base_url, registry_url, public_read, "primary", status, image_ref,
				railway_project_id, railway_service_id, railway_environment_id, volume_mount_path, metadata_json, created_at, updated_at
			) VALUES (
				?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
			)
			ON CONFLICT (id) DO UPDATE SET
				kind = EXCLUDED.kind,
				provider = EXCLUDED.provider,
				name = EXCLUDED.name,
				base_url = EXCLUDED.base_url,
				registry_url = EXCLUDED.registry_url,
				public_read = EXCLUDED.public_read,
				"primary" = EXCLUDED."primary",
				status = EXCLUDED.status,
				image_ref = EXCLUDED.image_ref,
				railway_project_id = EXCLUDED.railway_project_id,
				railway_service_id = EXCLUDED.railway_service_id,
				railway_environment_id = EXCLUDED.railway_environment_id,
				volume_mount_path = EXCLUDED.volume_mount_path,
				metadata_json = EXCLUDED.metadata_json,
				updated_at = EXCLUDED.updated_at`,
			[
				id,
				teamId,
				kind,
				provider,
				String(input.name ?? existing?.name ?? 'TreeDX Knowledge Library'),
				input.baseUrl ?? existing?.baseUrl ?? null,
				input.registryUrl ?? input.baseUrl ?? existing?.registryUrl ?? null,
				input.publicRead === undefined ? Number(existing?.publicRead ?? false) : Number(Boolean(input.publicRead)),
				1,
				status,
				input.imageRef ?? existing?.imageRef ?? 'treeseed/treedx:latest',
				input.railwayProjectId ?? existing?.railwayProjectId ?? null,
				input.railwayServiceId ?? existing?.railwayServiceId ?? null,
				input.railwayEnvironmentId ?? existing?.railwayEnvironmentId ?? null,
				input.volumeMountPath ?? existing?.volumeMountPath ?? (provider === 'railway' ? '/data' : null),
				JSON.stringify({
					...(existing?.metadata ?? {}),
					...(objectValue(input.metadata, {}) ?? {}),
					hostRole: 'knowledge-library',
					contentCanonical: 'treedx',
				}),
				existing?.createdAt ?? timestamp,
				timestamp,
			],
		);
		return serializeTreeDxInstance(await this.first(`SELECT * FROM treedx_instances WHERE team_id = ? AND id = ? LIMIT 1`, [teamId, id])) ?? {
			id,
			teamId,
			kind,
			provider,
			name: String(input.name ?? existing?.name ?? 'TreeDX Knowledge Library'),
			baseUrl: input.baseUrl ?? existing?.baseUrl ?? null,
			registryUrl: input.registryUrl ?? input.baseUrl ?? existing?.registryUrl ?? null,
			publicRead: input.publicRead === undefined ? Boolean(existing?.publicRead ?? false) : Boolean(input.publicRead),
			primary: true,
			status,
			imageRef: input.imageRef ?? existing?.imageRef ?? 'treeseed/treedx:latest',
			railwayProjectId: input.railwayProjectId ?? existing?.railwayProjectId ?? null,
			railwayServiceId: input.railwayServiceId ?? existing?.railwayServiceId ?? null,
			railwayEnvironmentId: input.railwayEnvironmentId ?? existing?.railwayEnvironmentId ?? null,
			volumeMountPath: input.volumeMountPath ?? existing?.volumeMountPath ?? (provider === 'railway' ? '/data' : null),
			metadata: {
				...(existing?.metadata ?? {}),
				...(objectValue(input.metadata, {}) ?? {}),
				hostRole: 'knowledge-library',
				contentCanonical: 'treedx',
			},
			createdAt: existing?.createdAt ?? timestamp,
			updatedAt: timestamp,
		};
	}

	async provisionTeamTreeDx(teamId, input = {}) {
		const team = await this.getTeam(teamId);
		if (!team) return null;
		const publicRead = input.publicRead ?? !teamIsPrivate(team);
		const registryUrl = input.registryUrl ?? centralTreeDxRegistryUrl(this.config);
		const trustTokenRef = input.trustTokenRef ?? `treedx-trust:${teamId}:central-public`;
		const existing = await this.getPrimaryTreeDxInstance(teamId);
		const status = input.status
			?? (input.baseUrl || existing?.baseUrl ? 'active' : 'pending');
		const instance = await this.upsertTeamTreeDx(teamId, {
			...input,
			kind: publicRead ? 'managed_public_federation' : 'managed_private',
			provider: 'railway',
			publicRead,
			name: input.name ?? (publicRead ? 'TreeSeed public federation' : `${team.slug} TreeDX`),
			registryUrl,
			status,
			imageRef: input.imageRef ?? 'treeseed/treedx:latest',
			volumeMountPath: '/data',
			metadata: {
				...(objectValue(input.metadata, {}) ?? {}),
				deploymentScope: publicRead ? 'public_federation' : 'private_team',
				centralPublicRegistry: {
					url: registryUrl,
					trustMode: 'scoped_node_token',
					trustTokenRef,
					mirrorAllowed: !publicRead,
					queryDelegationAllowed: true,
				},
			},
		});
		const timestamp = isoNow();
		const deploymentId = randomUUID();
		await this.run(
			`INSERT INTO treedx_deployments (
				id, team_id, instance_id, provider, status, image_ref, volume_mount_path, service_refs_json, result_json, error_json, created_at, updated_at, completed_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				deploymentId,
				teamId,
				instance.id,
				instance.provider,
				instance.baseUrl ? 'succeeded' : 'queued',
				instance.imageRef,
				instance.volumeMountPath,
				JSON.stringify({ railwayProjectId: instance.railwayProjectId, railwayServiceId: instance.railwayServiceId }),
				JSON.stringify({
					mode: instance.publicRead ? 'public_federation' : 'managed_private',
					nextAction: instance.publicRead
						? 'Create or attach the shared public Railway TreeDX federation project, service, persistent /data volume, and public service domain.'
						: 'Create dedicated Railway project, service, persistent /data volume, and service token.',
					operation: 'queued_treedx_provision',
				}),
				null,
				timestamp,
				timestamp,
				instance.baseUrl ? timestamp : null,
			],
		);
		let payload = await this.getTeamTreeDx(teamId);
		if (!publicRead) {
			const mirrors = payload.mirrors ?? await this.listTreeDxMirrors(teamId, instance.id);
			const hasCentralMirror = mirrors.some((mirror) => mirror.metadata?.centralPublicRegistry === true || mirror.targetUrl === registryUrl);
			if (!hasCentralMirror) {
				await this.createTreeDxMirror(teamId, {
					instanceId: instance.id,
					name: 'TreeSeed public registry mirror',
					direction: 'pull',
					targetKind: 'treedx',
					targetUrl: registryUrl,
					status: 'pending',
					instructions: 'Use the scoped TreeDX node trust token to mirror public templates, workflow imports, and knowledge packs from the central public registry.',
					metadata: {
						centralPublicRegistry: true,
						trustMode: 'scoped_node_token',
						trustTokenRef,
						privateDataEgress: 'deny_by_default',
					},
				});
				payload = await this.getTeamTreeDx(teamId);
			}
		}
		if (payload.instance) return payload;
		return {
			instance,
			mirrors: await this.listTreeDxMirrors(teamId, instance.id),
			shares: await this.listTreeDxShares(teamId),
			deployments: await this.listTreeDxDeployments(teamId, instance.id),
		};
	}

	async updateTreeDxDeployment(deploymentId, patch = {}) {
		await this.ensureInitialized();
		const existing = serializeTreeDxDeployment(await this.first(`SELECT * FROM treedx_deployments WHERE id = ? LIMIT 1`, [deploymentId]));
		if (!existing) return null;
		const timestamp = isoNow();
		const status = patch.status ?? existing.status;
		const terminal = ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(status);
		await this.run(
			`UPDATE treedx_deployments
			 SET status = ?,
			     image_ref = ?,
			     volume_mount_path = ?,
			     service_refs_json = ?,
			     result_json = ?,
			     error_json = ?,
			     updated_at = ?,
			     completed_at = ?
			 WHERE id = ?`,
			[
				status,
				patch.imageRef ?? existing.imageRef,
				patch.volumeMountPath ?? existing.volumeMountPath,
				JSON.stringify({
					...(existing.serviceRefs ?? {}),
					...(objectValue(patch.serviceRefs, {}) ?? {}),
				}),
				JSON.stringify({
					...(existing.result ?? {}),
					...(objectValue(patch.result, {}) ?? {}),
				}),
				patch.error ? JSON.stringify(redactDeploymentValue(patch.error)) : (patch.clearError ? null : JSON.stringify(existing.error ?? {})),
				timestamp,
				terminal ? patch.completedAt ?? timestamp : patch.completedAt ?? existing.completedAt ?? null,
				deploymentId,
			],
		);
		return serializeTreeDxDeployment(await this.first(`SELECT * FROM treedx_deployments WHERE id = ? LIMIT 1`, [deploymentId]));
	}

	async listTreeDxDeployments(teamId, instanceId = null) {
		await this.ensureInitialized();
		let rows = instanceId
			? await this.all(`SELECT * FROM treedx_deployments WHERE team_id = ? AND instance_id = ? ORDER BY created_at DESC`, [teamId, instanceId])
			: await this.all(`SELECT * FROM treedx_deployments WHERE team_id = ? ORDER BY created_at DESC`, [teamId]);
		if (rows.length === 0) {
			rows = (await this.all(`SELECT * FROM treedx_deployments ORDER BY created_at DESC`))
				.filter((row) => row.team_id === teamId && (!instanceId || row.instance_id === instanceId));
		}
		return rows.map(serializeTreeDxDeployment).filter(Boolean);
	}

	async listTreeDxMirrors(teamId, instanceId = null) {
		await this.ensureInitialized();
		let rows = instanceId
			? await this.all(`SELECT * FROM treedx_mirrors WHERE team_id = ? AND instance_id = ? ORDER BY created_at ASC`, [teamId, instanceId])
			: await this.all(`SELECT * FROM treedx_mirrors WHERE team_id = ? ORDER BY created_at ASC`, [teamId]);
		if (rows.length === 0) {
			rows = (await this.all(`SELECT * FROM treedx_mirrors ORDER BY created_at ASC`))
				.filter((row) => row.team_id === teamId && (!instanceId || row.instance_id === instanceId));
		}
		return rows.map(serializeTreeDxMirror).filter(Boolean);
	}

	async createTreeDxMirror(teamId, input = {}) {
		await this.ensureInitialized();
		const instance = input.instanceId
			? serializeTreeDxInstance(await this.first(`SELECT * FROM treedx_instances WHERE id = ? LIMIT 1`, [input.instanceId]))
			: await this.getPrimaryTreeDxInstance(teamId);
		if (!instance || instance.teamId !== teamId) return null;
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO treedx_mirrors (
				id, team_id, instance_id, name, direction, target_kind, target_url, status, instructions,
				last_sync_at, last_sync_status, last_sync_metadata_json, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				teamId,
				instance.id,
				String(input.name ?? 'TreeDX mirror'),
				String(input.direction ?? 'bidirectional'),
				String(input.targetKind ?? 'git'),
				input.targetUrl ?? null,
				String(input.status ?? 'pending'),
				input.instructions ?? `Connect this mirror to ${instance.baseUrl ?? 'the team TreeDX'} and sync the selected libraries. Store credentials in the target secret manager, not in seed exports.`,
				null,
				null,
				JSON.stringify({}),
				JSON.stringify(objectValue(input.metadata, {})),
				timestamp,
				timestamp,
			],
		);
		return serializeTreeDxMirror(await this.first(`SELECT * FROM treedx_mirrors WHERE id = ? LIMIT 1`, [id]));
	}

	async syncTreeDxMirror(teamId, mirrorId, input = {}) {
		await this.ensureInitialized();
		const existing = serializeTreeDxMirror(await this.first(`SELECT * FROM treedx_mirrors WHERE team_id = ? AND id = ? LIMIT 1`, [teamId, mirrorId]));
		if (!existing) return null;
		const timestamp = isoNow();
		await this.run(
			`UPDATE treedx_mirrors
			 SET status = ?, last_sync_at = ?, last_sync_status = ?, last_sync_metadata_json = ?, updated_at = ?
			 WHERE team_id = ? AND id = ?`,
			[
				String(input.status ?? 'syncing'),
				timestamp,
				String(input.lastSyncStatus ?? 'queued'),
				JSON.stringify(objectValue(input.metadata, {})),
				timestamp,
				teamId,
				mirrorId,
			],
		);
		return serializeTreeDxMirror(await this.first(`SELECT * FROM treedx_mirrors WHERE team_id = ? AND id = ? LIMIT 1`, [teamId, mirrorId]));
	}

	async listTreeDxShares(teamId) {
		await this.ensureInitialized();
		let rows = await this.all(`SELECT * FROM treedx_shares WHERE team_id = ? ORDER BY created_at ASC`, [teamId]);
		if (rows.length === 0) {
			rows = (await this.all(`SELECT * FROM treedx_shares ORDER BY created_at ASC`))
				.filter((row) => row.team_id === teamId);
		}
		return rows
			.map(serializeTreeDxShare)
			.filter(Boolean);
	}

	async createTreeDxShare(teamId, input = {}) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const instance = input.instanceId
			? serializeTreeDxInstance(await this.first(`SELECT * FROM treedx_instances WHERE id = ? LIMIT 1`, [input.instanceId]))
			: await this.getPrimaryTreeDxInstance(teamId);
		if (instance && instance.teamId !== teamId) return null;
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO treedx_shares (
				id, team_id, instance_id, project_id, library_id, scope, target_team_id, trust_grant_json,
				public_read, status, expires_at, metadata_json, created_at, updated_at, revoked_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				teamId,
				input.instanceId ?? instance?.id ?? null,
				input.projectId ?? null,
				input.libraryId ?? null,
				String(input.scope ?? (input.publicRead ? 'public_federation' : 'team')),
				input.targetTeamId ?? null,
				JSON.stringify(objectValue(input.trustGrant, {})),
				Number(Boolean(input.publicRead)),
				String(input.status ?? 'active'),
				input.expiresAt ?? null,
				JSON.stringify(objectValue(input.metadata, {})),
				timestamp,
				timestamp,
				null,
			],
		);
		return serializeTreeDxShare(await this.first(`SELECT * FROM treedx_shares WHERE id = ? LIMIT 1`, [id]));
	}

	async upsertProjectTreeDxLibrary(projectId, input = {}) {
		await this.ensureInitialized();
		const project = await this.getProject(projectId);
		if (!project) return null;
		const instance = input.instanceId
			? serializeTreeDxInstance(await this.first(`SELECT * FROM treedx_instances WHERE id = ? LIMIT 1`, [input.instanceId]))
			: await this.getPrimaryTreeDxInstance(project.teamId);
		if (!instance || instance.teamId !== project.teamId) return null;
		const existing = await this.getProjectTreeDxLibrary(projectId);
		const repositories = await this.listHubRepositories(projectId);
		const contentRepository = repositories.find((entry) => entry.role === 'content') ?? null;
		const softwareRepository = repositories.find((entry) => ['software', 'primary', 'package'].includes(entry.role)) ?? repositories[0] ?? null;
		const workspaceLink = serializeHubWorkspaceLink(await this.first(`SELECT * FROM hub_workspace_links WHERE hub_id = ? LIMIT 1`, [projectId]));
		const timestamp = isoNow();
		const id = input.id ?? existing?.id ?? randomUUID();
		const libraryId = String(input.libraryId ?? existing?.libraryId ?? `${project.teamId}/${project.slug}`);
		const topology = this.buildRepositoryTopologySnapshot({
			project,
			instance,
			binding: {
				libraryId,
				repositoryId: input.repositoryId ?? existing?.repositoryId ?? null,
				contentPath: input.contentPath ?? existing?.contentPath ?? 'src/content',
				contentRepositoryUrl: input.contentRepositoryUrl ?? existing?.contentRepositoryUrl ?? contentRepository?.url ?? null,
				contentRepositoryDefaultBranch: input.contentRepositoryDefaultBranch ?? existing?.contentRepositoryDefaultBranch ?? contentRepository?.defaultBranch ?? null,
				contentRepositoryRef: input.contentRepositoryRef ?? existing?.contentRepositoryRef ?? contentRepository?.currentBranch ?? null,
				r2BucketName: input.r2BucketName ?? existing?.r2BucketName ?? null,
				r2ManifestKey: input.r2ManifestKey ?? existing?.r2ManifestKey ?? null,
			},
			softwareRepository,
			workspaceLink,
			metadata: objectValue(input.topology, {}),
		});
		if (existing) {
			await this.run(
				`UPDATE treedx_project_libraries
				 SET instance_id = ?, library_id = ?, repository_id = ?, content_path = ?, content_repository_url = ?,
				     content_repository_default_branch = ?, content_repository_ref = ?, r2_bucket_name = ?, r2_manifest_key = ?,
				     topology_json = ?, metadata_json = ?, updated_at = ?
				 WHERE project_id = ?`,
				[
					instance.id,
					libraryId,
					input.repositoryId ?? existing.repositoryId ?? null,
					input.contentPath ?? existing.contentPath ?? 'src/content',
					input.contentRepositoryUrl ?? existing.contentRepositoryUrl ?? contentRepository?.url ?? null,
					input.contentRepositoryDefaultBranch ?? existing.contentRepositoryDefaultBranch ?? contentRepository?.defaultBranch ?? null,
					input.contentRepositoryRef ?? existing.contentRepositoryRef ?? contentRepository?.currentBranch ?? null,
					input.r2BucketName ?? existing.r2BucketName ?? null,
					input.r2ManifestKey ?? existing.r2ManifestKey ?? null,
					JSON.stringify(topology),
					JSON.stringify({ ...(existing.metadata ?? {}), ...(objectValue(input.metadata, {}) ?? {}) }),
					timestamp,
					projectId,
				],
			);
		} else {
			await this.run(
				`INSERT INTO treedx_project_libraries (
					id, team_id, project_id, instance_id, library_id, repository_id, content_path, content_repository_url,
					content_repository_default_branch, content_repository_ref, r2_bucket_name, r2_manifest_key,
					topology_json, metadata_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					id,
					project.teamId,
					projectId,
					instance.id,
					libraryId,
					input.repositoryId ?? null,
					input.contentPath ?? 'src/content',
					input.contentRepositoryUrl ?? contentRepository?.url ?? null,
					input.contentRepositoryDefaultBranch ?? contentRepository?.defaultBranch ?? null,
					input.contentRepositoryRef ?? contentRepository?.currentBranch ?? null,
					input.r2BucketName ?? null,
					input.r2ManifestKey ?? null,
					JSON.stringify(topology),
					JSON.stringify(objectValue(input.metadata, {})),
					timestamp,
					timestamp,
				],
			);
		}
		await this.ensureHubContentSourceTreeDx(projectId, project.teamId, contentRepository?.id ?? null, topology);
		return this.getProjectTreeDxLibrary(projectId);
	}

	async getProjectTreeDxLibrary(projectId) {
		await this.ensureInitialized();
		return serializeTreeDxProjectLibrary(await this.first(`SELECT * FROM treedx_project_libraries WHERE project_id = ? LIMIT 1`, [projectId]));
	}

	async getProjectRepositoryTopology(projectId) {
		const binding = await this.getProjectTreeDxLibrary(projectId);
		if (binding?.topology && Object.keys(binding.topology).length > 0) return binding.topology;
		const project = await this.getProject(projectId);
		if (!project) return null;
		const instance = await this.getPrimaryTreeDxInstance(project.teamId);
		if (!instance) return null;
		const created = await this.upsertProjectTreeDxLibrary(projectId, {});
		return created?.topology ?? null;
	}

	async upsertProjectRepositoryTopology(projectId, topology = {}) {
		return this.upsertProjectTreeDxLibrary(projectId, { topology });
	}

	async getProjectAgentClassAllocation(projectId) {
		await this.ensureInitialized();
		const project = await this.getProject(projectId);
		if (!project) return null;
		const existing = project.metadata?.capacityAllocation?.agentClasses;
		const fallback = [
			{ id: 'planning', name: 'Planning', percentage: 15 },
			{ id: 'research', name: 'Research', percentage: 20 },
			{ id: 'architecture', name: 'Architecture', percentage: 10 },
			{ id: 'implementation', name: 'Implementation', percentage: 30 },
			{ id: 'review', name: 'Review', percentage: 10 },
			{ id: 'release', name: 'Release', percentage: 5 },
			{ id: 'reporting', name: 'Reporting', percentage: 5 },
			{ id: 'knowledge', name: 'Knowledge', percentage: 5 },
		];
		return {
			projectId,
			teamId: project.teamId,
			slices: normalizeAllocationSlices(existing, fallback),
			metadata: project.metadata?.capacityAllocation?.metadata ?? {},
		};
	}

	async updateProjectAgentClassAllocation(projectId, input = {}) {
		await this.ensureInitialized();
		const project = await this.getProject(projectId);
		if (!project) return null;
		const slices = normalizeAllocationSlices(input.allocations ?? input.slices);
		const total = Math.round(slices.reduce((sum, slice) => sum + slice.percentage, 0) * 100) / 100;
		if (slices.length === 0) throw new Error('At least one agent class allocation slice is required.');
		if (Math.abs(total - 100) > 0.01) throw new Error('Agent class allocation must total 100%.');
		const nextMetadata = {
			...(project.metadata ?? {}),
			capacityAllocation: {
				...(project.metadata?.capacityAllocation ?? {}),
				agentClasses: slices,
				metadata: {
					...(project.metadata?.capacityAllocation?.metadata ?? {}),
					source: 'project_agent_class_allocation_ui',
					updatedAt: isoNow(),
				},
			},
		};
		await this.updateProject(projectId, { metadata: nextMetadata });
		return this.getProjectAgentClassAllocation(projectId);
	}

	async ensureHubContentSourceTreeDx(projectId, teamId, contentRepositoryId, topology) {
		const timestamp = isoNow();
		const existing = serializeHubContentSource(await this.first(`SELECT * FROM hub_content_sources WHERE hub_id = ? LIMIT 1`, [projectId]));
		const r2 = topology?.contentRepository?.r2 ?? {};
		if (existing) {
			await this.run(
				`UPDATE hub_content_sources
				 SET content_repository_id = ?, production_source = ?, overlay_policy = ?, r2_bucket_name = ?, r2_manifest_key = ?, metadata_json = ?, updated_at = ?
				 WHERE hub_id = ?`,
				[
					contentRepositoryId,
					'treedx',
					existing.overlayPolicy ?? 'treedx_snapshot',
					r2.bucketName ?? existing.r2BucketName ?? null,
					r2.manifestKey ?? existing.r2ManifestKey ?? null,
					JSON.stringify({
						...(existing.metadata ?? {}),
						contentCanonical: 'treedx',
						publishSource: 'treedx_to_r2',
						repositoryTopology: topology,
					}),
					timestamp,
					projectId,
				],
			);
		} else {
			await this.run(
				`INSERT INTO hub_content_sources (
					id, hub_id, team_id, content_repository_id, production_source, overlay_policy, r2_bucket_name,
					r2_manifest_key, r2_public_base_url, latest_publish_id, latest_content_version, metadata_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					randomUUID(),
					projectId,
					teamId,
					contentRepositoryId,
					'treedx',
					'treedx_snapshot',
					r2.bucketName ?? null,
					r2.manifestKey ?? null,
					r2.publicBaseUrl ?? null,
					null,
					null,
					JSON.stringify({
						contentCanonical: 'treedx',
						publishSource: 'treedx_to_r2',
						repositoryTopology: topology,
					}),
					timestamp,
					timestamp,
				],
			);
		}
	}

	buildRepositoryTopologySnapshot({ project, instance, binding, softwareRepository, workspaceLink, metadata = {} }) {
		const siteCheckoutBase = `/data/projects/${project.slug}/site`;
		const projectCheckoutBase = workspaceLink?.parentName ? `/data/projects/${project.slug}/project` : null;
		return {
			contentRepository: {
				accessMode: 'treedx',
				githubUrl: binding.contentRepositoryUrl ?? null,
				defaultBranch: binding.contentRepositoryDefaultBranch ?? null,
				ref: binding.contentRepositoryRef ?? null,
				contentPath: binding.contentPath ?? 'src/content',
				treeDx: {
					instanceId: instance.id,
					libraryId: binding.libraryId,
					repositoryId: binding.repositoryId ?? null,
					baseUrl: instance.baseUrl ?? null,
				},
				r2: {
					bucketName: binding.r2BucketName ?? null,
					manifestKey: binding.r2ManifestKey ?? null,
				},
			},
			siteRepository: {
				accessMode: 'filesystem',
				provider: softwareRepository?.provider ?? 'github',
				owner: softwareRepository?.owner ?? null,
				name: softwareRepository?.name ?? project.slug,
				url: softwareRepository?.url ?? null,
				defaultBranch: softwareRepository?.defaultBranch ?? 'staging',
				ref: softwareRepository?.currentBranch ?? null,
				checkoutPath: metadata.siteRepository?.checkoutPath ?? siteCheckoutBase,
				volumePath: metadata.siteRepository?.volumePath ?? siteCheckoutBase,
				submoduleMountPath: softwareRepository?.submodulePath ?? workspaceLink?.softwareSubmodulePath ?? null,
			},
			projectRepository: workspaceLink?.parentUrl || metadata.projectRepository
				? {
					accessMode: 'filesystem',
					provider: metadata.projectRepository?.provider ?? 'github',
					owner: workspaceLink?.parentOwner ?? metadata.projectRepository?.owner ?? null,
					name: workspaceLink?.parentName ?? metadata.projectRepository?.name ?? null,
					url: workspaceLink?.parentUrl ?? metadata.projectRepository?.url ?? null,
					defaultBranch: workspaceLink?.parentBranch ?? metadata.projectRepository?.defaultBranch ?? 'staging',
					ref: metadata.projectRepository?.ref ?? null,
					checkoutPath: metadata.projectRepository?.checkoutPath ?? projectCheckoutBase,
					volumePath: metadata.projectRepository?.volumePath ?? projectCheckoutBase,
					siteSubmodulePath: workspaceLink?.softwareSubmodulePath ?? metadata.projectRepository?.siteSubmodulePath ?? null,
				}
				: null,
		};
	}

	async buildCapacityProviderPortfolio(principal) {
		await this.ensureInitialized();
		const team = await this.getTeam(principal.teamId);
		if (!team) return null;
		const projects = await this.listTeamProjects(principal.teamId);
		const manifestProjects = [];
		for (const project of projects) {
			const metadata = project.metadata ?? {};
			const repositories = await this.listHubRepositories(project.id);
			const topology = await this.getProjectRepositoryTopology(project.id).catch(() => null);
			const canonicalRepository = repositories.find((entry) => ['software', 'primary', 'package'].includes(entry.role))
				?? repositories[0]
				?? null;
			const repository = metadata.repository && typeof metadata.repository === 'object'
				? metadata.repository
				: {};
			const policy = await this.getProjectWorkPolicy(project.id, metadata.environment ?? 'staging');
			manifestProjects.push({
				id: project.id,
				slug: project.slug,
				name: project.name,
				repository: {
					provider: String(canonicalRepository?.provider ?? repository.provider ?? 'github'),
					role: canonicalRepository?.role ?? repository.role ?? null,
					owner: String(canonicalRepository?.owner ?? repository.owner ?? metadata.repositoryOwner ?? team.slug ?? 'treeseed'),
					name: String(canonicalRepository?.name ?? repository.name ?? metadata.repositoryName ?? project.slug),
					defaultBranch: String(canonicalRepository?.defaultBranch ?? repository.defaultBranch ?? metadata.defaultBranch ?? 'staging'),
					cloneUrl: String(canonicalRepository?.url ?? repository.cloneUrl ?? metadata.cloneUrl ?? metadata.repositoryUrl ?? `git@github.com:${team.slug}/${project.slug}.git`),
					currentBranch: canonicalRepository?.currentBranch ?? repository.currentBranch ?? null,
					checkoutPath: repository.checkoutPath ?? metadata.checkoutPath ?? null,
					submodulePath: canonicalRepository?.submodulePath ?? repository.submodulePath ?? metadata.submodulePath ?? null,
					webUrl: canonicalRepository?.metadata?.webUrl ?? repository.webUrl ?? null,
				},
				...(topology ? { repositoryTopology: topology } : {}),
				agentSpecs: {
					root: String(metadata.agentSpecs?.root ?? 'src/content/agents'),
					testsRoot: String(metadata.agentSpecs?.testsRoot ?? 'src/content/agent-tests'),
				},
				workPolicy: policy
					? {
						enabled: policy.enabled,
						startCron: policy.startCron,
						durationMinutes: policy.durationMinutes,
						dailyCreditBudget: policy.dailyCreditBudget,
						maxRunners: policy.maxRunners,
						maxWorkersPerRunner: policy.maxWorkersPerRunner,
					}
					: {
						enabled: true,
						startCron: '0 9 * * 1-5',
						durationMinutes: 480,
						dailyCreditBudget: 0,
						maxRunners: 1,
						maxWorkersPerRunner: 4,
					},
				metadata: {
					environment: metadata.environment ?? 'staging',
				},
			});
		}
		return {
			team: {
				id: team.id,
				slug: team.slug,
				name: team.name,
			},
			projects: manifestProjects,
		};
	}

	async upsertCapacityProviderHost(teamId, providerId, input) {
		await this.ensureInitialized();
		if (!(await this.getCapacityProvider(teamId, providerId))) return null;
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT OR REPLACE INTO capacity_provider_hosts (
				id, capacity_provider_id, host_id, role, required, metadata_json, created_at, updated_at
			) VALUES (
				?, ?, ?, ?, ?, ?,
				COALESCE((SELECT created_at FROM capacity_provider_hosts WHERE id = ?), ?),
				?
			)`,
			[
				id,
				providerId,
				String(input.hostId),
				String(input.role),
				input.required === false ? 0 : 1,
				JSON.stringify(input.metadata ?? {}),
				id,
				timestamp,
				timestamp,
			],
		);
		return serializeCapacityProviderHost(await this.first(`SELECT * FROM capacity_provider_hosts WHERE id = ? LIMIT 1`, [id]));
	}

	async listCapacityProviderHosts(teamId, providerId) {
		await this.ensureInitialized();
		if (!(await this.getCapacityProvider(teamId, providerId))) return [];
		const rows = await this.all(
			`SELECT * FROM capacity_provider_hosts WHERE capacity_provider_id = ? ORDER BY created_at ASC`,
			[providerId],
		);
		return rows.map(serializeCapacityProviderHost);
	}

	async listCapacityProviderLanes(teamId, providerId) {
		await this.ensureInitialized();
		if (!(await this.getCapacityProvider(teamId, providerId))) return [];
		const rows = await this.all(
			`SELECT * FROM capacity_provider_lanes WHERE capacity_provider_id = ? ORDER BY created_at ASC`,
			[providerId],
		);
		return rows.map(serializeCapacityProviderLane);
	}

	async upsertCapacityProviderLane(teamId, providerId, input) {
		await this.ensureInitialized();
		if (!(await this.getCapacityProvider(teamId, providerId))) return null;
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		const existing = await this.first(`SELECT * FROM capacity_provider_lanes WHERE id = ? LIMIT 1`, [id]);
		await this.run(
			`INSERT OR REPLACE INTO capacity_provider_lanes (
				id, capacity_provider_id, name, business_model, model_family, model_class, region_policy, unit,
				scarcity_level, hard_limits_json, routing_policy_json, metadata_json, created_at, updated_at
			) VALUES (
				?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
				COALESCE((SELECT created_at FROM capacity_provider_lanes WHERE id = ?), ?),
				?
			)`,
			[
				id,
				providerId,
				String(input.name ?? existing?.name ?? '').trim(),
				String(input.businessModel ?? existing?.business_model ?? 'custom'),
				input.modelFamily ?? existing?.model_family ?? null,
				input.modelClass ?? existing?.model_class ?? null,
				input.regionPolicy ?? existing?.region_policy ?? null,
				String(input.unit ?? existing?.unit ?? 'treeseed_credit'),
				String(input.scarcityLevel ?? existing?.scarcity_level ?? 'medium'),
				JSON.stringify(input.hardLimits ?? parseJson(existing?.hard_limits_json, {})),
				JSON.stringify(input.routingPolicy ?? parseJson(existing?.routing_policy_json, {})),
				JSON.stringify(input.metadata ?? parseJson(existing?.metadata_json, {})),
				id,
				timestamp,
				timestamp,
			],
		);
		return serializeCapacityProviderLane(await this.first(`SELECT * FROM capacity_provider_lanes WHERE id = ? LIMIT 1`, [id]));
	}

	async listCapacityGrants(teamId, filters = {}) {
		await this.ensureInitialized();
		const clauses = ['team_id = ?'];
		const values = [teamId];
		if (filters.projectId) {
			clauses.push('(project_id = ? OR project_id IS NULL)');
			values.push(filters.projectId);
		}
		if (filters.providerId) {
			clauses.push('capacity_provider_id = ?');
			values.push(filters.providerId);
		}
		const rows = await this.all(
			`SELECT * FROM capacity_grants WHERE ${clauses.join(' AND ')} ORDER BY created_at ASC`,
			values,
		);
		return rows.map(serializeCapacityGrant);
	}

	async getTeamPortfolioAllocation(teamId) {
		await this.ensureInitialized();
		const [projects, providers, grants] = await Promise.all([
			this.listTeamProjects(teamId),
			this.listTeamCapacityProviders(teamId),
			this.listCapacityGrants(teamId),
		]);
		const projectGrants = grants.filter((grant) => grant.grantScope === 'project' && grant.projectId);
		const slices = normalizeAllocationSlices(projects.map((project, index) => {
			const grant = projectGrants.find((entry) => entry.projectId === project.id);
			const even = projects.length > 0 ? 100 / projects.length : 100;
			return {
				id: project.id,
				name: project.name ?? project.slug,
				percentage: grant?.portfolioAllocationPercent ?? even,
			};
		}));
		return {
			teamId,
			providers,
			projects,
			grants,
			slices,
		};
	}

	async updateTeamPortfolioAllocation(teamId, input = {}) {
		await this.ensureInitialized();
		const providerId = stringValue(input.capacityProviderId, '');
		if (!providerId) throw new Error('capacityProviderId is required.');
		const provider = await this.getCapacityProvider(teamId, providerId);
		if (!provider) throw new Error('Unknown capacity provider.');
		const projects = await this.listTeamProjects(teamId);
		const byId = new Map(projects.map((project) => [project.id, project]));
		const slices = normalizeAllocationSlices(input.allocations ?? input.slices);
		const total = Math.round(slices.reduce((sum, slice) => sum + slice.percentage, 0) * 100) / 100;
		if (slices.length === 0) throw new Error('At least one allocation slice is required.');
		if (Math.abs(total - 100) > 0.01) throw new Error('Portfolio allocation must total 100%.');
		const grants = [];
		for (const slice of slices) {
			if (!byId.has(slice.id)) throw new Error(`Unknown project allocation target "${slice.id}".`);
			grants.push(await this.upsertCapacityGrant(teamId, {
				id: `${providerId}:${slice.id}:portfolio-allocation`,
				capacityProviderId: providerId,
				grantScope: 'project',
				teamId,
				projectId: slice.id,
				environment: stringValue(input.environment, 'local'),
				state: 'active',
				priorityWeight: 1,
				overflowPolicy: 'approval_required',
				portfolioAllocationPercent: slice.percentage,
				metadata: {
					source: 'portfolio_allocation_ui',
					allocationName: slice.name,
					allocationTreeLevel: 'team_project',
				},
			}));
		}
		return {
			...await this.getTeamPortfolioAllocation(teamId),
			updatedGrants: grants,
		};
	}

	async upsertCapacityGrant(teamId, input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		const existing = await this.first(`SELECT * FROM capacity_grants WHERE id = ? LIMIT 1`, [id]);
		const metadata = {
			...parseJson(existing?.metadata_json, {}),
			...(input.metadata ?? {}),
		};
		for (const [inputKey, metadataKey] of [
			['portfolioAllocationPercent', 'portfolioAllocationPercent'],
			['allocationPercent', 'portfolioAllocationPercent'],
			['derivedAllocationPercent', 'portfolioAllocationPercent'],
			['reservePoolPercent', 'reservePoolPercent'],
			['minimumReservePercent', 'reservePoolPercent'],
			['maxDailyProjectCredits', 'maxDailyProjectCredits'],
		]) {
			const value = numberValue(input[inputKey], null);
			if (value !== null) metadata[metadataKey] = value;
		}
		if (input.emergencyOverride !== undefined || input.emergencyOverrideEnabled !== undefined) {
			metadata.emergencyOverride = input.emergencyOverride === true || input.emergencyOverrideEnabled === true;
		}
		await this.run(
			`INSERT OR REPLACE INTO capacity_grants (
				id, capacity_provider_id, lane_id, grant_scope, team_id, project_id, environment, state,
				daily_credit_limit, weekly_credit_limit, monthly_credit_limit, daily_usd_limit,
				weekly_quota_minutes, monthly_provider_units, priority_weight, overflow_policy,
				metadata_json, created_at, updated_at
			) VALUES (
				?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
				COALESCE((SELECT created_at FROM capacity_grants WHERE id = ?), ?),
				?
			)`,
			[
				id,
				input.capacityProviderId,
				input.laneId ?? null,
				input.grantScope ?? 'team',
				input.teamId ?? teamId,
				input.projectId ?? null,
				input.environment ?? null,
				input.state ?? 'active',
				input.dailyCreditLimit ?? null,
				input.weeklyCreditLimit ?? null,
				input.monthlyCreditLimit ?? null,
				input.dailyUsdLimit ?? null,
				input.weeklyQuotaMinutes ?? null,
				input.monthlyProviderUnits ?? null,
				Number(input.priorityWeight ?? 1),
				input.overflowPolicy ?? 'soft_grant',
				JSON.stringify(metadata),
				id,
				timestamp,
				timestamp,
			],
		);
		return serializeCapacityGrant(await this.first(`SELECT * FROM capacity_grants WHERE id = ? LIMIT 1`, [id]));
	}

	async launchManagedCapacityProvider(teamId, input = {}) {
		await this.ensureInitialized();
		const projects = await this.listTeamProjects(teamId);
		const providerId = input.providerId ?? `managed-capacity-${teamId}`;
		const existing = await this.getCapacityProvider(teamId, providerId);
		const provider = await this.upsertCapacityProvider(teamId, {
			id: providerId,
			teamId,
			ownerTeamId: teamId,
			name: input.name ?? existing?.name ?? 'TreeSeed-managed helper capacity',
			kind: 'treeseed_managed',
			status: input.status ?? 'active',
			provider: input.provider ?? 'treeseed-managed',
			billingScope: 'team',
			monthlyCreditBudget: Number(input.monthlyCreditBudget ?? 1000),
			dailyCreditBudget: Number(input.dailyCreditBudget ?? 50),
			creditBudgetMode: normalizeCreditBudgetMode(input.creditBudgetMode ?? input.credit_budget_mode, 'hybrid'),
			maxConcurrentWorkdays: Number(input.maxConcurrentWorkdays ?? 1),
			maxConcurrentWorkers: Number(input.maxConcurrentWorkers ?? 2),
			metadata: {
				...(existing?.metadata ?? {}),
				launchSource: input.launchSource ?? 'team_capacity_page',
				connectionMode: 'treeseed_managed',
				providerHostIds: Array.isArray(input.providerHostIds) ? input.providerHostIds : [],
				operationalWarnings: [],
				lastHealth: {
					ok: true,
					checkedAt: isoNow(),
					queueDepth: 0,
					activeWorkers: 0,
					draining: false,
				},
			},
		});
		const lanes = [];
		for (const lane of defaultCapacityLaneDefinitions(provider.id)) {
			lanes.push(await this.upsertCapacityProviderLane(teamId, provider.id, lane));
		}
		const teamGrant = await this.upsertCapacityGrant(teamId, {
			id: `${provider.id}:team-grant`,
			capacityProviderId: provider.id,
			grantScope: 'team',
			teamId,
			state: 'active',
			dailyCreditLimit: Number(input.dailyCreditLimit ?? 50),
			monthlyCreditLimit: Number(input.monthlyCreditLimit ?? 1000),
			priorityWeight: 1,
			overflowPolicy: 'approval_required',
			metadata: {
				activeWorkdayDaysPerMonth: 20,
				source: 'managed_capacity_launch',
			},
		});
		const projectGrants = [];
		for (const project of projects) {
			projectGrants.push(await this.upsertCapacityGrant(teamId, {
				id: `${provider.id}:${project.id}:staging-grant`,
				capacityProviderId: provider.id,
				grantScope: 'project',
				teamId,
				projectId: project.id,
				environment: 'staging',
				state: 'active',
				dailyCreditLimit: 25,
				monthlyCreditLimit: 500,
				priorityWeight: 2,
				overflowPolicy: 'approval_required',
				metadata: {
					source: 'managed_capacity_launch',
				},
			}));
			await this.upsertProjectWorkPolicy(project.id, {
				environment: 'staging',
				enabled: true,
				startCron: '0 9 * * 1-5',
				durationMinutes: 480,
				maxRunners: 1,
				maxWorkersPerRunner: 2,
				dailyCreditBudget: 25,
				closeoutGraceMinutes: 15,
				maxQueuedTasks: 10,
				maxQueuedCredits: 25,
				autoscale: { minWorkers: 0, maxWorkers: 1, targetQueueDepth: 1, cooldownSeconds: 60 },
				creditWeights: [],
				metadata: {
					budgetSource: 'team_grant',
					defaultCapacityGrantIds: [`${provider.id}:${project.id}:staging-grant`, `${provider.id}:team-grant`],
					allowedTaskKinds: [],
					requiresDecisionForBindingWork: true,
					requiresApprovalForProduction: true,
					inboxOnBudgetBlocked: true,
				},
			});
		}
		const activeKeys = await this.listCapacityProviderApiKeys(teamId, provider.id);
		const existingActiveKey = activeKeys.find((key) => key.status === 'active' && !key.revokedAt) ?? null;
		const keyResult = existingActiveKey
			? { key: existingActiveKey, plaintextKey: null }
			: await this.createCapacityProviderApiKey(teamId, provider.id, {
				name: 'Managed provider security code',
				scopes: PHASE4_CAPACITY_PROVIDER_SCOPES,
				createdById: input.createdById ?? null,
			});
		await this.upsertTeamInboxItem(teamId, {
			kind: 'capacity_connected',
			state: 'open',
			title: 'Helper capacity connected',
			summary: 'TreeSeed-managed helper capacity is connected and ready for approved project work.',
			href: '/app/capacity',
			itemKey: `capacity-connected:${provider.id}`,
			metadata: {
				providerId: provider.id,
			},
		});
		return {
			provider: await this.getCapacityProvider(teamId, provider.id),
			lanes,
			grants: [teamGrant, ...projectGrants],
			apiKey: keyResult?.key ?? null,
			plaintextKey: keyResult?.plaintextKey ?? null,
		};
	}

	async createCapacityReservation(input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO capacity_reservations (
				id, capacity_provider_id, execution_provider_id, lane_id, team_id, project_id, work_day_id, task_id, state,
				reserved_credits, consumed_credits, native_unit, reserved_native_amount, consumed_native_amount,
				reserved_provider_units, consumed_provider_units,
				reserved_usd, consumed_usd, expires_at, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?)`,
			[
				id,
				input.capacityProviderId,
				input.executionProviderId ?? null,
				input.laneId,
				input.teamId,
				input.projectId,
				input.workDayId ?? null,
				input.taskId ?? null,
				input.state ?? 'reserved',
				Number(input.reservedCredits ?? 0),
				input.nativeUnit ?? input.native_unit ?? null,
				input.reservedNativeAmount ?? input.reserved_native_amount ?? null,
				input.consumedNativeAmount ?? input.consumed_native_amount ?? null,
				input.reservedProviderUnits ?? null,
				input.reservedUsd ?? null,
				input.expiresAt ?? null,
				JSON.stringify(input.metadata ?? {}),
				timestamp,
				timestamp,
			],
		);
		return serializeCapacityReservation(await this.first(`SELECT * FROM capacity_reservations WHERE id = ? LIMIT 1`, [id]));
	}

	async listCapacityReservationsForProject(projectId, workDayId = null) {
		await this.ensureInitialized();
		const rows = workDayId
			? await this.all(
				`SELECT * FROM capacity_reservations WHERE project_id = ? AND work_day_id = ? ORDER BY created_at DESC`,
				[projectId, workDayId],
			)
			: await this.all(
				`SELECT * FROM capacity_reservations WHERE project_id = ? ORDER BY created_at DESC`,
				[projectId],
			);
		return rows.map(serializeCapacityReservation);
	}

	async listCapacityRoutingDecisionsForProject(projectId, limit = 50) {
		await this.ensureInitialized();
		const rows = await this.all(
			`SELECT * FROM capacity_routing_decisions
			 WHERE project_id = ?
			 ORDER BY created_at DESC LIMIT ?`,
			[projectId, Math.max(1, Math.min(200, Number(limit) || 50))],
		);
		return rows.map(serializeCapacityRoutingDecision);
	}

	async recordCapacityUsage(input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		const phase = input.phase ?? 'consume';
		await this.run(
			`INSERT INTO capacity_ledger_entries (
				id, capacity_provider_id, lane_id, reservation_id, team_id, project_id, work_day_id, task_id,
				phase, credits, provider_units, usd, source, metadata_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				input.capacityProviderId,
				input.laneId ?? null,
				input.reservationId ?? null,
				input.teamId,
				input.projectId ?? null,
				input.workDayId ?? null,
				input.taskId ?? null,
				phase,
				Number(input.credits ?? 0),
				input.providerUnits ?? null,
				input.usd ?? null,
				input.source ?? 'runner',
				JSON.stringify(input.metadata ?? {}),
				timestamp,
			],
		);
		if (input.reservationId && phase === 'task_started') {
			await this.run(
				`UPDATE capacity_reservations
				 SET state = 'consuming', updated_at = ?
				 WHERE id = ? AND state = 'reserved'`,
				[timestamp, input.reservationId],
			);
		}
		if (input.reservationId && ['consume', 'task_completed_actual_settlement'].includes(phase)) {
			await this.run(
				`UPDATE capacity_reservations
				 SET consumed_credits = MAX(consumed_credits, ?),
				     native_unit = CASE WHEN ? IS NULL THEN native_unit ELSE ? END,
				     consumed_native_amount = CASE WHEN ? IS NULL THEN consumed_native_amount ELSE ? END,
				     consumed_provider_units = CASE WHEN ? IS NULL THEN consumed_provider_units ELSE ? END,
				     consumed_usd = CASE WHEN ? IS NULL THEN consumed_usd ELSE ? END,
				     state = CASE WHEN ? >= reserved_credits THEN 'consumed' ELSE state END,
				     updated_at = ?
				 WHERE id = ?`,
				[
					Number(input.credits ?? 0),
					input.nativeUnit ?? null,
					input.nativeUnit ?? null,
					input.nativeAmount ?? null,
					input.nativeAmount ?? null,
					input.providerUnits ?? null,
					input.providerUnits ?? null,
					input.usd ?? null,
					input.usd ?? null,
					Number(input.credits ?? 0),
					timestamp,
					input.reservationId,
				],
			);
		}
		if (input.reservationId && phase === 'reservation_released') {
			await this.run(
				`UPDATE capacity_reservations
				 SET state = CASE WHEN consumed_credits > 0 THEN 'consumed' ELSE 'released' END,
				     updated_at = ?
				 WHERE id = ?`,
				[timestamp, input.reservationId],
			);
		}
		if (input.reservationId && phase === 'task_failed_refund') {
			await this.run(
				`UPDATE capacity_reservations
				 SET state = 'failed',
				     updated_at = ?
				 WHERE id = ?`,
				[timestamp, input.reservationId],
			);
		}
		if (input.reservationId && phase === 'overrun_hold') {
			await this.run(
				`UPDATE capacity_reservations
				 SET state = 'overran_pending_approval',
				     updated_at = ?
				 WHERE id = ?`,
				[timestamp, input.reservationId],
			);
		}
		return serializeCapacityLedgerEntry(await this.first(`SELECT * FROM capacity_ledger_entries WHERE id = ? LIMIT 1`, [id]));
	}

	async listCapacityLedgerEntries(projectId, workDayId = null) {
		await this.ensureInitialized();
		const rows = workDayId
			? await this.all(
				`SELECT * FROM capacity_ledger_entries WHERE project_id = ? AND work_day_id = ? ORDER BY created_at ASC`,
				[projectId, workDayId],
			)
			: await this.all(
				`SELECT * FROM capacity_ledger_entries WHERE project_id = ? ORDER BY created_at DESC LIMIT 200`,
				[projectId],
			);
		return rows.map(serializeCapacityLedgerEntry);
	}

	async createCapacityRoutingDecision(input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO capacity_routing_decisions (
				id, task_id, work_day_id, project_id, selected_provider_id, selected_lane_id, selected_model,
				decision, reason, candidate_json, score_json, metadata_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				input.taskId ?? null,
				input.workDayId ?? null,
				input.projectId,
				input.selectedProviderId,
				input.selectedLaneId,
				input.selectedModel ?? null,
				input.decision ?? 'selected',
				input.reason,
				JSON.stringify(input.candidates ?? []),
				JSON.stringify(input.scores ?? {}),
				JSON.stringify(input.metadata ?? {}),
				timestamp,
			],
		);
		return serializeCapacityRoutingDecision(await this.first(`SELECT * FROM capacity_routing_decisions WHERE id = ? LIMIT 1`, [id]));
	}

	async createTaskEstimate(input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO task_estimates (
				id, task_id, work_day_id, project_id, estimate_phase, task_signature, execution_profile_id, confidence,
				estimated_credits_p50, estimated_credits_p90, reserved_credits,
				estimated_input_tokens_p50, estimated_input_tokens_p90, estimated_output_tokens_p50,
				estimated_output_tokens_p90, estimated_quota_minutes_p50, estimated_quota_minutes_p90,
				features_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				input.taskId ?? null,
				input.workDayId ?? null,
				input.projectId,
				input.estimatePhase,
				input.taskSignature,
				executionProfileId(input.executionProfileId),
				input.confidence,
				Number(input.estimatedCreditsP50 ?? 0),
				Number(input.estimatedCreditsP90 ?? 0),
				Number(input.reservedCredits ?? input.estimatedCreditsP90 ?? input.estimatedCreditsP50 ?? 0),
				input.estimatedInputTokensP50 ?? null,
				input.estimatedInputTokensP90 ?? null,
				input.estimatedOutputTokensP50 ?? null,
				input.estimatedOutputTokensP90 ?? null,
				input.estimatedQuotaMinutesP50 ?? null,
				input.estimatedQuotaMinutesP90 ?? null,
				JSON.stringify(input.features ?? {}),
				timestamp,
			],
		);
		return serializeTaskEstimate(await this.first(`SELECT * FROM task_estimates WHERE id = ? LIMIT 1`, [id]));
	}

	async getExecutionProviderKind(executionProviderId) {
		if (!executionProviderId) return null;
		await this.ensureInitialized();
		const row = await this.first(`SELECT kind FROM execution_providers WHERE id = ? LIMIT 1`, [executionProviderId]);
		return typeof row?.kind === 'string' && row.kind ? row.kind : null;
	}

	async getCreditConversionProfile(taskSignature, profileId, executionProviderKind, nativeUnit) {
		if (!taskSignature || !executionProviderKind || !nativeUnit) return null;
		await this.ensureInitialized();
		return serializeCreditConversionProfile(await this.first(
			`SELECT * FROM credit_conversion_profiles
			 WHERE task_signature = ? AND execution_profile_id = ? AND execution_provider_kind = ? AND native_unit = ?
			 LIMIT 1`,
			[taskSignature, executionProfileId(profileId), executionProviderKind, nativeUnit],
		));
	}

	async upsertCreditConversionProfileFromActuals(input) {
		await this.ensureInitialized();
		if (!input?.taskSignature || !input?.executionProviderKind || !input?.nativeUnit) return null;
		const profileId = executionProfileId(input.executionProfileId);
		const timestamp = isoNow();
		const actuals = (await this.all(
			`SELECT a.*
			 FROM task_usage_actuals a
			 JOIN execution_providers ep ON ep.id = a.execution_provider_id
			 WHERE a.task_signature = ?
			   AND COALESCE(a.execution_profile_id, ?) = ?
			   AND ep.kind = ?
			 ORDER BY a.created_at DESC LIMIT 200`,
			[input.taskSignature, defaultExecutionProfileId, profileId, input.executionProviderKind],
		)).map(serializeTaskUsageActual);
		const existing = await this.getCreditConversionProfile(input.taskSignature, profileId, input.executionProviderKind, input.nativeUnit);
		const profile = buildCreditConversionProfileFromActuals({
			id: existing?.id ?? `${input.taskSignature}:${profileId}:${input.executionProviderKind}:${input.nativeUnit}`,
			taskSignature: input.taskSignature,
			executionProfileId: profileId,
			executionProviderKind: input.executionProviderKind,
			nativeUnit: input.nativeUnit,
			actuals,
			formulaVersion: input.formulaVersion,
			now: timestamp,
		});
		await this.run(
			`INSERT OR REPLACE INTO credit_conversion_profiles (
				id, task_signature, execution_profile_id, execution_provider_kind, native_unit,
				sample_count, completed_sample_count, interrupted_sample_count,
				native_units_per_credit_p50, native_units_per_credit_p90,
				credits_per_native_unit_p50, credits_per_native_unit_p90,
				actual_credits_p50, actual_credits_p90, confidence, formula_version,
				metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				profile.id,
				profile.taskSignature,
				profile.executionProfileId,
				profile.executionProviderKind,
				profile.nativeUnit,
				profile.sampleCount,
				profile.completedSampleCount,
				profile.interruptedSampleCount ?? 0,
				profile.nativeUnitsPerCreditP50,
				profile.nativeUnitsPerCreditP90,
				profile.creditsPerNativeUnitP50,
				profile.creditsPerNativeUnitP90,
				profile.actualCreditsP50,
				profile.actualCreditsP90,
				profile.confidence,
				profile.formulaVersion,
				JSON.stringify(profile.metadata ?? {}),
				existing?.createdAt ?? timestamp,
				profile.updatedAt,
			],
		);
		return await this.getCreditConversionProfile(input.taskSignature, profileId, input.executionProviderKind, input.nativeUnit);
	}

	async listCreditConversionProfiles(limit = 100) {
		await this.ensureInitialized();
		const rows = await this.all(
			`SELECT * FROM credit_conversion_profiles ORDER BY updated_at DESC LIMIT ?`,
			[Math.max(1, Math.min(500, Number(limit) || 100))],
		);
		return rows.map(serializeCreditConversionProfile);
	}

	async getBestCreditConversionProfile(executionProviderKind, nativeUnit) {
		if (!executionProviderKind || !nativeUnit) return null;
		await this.ensureInitialized();
		return serializeCreditConversionProfile(await this.first(
			`SELECT * FROM credit_conversion_profiles
			 WHERE execution_provider_kind = ? AND native_unit = ?
			 ORDER BY CASE confidence WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
			          completed_sample_count DESC, sample_count DESC, updated_at DESC
			 LIMIT 1`,
			[executionProviderKind, nativeUnit],
		));
	}

	summarizeDerivedCapacity(entries = []) {
		const availableNativeByUnit = {};
		let totalDerivedAvailableCredits = 0;
		let derivedEntryCount = 0;
		let learningEntryCount = 0;
		for (const entry of entries) {
			if (!entry) continue;
			availableNativeByUnit[entry.nativeUnit] = (availableNativeByUnit[entry.nativeUnit] ?? 0) + Number(entry.availableNativeAmount ?? 0);
			if (entry.derivedAvailableCredits == null) {
				learningEntryCount += 1;
			} else {
				totalDerivedAvailableCredits += Number(entry.derivedAvailableCredits ?? 0);
				derivedEntryCount += 1;
			}
		}
		return {
			entries,
			totalDerivedAvailableCredits: Math.floor(totalDerivedAvailableCredits * 100) / 100,
			derivedEntryCount,
			learningEntryCount,
			availableNativeByUnit,
		};
	}

	async getCapacityProviderDerivedCapacity(teamId, providerId, options = {}) {
		await this.ensureInitialized();
		const executionProviders = Array.isArray(options.executionProviders)
			? options.executionProviders
			: await this.listExecutionProviders(teamId, providerId);
		const activeReservations = Array.isArray(options.activeReservations)
			? options.activeReservations
			: (await this.all(
				`SELECT * FROM capacity_reservations
				 WHERE team_id = ? AND capacity_provider_id = ?
				   AND state IN ('reserved', 'consuming', 'consumed', 'failed', 'overran_pending_approval')
				 ORDER BY created_at DESC`,
				[teamId, providerId],
			)).map(serializeCapacityReservation);
		const entries = [];
		for (const executionProvider of executionProviders) {
			const limits = Array.isArray(executionProvider.nativeLimits) && executionProvider.nativeLimits.length > 0
				? executionProvider.nativeLimits
				: [{ nativeUnit: executionProvider.nativeUnit, scope: null, limitAmount: null, reserveBufferPercent: 0 }];
			for (const limit of limits) {
				const nativeUnit = limit?.nativeUnit ?? executionProvider.nativeUnit;
				const conversionProfile = await this.getBestCreditConversionProfile(executionProvider.kind, nativeUnit);
				entries.push(deriveAvailableCredits({
					executionProvider,
					nativeLimit: limit,
					latestObservation: executionProvider.latestObservation ?? null,
					activeReservations,
					conversionProfile,
					scope: limit?.scope ?? null,
					nativeUnit,
				}));
			}
		}
		return this.summarizeDerivedCapacity(entries);
	}

	async getTeamDerivedCapacity(teamId, options = {}) {
		await this.ensureInitialized();
		const providers = Array.isArray(options.providers) ? options.providers : await this.listTeamCapacityProviders(teamId);
		const activeReservations = Array.isArray(options.activeReservations)
			? options.activeReservations
			: (await this.all(
				`SELECT * FROM capacity_reservations
				 WHERE team_id = ? AND state IN ('reserved', 'consuming', 'consumed', 'failed', 'overran_pending_approval')
				 ORDER BY created_at DESC`,
				[teamId],
			)).map(serializeCapacityReservation);
		const providerSummaries = [];
		for (const provider of providers) {
			providerSummaries.push({
				capacityProviderId: provider.id,
				...(await this.getCapacityProviderDerivedCapacity(teamId, provider.id, {
					activeReservations: activeReservations.filter((reservation) => reservation.capacityProviderId === provider.id),
				})),
			});
		}
		const entries = providerSummaries.flatMap((summary) => summary.entries ?? []);
		return {
			...this.summarizeDerivedCapacity(entries),
			providers: providerSummaries,
		};
	}

	async createTaskUsageActual(input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		const profileId = executionProfileId(input.executionProfileId);
		const profileNativeUnit = nativeUsageUnit(input.nativeUsage) ?? nativeUsageUnit(input);
		const executionProviderKind = input.executionProviderKind
			?? await this.getExecutionProviderKind(input.executionProviderId);
		const conversionProfile = profileNativeUnit && executionProviderKind
			? await this.getCreditConversionProfile(input.taskSignature, profileId, executionProviderKind, profileNativeUnit)
			: null;
		const creditCalculation = calculateActualCredits({
			nativeUsage: input.nativeUsage,
			conversionProfile,
			legacyActualCredits: input.actualCredits,
			actualCreditsOverride: input.actualCreditsOverride === true,
			reservedCredits: input.reservedCredits,
			actualUsd: input.actualUsd,
			inputTokens: input.inputTokens,
			outputTokens: input.outputTokens,
			cachedInputTokens: input.cachedInputTokens,
			quotaMinutes: input.quotaMinutes,
			wallMinutes: input.wallMinutes,
			filesOpened: input.filesOpened,
			filesChanged: input.filesChanged,
			diffLinesAdded: input.diffLinesAdded,
			diffLinesRemoved: input.diffLinesRemoved,
			testRuns: input.testRuns,
			retryCount: input.retryCount,
			source: input.source,
		});
		const metadata = {
			...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
			actualCreditCalculation: {
				formulaVersion: creditCalculation.formulaVersion,
				source: creditCalculation.source,
				components: creditCalculation.components,
				conversionProfileId: creditCalculation.conversionProfileId ?? null,
				conversionConfidence: creditCalculation.conversionConfidence ?? null,
			},
		};
		if (creditCalculation.partial) metadata.partial = true;
		if (creditCalculation.interrupted) metadata.interrupted = true;
		await this.run(
			`INSERT INTO task_usage_actuals (
				id, task_id, work_day_id, project_id, task_signature, execution_profile_id, capacity_provider_id, execution_provider_id, lane_id,
				business_model, model_name, input_tokens, output_tokens, cached_input_tokens, quota_minutes,
				wall_minutes, files_opened, files_changed, diff_lines_added, diff_lines_removed,
				test_runs, retry_count, actual_credits, actual_usd, credit_formula_version, actual_credit_source,
				native_usage_json, metadata_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				input.taskId ?? null,
				input.workDayId ?? null,
				input.projectId,
				input.taskSignature,
				profileId,
				input.capacityProviderId ?? null,
				input.executionProviderId ?? null,
				input.laneId ?? null,
				input.businessModel ?? 'credit',
				input.modelName ?? null,
				input.inputTokens ?? null,
				input.outputTokens ?? null,
				input.cachedInputTokens ?? null,
				input.quotaMinutes ?? null,
				input.wallMinutes ?? null,
				input.filesOpened ?? null,
				input.filesChanged ?? null,
				input.diffLinesAdded ?? null,
				input.diffLinesRemoved ?? null,
				input.testRuns ?? null,
				input.retryCount ?? null,
				creditCalculation.actualCredits,
				input.actualUsd ?? null,
				input.creditFormulaVersion ?? creditCalculation.formulaVersion,
				input.actualCreditSource ?? creditCalculation.source,
				JSON.stringify(creditCalculation.nativeUsage ?? {}),
				JSON.stringify(metadata),
				timestamp,
			],
		);
		const nativeUsageInput = objectValue(input.nativeUsage);
		const hasNativeObservation = Object.keys(nativeUsageInput).length > 0
			|| Object.keys(creditCalculation.components).length > 0;
		if (hasNativeObservation) {
			await this.run(
				`INSERT INTO native_usage_observations (
					id, task_usage_actual_id, task_id, work_day_id, project_id, task_signature, execution_profile_id,
					capacity_provider_id, execution_provider_id, native_unit, native_usage_json, observed_at, source,
					formula_version, actual_credits, metadata_json, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					randomUUID(),
					id,
					input.taskId ?? null,
					input.workDayId ?? null,
					input.projectId,
					input.taskSignature,
					profileId,
					input.capacityProviderId ?? null,
					input.executionProviderId ?? null,
					creditCalculation.nativeUsage?.nativeUnit ?? null,
					JSON.stringify(creditCalculation.nativeUsage ?? {}),
					creditCalculation.nativeUsage?.observedAt ?? timestamp,
					creditCalculation.nativeUsage?.source ?? input.source ?? 'provider_report',
					input.creditFormulaVersion ?? creditCalculation.formulaVersion,
					creditCalculation.actualCredits,
					JSON.stringify(metadata),
					timestamp,
				],
			);
		}
		await this.upsertTaskEstimateProfileFromActual(input.taskSignature, profileId);
		const learnedNativeUnit = creditCalculation.nativeUsage?.nativeUnit ?? profileNativeUnit;
		if (executionProviderKind && learnedNativeUnit) {
			await this.upsertCreditConversionProfileFromActuals({
				taskSignature: input.taskSignature,
				executionProfileId: profileId,
				executionProviderKind,
				nativeUnit: learnedNativeUnit,
				formulaVersion: input.creditFormulaVersion ?? creditCalculation.formulaVersion,
			});
		}
		return serializeTaskUsageActual(await this.first(`SELECT * FROM task_usage_actuals WHERE id = ? LIMIT 1`, [id]));
	}

	async upsertTaskEstimateProfileFromActual(taskSignature, profileId = defaultExecutionProfileId) {
		const timestamp = isoNow();
		const actuals = (await this.all(
			`SELECT * FROM task_usage_actuals
			 WHERE task_signature = ? AND COALESCE(execution_profile_id, ?) = ?
			 ORDER BY created_at DESC LIMIT 200`,
			[taskSignature, defaultExecutionProfileId, executionProfileId(profileId)],
		)).map(serializeTaskUsageActual);
		const completed = actuals.filter((actual) => !interruptedActual(actual));
		const interrupted = actuals.filter(interruptedActual);
		const creditsP50 = percentile(completed.map((actual) => actual.actualCredits), 50);
		const creditsP90 = percentile(completed.map((actual) => actual.actualCredits), 90);
		const creditsVariance = variance(completed.map((actual) => actual.actualCredits));
		const outlierLimit = creditsP90 == null ? null : Math.max(creditsP90 * 1.5, (creditsP50 ?? creditsP90) + Math.sqrt(creditsVariance));
		const sampleDates = actuals.map((actual) => actual.createdAt).filter(Boolean).sort();
		const partialCredits = interrupted.reduce((total, actual) => total + Number(actual.actualCredits ?? 0), 0);
		await this.run(
			`INSERT OR REPLACE INTO task_estimate_profiles (
				task_signature, execution_profile_id, sample_count, completed_sample_count, interrupted_sample_count,
				input_tokens_p50, input_tokens_p90, output_tokens_p50, output_tokens_p90,
				quota_minutes_p50, quota_minutes_p90, files_changed_p50, files_changed_p90,
				credits_p50, credits_p90, credits_variance, confidence_score, outlier_count, partial_credits,
				first_sample_at, last_sample_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				taskSignature,
				executionProfileId(profileId),
				actuals.length,
				completed.length,
				interrupted.length,
				percentile(completed.map((actual) => actual.inputTokens), 50),
				percentile(completed.map((actual) => actual.inputTokens), 90),
				percentile(completed.map((actual) => actual.outputTokens), 50),
				percentile(completed.map((actual) => actual.outputTokens), 90),
				percentile(completed.map((actual) => actual.quotaMinutes), 50),
				percentile(completed.map((actual) => actual.quotaMinutes), 90),
				percentile(completed.map((actual) => actual.filesChanged), 50),
				percentile(completed.map((actual) => actual.filesChanged), 90),
				creditsP50,
				creditsP90,
				creditsVariance,
				confidenceScore({
					sampleCount: completed.length,
					creditsVariance,
					creditsP50,
					lastSampleAt: sampleDates.at(-1) ?? null,
				}),
				outlierLimit == null ? 0 : completed.filter((actual) => Number(actual.actualCredits ?? 0) > outlierLimit).length,
				partialCredits || null,
				sampleDates[0] ?? null,
				sampleDates.at(-1) ?? null,
				timestamp,
			],
		);
		return serializeTaskEstimateProfile(await this.first(
			`SELECT * FROM task_estimate_profiles WHERE task_signature = ? AND execution_profile_id = ? LIMIT 1`,
			[taskSignature, executionProfileId(profileId)],
		));
	}

	async listTaskEstimateProfiles(limit = 100) {
		await this.ensureInitialized();
		const rows = await this.all(
			`SELECT * FROM task_estimate_profiles ORDER BY updated_at DESC LIMIT ?`,
			[Math.max(1, Math.min(500, Number(limit) || 100))],
		);
		return rows.map(serializeTaskEstimateProfile);
	}

	async listTaskUsageActualsForProject(projectId, limit = 50) {
		await this.ensureInitialized();
		const rows = await this.all(
			`SELECT * FROM task_usage_actuals
			 WHERE project_id = ?
			 ORDER BY created_at DESC LIMIT ?`,
			[projectId, Math.max(1, Math.min(200, Number(limit) || 50))],
		);
		return rows.map(serializeTaskUsageActual);
	}

	async createApprovalRequest(input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO approval_requests (
				id, team_id, project_id, work_day_id, task_id, kind, state, severity, requested_by_type,
				requested_by_id, title, summary, options_json, recommendation_json, policy_snapshot_json,
				expires_at, decision_json, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
			[
				id,
				input.teamId,
				input.projectId,
				input.workDayId ?? null,
				input.taskId ?? null,
				input.kind,
				input.severity ?? 'medium',
				input.requestedByType ?? 'worker',
				input.requestedById ?? null,
				input.title,
				input.summary,
				JSON.stringify(input.options ?? []),
				JSON.stringify(input.recommendation ?? {}),
				JSON.stringify(input.policySnapshot ?? {}),
				input.expiresAt ?? null,
				JSON.stringify(input.metadata ?? {}),
				timestamp,
				timestamp,
			],
		);
		return serializeApprovalRequest(await this.first(`SELECT * FROM approval_requests WHERE id = ? LIMIT 1`, [id]));
	}

	async getApprovalRequest(id) {
		await this.ensureInitialized();
		return serializeApprovalRequest(await this.first(`SELECT * FROM approval_requests WHERE id = ? LIMIT 1`, [id]));
	}

	async listApprovalRequestsForProject(projectId, limit = 50) {
		await this.ensureInitialized();
		const rows = await this.all(
			`SELECT * FROM approval_requests
			 WHERE project_id = ?
			 ORDER BY created_at DESC LIMIT ?`,
			[projectId, Math.max(1, Math.min(200, Number(limit) || 50))],
		);
		return rows.map(serializeApprovalRequest);
	}

	async listApprovalRequestsForTeam(teamId, options = {}) {
		await this.ensureInitialized();
		const limit = Math.max(1, Math.min(200, Number(options.limit) || 50));
		const kind = typeof options.kind === 'string' && options.kind.trim() ? options.kind.trim() : null;
		const rows = kind
			? await this.all(
				`SELECT * FROM approval_requests
				 WHERE team_id = ? AND kind = ?
				 ORDER BY created_at DESC LIMIT ?`,
				[teamId, kind, limit],
			)
			: await this.all(
				`SELECT * FROM approval_requests
				 WHERE team_id = ?
				 ORDER BY created_at DESC LIMIT ?`,
				[teamId, limit],
			);
		return rows.map(serializeApprovalRequest);
	}

	async decideApprovalRequest(id, input) {
		await this.ensureInitialized();
		const existing = await this.getApprovalRequest(id);
		if (!existing) return null;
		const timestamp = isoNow();
		const state = input.state === 'rejected' ? 'rejected' : input.state === 'expired' ? 'expired' : 'approved';
		await this.run(
			`UPDATE approval_requests
			 SET state = ?, decided_by_type = ?, decided_by_id = ?, decided_at = ?, decision_json = ?, updated_at = ?
			 WHERE id = ?`,
			[
				state,
				input.decidedByType ?? 'user',
				input.decidedById ?? null,
				timestamp,
				JSON.stringify(input.decision ?? {}),
				timestamp,
				id,
			],
		);
		return this.getApprovalRequest(id);
	}

	async createSeedRun(input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO seed_runs (
				id, seed_name, seed_version, environments_json, mode, state, actor_type, actor_id,
				manifest_hash, plan_json, result_json, error_json, created_at, updated_at, completed_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				input.seedName,
				Number(input.seedVersion ?? input.version ?? 1),
				JSON.stringify(input.environments ?? []),
				input.mode ?? 'plan',
				input.state ?? 'running',
				input.actorType ?? null,
				input.actorId ?? null,
				input.manifestHash ?? '',
				JSON.stringify(input.plan ?? null),
				input.result === undefined ? null : JSON.stringify(input.result),
				input.error === undefined ? null : JSON.stringify(input.error),
				timestamp,
				timestamp,
				input.completedAt ?? null,
			],
		);
		return this.getSeedRun(id);
	}

	async updateSeedRun(id, input) {
		await this.ensureInitialized();
		const existing = await this.getSeedRun(id);
		if (!existing) return null;
		const timestamp = isoNow();
		await this.run(
			`UPDATE seed_runs
			 SET state = ?, result_json = ?, error_json = ?, updated_at = ?, completed_at = ?
			 WHERE id = ?`,
			[
				input.state ?? existing.state,
				input.result === undefined ? JSON.stringify(existing.result ?? null) : JSON.stringify(input.result),
				input.error === undefined ? JSON.stringify(existing.error ?? null) : JSON.stringify(input.error),
				timestamp,
				input.completedAt ?? (['completed', 'failed', 'blocked', 'partial'].includes(input.state) ? timestamp : existing.completedAt),
				id,
			],
		);
		return this.getSeedRun(id);
	}

	async getSeedRun(id) {
		await this.ensureInitialized();
		return serializeSeedRun(await this.first(`SELECT * FROM seed_runs WHERE id = ? LIMIT 1`, [id]));
	}

	async listSeedRuns(limit = 50) {
		await this.ensureInitialized();
		const rows = await this.all(
			`SELECT * FROM seed_runs ORDER BY created_at DESC LIMIT ?`,
			[Math.max(1, Math.min(200, Number(limit) || 50))],
		);
		return rows.map(serializeSeedRun);
	}

	async getProjectCapacityPlan(projectId, environment = 'staging') {
		await this.ensureInitialized();
		const project = await this.getProject(projectId);
		if (!project) return null;
		const grants = await this.listCapacityGrants(project.teamId, { projectId });
		const providerIds = [...new Set(grants.map((grant) => grant.capacityProviderId))];
		const rawProviders = providerIds.length
			? (await this.all(
				`SELECT * FROM capacity_providers WHERE id IN (${providerIds.map(() => '?').join(',')}) ORDER BY created_at ASC`,
				providerIds,
			)).map(serializeCapacityProvider)
			: [];
		const rawLanes = providerIds.length
			? (await this.all(
				`SELECT * FROM capacity_provider_lanes WHERE capacity_provider_id IN (${providerIds.map(() => '?').join(',')}) ORDER BY created_at ASC`,
				providerIds,
			)).map(serializeCapacityProviderLane)
			: [];
		const activeReservations = (await this.listCapacityReservationsForProject(projectId))
			.filter((reservation) => ['reserved', 'consuming', 'consumed'].includes(reservation.state));
		const providers = rawProviders.map((provider) => ({
			...provider,
			metadata: {
				...(provider.metadata ?? {}),
				pressure: capacityPressure(provider, null, activeReservations),
			},
		}));
		const lanes = rawLanes.map((lane) => {
			const provider = rawProviders.find((entry) => entry.id === lane.capacityProviderId) ?? {};
			return {
				...lane,
				metadata: {
					...(lane.metadata ?? {}),
					pressure: capacityPressure(provider, lane, activeReservations),
				},
			};
		});
		const profiles = await this.listTaskEstimateProfiles(100);
		const dailyCredits = grants.reduce((total, grant) => total + Number(grant.dailyCreditLimit ?? 0), 0);
		const weeklyCredits = grants.reduce((total, grant) => total + Number(grant.weeklyCreditLimit ?? 0), 0);
		const monthlyCredits = grants.reduce((total, grant) => total + Number(grant.monthlyCreditLimit ?? 0), 0);
		const weeklyQuotaMinutes = grants.reduce((total, grant) => total + Number(grant.weeklyQuotaMinutes ?? 0), 0);
		const dailyUsd = grants.reduce((total, grant) => total + Number(grant.dailyUsdLimit ?? 0), 0);
		const reservedCredits = activeReservations
			.filter((reservation) => reservation.state === 'reserved')
			.reduce((total, reservation) => total + Number(reservation.reservedCredits ?? 0), 0);
		const derivedCapacity = await this.getTeamDerivedCapacity(project.teamId, {
			providers,
			activeReservations,
		});
		return {
			projectId,
			teamId: project.teamId,
			environment,
			providers,
			lanes,
			grants,
			activeReservations,
			estimateProfiles: profiles,
			derivedCapacity,
			remaining: {
				dailyCredits: dailyCredits > 0 ? Math.max(0, dailyCredits - reservedCredits) : null,
				weeklyCredits: weeklyCredits || null,
				monthlyCredits: monthlyCredits || null,
				weeklyQuotaMinutes: weeklyQuotaMinutes || null,
				dailyUsd: dailyUsd || null,
			},
		};
	}

	async getProjectCapacityOperations(projectId, environment = 'staging') {
		await this.ensureInitialized();
		const [
			plan,
			summary,
			reservations,
			ledgerEntries,
			routingDecisions,
			usageActuals,
			approvalRequests,
		] = await Promise.all([
			this.getProjectCapacityPlan(projectId, environment),
			this.getProjectCapacitySummary(projectId, environment),
			this.listCapacityReservationsForProject(projectId),
			this.listCapacityLedgerEntries(projectId),
			this.listCapacityRoutingDecisionsForProject(projectId, 50),
			this.listTaskUsageActualsForProject(projectId, 50),
			this.listApprovalRequestsForProject(projectId, 50),
		]);
		const blockedRoutingDecisions = routingDecisions.filter((decision) =>
			decision.decision === 'blocked'
			|| decision.decision === 'approval_required'
			|| String(decision.reason ?? '').includes('budget')
			|| String(decision.reason ?? '').includes('approval')
		);
		const interruptionReservations = reservations.filter((reservation) =>
			reservation.state === 'overran_pending_approval'
			|| reservation.state === 'continuation_required'
			|| reservation.metadata?.interrupted === true
			|| reservation.metadata?.checkpointId
		);
		return {
			projectId,
			environment,
			summary,
			plan,
			reservations: reservations.slice(0, 50),
			ledgerEntries: ledgerEntries.slice(0, 50),
			routingDecisions,
			blockedRoutingDecisions,
			usageActuals,
			estimateProfiles: plan?.estimateProfiles ?? [],
			approvalRequests,
			pendingApprovalRequests: approvalRequests.filter((request) => request.state === 'pending'),
			interruptionReservations,
		};
	}

	async getTeamCapacitySummary(teamId) {
		await this.ensureInitialized();
		const [providers, grants, projects] = await Promise.all([
			this.listTeamCapacityProviders(teamId),
			this.listCapacityGrants(teamId),
			this.listTeamProjects(teamId),
		]);
		const reservations = projects.length
			? (await this.all(
				`SELECT * FROM capacity_reservations
				 WHERE team_id = ? AND project_id IN (${projects.map(() => '?').join(',')})
				 ORDER BY created_at DESC`,
				[teamId, ...projects.map((project) => project.id)],
			)).map(serializeCapacityReservation)
			: [];
		const activeReservations = reservations.filter((reservation) =>
			['reserved', 'consuming', 'consumed', 'failed', 'overran_pending_approval'].includes(reservation.state)
		);
		const dailyCredits = sumNumbers(grants.filter((grant) => grant.state === 'active').map((grant) => grant.dailyCreditLimit));
		const monthlyCredits = sumNumbers(grants.filter((grant) => grant.state === 'active').map((grant) => grant.monthlyCreditLimit));
		const dailyReservedCredits = sumNumbers(activeReservations.map((reservation) =>
			['reserved', 'consuming'].includes(reservation.state)
				? Math.max(reservation.reservedCredits, reservation.consumedCredits)
				: reservation.consumedCredits
		));
		const dailyUsedCredits = sumNumbers(activeReservations.map((reservation) => reservation.consumedCredits));
		const blocked = await this.all(
			`SELECT * FROM capacity_routing_decisions
			 WHERE project_id IN (${projects.length ? projects.map(() => '?').join(',') : '?'})
			   AND decision IN ('blocked', 'approval_required')
			 ORDER BY created_at DESC LIMIT 200`,
			projects.length ? projects.map((project) => project.id) : ['__none__'],
		);
		const derivedCapacity = await this.getTeamDerivedCapacity(teamId, { providers, activeReservations });
		return {
			teamId,
			monthlyCredits: monthlyCredits || null,
			monthlyUsedCredits: dailyUsedCredits,
			monthlyRemainingCredits: monthlyCredits ? Math.max(0, monthlyCredits - dailyUsedCredits) : null,
			dailyCredits: dailyCredits || null,
			dailyUsedCredits,
			dailyReservedCredits,
			dailyRemainingCredits: dailyCredits ? Math.max(0, dailyCredits - dailyReservedCredits) : null,
			providerCount: providers.length,
			activeProviderCount: providers.filter((provider) => provider.status === 'active').length,
			degradedProviderCount: providers.filter((provider) => provider.status === 'degraded' || provider.status === 'failed').length,
			grantCount: grants.length,
			blockedTaskCount: blocked.filter((entry) => entry.decision === 'blocked').length,
			approvalRequiredCount: blocked.filter((entry) => entry.decision === 'approval_required').length,
			derivedCapacity,
		};
	}

	async getProjectCapacitySummary(projectId, environment = 'staging') {
		await this.ensureInitialized();
		const [plan, policy] = await Promise.all([
			this.getProjectCapacityPlan(projectId, environment),
			this.getProjectWorkPolicy(projectId, environment),
		]);
		if (!plan) return null;
		const teamSummary = await this.getTeamCapacitySummary(plan.teamId);
		const projectReservations = plan.activeReservations.filter((reservation) =>
			['reserved', 'consuming', 'consumed', 'failed', 'overran_pending_approval'].includes(reservation.state)
		);
		const dailyReservedCredits = sumNumbers(projectReservations.map((reservation) =>
			['reserved', 'consuming'].includes(reservation.state)
				? Math.max(reservation.reservedCredits, reservation.consumedCredits)
				: reservation.consumedCredits
		));
		const dailyUsedCredits = sumNumbers(projectReservations.map((reservation) => reservation.consumedCredits));
		const dailyCredits = sumNumbers(plan.grants.filter((grant) => grant.state === 'active').map((grant) => grant.dailyCreditLimit));
		const derivedCapacity = await this.getTeamDerivedCapacity(plan.teamId, {
			providers: plan.providers,
			activeReservations: projectReservations,
		});
		let readiness = 'ready';
		const reasons = [];
		if (policy?.enabled === false) {
			readiness = 'paused_by_policy';
			reasons.push('work_policy_disabled');
		} else if (plan.providers.filter((provider) => provider.status === 'active').length === 0) {
			readiness = 'waiting_for_provider';
			reasons.push('no_active_provider');
		} else if (dailyCredits > 0 && Math.max(0, dailyCredits - dailyReservedCredits) <= 0) {
			readiness = 'waiting_for_budget';
			reasons.push('daily_budget_exhausted');
		}
		return {
			...teamSummary,
			projectId,
			environment,
			dailyCredits: dailyCredits || teamSummary.dailyCredits,
			dailyUsedCredits,
			dailyReservedCredits,
			dailyRemainingCredits: dailyCredits ? Math.max(0, dailyCredits - dailyReservedCredits) : teamSummary.dailyRemainingCredits,
			derivedCapacity,
			readiness,
			reasons,
			workPolicy: policy,
		};
	}

	async listTeamInvites(teamId) {
		await this.ensureInitialized();
		const rows = await this.all(
			`SELECT * FROM team_invites WHERE team_id = ? AND status = 'pending' ORDER BY created_at DESC`,
			[teamId],
		);
		return rows.map(serializeTeamInvite);
	}

	async findUserByEmail(email) {
		await this.ensureInitialized();
		const normalized = String(email ?? '').trim().toLowerCase();
		if (!normalized) return null;
		const verified = await this.first(
			`SELECT users.*
			   FROM users
			   INNER JOIN user_email_addresses
			     ON user_email_addresses.user_id = users.id
			    AND user_email_addresses.normalized_email = ?
			    AND user_email_addresses.status = 'verified'
			  WHERE users.status = 'active'
			  LIMIT 1`,
			[normalized],
		);
		if (verified) return verified;
		const legacy = await this.first(`SELECT * FROM users WHERE LOWER(email) = LOWER(?) AND status = 'active' LIMIT 1`, [normalized]);
		if (!legacy?.id) return null;
		const emailRows = await this.first(`SELECT COUNT(*) AS count FROM user_email_addresses WHERE user_id = ?`, [legacy.id]);
		return Number(emailRows?.count ?? 0) === 0 ? legacy : null;
	}

	async listActiveUsers(limit = 50) {
		await this.ensureInitialized();
		const boundedLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
		return this.all(
			`SELECT * FROM users WHERE status = 'active' ORDER BY created_at ASC LIMIT ?`,
			[boundedLimit],
		);
	}

	async membershipOwnerCount(teamId) {
		await this.ensureInitialized();
		const row = await this.first(
			`SELECT COUNT(*) AS count
			 FROM team_memberships
			 INNER JOIN team_role_bindings ON team_role_bindings.team_membership_id = team_memberships.id
			 INNER JOIN roles ON roles.id = team_role_bindings.role_id
			 WHERE team_memberships.team_id = ? AND team_memberships.status = 'active' AND roles.key = 'team_owner'`,
			[teamId],
		);
		return Number(row?.count ?? 0);
	}

	async upsertTeamMember(teamId, userId, roleKey = 'contributor') {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const role = normalizeTeamRoleKey(roleKey);
		let membership = await this.first(
			`SELECT * FROM team_memberships WHERE team_id = ? AND user_id = ? LIMIT 1`,
			[teamId, userId],
		);
		if (!membership?.id) {
			const membershipId = randomUUID();
			await this.run(
				`INSERT INTO team_memberships (id, team_id, user_id, status, created_at, updated_at)
				 VALUES (?, ?, ?, 'active', ?, ?)`,
				[membershipId, teamId, userId, timestamp, timestamp],
			);
			membership = { id: membershipId };
		} else {
			await this.run(
				`UPDATE team_memberships SET status = 'active', updated_at = ? WHERE id = ?`,
				[timestamp, membership.id],
			);
		}
		await this.replaceMembershipRole(membership.id, role);
		return (await this.listTeamMembers(teamId)).find((member) => member.id === membership.id) ?? null;
	}

	async replaceMembershipRole(membershipId, roleKey) {
		await this.ensureInitialized();
		const role = normalizeTeamRoleKey(roleKey);
		await this.run(`DELETE FROM team_role_bindings WHERE team_membership_id = ?`, [membershipId]);
		await this.bindRoleToMembership(membershipId, role);
	}

	async updateTeamMemberRole(teamId, membershipId, roleKey) {
		await this.ensureInitialized();
		const role = normalizeTeamRoleKey(roleKey);
		const membership = await this.first(`SELECT * FROM team_memberships WHERE id = ? AND team_id = ? LIMIT 1`, [membershipId, teamId]);
		if (!membership?.id) return { ok: false, code: 'missing', message: 'Team member not found.' };
		const currentRoles = await this.listRoleKeysForMembership(membershipId);
		if (currentRoles.includes('team_owner') && role !== 'team_owner' && (await this.membershipOwnerCount(teamId)) <= 1) {
			return { ok: false, code: 'last_owner', message: 'A team must keep at least one owner.' };
		}
		await this.replaceMembershipRole(membershipId, role);
		await this.run(`UPDATE team_memberships SET updated_at = ? WHERE id = ?`, [isoNow(), membershipId]);
		return { ok: true, member: (await this.listTeamMembers(teamId)).find((member) => member.id === membershipId) ?? null };
	}

	async removeTeamMember(teamId, membershipId) {
		await this.ensureInitialized();
		const membership = await this.first(`SELECT * FROM team_memberships WHERE id = ? AND team_id = ? LIMIT 1`, [membershipId, teamId]);
		if (!membership?.id) return { ok: false, code: 'missing', message: 'Team member not found.' };
		const currentRoles = await this.listRoleKeysForMembership(membershipId);
		if (currentRoles.includes('team_owner') && (await this.membershipOwnerCount(teamId)) <= 1) {
			return { ok: false, code: 'last_owner', message: 'A team must keep at least one owner.' };
		}
		await this.run(`DELETE FROM team_memberships WHERE id = ? AND team_id = ?`, [membershipId, teamId]);
		return { ok: true };
	}

	async createTeamInvite(teamId, input) {
		await this.ensureInitialized();
		const email = String(input.email ?? '').trim().toLowerCase();
		if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
			return { ok: false, code: 'invalid_email', message: 'A valid invite email is required.' };
		}
		const roleKey = normalizeTeamRoleKey(input.roleKey);
		const token = `tiv_${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`;
		const timestamp = isoNow();
		const expiresAt = input.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
		const existingUser = await this.findUserByEmail(email);
		if (existingUser?.id && input.autoAddExisting !== false) {
			const member = await this.upsertTeamMember(teamId, existingUser.id, roleKey);
			return { ok: true, existingUser: true, member, invite: null, token: null };
		}
		const id = randomUUID();
		await this.run(
			`INSERT INTO team_invites (
				id, team_id, email, role_key, token_prefix, token_hash, status, invited_by_user_id, expires_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
			[
				id,
				teamId,
				email,
				roleKey,
				tokenPrefix(token),
				stableHash(token, this.config.authSecret),
				typeof input.invitedByUserId === 'string' ? input.invitedByUserId : null,
				expiresAt,
				timestamp,
				timestamp,
			],
		);
		return { ok: true, existingUser: false, invite: await this.getTeamInvite(id), token };
	}

	async getTeamInvite(inviteId) {
		await this.ensureInitialized();
		return serializeTeamInvite(await this.first(`SELECT * FROM team_invites WHERE id = ? LIMIT 1`, [inviteId]));
	}

	async revokeTeamInvite(teamId, inviteId) {
		await this.ensureInitialized();
		await this.run(
			`UPDATE team_invites SET status = 'revoked', updated_at = ? WHERE id = ? AND team_id = ? AND status = 'pending'`,
			[isoNow(), inviteId, teamId],
		);
		return { ok: true };
	}

	async acceptTeamInvite(token, userId) {
		await this.ensureInitialized();
		const prefix = tokenPrefix(String(token ?? ''));
		const rows = await this.all(
			`SELECT * FROM team_invites WHERE token_prefix = ? AND status = 'pending'`,
			[prefix],
		);
		for (const row of rows) {
			if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
				await this.run(`UPDATE team_invites SET status = 'expired', updated_at = ? WHERE id = ?`, [isoNow(), row.id]);
				continue;
			}
			if (!equalHash(stableHash(token, this.config.authSecret), row.token_hash)) continue;
			const member = await this.upsertTeamMember(row.team_id, userId, row.role_key);
			await this.run(
				`UPDATE team_invites
				 SET status = 'accepted', accepted_by_user_id = ?, accepted_at = ?, updated_at = ?
				 WHERE id = ?`,
				[userId, isoNow(), isoNow(), row.id],
			);
			return { ok: true, invite: serializeTeamInvite(row), member, team: await this.getTeam(row.team_id) };
		}
		return { ok: false, code: 'invalid', message: 'Invite link is invalid or expired.' };
	}

	async createTeamApiKey(teamId, input) {
		await this.ensureInitialized();
		const token = `tsk_${randomUUID().replaceAll('-', '')}`;
		const timestamp = isoNow();
		const id = randomUUID();
		await this.run(
			`INSERT INTO team_api_keys (
				id, team_id, name, key_prefix, key_hash, permissions_json, expires_at, last_used_at, revoked_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
			[
				id,
				teamId,
				input.name,
				tokenPrefix(token),
				stableHash(token, this.config.authSecret),
				JSON.stringify(input.permissions ?? []),
				input.expiresAt ?? null,
				timestamp,
				timestamp,
			],
		);
		return {
			id,
			token,
			prefix: tokenPrefix(token),
			name: input.name,
			expiresAt: input.expiresAt ?? null,
		};
	}

	async getTeamStorageLocator(teamId) {
		await this.ensureInitialized();
		return serializeTeamStorageLocator(await this.first(`SELECT * FROM team_storage_locators WHERE team_id = ?`, [teamId]));
	}

	async upsertTeamStorageLocator(teamId, input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const existing = await this.first(`SELECT * FROM team_storage_locators WHERE team_id = ?`, [teamId]);
		if (existing) {
			await this.run(
				`UPDATE team_storage_locators
				 SET bucket_name = ?, manifest_key_template = ?, preview_root_template = ?, public_base_url = ?, metadata_json = ?, updated_at = ?
				 WHERE team_id = ?`,
				[
					input.bucketName,
					input.manifestKeyTemplate,
					input.previewRootTemplate,
					input.publicBaseUrl ?? null,
					JSON.stringify(input.metadata ?? parseJson(existing.metadata_json, {})),
					timestamp,
					teamId,
				],
			);
		} else {
			await this.run(
				`INSERT INTO team_storage_locators (
					id, team_id, bucket_name, manifest_key_template, preview_root_template, public_base_url, metadata_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					randomUUID(),
					teamId,
					input.bucketName,
					input.manifestKeyTemplate,
					input.previewRootTemplate,
					input.publicBaseUrl ?? null,
					JSON.stringify(input.metadata ?? {}),
					timestamp,
					timestamp,
				],
			);
		}
		return this.getTeamStorageLocator(teamId);
	}

	async upsertCatalogItem(teamId, input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		const existing = await this.first(`SELECT * FROM catalog_items WHERE id = ?`, [id]);
		if (existing) {
			await this.run(
				`UPDATE catalog_items
				 SET team_id = ?, kind = ?, slug = ?, title = ?, summary = ?, visibility = ?, listing_enabled = ?, offer_mode = ?, manifest_key = ?, artifact_key = ?, search_text = ?, metadata_json = ?, updated_at = ?
				 WHERE id = ?`,
				[
					teamId,
					input.kind,
					input.slug,
					input.title,
					input.summary ?? null,
					input.visibility ?? 'private',
					input.listingEnabled === true ? 1 : 0,
					input.offerMode ?? 'private',
					input.manifestKey ?? null,
					input.artifactKey ?? null,
					input.searchText ?? null,
					JSON.stringify(input.metadata ?? {}),
					timestamp,
					id,
				],
			);
		} else {
			await this.run(
				`INSERT INTO catalog_items (
					id, team_id, kind, slug, title, summary, visibility, listing_enabled, offer_mode, manifest_key, artifact_key, search_text, metadata_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					id,
					teamId,
					input.kind,
					input.slug,
					input.title,
					input.summary ?? null,
					input.visibility ?? 'private',
					input.listingEnabled === true ? 1 : 0,
					input.offerMode ?? 'private',
					input.manifestKey ?? null,
					input.artifactKey ?? null,
					input.searchText ?? null,
					JSON.stringify(input.metadata ?? {}),
					timestamp,
					timestamp,
				],
			);
		}
		return serializeCatalogItem(await this.first(`SELECT * FROM catalog_items WHERE id = ?`, [id]));
	}

	async getCatalogItem(itemId) {
		await this.ensureInitialized();
		return serializeCatalogItem(await this.first(`SELECT * FROM catalog_items WHERE id = ?`, [itemId]));
	}

	async getCatalogItemBySlug(kind, slug) {
		await this.ensureInitialized();
		return serializeCatalogItem(await this.first(
			`SELECT * FROM catalog_items WHERE kind = ? AND slug = ? LIMIT 1`,
			[kind, slug],
		));
	}

	async listCatalogItems(principal, filters = {}) {
		await this.ensureInitialized();
		const clauses = [];
		const params = [];
		if (filters.kind) {
			clauses.push('kind = ?');
			params.push(filters.kind);
		}
		if (filters.teamId) {
			clauses.push('team_id = ?');
			params.push(filters.teamId);
		}
		if (filters.slug) {
			clauses.push('slug = ?');
			params.push(filters.slug);
		}
		const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
		const rows = await this.all(
			`SELECT * FROM catalog_items ${where} ORDER BY updated_at DESC, created_at DESC`,
			params,
		);
		const teamIds = await this.teamIdsForPrincipal(principal);
		return rows
			.map(serializeCatalogItem)
			.filter((item) =>
				item.visibility === 'public'
					? item.listingEnabled
					: principalIsAdmin(principal) || teamIds.includes(item.teamId),
			);
	}

	async upsertCatalogArtifactVersion(teamId, itemId, input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		const existing = await this.first(`SELECT * FROM catalog_artifact_versions WHERE item_id = ? AND version = ? LIMIT 1`, [itemId, input.version]);
		if (existing) {
			await this.run(
				`UPDATE catalog_artifact_versions
				 SET team_id = ?, kind = ?, content_key = ?, manifest_key = ?, metadata_json = ?, published_at = ?, updated_at = ?
				 WHERE id = ?`,
				[
					teamId,
					input.kind,
					input.contentKey,
					input.manifestKey ?? null,
					JSON.stringify(input.metadata ?? {}),
					input.publishedAt ?? timestamp,
					timestamp,
					existing.id,
				],
			);
			return serializeCatalogArtifactVersion(await this.first(`SELECT * FROM catalog_artifact_versions WHERE id = ?`, [existing.id]));
		}
		await this.run(
			`INSERT INTO catalog_artifact_versions (
				id, item_id, team_id, kind, version, content_key, manifest_key, metadata_json, published_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				itemId,
				teamId,
				input.kind,
				input.version,
				input.contentKey,
				input.manifestKey ?? null,
				JSON.stringify(input.metadata ?? {}),
				input.publishedAt ?? timestamp,
				timestamp,
				timestamp,
			],
		);
		return serializeCatalogArtifactVersion(await this.first(`SELECT * FROM catalog_artifact_versions WHERE id = ?`, [id]));
	}

	async listCatalogArtifactVersions(itemId) {
		await this.ensureInitialized();
		const rows = await this.all(
			`SELECT * FROM catalog_artifact_versions WHERE item_id = ? ORDER BY published_at DESC, created_at DESC`,
			[itemId],
		);
		return rows.map(serializeCatalogArtifactVersion);
	}

	async getCatalogArtifactVersion(itemId, version) {
		await this.ensureInitialized();
		const row = await this.first(
			`SELECT * FROM catalog_artifact_versions WHERE item_id = ? AND version = ? LIMIT 1`,
			[itemId, version],
		);
		return serializeCatalogArtifactVersion(row);
	}

	async listTeamProducts(teamId, principal = null) {
		const items = await this.listCatalogItems(principal, { teamId });
		const latestArtifacts = new Map();
		for (const item of items) {
			const latest = (await this.listCatalogArtifactVersions(item.id))[0] ?? null;
			latestArtifacts.set(item.id, latest);
		}
		return items.map((item) => ({
			...item,
			latestArtifact: latestArtifacts.get(item.id) ?? null,
		}));
	}

	async loadTeamProfileByName(name, principal = null) {
		const team = await this.getTeamByName(name);
		if (!team) return null;
		const [projects, products, knowledgePacks, members] = await Promise.all([
			this.listTeamProjects(team.id),
			this.listTeamProducts(team.id, principal),
			this.all(`SELECT * FROM knowledge_packs WHERE team_id = ? ORDER BY updated_at DESC, created_at DESC`, [team.id]),
			this.listTeamMembers(team.id),
		]);
		const canAccessPrivate = principal ? await this.principalCanAccessTeam(principal, team.id) : false;
		return {
			team,
			members: canAccessPrivate ? members : [],
			activity: {
				projects: canAccessPrivate ? projects : projects.filter((project) => project.metadata?.publicSite === true || project.metadata?.visibility === 'public'),
				catalogItems: products.filter((item) => item.visibility === 'public' && item.listingEnabled || canAccessPrivate),
				knowledgePacks: knowledgePacks.map(serializeKnowledgePack).filter((pack) => pack.visibility === 'public' || canAccessPrivate),
			},
		};
	}

	async loadUserProfileByUsername(username, principal = null) {
		await this.ensureInitialized();
		const normalized = String(username ?? '').trim().toLowerCase();
		if (
			!normalized
			|| normalized.length > 39
			|| !/^[a-z0-9-]+$/u.test(normalized)
			|| normalized.startsWith('-')
			|| normalized.endsWith('-')
			|| normalized.includes('--')
		) {
			return null;
		}
		const row = await this.first(
			`SELECT users.id, users.email, users.username, users.display_name, users.status, users.created_at,
			        user_identities.profile_json
			   FROM users
			   LEFT JOIN user_identities ON user_identities.user_id = users.id
			  WHERE LOWER(users.username) = LOWER(?)
			    AND users.status = 'active'
			  ORDER BY user_identities.updated_at DESC
			  LIMIT 1`,
			[normalized],
		);
		if (!row?.id || !row.username) return null;
		const profile = parseJson(row.profile_json, {});
		const viewerTeamIds = new Set(await this.teamIdsForPrincipal(principal));
		const membershipRows = await this.all(
			`SELECT teams.id, teams.slug, teams.name, teams.display_name, teams.created_at
			   FROM team_memberships
			   INNER JOIN teams ON teams.id = team_memberships.team_id
			  WHERE team_memberships.user_id = ?
			    AND team_memberships.status = 'active'
			  ORDER BY teams.created_at ASC`,
			[row.id],
		);
		const profileTeams = membershipRows.map((team) => ({
			id: team.id,
			slug: team.slug ?? team.name,
			name: team.display_name ?? team.name,
			createdAt: team.created_at,
		}));
		const profileTeamIds = new Set(profileTeams.map((team) => team.id));
		const catalogItems = (await this.listCatalogItems(principal)).filter((item) => profileTeamIds.has(item.teamId));
		const knowledgePacks = (await this.listKnowledgePacks(principal)).filter((pack) => profileTeamIds.has(pack.teamId));
		const visibleTeamIds = new Set([
			...catalogItems.map((item) => item.teamId),
			...knowledgePacks.map((pack) => pack.teamId),
			...profileTeams.filter((team) => viewerTeamIds.has(team.id)).map((team) => team.id),
		]);
		const projects = [];
		for (const team of profileTeams) {
			if (!viewerTeamIds.has(team.id)) continue;
			projects.push(...await this.listTeamProjects(team.id));
		}
		return {
			user: {
				id: row.id,
				username: String(row.username).trim().toLowerCase(),
				displayName: row.display_name ?? null,
				email: principal?.id === row.id || principalIsAdmin(principal) ? row.email ?? null : null,
				image: typeof profile.image === 'string' ? profile.image : null,
				joinedAt: row.created_at,
			},
			activity: {
				teams: profileTeams.filter((team) => visibleTeamIds.has(team.id)),
				projects,
				catalogItems,
				knowledgePacks,
			},
		};
	}

	async evaluateTeamDeletionBlockers(teamId) {
		await this.ensureInitialized();
		const [projects, catalogItems, knowledgePacks, jobs] = await Promise.all([
			this.all(`SELECT id, slug, name FROM projects WHERE team_id = ? ORDER BY created_at ASC LIMIT 20`, [teamId]),
			this.all(`SELECT id, kind, slug, title FROM catalog_items WHERE team_id = ? ORDER BY created_at ASC LIMIT 20`, [teamId]),
			this.all(`SELECT id, slug, name FROM knowledge_packs WHERE team_id = ? ORDER BY created_at ASC LIMIT 20`, [teamId]),
			this.all(
				`SELECT remote_jobs.id, remote_jobs.operation, remote_jobs.status, projects.slug AS project_slug, projects.name AS project_name
				 FROM remote_jobs
				 INNER JOIN projects ON projects.id = remote_jobs.project_id
				 WHERE projects.team_id = ? AND remote_jobs.status IN ('pending', 'claimed', 'running', 'waiting_for_approval')
				 ORDER BY remote_jobs.created_at ASC LIMIT 20`,
				[teamId],
			),
		]);
		return [
			...projects.map((row) => ({ code: 'project', id: row.id, label: row.name, href: `/app/projects/${row.id}/settings` })),
			...catalogItems.map((row) => ({ code: 'catalog_item', id: row.id, label: row.title, href: '/app/knowledge/templates' })),
			...knowledgePacks.map((row) => ({ code: 'knowledge_pack', id: row.id, label: row.name, href: '/app/knowledge/packs' })),
			...jobs.map((row) => ({ code: 'active_job', id: row.id, label: `${row.project_name}: ${row.operation}`, href: '/app/work/objectives' })),
		];
	}

	async deleteTeam(teamId, confirmation) {
		await this.ensureInitialized();
		const team = await this.getTeam(teamId);
		if (!team) return { ok: false, code: 'missing', message: 'Team not found.' };
		if (!teamDeletionConfirmationMatches(confirmation, team.name)) {
			return { ok: false, code: 'confirmation', message: `Type DELETE ${team.name} to confirm.` };
		}
		const blockers = await this.evaluateTeamDeletionBlockers(teamId);
		if (blockers.length > 0) {
			return { ok: false, code: 'blocked', message: 'Team still has owned content.', blockers };
		}
		await this.run(`DELETE FROM teams WHERE id = ?`, [teamId]);
		return { ok: true, team };
	}

	async evaluateProjectDeletionBlockers(projectId) {
		await this.ensureInitialized();
		const project = await this.getProject(projectId);
		if (!project) return [{ code: 'missing', id: projectId, label: 'Project not found.' }];
		const [jobs, workdays, requests, leases, runners, reservations, approvals] = await Promise.all([
			this.all(
				`SELECT id, namespace, operation, status FROM remote_jobs
				 WHERE project_id = ? AND status IN ('pending', 'claimed', 'running', 'waiting_for_approval')
				 ORDER BY created_at ASC LIMIT 20`,
				[projectId],
			),
			this.all(
				`SELECT id, state, started_at FROM work_days
				 WHERE project_id = ? AND state IN ('active', 'running', 'open')
				 ORDER BY updated_at DESC LIMIT 20`,
				[projectId],
			),
			this.all(
				`SELECT id, type, state, environment FROM workday_requests
				 WHERE project_id = ? AND state IN ('pending', 'approved', 'running')
				 ORDER BY created_at ASC LIMIT 20`,
				[projectId],
			),
			this.all(
				`SELECT id, manager_id, state, environment FROM workday_manager_leases
				 WHERE project_id = ? AND state = 'active'
				 ORDER BY heartbeat_at DESC LIMIT 20`,
				[projectId],
			),
			this.all(
				`SELECT id, runner_id, state, environment FROM worker_runners
				 WHERE project_id = ? AND state IN ('active', 'starting', 'running')
				 ORDER BY updated_at DESC LIMIT 20`,
				[projectId],
			),
			this.all(
				`SELECT id, state, reserved_credits, consumed_credits FROM capacity_reservations
				 WHERE project_id = ? AND state IN ('reserved', 'consuming', 'overran_pending_approval')
				 ORDER BY created_at DESC LIMIT 20`,
				[projectId],
			),
			this.all(
				`SELECT id, kind, state, title FROM approval_requests
				 WHERE project_id = ? AND state = 'pending'
				 ORDER BY created_at DESC LIMIT 20`,
				[projectId],
			),
		]);
		const href = `/app/projects/${project.id}/settings`;
		return [
			...jobs.map((row) => ({ code: 'active_job', id: row.id, label: `${row.namespace}:${row.operation} ${row.status}`, href: '/app/work/objectives' })),
			...workdays.map((row) => ({ code: 'active_workday', id: row.id, label: `Workday ${row.id} ${row.state}`, href: `/app/work/objectives#work-${row.id}` })),
			...requests.map((row) => ({ code: 'workday_request', id: row.id, label: `${row.environment} ${row.type} ${row.state}`, href: '/app/work/objectives' })),
			...leases.map((row) => ({ code: 'manager_lease', id: row.id, label: `${row.environment} ${row.manager_id}`, href })),
			...runners.map((row) => ({ code: 'worker_runner', id: row.id, label: `${row.environment} ${row.runner_id}`, href })),
			...reservations.map((row) => ({ code: 'capacity_reservation', id: row.id, label: `${row.state} ${row.reserved_credits ?? 0} credits`, href: '/app/capacity' })),
			...approvals.map((row) => ({ code: 'pending_approval', id: row.id, label: row.title ?? row.kind, href: `/app/work/decisions#approval-${row.id}` })),
		];
	}

	async deleteProject(projectId, confirmation) {
		await this.ensureInitialized();
		const project = await this.getProject(projectId);
		if (!project) return { ok: false, code: 'missing', message: 'Project not found.' };
		if (!projectDeletionConfirmationMatches(confirmation, project.slug)) {
			return { ok: false, code: 'confirmation', message: `Type DELETE ${project.slug} to confirm.` };
		}
		const blockers = await this.evaluateProjectDeletionBlockers(projectId);
		if (blockers.length > 0) {
			return { ok: false, code: 'blocked', message: 'Project still has active work or pending decisions.', blockers };
		}

		await this.run(
			`DELETE FROM task_outputs WHERE task_id IN (
				SELECT tasks.id FROM tasks INNER JOIN work_days ON work_days.id = tasks.work_day_id WHERE work_days.project_id = ?
			)`,
			[projectId],
		);
		await this.run(
			`DELETE FROM task_events WHERE task_id IN (
				SELECT tasks.id FROM tasks INNER JOIN work_days ON work_days.id = tasks.work_day_id WHERE work_days.project_id = ?
			)`,
			[projectId],
		);
		await this.run(`DELETE FROM tasks WHERE work_day_id IN (SELECT id FROM work_days WHERE project_id = ?)`, [projectId]);
		await this.run(`DELETE FROM graph_runs WHERE work_day_id IN (SELECT id FROM work_days WHERE project_id = ?)`, [projectId]);
		await this.run(`DELETE FROM reports WHERE work_day_id IN (SELECT id FROM work_days WHERE project_id = ?)`, [projectId]);

		const catalogItemIds = (await this.all(
			`SELECT id FROM catalog_items WHERE team_id = ? AND (id = ? OR (kind = 'project' AND slug = ?))`,
			[project.teamId, projectId, project.slug],
		)).map((row) => row.id);
		for (const itemId of catalogItemIds) {
			await this.run(`DELETE FROM catalog_artifact_versions WHERE item_id = ?`, [itemId]);
			await this.run(`DELETE FROM catalog_item_collaborators WHERE item_id = ?`, [itemId]);
		}

		for (const table of [
			'team_inbox_items',
			'provider_credential_sessions',
			'capacity_routing_decisions',
			'task_estimates',
			'task_usage_actuals',
			'capacity_ledger_entries',
			'capacity_reservations',
			'capacity_grants',
			'approval_requests',
			'agent_pool_scale_decisions',
			'agent_pool_registrations',
			'agent_pools',
			'project_workday_summaries',
			'workday_requests',
			'workday_manager_leases',
			'worker_runners',
			'repository_claims',
			'runner_scale_decisions',
			'priority_overrides',
			'priority_snapshots',
			'task_credit_ledger',
			'scale_decisions',
			'work_policies',
			'project_summary_snapshots',
			'project_infrastructure_resources',
			'project_deployments',
			'project_environments',
			'project_hosting',
			'project_capability_grants',
			'project_connections',
			'entitlements',
		]) {
			await this.run(`DELETE FROM ${table} WHERE project_id = ?`, [projectId]);
		}
		await this.run(`DELETE FROM project_update_plans WHERE hub_id = ?`, [projectId]);
		await this.run(`DELETE FROM hub_workspace_links WHERE hub_id = ?`, [projectId]);
		await this.run(`DELETE FROM hub_content_sources WHERE hub_id = ?`, [projectId]);
		await this.run(`DELETE FROM hub_repositories WHERE hub_id = ?`, [projectId]);
		await this.run(`DELETE FROM catalog_items WHERE team_id = ? AND (id = ? OR (kind = 'project' AND slug = ?))`, [project.teamId, projectId, project.slug]);
		await this.run(`DELETE FROM remote_job_events WHERE job_id IN (SELECT id FROM remote_jobs WHERE project_id = ?)`, [projectId]);
		await this.run(`DELETE FROM remote_jobs WHERE project_id = ?`, [projectId]);
		await this.run(`DELETE FROM work_days WHERE project_id = ?`, [projectId]);
		await this.run(`DELETE FROM projects WHERE id = ?`, [projectId]);
		return { ok: true, project };
	}

	async listProjectsForPrincipal(principal) {
		await this.ensureInitialized();
		const teamIds = await this.teamIdsForPrincipal(principal);
		if (teamIds.length === 0) {
			return [];
		}
		const placeholders = teamIds.map(() => '?').join(', ');
		const rows = await this.all(
			`SELECT * FROM projects WHERE team_id IN (${placeholders}) ORDER BY created_at ASC`,
			teamIds,
		);
		return rows.map(serializeProject).filter((project) => project?.metadata?.deletion?.status !== 'succeeded');
	}

	async listTeamProjects(teamId) {
		await this.ensureInitialized();
		const rows = await this.all(
			`SELECT * FROM projects WHERE team_id = ? ORDER BY created_at ASC`,
			[teamId],
		);
		return rows.map(serializeProject).filter((project) => project?.metadata?.deletion?.status !== 'succeeded');
	}

	async createProject(teamId, input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		const slugResult = validateProjectSlug(input.slug);
		if (!slugResult.ok) {
			throw new Error(slugResult.message);
		}
		const existing = await this.getProjectByTeamAndSlug(teamId, slugResult.slug);
		if (existing) {
			throw new Error('That project slug is already in use for this team.');
		}
		await this.run(
			`INSERT INTO projects (id, team_id, slug, name, description, metadata_json, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				teamId,
				slugResult.slug,
				input.name,
				input.description ?? null,
				JSON.stringify(input.metadata ?? {}),
				timestamp,
				timestamp,
			],
		);
		await this.run(
			`INSERT INTO entitlements (id, team_id, project_id, tier, status, metadata_json, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
			[
				randomUUID(),
				teamId,
				id,
				input.entitlementTier ?? 'free',
				JSON.stringify({ seededBy: 'market_control_plane' }),
				timestamp,
				timestamp,
			],
		);
		await this.upsertCatalogItem(teamId, {
			id,
			kind: 'project',
			slug: slugResult.slug,
			title: input.name,
			summary: input.description ?? null,
			visibility: 'team',
			listingEnabled: input.metadata?.listingEnabled === true,
			offerMode: input.entitlementTier ?? 'free',
			manifestKey: input.metadata?.manifestKey ?? null,
			artifactKey: input.metadata?.artifactKey ?? null,
			searchText: [input.name, input.description].filter(Boolean).join(' ').trim() || null,
				metadata: input.metadata ?? {},
			});
		await this.upsertProjectTreeDxLibrary(id, {
			contentPath: input.metadata?.contentRoot ?? 'src/content',
			metadata: {
				source: 'project_creation_default',
				privateTeamTreeDxDefault: true,
			},
		}).catch(() => null);
		return this.getProjectDetails(id);
	}

	async updateProject(projectId, input) {
		await this.ensureInitialized();
		const existing = await this.first(`SELECT * FROM projects WHERE id = ? LIMIT 1`, [projectId]);
		if (!existing) {
			return null;
		}
		const timestamp = isoNow();
		const metadata = input.metadata ?? parseJson(existing.metadata_json, {});
		const nextSlug = input.slug ?? existing.slug;
		const nextName = input.name ?? existing.name;
		const nextDescription = input.description ?? existing.description ?? null;
		await this.run(
			`UPDATE projects
			 SET slug = ?, name = ?, description = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`,
			[
				nextSlug,
				nextName,
				nextDescription,
				JSON.stringify(metadata),
				timestamp,
				projectId,
			],
		);
		const existingCatalogItem = await this.getCatalogItem(projectId);
		if (existingCatalogItem) {
			await this.upsertCatalogItem(existing.team_id, {
				id: projectId,
				kind: 'project',
				slug: nextSlug,
				title: nextName,
				summary: nextDescription,
				visibility: existingCatalogItem.visibility,
				listingEnabled: existingCatalogItem.listingEnabled,
				offerMode: existingCatalogItem.offerMode,
				manifestKey: existingCatalogItem.manifestKey,
				artifactKey: existingCatalogItem.artifactKey,
				searchText: [nextName, nextDescription].filter(Boolean).join(' ').trim() || null,
				metadata: {
					...(existingCatalogItem.metadata ?? {}),
					...metadata,
				},
			});
		}
		return this.getProject(projectId);
	}

	async getProject(projectId) {
		await this.ensureInitialized();
		return serializeProject(await this.first(`SELECT * FROM projects WHERE id = ?`, [projectId]));
	}

	async getProjectByTeamAndSlug(teamId, slug) {
		await this.ensureInitialized();
		return serializeProject(await this.first(
			`SELECT * FROM projects WHERE team_id = ? AND slug = ? LIMIT 1`,
			[teamId, slug],
		));
	}

	async upsertHubRepository(hubId, input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const project = await this.getProject(hubId);
		const teamId = input.teamId ?? project?.teamId;
		if (!teamId) throw new Error('teamId is required for hub repository records.');
		const role = String(input.role);
		const existing = await this.first(
			`SELECT * FROM hub_repositories WHERE hub_id = ? AND role = ? LIMIT 1`,
			[hubId, role],
		);
		const payload = [
			teamId,
			role,
			input.repositoryHostId ?? null,
			input.provider ?? 'github',
			input.owner,
			input.name,
			input.url ?? null,
			input.defaultBranch ?? null,
			input.currentBranch ?? input.defaultBranch ?? null,
			input.status ?? 'queued',
			JSON.stringify(input.accessPolicy ?? {}),
			JSON.stringify(input.releasePolicy ?? {}),
			JSON.stringify(input.publishPolicy ?? {}),
			input.submodulePath ?? null,
			JSON.stringify(input.metadata ?? {}),
		];
		if (existing) {
			await this.run(
				`UPDATE hub_repositories
				 SET team_id = ?, role = ?, repository_host_id = ?, provider = ?, owner = ?, name = ?, url = ?,
				     default_branch = ?, current_branch = ?, status = ?, access_policy_json = ?, release_policy_json = ?,
				     publish_policy_json = ?, submodule_path = ?, metadata_json = ?, updated_at = ?
				 WHERE hub_id = ? AND role = ?`,
				[...payload, timestamp, hubId, role],
			);
			return serializeHubRepository(await this.first(`SELECT * FROM hub_repositories WHERE hub_id = ? AND role = ?`, [hubId, role]));
		}
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO hub_repositories (
				id, hub_id, team_id, role, repository_host_id, provider, owner, name, url, default_branch, current_branch, status,
				access_policy_json, release_policy_json, publish_policy_json, submodule_path, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[id, hubId, ...payload, timestamp, timestamp],
		);
		return serializeHubRepository(await this.first(`SELECT * FROM hub_repositories WHERE id = ?`, [id]));
	}

	async listHubRepositories(hubId) {
		await this.ensureInitialized();
		const rows = await this.all(
			`SELECT * FROM hub_repositories WHERE hub_id = ? ORDER BY role ASC`,
			[hubId],
		);
		return rows.map(serializeHubRepository);
	}

	async upsertHubContentSource(hubId, input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const project = await this.getProject(hubId);
		const teamId = input.teamId ?? project?.teamId;
		if (!teamId) throw new Error('teamId is required for hub content source records.');
		const existing = await this.first(`SELECT * FROM hub_content_sources WHERE hub_id = ? LIMIT 1`, [hubId]);
		const payload = [
			teamId,
			input.contentRepositoryId ?? null,
			input.productionSource ?? 'r2_published_artifacts',
			input.overlayPolicy ?? 'src_content_when_present',
			input.r2BucketName ?? null,
			input.r2ManifestKey ?? null,
			input.r2PublicBaseUrl ?? null,
			input.latestPublishId ?? null,
			input.latestContentVersion ?? null,
			JSON.stringify(input.metadata ?? {}),
		];
		if (existing) {
			await this.run(
				`UPDATE hub_content_sources
				 SET team_id = ?, content_repository_id = ?, production_source = ?, overlay_policy = ?, r2_bucket_name = ?,
				     r2_manifest_key = ?, r2_public_base_url = ?, latest_publish_id = ?, latest_content_version = ?,
				     metadata_json = ?, updated_at = ?
				 WHERE hub_id = ?`,
				[...payload, timestamp, hubId],
			);
			return serializeHubContentSource(await this.first(`SELECT * FROM hub_content_sources WHERE hub_id = ?`, [hubId]));
		}
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO hub_content_sources (
				id, hub_id, team_id, content_repository_id, production_source, overlay_policy, r2_bucket_name, r2_manifest_key,
				r2_public_base_url, latest_publish_id, latest_content_version, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[id, hubId, ...payload, timestamp, timestamp],
		);
		return serializeHubContentSource(await this.first(`SELECT * FROM hub_content_sources WHERE id = ?`, [id]));
	}

	async getHubContentSource(hubId) {
		await this.ensureInitialized();
		return serializeHubContentSource(await this.first(`SELECT * FROM hub_content_sources WHERE hub_id = ?`, [hubId]));
	}

	async createHubLaunch(input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO hub_launches (
				id, hub_id, team_id, job_id, intent_json, plan_json, state, current_phase, last_successful_phase,
				result_json, error_json, created_at, updated_at, completed_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL)`,
			[
				id,
				input.hubId,
				input.teamId,
				input.jobId ?? null,
				JSON.stringify(input.intent ?? {}),
				JSON.stringify(input.plan ?? {}),
				input.state ?? 'queued',
				input.currentPhase ?? 'launch_queued',
				input.lastSuccessfulPhase ?? null,
				timestamp,
				timestamp,
			],
		);
		return this.getHubLaunch(id);
	}

	async getHubLaunch(launchId) {
		await this.ensureInitialized();
		return serializeHubLaunch(await this.first(`SELECT * FROM hub_launches WHERE id = ?`, [launchId]));
	}

	async getLatestHubLaunchForHub(hubId) {
		await this.ensureInitialized();
		return serializeHubLaunch(await this.first(
			`SELECT * FROM hub_launches WHERE hub_id = ? ORDER BY created_at DESC LIMIT 1`,
			[hubId],
		));
	}

	async getHubLaunchByJobId(jobId) {
		await this.ensureInitialized();
		return serializeHubLaunch(await this.first(`SELECT * FROM hub_launches WHERE job_id = ? ORDER BY created_at DESC LIMIT 1`, [jobId]));
	}

	async updateHubLaunch(launchId, input) {
		await this.ensureInitialized();
		const existing = await this.getHubLaunch(launchId);
		if (!existing) return null;
		const timestamp = isoNow();
		const completedAt = input.completedAt === undefined ? existing.completedAt : input.completedAt;
		await this.run(
			`UPDATE hub_launches
			 SET state = ?, current_phase = ?, last_successful_phase = ?, result_json = ?, error_json = ?, updated_at = ?, completed_at = ?
			 WHERE id = ?`,
			[
				input.state ?? existing.state,
				input.currentPhase ?? existing.currentPhase,
				input.lastSuccessfulPhase ?? existing.lastSuccessfulPhase,
				JSON.stringify(input.result === undefined ? existing.result : input.result),
				JSON.stringify(input.error === undefined ? existing.error : input.error),
				timestamp,
				completedAt ?? null,
				launchId,
			],
		);
		return this.getHubLaunch(launchId);
	}

	async appendHubLaunchEvent(launchId, input) {
		await this.ensureInitialized();
		const row = await this.first(
			`SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM hub_launch_events WHERE launch_id = ?`,
			[launchId],
		);
		const seq = Number(row?.next_seq ?? 1);
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO hub_launch_events (
				id, launch_id, seq, phase, status, title, summary, started_at, finished_at, error_json, data_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				launchId,
				seq,
				input.phase,
				input.status,
				input.title ?? null,
				input.summary ?? null,
				input.startedAt ?? null,
				input.finishedAt ?? null,
				input.error ? JSON.stringify(input.error) : null,
				JSON.stringify(input.data ?? {}),
				timestamp,
			],
		);
		return serializeHubLaunchEvent(await this.first(`SELECT * FROM hub_launch_events WHERE id = ?`, [id]));
	}

	async listHubLaunchEvents(launchId) {
		await this.ensureInitialized();
		const rows = await this.all(
			`SELECT * FROM hub_launch_events WHERE launch_id = ? ORDER BY seq ASC`,
			[launchId],
		);
		return rows.map(serializeHubLaunchEvent);
	}

	async upsertHubWorkspaceLink(hubId, input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const project = await this.getProject(hubId);
		const teamId = input.teamId ?? project?.teamId;
		if (!teamId) throw new Error('teamId is required for hub workspace links.');
		const id = input.id ?? randomUUID();
		const existing = input.id
			? await this.first(`SELECT * FROM hub_workspace_links WHERE id = ? AND hub_id = ? LIMIT 1`, [input.id, hubId])
			: null;
		const payload = [
			hubId,
			teamId,
			input.parentRepositoryHostId ?? null,
			input.parentOwner ?? null,
			input.parentName ?? null,
			input.parentUrl ?? null,
			input.parentBranch ?? null,
			input.hubMountPath ?? null,
			input.softwareSubmodulePath ?? null,
			input.contentSubmodulePath ?? null,
			input.updateSubmodulePointersEnabled === true ? 1 : 0,
			JSON.stringify(input.accessPolicy ?? {}),
			JSON.stringify(input.metadata ?? {}),
		];
		if (existing) {
			await this.run(
				`UPDATE hub_workspace_links
				 SET hub_id = ?, team_id = ?, parent_repository_host_id = ?, parent_owner = ?, parent_name = ?, parent_url = ?,
				     parent_branch = ?, hub_mount_path = ?, software_submodule_path = ?, content_submodule_path = ?,
				     update_submodule_pointers_enabled = ?, access_policy_json = ?, metadata_json = ?, updated_at = ?
				 WHERE id = ?`,
				[...payload, timestamp, id],
			);
		} else {
			await this.run(
				`INSERT INTO hub_workspace_links (
					id, hub_id, team_id, parent_repository_host_id, parent_owner, parent_name, parent_url, parent_branch,
					hub_mount_path, software_submodule_path, content_submodule_path, update_submodule_pointers_enabled,
					access_policy_json, metadata_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[id, ...payload, timestamp, timestamp],
			);
		}
		return serializeHubWorkspaceLink(await this.first(`SELECT * FROM hub_workspace_links WHERE id = ?`, [id]));
	}

	async listHubWorkspaceLinks(hubId) {
		await this.ensureInitialized();
		const rows = await this.all(`SELECT * FROM hub_workspace_links WHERE hub_id = ? ORDER BY created_at DESC`, [hubId]);
		return rows.map(serializeHubWorkspaceLink);
	}

	async createProjectUpdatePlan(hubId, input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const project = await this.getProject(hubId);
		const teamId = input.teamId ?? project?.teamId;
		if (!teamId) throw new Error('teamId is required for project update plans.');
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO project_update_plans (
				id, hub_id, team_id, source_kind, source_ref, source_version, plan_json, state,
				requires_decision, decision_id, created_by, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				hubId,
				teamId,
				input.sourceKind,
				input.sourceRef ?? null,
				input.sourceVersion ?? null,
				JSON.stringify(input.plan ?? {}),
				input.state ?? 'planned',
				input.requiresDecision === true ? 1 : 0,
				input.decisionId ?? null,
				input.createdBy ?? null,
				timestamp,
				timestamp,
			],
		);
		return serializeProjectUpdatePlan(await this.first(`SELECT * FROM project_update_plans WHERE id = ?`, [id]));
	}

	async listProjectUpdatePlans(hubId) {
		await this.ensureInitialized();
		const rows = await this.all(`SELECT * FROM project_update_plans WHERE hub_id = ? ORDER BY created_at DESC`, [hubId]);
		return rows.map(serializeProjectUpdatePlan);
	}

	async getProjectConnection(projectId) {
		await this.ensureInitialized();
		return serializeConnection(await this.first(`SELECT * FROM project_connections WHERE project_id = ?`, [projectId]));
	}

	async getProjectHosting(projectId) {
		await this.ensureInitialized();
		return serializeProjectHosting(await this.first(`SELECT * FROM project_hosting WHERE project_id = ?`, [projectId]));
	}

	async upsertProjectHosting(projectId, input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const existing = await this.first(`SELECT * FROM project_hosting WHERE project_id = ?`, [projectId]);
		const nextMode = projectConnectionModeFromHosting(input.kind, input.registration ?? 'none');
		const metadata = input.metadata ?? parseJson(existing?.metadata_json, {});
		if (existing) {
			await this.run(
				`UPDATE project_hosting
				 SET hosting_kind = ?, registration = ?, market_base_url = ?, source_repo_owner = ?, source_repo_name = ?, source_repo_url = ?, source_repo_workflow_path = ?, metadata_json = ?, updated_at = ?
				 WHERE project_id = ?`,
				[
					input.kind,
					input.registration ?? 'none',
					input.marketBaseUrl ?? null,
					input.sourceRepoOwner ?? null,
					input.sourceRepoName ?? null,
					input.sourceRepoUrl ?? null,
					input.sourceRepoWorkflowPath ?? null,
					JSON.stringify(metadata),
					timestamp,
					projectId,
				],
			);
		} else {
			await this.run(
				`INSERT INTO project_hosting (
					id, project_id, hosting_kind, registration, market_base_url, source_repo_owner, source_repo_name, source_repo_url, source_repo_workflow_path, metadata_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					randomUUID(),
					projectId,
					input.kind,
					input.registration ?? 'none',
					input.marketBaseUrl ?? null,
					input.sourceRepoOwner ?? null,
					input.sourceRepoName ?? null,
					input.sourceRepoUrl ?? null,
					input.sourceRepoWorkflowPath ?? null,
					JSON.stringify(metadata),
					timestamp,
					timestamp,
				],
			);
		}

		const connection = await this.getProjectConnection(projectId);
		await this.upsertProjectConnection(projectId, {
			mode: nextMode,
			projectApiBaseUrl: input.projectApiBaseUrl ?? connection?.projectApiBaseUrl ?? null,
			executionOwner: input.executionOwner ?? connection?.executionOwner ?? (nextMode === 'hosted' ? 'project_api' : 'project_runner'),
			metadata: {
				...(connection?.metadata ?? {}),
				hostingKind: input.kind,
				registration: input.registration ?? 'none',
				marketBaseUrl: input.marketBaseUrl ?? null,
				sourceRepoOwner: input.sourceRepoOwner ?? null,
				sourceRepoName: input.sourceRepoName ?? null,
				sourceRepoUrl: input.sourceRepoUrl ?? null,
				sourceRepoWorkflowPath: input.sourceRepoWorkflowPath ?? null,
			},
		});

		return this.getProjectHosting(projectId);
	}

	async listProjectEnvironments(projectId) {
		await this.ensureInitialized();
		const rows = await this.all(
			`SELECT * FROM project_environments WHERE project_id = ? ORDER BY environment ASC`,
			[projectId],
		);
		return rows.map(serializeProjectEnvironment);
	}

	async upsertProjectEnvironment(projectId, input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const existing = await this.first(
			`SELECT * FROM project_environments WHERE project_id = ? AND environment = ? LIMIT 1`,
			[projectId, input.environment],
		);
		if (existing) {
			await this.run(
				`UPDATE project_environments
				 SET deployment_profile = ?, base_url = ?, cloudflare_account_id = ?, pages_project_name = ?, worker_name = ?, r2_bucket_name = ?, d1_database_name = ?, queue_name = ?, railway_project_name = ?, metadata_json = ?, updated_at = ?
				 WHERE project_id = ? AND environment = ?`,
				[
					input.deploymentProfile,
					input.baseUrl ?? null,
					input.cloudflareAccountId ?? null,
					input.pagesProjectName ?? null,
					input.workerName ?? null,
					input.r2BucketName ?? null,
					input.d1DatabaseName ?? null,
					input.queueName ?? null,
					input.railwayProjectName ?? null,
					JSON.stringify(input.metadata ?? parseJson(existing.metadata_json, {})),
					timestamp,
					projectId,
					input.environment,
				],
			);
		} else {
			await this.run(
				`INSERT INTO project_environments (
					id, project_id, environment, deployment_profile, base_url, cloudflare_account_id, pages_project_name, worker_name, r2_bucket_name, d1_database_name, queue_name, railway_project_name, metadata_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					randomUUID(),
					projectId,
					input.environment,
					input.deploymentProfile,
					input.baseUrl ?? null,
					input.cloudflareAccountId ?? null,
					input.pagesProjectName ?? null,
					input.workerName ?? null,
					input.r2BucketName ?? null,
					input.d1DatabaseName ?? null,
					input.queueName ?? null,
					input.railwayProjectName ?? null,
					JSON.stringify(input.metadata ?? {}),
					timestamp,
					timestamp,
				],
			);
		}

		return serializeProjectEnvironment(await this.first(
			`SELECT * FROM project_environments WHERE project_id = ? AND environment = ? LIMIT 1`,
			[projectId, input.environment],
		));
	}

	async listProjectInfrastructureResources(projectId, environment = null) {
		await this.ensureInitialized();
		const rows = environment
			? await this.all(
				`SELECT * FROM project_infrastructure_resources WHERE project_id = ? AND environment = ? ORDER BY provider ASC, resource_kind ASC, logical_name ASC`,
				[projectId, environment],
			)
			: await this.all(
				`SELECT * FROM project_infrastructure_resources WHERE project_id = ? ORDER BY environment ASC, provider ASC, resource_kind ASC, logical_name ASC`,
				[projectId],
			);
		return rows.map(serializeProjectInfrastructureResource);
	}

	async upsertProjectInfrastructureResource(projectId, input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const existing = await this.first(
			`SELECT * FROM project_infrastructure_resources
			 WHERE project_id = ? AND environment = ? AND provider = ? AND resource_kind = ? AND logical_name = ?
			 LIMIT 1`,
			[projectId, input.environment, input.provider, input.resourceKind, input.logicalName],
		);
		if (existing) {
			await this.run(
				`UPDATE project_infrastructure_resources
				 SET locator = ?, metadata_json = ?, updated_at = ?
				 WHERE id = ?`,
				[
					input.locator ?? null,
					JSON.stringify(input.metadata ?? parseJson(existing.metadata_json, {})),
					timestamp,
					existing.id,
				],
			);
			return serializeProjectInfrastructureResource(await this.first(`SELECT * FROM project_infrastructure_resources WHERE id = ?`, [existing.id]));
		}

		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO project_infrastructure_resources (
				id, project_id, environment, provider, resource_kind, logical_name, locator, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				projectId,
				input.environment,
				input.provider,
				input.resourceKind,
				input.logicalName,
				input.locator ?? null,
				JSON.stringify(input.metadata ?? {}),
				timestamp,
				timestamp,
			],
		);
		return serializeProjectInfrastructureResource(await this.first(`SELECT * FROM project_infrastructure_resources WHERE id = ?`, [id]));
	}

	async createProjectDeployment(projectId, input) {
		await this.ensureInitialized();
		const project = await this.getProject(projectId);
		if (!project) {
			throw new Error(`Unknown project "${projectId}".`);
		}
		if (input.idempotencyKey) {
			const existing = await this.findProjectDeploymentByIdempotencyKey(projectId, input.idempotencyKey);
			if (existing) return existing;
		}
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		const action = input.action ?? (input.deploymentKind === 'content' ? 'publish_content' : 'deploy_web');
		const status = normalizeProjectDeploymentStatus(input.status, 'queued');
		const completedAt = PROJECT_DEPLOYMENT_TERMINAL_STATUSES.has(status)
			? input.completedAt ?? input.finishedAt ?? timestamp
			: input.completedAt ?? null;
		await this.run(
			`INSERT INTO project_deployments (
				id, team_id, project_id, environment, deployment_kind, action, status,
				platform_operation_id, retry_of_deployment_id, resumed_from_deployment_id, idempotency_key, requested_by_user_id,
				source_ref, release_tag, commit_sha, triggered_by_type, triggered_by_id,
				repository_json, external_workflow_json, target_json, monitor_json, summary, error_json, metadata_json,
				started_at, finished_at, created_at, updated_at, completed_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				input.teamId ?? project.teamId,
				projectId,
				input.environment,
				input.deploymentKind ?? deploymentKindForAction(action),
				action,
				status,
				input.platformOperationId ?? null,
				input.retryOfDeploymentId ?? null,
				input.resumedFromDeploymentId ?? null,
				input.idempotencyKey ?? null,
				input.requestedByUserId ?? null,
				input.sourceRef ?? null,
				input.releaseTag ?? null,
				input.commitSha ?? null,
				input.triggeredByType ?? null,
				input.triggeredById ?? null,
				JSON.stringify(redactDeploymentValue(input.repository ?? {})),
				JSON.stringify(redactDeploymentValue(input.externalWorkflow ?? {})),
				JSON.stringify(redactDeploymentValue(input.target ?? {})),
				JSON.stringify(redactDeploymentValue(input.monitor ?? {})),
				input.summary ?? null,
				JSON.stringify(redactDeploymentValue(input.error ?? {})),
				JSON.stringify(redactDeploymentValue(input.metadata ?? {})),
				input.startedAt ?? timestamp,
				input.finishedAt ?? null,
				timestamp,
				timestamp,
				completedAt,
			],
		);
		const deployment = serializeProjectDeployment(await this.first(`SELECT * FROM project_deployments WHERE id = ?`, [id]));
		await this.appendProjectDeploymentEvent(id, {
			kind: 'deployment.requested',
			message: input.summary ?? `Queued ${action} for ${input.environment}.`,
			status,
			payload: { source: input.triggeredByType ?? input.source ?? null },
		}).catch(() => null);
		return deployment;
	}

	async findProjectDeploymentById(deploymentId) {
		await this.ensureInitialized();
		return serializeProjectDeployment(await this.first(`SELECT * FROM project_deployments WHERE id = ? LIMIT 1`, [deploymentId]));
	}

	async findProjectDeploymentByOperationId(operationId) {
		await this.ensureInitialized();
		return serializeProjectDeployment(await this.first(`SELECT * FROM project_deployments WHERE platform_operation_id = ? LIMIT 1`, [operationId]));
	}

	async findProjectDeploymentByIdempotencyKey(projectId, idempotencyKey) {
		await this.ensureInitialized();
		if (!idempotencyKey) return null;
		return serializeProjectDeployment(await this.first(
			`SELECT * FROM project_deployments WHERE project_id = ? AND idempotency_key = ? ORDER BY created_at DESC LIMIT 1`,
			[projectId, idempotencyKey],
		));
	}

	async listProjectDeployments(projectId, filters = null) {
		await this.ensureInitialized();
		const normalized = typeof filters === 'string' ? { environment: filters } : (filters && typeof filters === 'object' ? filters : {});
		const where = ['project_id = ?'];
		const params = [projectId];
		if (normalized.environment) {
			where.push('environment = ?');
			params.push(normalized.environment);
		}
		if (normalized.action) {
			where.push('action = ?');
			params.push(normalized.action);
		}
		if (normalized.status) {
			where.push('status = ?');
			params.push(normalized.status);
		}
		const limit = Math.max(1, Math.min(Number(normalized.limit ?? 100) || 100, 100));
		params.push(limit);
		const rows = await this.all(
			`SELECT * FROM project_deployments WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
			params,
		);
		return rows.map(serializeProjectDeployment);
	}

	async updateProjectDeployment(deploymentId, patch = {}) {
		await this.ensureInitialized();
		const existing = await this.findProjectDeploymentById(deploymentId);
		if (!existing) return null;
		const timestamp = isoNow();
		const status = patch.status ? normalizeProjectDeploymentStatus(patch.status, existing.status) : existing.status;
		const completedAt = existing.completedAt ?? (PROJECT_DEPLOYMENT_TERMINAL_STATUSES.has(status) ? patch.completedAt ?? patch.finishedAt ?? timestamp : null);
		await this.run(
			`UPDATE project_deployments
			 SET status = ?, platform_operation_id = ?, repository_json = ?, external_workflow_json = ?,
			     target_json = ?, monitor_json = ?, summary = ?, error_json = ?, metadata_json = ?,
			     finished_at = ?, updated_at = ?, completed_at = ?
			 WHERE id = ?`,
			[
				status,
				patch.platformOperationId ?? existing.platformOperationId ?? null,
				JSON.stringify(redactDeploymentValue(patch.repository ?? existing.repository ?? {})),
				JSON.stringify(redactDeploymentValue(patch.externalWorkflow ?? existing.externalWorkflow ?? {})),
				JSON.stringify(redactDeploymentValue(patch.target ?? existing.target ?? {})),
				JSON.stringify(redactDeploymentValue(patch.monitor ?? existing.monitor ?? {})),
				patch.summary ?? existing.summary ?? null,
				JSON.stringify(redactDeploymentValue(patch.error ?? existing.error ?? {})),
				JSON.stringify(redactDeploymentValue(patch.metadata ?? existing.metadata ?? {})),
				patch.finishedAt ?? existing.finishedAt ?? null,
				timestamp,
				completedAt,
				deploymentId,
			],
		);
		return this.findProjectDeploymentById(deploymentId);
	}

	async findLatestProjectDeployment(projectId, environment, action = null) {
		const rows = await this.listProjectDeployments(projectId, { environment, action: action ?? undefined, limit: 1 });
		return rows[0] ?? null;
	}

	async listActiveProjectDeployments(projectId, environment = null, action = null) {
		const deployments = await this.listProjectDeployments(projectId, { environment: environment ?? undefined, action: action ?? undefined, limit: 100 });
		return deployments.filter((deployment) => PROJECT_DEPLOYMENT_ACTIVE_STATUSES.has(deployment.status));
	}

	async createProjectDeploymentRetry(originalDeploymentId, input = {}) {
		const original = await this.findProjectDeploymentById(originalDeploymentId);
		if (!original) return null;
		return this.createProjectDeployment(original.projectId, {
			...input,
			environment: input.environment ?? original.environment,
			action: input.action ?? original.action,
			deploymentKind: input.deploymentKind ?? original.deploymentKind,
			retryOfDeploymentId: original.id,
			repository: input.repository ?? original.repository,
			target: input.target ?? original.target,
			metadata: { ...(original.metadata ?? {}), ...(input.metadata ?? {}) },
			sourceRef: input.sourceRef ?? original.sourceRef,
			triggeredByType: input.triggeredByType ?? 'user',
		});
	}

	async markProjectDeploymentCancellationRequested(deploymentId, actor = null) {
		const deployment = await this.findProjectDeploymentById(deploymentId);
		if (!deployment) return null;
		const metadata = {
			...(deployment.metadata ?? {}),
			cancellation: {
				requested: true,
				requestedAt: isoNow(),
				actor,
			},
		};
		const nextStatus = deployment.status === 'queued' ? 'cancelled' : deployment.status;
		const updated = await this.updateProjectDeployment(deploymentId, { status: nextStatus, metadata });
		await this.appendProjectDeploymentEvent(deploymentId, {
			kind: nextStatus === 'cancelled' ? 'deployment.cancelled' : 'deployment.cancellation_requested',
			message: nextStatus === 'cancelled' ? 'Deployment was cancelled before runner claim.' : 'Deployment cancellation was requested.',
			status: nextStatus,
			severity: 'warning',
		});
		return updated;
	}

	async appendProjectDeploymentEvent(deploymentId, event = {}) {
		await this.ensureInitialized();
		const deployment = await this.findProjectDeploymentById(deploymentId);
		if (!deployment) return null;
		const row = await this.first(
			`SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM project_deployment_events WHERE deployment_id = ?`,
			[deploymentId],
		);
		const sequence = Number(row?.next_sequence ?? 1);
		const id = event.id ?? randomUUID();
		await this.run(
			`INSERT INTO project_deployment_events (
				id, deployment_id, project_id, team_id, operation_id, kind, message, status, severity, sequence, payload_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				deploymentId,
				deployment.projectId,
				deployment.teamId,
				event.operationId ?? deployment.platformOperationId ?? null,
				event.kind ?? 'deployment.event',
				event.message ?? event.kind ?? 'Deployment event recorded.',
				event.status ?? deployment.status ?? null,
				event.severity ?? 'info',
				sequence,
				JSON.stringify(redactDeploymentValue(event.payload ?? {})),
				event.createdAt ?? isoNow(),
			],
		);
		return serializeProjectDeploymentEvent(await this.first(`SELECT * FROM project_deployment_events WHERE id = ?`, [id]));
	}

	async listProjectDeploymentEvents(deploymentId, filters = {}) {
		await this.ensureInitialized();
		const limit = Math.max(1, Math.min(Number(filters.limit ?? 200) || 200, 200));
		const rows = await this.all(
			`SELECT * FROM project_deployment_events WHERE deployment_id = ? ORDER BY sequence ASC LIMIT ?`,
			[deploymentId, limit],
		);
		const deploymentEvents = rows.map(serializeProjectDeploymentEvent);
		const deployment = await this.findProjectDeploymentById(deploymentId);
		if (!deployment?.platformOperationId) return deploymentEvents;
		const platformEvents = await this.listPlatformOperationEvents(deployment.platformOperationId).catch(() => []);
		const mapped = platformEvents.map((event) => ({
			id: `platform:${event.id}`,
			deploymentId,
			projectId: deployment.projectId,
			teamId: deployment.teamId,
			operationId: deployment.platformOperationId,
			kind: event.kind,
			message: event.data?.message ?? event.kind,
			status: event.data?.status ?? null,
			severity: event.data?.severity ?? 'info',
			sequence: 100000 + Number(event.seq ?? 0),
			payload: redactDeploymentValue(event.data ?? {}),
			createdAt: event.createdAt,
		}));
		return [...deploymentEvents, ...mapped].sort((left, right) => left.sequence - right.sequence);
	}

	async upsertAgentPool(projectId, input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const existing = await this.first(
			`SELECT * FROM agent_pools WHERE project_id = ? AND environment = ? AND name = ? LIMIT 1`,
			[projectId, input.environment, input.name],
		);
		if (existing) {
			await this.run(
				`UPDATE agent_pools
				 SET team_id = ?, registration_identity = ?, service_base_url = ?, status = ?, min_workers = ?, max_workers = ?, target_queue_depth = ?, cooldown_seconds = ?, metadata_json = ?, updated_at = ?
				 WHERE id = ?`,
				[
					input.teamId,
					input.registrationIdentity ?? null,
					input.serviceBaseUrl ?? null,
					input.status ?? 'active',
					input.autoscale?.minWorkers ?? 0,
					input.autoscale?.maxWorkers ?? 1,
					input.autoscale?.targetQueueDepth ?? 1,
					input.autoscale?.cooldownSeconds ?? 60,
					JSON.stringify(input.metadata ?? parseJson(existing.metadata_json, {})),
					timestamp,
					existing.id,
				],
			);
			return serializeAgentPool(await this.first(`SELECT * FROM agent_pools WHERE id = ?`, [existing.id]));
		}

		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO agent_pools (
				id, project_id, team_id, environment, name, registration_identity, service_base_url, status, min_workers, max_workers, target_queue_depth, cooldown_seconds, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				projectId,
				input.teamId,
				input.environment,
				input.name,
				input.registrationIdentity ?? null,
				input.serviceBaseUrl ?? null,
				input.status ?? 'active',
				input.autoscale?.minWorkers ?? 0,
				input.autoscale?.maxWorkers ?? 1,
				input.autoscale?.targetQueueDepth ?? 1,
				input.autoscale?.cooldownSeconds ?? 60,
				JSON.stringify(input.metadata ?? {}),
				timestamp,
				timestamp,
			],
		);
		return serializeAgentPool(await this.first(`SELECT * FROM agent_pools WHERE id = ?`, [id]));
	}

	async listAgentPools(projectId, environment = null) {
		await this.ensureInitialized();
		const rows = environment
			? await this.all(
				`SELECT * FROM agent_pools WHERE project_id = ? AND environment = ? ORDER BY created_at ASC`,
				[projectId, environment],
			)
			: await this.all(
				`SELECT * FROM agent_pools WHERE project_id = ? ORDER BY environment ASC, created_at ASC`,
				[projectId],
			);
		return rows.map(serializeAgentPool);
	}

	async recordAgentPoolRegistration(projectId, input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO agent_pool_registrations (
				id, pool_id, project_id, runner_id, manager_id, service_name, heartbeat_at, desired_workers, observed_queue_depth, observed_active_leases, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				input.poolId,
				projectId,
				input.runnerId ?? null,
				input.managerId ?? null,
				input.serviceName ?? null,
				input.heartbeatAt ?? timestamp,
				input.desiredWorkers ?? null,
				input.observedQueueDepth ?? null,
				input.observedActiveLeases ?? null,
				JSON.stringify(input.metadata ?? {}),
				timestamp,
				timestamp,
			],
		);
		return serializeAgentPoolRegistration(await this.first(`SELECT * FROM agent_pool_registrations WHERE id = ?`, [id]));
	}

	async listAgentPoolRegistrations(poolId) {
		await this.ensureInitialized();
		const rows = await this.all(
			`SELECT * FROM agent_pool_registrations WHERE pool_id = ? ORDER BY heartbeat_at DESC`,
			[poolId],
		);
		return rows.map(serializeAgentPoolRegistration);
	}

	async recordAgentPoolScaleDecision(projectId, input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO agent_pool_scale_decisions (
				id, pool_id, project_id, environment, desired_workers, observed_queue_depth, observed_active_leases, work_day_id, reason, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				input.poolId,
				projectId,
				input.environment,
				input.desiredWorkers,
				input.observedQueueDepth ?? 0,
				input.observedActiveLeases ?? 0,
				input.workDayId ?? null,
				input.reason,
				JSON.stringify(input.metadata ?? {}),
				timestamp,
				timestamp,
			],
		);
		return serializeAgentPoolScaleDecision(await this.first(`SELECT * FROM agent_pool_scale_decisions WHERE id = ?`, [id]));
	}

	async listAgentPoolScaleDecisions(poolId) {
		await this.ensureInitialized();
		const rows = await this.all(
			`SELECT * FROM agent_pool_scale_decisions WHERE pool_id = ? ORDER BY created_at DESC`,
			[poolId],
		);
		return rows.map(serializeAgentPoolScaleDecision);
	}

	async createProjectWorkdaySummary(projectId, input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO project_workday_summaries (
				id, project_id, environment, work_day_id, kind, state, started_at, ended_at, summary_json, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				projectId,
				input.environment,
				input.workDayId,
				input.kind ?? 'workday_summary',
				input.state ?? null,
				input.startedAt ?? null,
				input.endedAt ?? null,
				JSON.stringify(input.summary ?? {}),
				JSON.stringify(input.metadata ?? {}),
				timestamp,
				timestamp,
			],
		);
		return serializeProjectWorkdaySummary(await this.first(`SELECT * FROM project_workday_summaries WHERE id = ?`, [id]));
	}

	async listProjectWorkdaySummaries(projectId, environment = null) {
		await this.ensureInitialized();
		const rows = environment
			? await this.all(
				`SELECT * FROM project_workday_summaries WHERE project_id = ? AND environment = ? ORDER BY created_at DESC`,
				[projectId, environment],
			)
			: await this.all(
				`SELECT * FROM project_workday_summaries WHERE project_id = ? ORDER BY created_at DESC`,
				[projectId],
			);
		return rows.map(serializeProjectWorkdaySummary);
	}

	async startRuntimeWorkDay(projectId, input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		const existing = await this.first(`SELECT * FROM work_days WHERE id = ? LIMIT 1`, [id]);
		if (existing) return serializeRuntimeWorkDay(existing);
		await this.run(
			`INSERT INTO work_days (
				id, project_id, state, capacity_budget, capacity_used, graph_version, summary_json, started_at, ended_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				projectId,
				input.state ?? 'active',
				Number(input.capacityBudget ?? 0),
				Number(input.capacityUsed ?? 0),
				input.graphVersion ?? null,
				JSON.stringify(input.summary ?? {}),
				input.startedAt ?? timestamp,
				input.endedAt ?? null,
				timestamp,
				timestamp,
			],
		);
		return serializeRuntimeWorkDay(await this.first(`SELECT * FROM work_days WHERE id = ? LIMIT 1`, [id]));
	}

	async closeRuntimeWorkDay(projectId, workDayId, input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const existing = await this.first(`SELECT * FROM work_days WHERE id = ? AND project_id = ? LIMIT 1`, [workDayId, projectId]);
		if (!existing) return null;
		await this.run(
			`UPDATE work_days SET state = ?, summary_json = ?, ended_at = ?, updated_at = ? WHERE id = ? AND project_id = ?`,
			[
				input.state ?? 'completed',
				JSON.stringify(input.summary ?? parseJson(existing.summary_json, {})),
				input.endedAt ?? timestamp,
				timestamp,
				workDayId,
				projectId,
			],
		);
		return serializeRuntimeWorkDay(await this.first(`SELECT * FROM work_days WHERE id = ? AND project_id = ? LIMIT 1`, [workDayId, projectId]));
	}

	async listRuntimeWorkDays(projectId, input = {}) {
		await this.ensureInitialized();
		const limit = Math.max(1, Math.min(1000, Number(input.limit ?? 10)));
		const rows = input.state
			? await this.all(
				`SELECT * FROM work_days WHERE project_id = ? AND state = ? ORDER BY updated_at DESC LIMIT ?`,
				[projectId, input.state, limit],
			)
			: await this.all(
				`SELECT * FROM work_days WHERE project_id = ? ORDER BY updated_at DESC LIMIT ?`,
				[projectId, limit],
			);
		return rows.map(serializeRuntimeWorkDay);
	}

	async createRuntimeTask(projectId, input) {
		await this.ensureInitialized();
		const workDay = await this.first(`SELECT * FROM work_days WHERE id = ? AND project_id = ? LIMIT 1`, [input.workDayId, projectId]);
		if (!workDay) return null;
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT OR IGNORE INTO tasks (
				id, work_day_id, agent_id, type, state, priority, idempotency_key, payload_json, payload_hash,
				attempt_count, max_attempts, claimed_by, lease_expires_at, available_at, last_error_code, last_error_message,
				graph_version, parent_task_id, created_at, started_at, completed_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, ?, NULL, NULL, ?, ?, ?, NULL, NULL, ?)`,
			[
				id,
				input.workDayId,
				input.agentId,
				input.type,
				input.state ?? 'pending',
				Number(input.priority ?? 0),
				input.idempotencyKey,
				JSON.stringify(input.payload ?? {}),
				input.payloadHash ?? null,
				Number(input.maxAttempts ?? 3),
				input.availableAt ?? timestamp,
				input.graphVersion ?? null,
				input.parentTaskId ?? null,
				timestamp,
				timestamp,
			],
		);
		return serializeRuntimeTask(await this.first(
			`SELECT tasks.* FROM tasks JOIN work_days ON work_days.id = tasks.work_day_id WHERE work_days.project_id = ? AND (tasks.id = ? OR tasks.idempotency_key = ?) LIMIT 1`,
			[projectId, id, input.idempotencyKey],
		));
	}

	async listRuntimeTasks(projectId, input = {}) {
		await this.ensureInitialized();
		const clauses = ['work_days.project_id = ?'];
		const params = [projectId];
		if (input.workDayId) {
			clauses.push('tasks.work_day_id = ?');
			params.push(input.workDayId);
		}
		if (input.agentId) {
			clauses.push('tasks.agent_id = ?');
			params.push(input.agentId);
		}
		if (input.state) {
			const states = Array.isArray(input.state) ? input.state : String(input.state).split(',').filter(Boolean);
			clauses.push(`tasks.state IN (${states.map(() => '?').join(', ')})`);
			params.push(...states);
		}
		const limit = Math.max(1, Math.min(1000, Number(input.limit ?? 50)));
		params.push(limit);
		const rows = await this.all(
			`SELECT tasks.* FROM tasks JOIN work_days ON work_days.id = tasks.work_day_id WHERE ${clauses.join(' AND ')} ORDER BY tasks.priority DESC, tasks.available_at ASC LIMIT ?`,
			params,
		);
		return rows.map(serializeRuntimeTask);
	}

	async claimRuntimeTask(projectId, taskId, input) {
		await this.ensureInitialized();
		const existing = await this.first(
			`SELECT tasks.* FROM tasks JOIN work_days ON work_days.id = tasks.work_day_id WHERE work_days.project_id = ? AND tasks.id = ? LIMIT 1`,
			[projectId, taskId],
		);
		if (!existing) return null;
		const timestamp = isoNow();
		const leaseExpiresAt = new Date(Date.now() + Number(input.leaseSeconds ?? 300) * 1000).toISOString();
		await this.run(
			`UPDATE tasks SET state = 'claimed', claimed_by = ?, lease_expires_at = ?, attempt_count = attempt_count + 1, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?`,
			[input.workerId, leaseExpiresAt, timestamp, timestamp, taskId],
		);
		return serializeRuntimeTask(await this.first(`SELECT * FROM tasks WHERE id = ? LIMIT 1`, [taskId]));
	}

	async recordRuntimeTaskProgress(projectId, taskId, input) {
		await this.ensureInitialized();
		const existing = await this.first(
			`SELECT tasks.* FROM tasks JOIN work_days ON work_days.id = tasks.work_day_id WHERE work_days.project_id = ? AND tasks.id = ? LIMIT 1`,
			[projectId, taskId],
		);
		if (!existing) return null;
		const payload = {
			...parseJson(existing.payload_json, {}),
			...(input.patch ?? {}),
		};
		await this.run(
			`UPDATE tasks SET state = ?, claimed_by = COALESCE(?, claimed_by), payload_json = ?, updated_at = ? WHERE id = ?`,
			[input.state ?? existing.state, input.workerId ?? null, JSON.stringify(payload), isoNow(), taskId],
		);
		if (input.appendEvent?.kind) {
			await this.appendRuntimeTaskEvent(projectId, taskId, {
				kind: input.appendEvent.kind,
				data: input.appendEvent.data ?? {},
				actor: input.actor,
			});
		}
		return serializeRuntimeTask(await this.first(`SELECT * FROM tasks WHERE id = ? LIMIT 1`, [taskId]));
	}

	async completeRuntimeTask(projectId, taskId, input) {
		await this.ensureInitialized();
		const existing = await this.first(
			`SELECT tasks.* FROM tasks JOIN work_days ON work_days.id = tasks.work_day_id WHERE work_days.project_id = ? AND tasks.id = ? LIMIT 1`,
			[projectId, taskId],
		);
		if (!existing) return null;
		const timestamp = isoNow();
		await this.run(
			`UPDATE tasks SET state = 'completed', completed_at = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
			[timestamp, timestamp, taskId],
		);
		if (input.output) {
			await this.run(
				`INSERT INTO task_outputs (id, task_id, output_json, output_ref, created_at) VALUES (?, ?, ?, ?, ?)`,
				[randomUUID(), taskId, JSON.stringify(input.output), input.outputRef ?? null, timestamp],
			);
		}
		if (input.summary) {
			await this.appendRuntimeTaskEvent(projectId, taskId, {
				kind: 'completed',
				data: input.summary,
				actor: input.actor,
			});
		}
		return serializeRuntimeTask(await this.first(`SELECT * FROM tasks WHERE id = ? LIMIT 1`, [taskId]));
	}

	async storeRunnerTaskOutputArtifact(projectId, input) {
		await this.ensureInitialized();
		const project = await this.getProject(projectId);
		if (!project) return null;
		const timestamp = isoNow();
		const contentType = typeof input.contentType === 'string' && input.contentType.trim()
			? input.contentType.trim()
			: 'application/json';
		const buffer = input.contentBase64
			? Buffer.from(String(input.contentBase64), 'base64')
			: Buffer.from(typeof input.content === 'string' ? input.content : JSON.stringify(input.content ?? {}));
		const sha256 = createHash('sha256').update(buffer).digest('hex');
		if (input.sha256 && String(input.sha256) !== sha256) {
			const error = new Error('Artifact body checksum does not match sha256.');
			error.code = 'artifact_checksum_mismatch';
			throw error;
		}
		const objectKey = safeStoragePathSegment(
			input.objectKey
			?? `agent-artifacts/${projectId}/${timestamp.slice(0, 10)}/${randomUUID()}.json`,
		);
		if (!objectKey) {
			const error = new Error('objectKey is required.');
			error.code = 'artifact_object_key_required';
			throw error;
		}
		let storageMode = 'local_r2_emulation';
		if (this.artifactBucket && typeof this.artifactBucket.put === 'function') {
			await this.artifactBucket.put(objectKey, buffer, {
				httpMetadata: { contentType },
				customMetadata: { sha256, projectId, teamId: project.teamId },
			});
			storageMode = 'cloudflare_r2';
		} else {
			const fs = getNodeBuiltin('fs');
			const path = getNodeBuiltin('path');
			if (!fs || !path) {
				const error = new Error('Artifact body storage is not available in this runtime.');
				error.code = 'artifact_storage_unavailable';
				throw error;
			}
			const root = artifactStorageRoot(this.config);
			const filePath = path.resolve(root, projectId, objectKey);
			const projectRoot = path.resolve(root, projectId);
			if (!filePath.startsWith(projectRoot + path.sep) && filePath !== projectRoot) {
				const error = new Error('Artifact objectKey escapes the project storage root.');
				error.code = 'artifact_object_key_forbidden';
				throw error;
			}
			await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
			await fs.promises.writeFile(filePath, buffer);
		}
		return {
			artifactStorage: 'r2',
			storageMode,
			outputRef: `r2:${objectKey}`,
			objectKey,
			contentType,
			sizeBytes: buffer.byteLength,
			sha256,
			teamId: project.teamId,
			projectId,
			createdAt: timestamp,
		};
	}

	async resolveRuntimeTaskOutput(row, projectId) {
		const serialized = serializeRuntimeTaskOutput(row);
		if (!serialized?.outputRef) return serialized;
		if (!String(serialized.outputRef).startsWith('r2:')) {
			return serialized;
		}
		const objectKey = safeStoragePathSegment(String(serialized.outputRef).slice(3));
		if (this.artifactBucket && typeof this.artifactBucket.get === 'function') {
			try {
				const object = await this.artifactBucket.get(objectKey);
				if (!object) throw new Error(`Artifact object ${objectKey} was not found.`);
				const content = typeof object.text === 'function'
					? await object.text()
					: typeof object.arrayBuffer === 'function'
						? Buffer.from(await object.arrayBuffer()).toString('utf8')
						: '';
				const parsed = parseJson(content, null);
				if (parsed && typeof parsed === 'object') {
					return {
						...serialized,
						outputJson: JSON.stringify({
							...parsed,
							outputRef: serialized.outputRef,
							outputMetadata: serialized.output,
						}),
						output: {
							...parsed,
							outputRef: serialized.outputRef,
							outputMetadata: serialized.output,
						},
					};
				}
				return {
					...serialized,
					outputJson: JSON.stringify({ outputRef: serialized.outputRef, content }),
					output: { outputRef: serialized.outputRef, content },
				};
			} catch (error) {
				return {
					...serialized,
					outputJson: JSON.stringify({
						outputRef: serialized.outputRef,
						outputResolutionError: error instanceof Error ? error.message : String(error),
					}),
					output: {
						outputRef: serialized.outputRef,
						outputResolutionError: error instanceof Error ? error.message : String(error),
					},
				};
			}
		}
		const fs = getNodeBuiltin('fs');
		const path = getNodeBuiltin('path');
		if (!fs || !path) {
			return serialized;
		}
		const root = artifactStorageRoot(this.config);
		const filePath = path.resolve(root, projectId, objectKey);
		const projectRoot = path.resolve(root, projectId);
		if (!filePath.startsWith(projectRoot + path.sep) && filePath !== projectRoot) {
			return {
				...serialized,
				output: {
					...serialized.output,
					outputResolutionError: 'artifact_object_key_forbidden',
				},
			};
		}
		try {
			const content = await fs.promises.readFile(filePath, 'utf8');
			const parsed = parseJson(content, null);
			if (parsed && typeof parsed === 'object') {
				return {
					...serialized,
					outputJson: JSON.stringify({
						...parsed,
						outputRef: serialized.outputRef,
						outputMetadata: serialized.output,
					}),
					output: {
						...parsed,
						outputRef: serialized.outputRef,
						outputMetadata: serialized.output,
					},
				};
			}
			return {
				...serialized,
				outputJson: JSON.stringify({
					...serialized.output,
					outputRef: serialized.outputRef,
					content,
				}),
				output: {
					...serialized.output,
					outputRef: serialized.outputRef,
					content,
				},
			};
		} catch (error) {
			return {
				...serialized,
				outputJson: JSON.stringify({
					...serialized.output,
					outputRef: serialized.outputRef,
					outputResolutionError: error instanceof Error ? error.message : String(error),
				}),
				output: {
					...serialized.output,
					outputRef: serialized.outputRef,
					outputResolutionError: error instanceof Error ? error.message : String(error),
				},
			};
		}
	}

	async failRuntimeTask(projectId, taskId, input) {
		await this.ensureInitialized();
		const existing = await this.first(
			`SELECT tasks.* FROM tasks JOIN work_days ON work_days.id = tasks.work_day_id WHERE work_days.project_id = ? AND tasks.id = ? LIMIT 1`,
			[projectId, taskId],
		);
		if (!existing) return null;
		await this.run(
			`UPDATE tasks SET state = ?, available_at = ?, last_error_code = ?, last_error_message = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
			[
				input.retryable ? 'pending' : 'failed',
				input.nextVisibleAt ?? existing.available_at,
				input.errorCode ?? null,
				input.errorMessage,
				isoNow(),
				taskId,
			],
		);
		await this.appendRuntimeTaskEvent(projectId, taskId, {
			kind: input.retryable ? 'retry_scheduled' : 'failed',
			data: { errorCode: input.errorCode ?? null, errorMessage: input.errorMessage },
			actor: input.actor,
		});
		return serializeRuntimeTask(await this.first(`SELECT * FROM tasks WHERE id = ? LIMIT 1`, [taskId]));
	}

	async appendRuntimeTaskEvent(projectId, taskId, input) {
		await this.ensureInitialized();
		const existing = await this.first(
			`SELECT tasks.id FROM tasks JOIN work_days ON work_days.id = tasks.work_day_id WHERE work_days.project_id = ? AND tasks.id = ? LIMIT 1`,
			[projectId, taskId],
		);
		if (!existing) return null;
		const row = await this.first(`SELECT COALESCE(MAX(seq), 0) AS max_seq FROM task_events WHERE task_id = ?`, [taskId]);
		const seq = Number(row?.max_seq ?? 0) + 1;
		const id = randomUUID();
		await this.run(
			`INSERT INTO task_events (id, task_id, seq, kind, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
			[id, taskId, seq, input.kind, JSON.stringify({ ...(input.data ?? {}), actor: input.actor }), isoNow()],
		);
		return serializeRuntimeTaskEvent(await this.first(`SELECT * FROM task_events WHERE id = ? LIMIT 1`, [id]));
	}

	async listRuntimeTaskEvents(projectId, taskId) {
		await this.ensureInitialized();
		const rows = await this.all(
			`SELECT task_events.* FROM task_events JOIN tasks ON tasks.id = task_events.task_id JOIN work_days ON work_days.id = tasks.work_day_id WHERE work_days.project_id = ? AND tasks.id = ? ORDER BY task_events.seq ASC`,
			[projectId, taskId],
		);
		return rows.map(serializeRuntimeTaskEvent);
	}

	async listRuntimeTaskOutputs(projectId, taskId) {
		await this.ensureInitialized();
		const rows = await this.all(
			`SELECT task_outputs.* FROM task_outputs JOIN tasks ON tasks.id = task_outputs.task_id JOIN work_days ON work_days.id = tasks.work_day_id WHERE work_days.project_id = ? AND tasks.id = ? ORDER BY task_outputs.created_at ASC`,
			[projectId, taskId],
		);
		return Promise.all(rows.map((row) => this.resolveRuntimeTaskOutput(row, projectId)));
	}

	async createRuntimeReport(input) {
		await this.ensureInitialized();
		const workDay = await this.first(`SELECT * FROM work_days WHERE id = ? LIMIT 1`, [input.workDayId]);
		if (!workDay) return null;
		const id = input.id ?? randomUUID();
		const timestamp = isoNow();
		await this.run(
			`INSERT INTO reports (id, work_day_id, kind, body_json, rendered_ref, sent_at, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				input.workDayId,
				String(input.kind ?? 'capacity_provider_report'),
				JSON.stringify(input.body ?? {}),
				input.renderedRef ?? null,
				input.sentAt ?? null,
				timestamp,
			],
		);
		return serializeRuntimeReport(await this.first(`SELECT * FROM reports WHERE id = ? LIMIT 1`, [id]));
	}

	async getRuntimeManagerContext(projectId, taskId) {
		await this.ensureInitialized();
		const task = serializeRuntimeTask(await this.first(
			`SELECT tasks.* FROM tasks JOIN work_days ON work_days.id = tasks.work_day_id WHERE work_days.project_id = ? AND tasks.id = ? LIMIT 1`,
			[projectId, taskId],
		));
		const workDay = task ? serializeRuntimeWorkDay(await this.first(`SELECT * FROM work_days WHERE id = ? LIMIT 1`, [task.workDayId])) : null;
		return {
			task,
			workDay,
			agent: null,
			graph: workDay?.graphVersion ? { graphVersion: workDay.graphVersion } : null,
		};
	}

	async getProjectWorkPolicy(projectId, environment) {
		await this.ensureInitialized();
		return serializeWorkPolicy(await this.first(
			`SELECT * FROM work_policies WHERE project_id = ? AND environment = ? LIMIT 1`,
			[projectId, environment],
		));
	}

	async upsertProjectWorkPolicy(projectId, input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const dailyCreditBudget = Number(input.dailyCreditBudget ?? input.dailyTaskCreditBudget ?? 0);
		await this.run(
			`INSERT OR REPLACE INTO work_policies (
				project_id, environment, schedule_json, enabled, start_cron, duration_minutes, max_runners, max_workers_per_runner,
				daily_credit_budget, closeout_grace_minutes, daily_task_credit_budget, max_queued_tasks, max_queued_credits,
				autoscale_json, credit_weights_json, metadata_json, created_at, updated_at
			) VALUES (
				?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
				COALESCE((SELECT created_at FROM work_policies WHERE project_id = ? AND environment = ?), ?),
				?
			)`,
			[
				projectId,
				input.environment,
				JSON.stringify(input.schedule ?? { timezone: 'UTC', windows: [] }),
				input.enabled === false ? 0 : 1,
				input.startCron ?? '0 9 * * 1-5',
				Number(input.durationMinutes ?? 480),
				Number(input.maxRunners ?? input.autoscale?.maxWorkers ?? 1),
				Number(input.maxWorkersPerRunner ?? 4),
				dailyCreditBudget,
				Number(input.closeoutGraceMinutes ?? 15),
				dailyCreditBudget,
				Number(input.maxQueuedTasks ?? 0),
				Number(input.maxQueuedCredits ?? 0),
				JSON.stringify(input.autoscale ?? {}),
				JSON.stringify(input.creditWeights ?? []),
				JSON.stringify(input.metadata ?? {}),
				projectId,
				input.environment,
				timestamp,
				timestamp,
			],
		);
		return this.getProjectWorkPolicy(projectId, input.environment);
	}

	async createWorkdayRequest(projectId, input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO workday_requests (
				id, project_id, environment, type, state, work_day_id, requested_by, reason, payload_json, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				projectId,
				input.environment,
				input.type,
				input.state ?? 'pending',
				input.workDayId ?? null,
				input.requestedBy ?? null,
				input.reason ?? null,
				JSON.stringify(input.payload ?? {}),
				JSON.stringify(input.metadata ?? {}),
				timestamp,
				timestamp,
			],
		);
		return serializeWorkdayRequest(await this.first(`SELECT * FROM workday_requests WHERE id = ?`, [id]));
	}

	async listWorkdayRequests(projectId, environment, state = null) {
		await this.ensureInitialized();
		const rows = state
			? await this.all(
				`SELECT * FROM workday_requests WHERE project_id = ? AND environment = ? AND state = ? ORDER BY created_at ASC`,
				[projectId, environment, state],
			)
			: await this.all(
				`SELECT * FROM workday_requests WHERE project_id = ? AND environment = ? ORDER BY created_at ASC`,
				[projectId, environment],
			);
		return rows.map(serializeWorkdayRequest);
	}

	async claimWorkdayManagerLease(projectId, input) {
		await this.ensureInitialized();
		const timestamp = input.now ?? isoNow();
		const nowMs = Date.parse(timestamp);
		const ttlSeconds = Number(input.ttlSeconds ?? 60);
		const staleAfterSeconds = Number(input.staleAfterSeconds ?? ttlSeconds);
		const existing = await this.first(
			`SELECT * FROM workday_manager_leases WHERE project_id = ? AND environment = ? AND state = 'active' ORDER BY heartbeat_at DESC LIMIT 1`,
			[projectId, input.environment],
		);
		if (existing && existing.manager_id !== input.managerId) {
			const heartbeatMs = Date.parse(existing.heartbeat_at);
			if (Number.isFinite(heartbeatMs) && Number.isFinite(nowMs) && nowMs - heartbeatMs <= staleAfterSeconds * 1000) {
				return null;
			}
		}
		const id = existing?.id ?? input.id ?? randomUUID();
		await this.run(
			`INSERT OR REPLACE INTO workday_manager_leases (
				id, project_id, environment, work_day_id, manager_id, state, heartbeat_at, expires_at, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?,
				COALESCE((SELECT created_at FROM workday_manager_leases WHERE id = ?), ?),
				?
			)`,
			[
				id,
				projectId,
				input.environment,
				input.workDayId ?? existing?.work_day_id ?? null,
				input.managerId,
				timestamp,
				new Date(Date.parse(timestamp) + ttlSeconds * 1000).toISOString(),
				JSON.stringify(input.metadata ?? parseJson(existing?.metadata_json, {})),
				id,
				timestamp,
				timestamp,
			],
		);
		return serializeWorkdayManagerLease(await this.first(`SELECT * FROM workday_manager_leases WHERE id = ? LIMIT 1`, [id]));
	}

	async releaseWorkdayManagerLease(projectId, input) {
		await this.ensureInitialized();
		const existing = await this.first(
			`SELECT * FROM workday_manager_leases WHERE id = ? AND project_id = ? LIMIT 1`,
			[input.id, projectId],
		);
		if (!existing || existing.manager_id !== input.managerId) return null;
		await this.run(`UPDATE workday_manager_leases SET state = 'released', updated_at = ? WHERE id = ?`, [isoNow(), input.id]);
		return serializeWorkdayManagerLease(await this.first(`SELECT * FROM workday_manager_leases WHERE id = ? LIMIT 1`, [input.id]));
	}

	async listWorkdayManagerLeases(projectId, environment) {
		await this.ensureInitialized();
		const rows = await this.all(
			`SELECT * FROM workday_manager_leases WHERE project_id = ? AND environment = ? ORDER BY heartbeat_at DESC LIMIT 10`,
			[projectId, environment],
		);
		return rows.map(serializeWorkdayManagerLease);
	}

	async recordWorkerRunner(projectId, input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? `${projectId}:${input.environment}:${input.runnerId}`;
		const maxLocalWorkers = Number(input.maxLocalWorkers ?? 4);
		const activeLocalWorkers = Number(input.activeLocalWorkers ?? 0);
		await this.run(
			`INSERT OR REPLACE INTO worker_runners (
				id, project_id, environment, runner_id, runner_service_name, volume_identity, state, max_local_workers, active_local_workers,
				available_capacity, last_heartbeat_at, claimed_repository_ids_json, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
				COALESCE((SELECT created_at FROM worker_runners WHERE id = ?), ?),
				?
			)`,
			[
				id,
				projectId,
				input.environment,
				input.runnerId,
				input.runnerServiceName,
				input.volumeIdentity,
				input.state ?? 'active',
				maxLocalWorkers,
				activeLocalWorkers,
				Math.max(0, maxLocalWorkers - activeLocalWorkers),
				input.lastHeartbeatAt ?? timestamp,
				JSON.stringify(input.claimedRepositoryIds ?? []),
				JSON.stringify(input.metadata ?? {}),
				id,
				timestamp,
				timestamp,
			],
		);
		return serializeWorkerRunner(await this.first(`SELECT * FROM worker_runners WHERE id = ?`, [id]));
	}

	async listWorkerRunners(projectId, environment) {
		await this.ensureInitialized();
		const rows = await this.all(
			`SELECT * FROM worker_runners WHERE project_id = ? AND environment = ? ORDER BY runner_id ASC`,
			[projectId, environment],
		);
		return rows.map(serializeWorkerRunner);
	}

	async recordRepositoryClaim(projectId, input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? `${projectId}:${input.repositoryId}:${input.runnerId}`;
		await this.run(
			`INSERT OR REPLACE INTO repository_claims (
				id, project_id, repository_id, runner_id, runner_service_name, volume_identity, last_seen_commit, last_task_at, claim_state, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
				COALESCE((SELECT created_at FROM repository_claims WHERE id = ?), ?),
				?
			)`,
			[
				id,
				projectId,
				input.repositoryId,
				input.runnerId,
				input.runnerServiceName,
				input.volumeIdentity,
				input.lastSeenCommit ?? null,
				input.lastTaskAt ?? timestamp,
				input.claimState ?? 'active',
				JSON.stringify(input.metadata ?? {}),
				id,
				timestamp,
				timestamp,
			],
		);
		return serializeRepositoryClaim(await this.first(`SELECT * FROM repository_claims WHERE id = ?`, [id]));
	}

	async listRepositoryClaims(projectId, repositoryId = null) {
		await this.ensureInitialized();
		const rows = repositoryId
			? await this.all(
				`SELECT * FROM repository_claims WHERE project_id = ? AND repository_id = ? ORDER BY updated_at DESC`,
				[projectId, repositoryId],
			)
			: await this.all(
				`SELECT * FROM repository_claims WHERE project_id = ? ORDER BY updated_at DESC`,
				[projectId],
			);
		return rows.map(serializeRepositoryClaim);
	}

	async recordRunnerScaleDecision(projectId, input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO runner_scale_decisions (
				id, project_id, environment, work_day_id, runner_id, runner_service_name, action, reason, metadata_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				projectId,
				input.environment,
				input.workDayId ?? null,
				input.runnerId ?? null,
				input.runnerServiceName ?? null,
				input.action,
				input.reason,
				JSON.stringify(input.metadata ?? {}),
				timestamp,
			],
		);
		return serializeRunnerScaleDecision(await this.first(`SELECT * FROM runner_scale_decisions WHERE id = ?`, [id]));
	}

	async listRunnerScaleDecisions(projectId, environment, workDayId = null) {
		await this.ensureInitialized();
		const rows = workDayId
			? await this.all(
				`SELECT * FROM runner_scale_decisions WHERE project_id = ? AND environment = ? AND work_day_id = ? ORDER BY created_at DESC`,
				[projectId, environment, workDayId],
			)
			: await this.all(
				`SELECT * FROM runner_scale_decisions WHERE project_id = ? AND environment = ? ORDER BY created_at DESC`,
				[projectId, environment],
			);
		return rows.map(serializeRunnerScaleDecision);
	}

	async listProjectPriorityOverrides(projectId) {
		await this.ensureInitialized();
		const rows = await this.all(
			`SELECT * FROM priority_overrides WHERE project_id = ? ORDER BY priority DESC, updated_at DESC`,
			[projectId],
		);
		return rows.map(serializePriorityOverride);
	}

	async upsertProjectPriorityOverride(projectId, input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT OR REPLACE INTO priority_overrides (
				id, project_id, model, subject_id, priority, estimated_credits, metadata_json, created_at, updated_at
			) VALUES (
				?, ?, ?, ?, ?, ?, ?,
				COALESCE((SELECT created_at FROM priority_overrides WHERE id = ?), ?),
				?
			)`,
			[
				id,
				projectId,
				input.model,
				input.subjectId,
				Number(input.priority ?? 0),
				input.estimatedCredits === null || input.estimatedCredits === undefined ? null : Number(input.estimatedCredits),
				JSON.stringify(input.metadata ?? {}),
				id,
				timestamp,
				timestamp,
			],
		);
		return serializePriorityOverride(await this.first(`SELECT * FROM priority_overrides WHERE id = ? LIMIT 1`, [id]));
	}

	async createProjectPrioritySnapshot(projectId, input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT OR REPLACE INTO priority_snapshots (
				id, project_id, work_day_id, snapshot_json, metadata_json, generated_at, created_at, updated_at
			) VALUES (
				?, ?, ?, ?, ?, ?,
				COALESCE((SELECT created_at FROM priority_snapshots WHERE id = ?), ?),
				?
			)`,
			[
				id,
				projectId,
				input.workDayId ?? null,
				JSON.stringify(input.snapshot ?? {}),
				JSON.stringify(input.metadata ?? {}),
				input.generatedAt ?? timestamp,
				id,
				timestamp,
				timestamp,
			],
		);
		return serializePrioritySnapshot(await this.first(`SELECT * FROM priority_snapshots WHERE id = ? LIMIT 1`, [id]));
	}

	async listProjectPrioritySnapshots(projectId, workDayId = null) {
		await this.ensureInitialized();
		const rows = workDayId
			? await this.all(
				`SELECT * FROM priority_snapshots WHERE project_id = ? AND work_day_id = ? ORDER BY generated_at DESC`,
				[projectId, workDayId],
			)
			: await this.all(
				`SELECT * FROM priority_snapshots WHERE project_id = ? ORDER BY generated_at DESC`,
				[projectId],
			);
		return rows.map(serializePrioritySnapshot);
	}

	async recordProjectTaskCredits(projectId, input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO task_credit_ledger (
				id, project_id, work_day_id, task_id, phase, credits, metadata_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				projectId,
				input.workDayId,
				input.taskId ?? null,
				input.phase,
				Number(input.credits ?? 0),
				JSON.stringify(input.metadata ?? {}),
				timestamp,
			],
		);
		return serializeTaskCreditLedgerEntry(await this.first(`SELECT * FROM task_credit_ledger WHERE id = ? LIMIT 1`, [id]));
	}

	async listProjectTaskCredits(projectId, workDayId) {
		await this.ensureInitialized();
		const rows = await this.all(
			`SELECT * FROM task_credit_ledger WHERE project_id = ? AND work_day_id = ? ORDER BY created_at ASC`,
			[projectId, workDayId],
		);
		return rows.map(serializeTaskCreditLedgerEntry);
	}

	async issueRunnerToken(projectId) {
		const token = `prjrun_${randomUUID().replaceAll('-', '')}`;
		const timestamp = isoNow();
		const existing = await this.first(`SELECT * FROM project_connections WHERE project_id = ?`, [projectId]);
		if (existing) {
			await this.run(
				`UPDATE project_connections
				 SET runner_key_prefix = ?, runner_key_hash = ?, updated_at = ?
				 WHERE project_id = ?`,
				[tokenPrefix(token), stableHash(token, this.config.authSecret), timestamp, projectId],
			);
		}
		return token;
	}

	async upsertProjectConnection(projectId, input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const existing = await this.first(`SELECT * FROM project_connections WHERE project_id = ?`, [projectId]);
		let runnerToken = null;
		if (!existing) {
			runnerToken = `prjrun_${randomUUID().replaceAll('-', '')}`;
			await this.run(
				`INSERT INTO project_connections (
					id, project_id, mode, project_api_base_url, execution_owner, runner_registration_state,
					runner_key_prefix, runner_key_hash, runner_registered_at, runner_last_seen_at, metadata_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
				[
					randomUUID(),
					projectId,
					input.mode,
					input.projectApiBaseUrl ?? null,
					input.executionOwner ?? 'project_runner',
					'pending',
					tokenPrefix(runnerToken),
					stableHash(runnerToken, this.config.authSecret),
					JSON.stringify(input.metadata ?? {}),
					timestamp,
					timestamp,
				],
			);
		} else {
			if (input.rotateRunnerToken === true || !existing.runner_key_hash) {
				runnerToken = `prjrun_${randomUUID().replaceAll('-', '')}`;
			}
			await this.run(
				`UPDATE project_connections
				 SET mode = ?, project_api_base_url = ?, execution_owner = ?, metadata_json = ?,
				     runner_key_prefix = COALESCE(?, runner_key_prefix),
				     runner_key_hash = COALESCE(?, runner_key_hash),
				     updated_at = ?
				 WHERE project_id = ?`,
				[
					input.mode ?? existing.mode,
					input.projectApiBaseUrl ?? existing.project_api_base_url ?? null,
					input.executionOwner ?? existing.execution_owner ?? 'project_runner',
					JSON.stringify(input.metadata ?? parseJson(existing.metadata_json, {})),
					runnerToken ? tokenPrefix(runnerToken) : null,
					runnerToken ? stableHash(runnerToken, this.config.authSecret) : null,
					timestamp,
					projectId,
				],
			);
		}
		return {
			connection: await this.getProjectConnection(projectId),
			runnerToken,
		};
	}

	async authenticateRunner(projectId, token) {
		await this.ensureInitialized();
		const row = await this.first(`SELECT * FROM project_connections WHERE project_id = ?`, [projectId]);
		if (!row?.runner_key_hash) {
			return null;
		}
		const expected = stableHash(token, this.config.authSecret);
		if (!equalHash(expected, row.runner_key_hash)) {
			return null;
		}
		const timestamp = isoNow();
		await this.run(
			`UPDATE project_connections
			 SET runner_registration_state = 'registered',
			     runner_registered_at = COALESCE(runner_registered_at, ?),
			     runner_last_seen_at = ?,
			     updated_at = ?
			 WHERE project_id = ?`,
			[timestamp, timestamp, timestamp, projectId],
		);
		return {
			projectId,
			connection: await this.getProjectConnection(projectId),
		};
	}

	async replaceProjectCapabilities(projectId, grants) {
		await this.ensureInitialized();
		await this.run(`DELETE FROM project_capability_grants WHERE project_id = ?`, [projectId]);
		const timestamp = isoNow();
		for (const grant of grants) {
			await this.run(
				`INSERT INTO project_capability_grants (
					id, project_id, namespace, operation, label, execution_class, allowed_targets_json,
					default_dispatch_mode, enabled, approval_policy_json, resource_scope_json, metadata_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					randomUUID(),
					projectId,
					grant.namespace,
					grant.operation,
					typeof grant.label === 'string' ? grant.label : null,
					grant.executionClass,
					JSON.stringify(grant.allowedTargets ?? []),
					grant.defaultDispatchMode ?? 'auto',
					grant.enabled === false ? 0 : 1,
					JSON.stringify(grant.approvalPolicy && typeof grant.approvalPolicy === 'object' ? grant.approvalPolicy : {}),
					JSON.stringify(grant.resourceScope && typeof grant.resourceScope === 'object' ? grant.resourceScope : {}),
					JSON.stringify(grant.metadata && typeof grant.metadata === 'object' ? grant.metadata : {}),
					timestamp,
					timestamp,
				],
			);
		}
		return this.listProjectCapabilities(projectId);
	}

	async listProjectCapabilities(projectId) {
		await this.ensureInitialized();
		const rows = await this.all(
			`SELECT * FROM project_capability_grants WHERE project_id = ? ORDER BY namespace ASC, operation ASC`,
			[projectId],
		);
		return rows.map(serializeCapability);
	}

	async getEffectiveCapability(projectId, namespace, operation) {
		await this.ensureInitialized();
		const row = await this.first(
			`SELECT * FROM project_capability_grants WHERE project_id = ? AND namespace = ? AND operation = ? LIMIT 1`,
			[projectId, namespace, operation],
		);
		return serializeCapability(row);
	}

	async getProjectDetails(projectId) {
		await this.ensureInitialized();
		const project = await this.getProject(projectId);
		if (!project) {
			return null;
		}
		const [connection, capabilityGrants, entitlement, hosting, environments, resources, deployments, agentPools, repositories, contentSource, latestLaunch] = await Promise.all([
			this.getProjectConnection(projectId),
			this.listProjectCapabilities(projectId),
			(async () => serializeEntitlement(await this.first(`SELECT * FROM entitlements WHERE project_id = ? LIMIT 1`, [projectId])))(),
			this.getProjectHosting(projectId),
			this.listProjectEnvironments(projectId),
			this.listProjectInfrastructureResources(projectId),
			this.listProjectDeployments(projectId),
			this.listAgentPools(projectId),
			this.listHubRepositories(projectId),
			this.getHubContentSource(projectId),
			this.getLatestHubLaunchForHub(projectId),
		]);
		const latestLaunchEvents = latestLaunch ? await this.listHubLaunchEvents(latestLaunch.id) : [];
		return {
			project,
			connection,
			capabilityGrants,
			entitlement,
			hosting,
			environments,
			resources,
			deployments,
			agentPools,
			repositories,
			contentSource,
			latestLaunch,
			latestLaunchEvents,
		};
	}

	async listRecentJobsForProject(projectId, limit = 10) {
		await this.ensureInitialized();
		const rows = await this.all(
			`SELECT * FROM remote_jobs WHERE project_id = ? ORDER BY updated_at DESC, created_at DESC LIMIT ?`,
			[projectId, Math.max(1, Math.min(Number(limit) || 10, 50))],
		);
		return rows.map(serializeJob);
	}

	async listProjectActivity(projectId, limit = 12) {
		const [jobs, deployments] = await Promise.all([
			this.listRecentJobsForProject(projectId, limit),
			this.listProjectDeployments(projectId),
		]);
		return [
			...jobs.map((job) => toActivityItem('job', {
				id: job.id,
				title: `${job.namespace}:${job.operation}`,
				status: job.status,
				timestamp: latestDate(job.finishedAt, job.updatedAt, job.createdAt),
				summary: typeof job.output?.summary === 'string' ? job.output.summary : null,
				metadata: {
					selectedTarget: job.selectedTarget,
				},
			})),
			...deployments.map((deployment) => toActivityItem('deployment', {
				id: deployment.id,
				title: `${deployment.environment} ${deployment.deploymentKind} deployment`,
				status: deployment.status,
				timestamp: latestDate(deployment.finishedAt, deployment.startedAt, deployment.createdAt),
				summary: deployment.releaseTag ? `Release ${deployment.releaseTag}` : deployment.sourceRef,
				metadata: {
					releaseTag: deployment.releaseTag,
					commitSha: deployment.commitSha,
				},
			})),
		]
			.filter((item) => item.timestamp)
			.sort((left, right) => compareDatesDesc(left.timestamp, right.timestamp))
			.slice(0, limit);
	}

	async getProjectSummary(projectId, principal = null) {
		const details = await this.getProjectDetails(projectId);
		if (!details) {
			return null;
		}

		const [runtimeSummary, jobs, activity, products, summarySnapshot] = await Promise.all([
			this.requestProjectRuntime(projectId, principal, '/v1/project/summary'),
			this.listRecentJobsForProject(projectId, 12),
			this.listProjectActivity(projectId, 12),
			this.listCatalogArtifactVersions(projectId),
			this.getProjectSummarySnapshot(projectId),
		]);
		const latestProdDeployment = details.deployments
			.filter((deployment) => deployment.environment === 'prod')
			.sort((left, right) => compareDatesDesc(latestDate(left.finishedAt, left.createdAt), latestDate(right.finishedAt, right.createdAt)))[0] ?? null;
		const latestStagingDeployment = details.deployments
			.filter((deployment) => deployment.environment === 'staging')
			.sort((left, right) => compareDatesDesc(latestDate(left.finishedAt, left.createdAt), latestDate(right.finishedAt, right.createdAt)))[0] ?? null;
		const health = summarizeProjectHealth({
			hosting: details.hosting,
			connection: details.connection,
			deployments: details.deployments,
			jobs,
		});
		const metadata = details.project.metadata ?? {};
		const runtimeCounts = typeof runtimeSummary?.counts === 'object' && runtimeSummary.counts ? runtimeSummary.counts : {};
		const runtimeConnection = typeof runtimeSummary?.connection === 'object' && runtimeSummary.connection ? runtimeSummary.connection : null;
		return {
			project: details.project,
			teamId: details.project.teamId,
			health: runtimeSummary?.health ?? health,
			counts: {
				objectives: Number(runtimeCounts.objectives ?? metadata.objectiveCount ?? metadata.objectives ?? 0),
				questions: Number(runtimeCounts.questions ?? metadata.questionCount ?? 0),
				notes: Number(runtimeCounts.notes ?? metadata.noteCount ?? 0),
				proposals: Number(runtimeCounts.proposals ?? metadata.proposalCount ?? 0),
				decisions: Number(runtimeCounts.decisions ?? metadata.decisionCount ?? 0),
				activeWorkstreams: Number(runtimeCounts.activeWorkstreams ?? (Array.isArray(metadata.workstreams) ? metadata.workstreams.length : 0)),
				agentPools: details.agentPools.length,
				agents: Number(runtimeCounts.agents ?? details.agentPools.length),
				releases: Number(runtimeCounts.releases ?? details.deployments.filter((deployment) => deployment.environment === 'prod' && deployment.status === 'succeeded').length),
				artifacts: products.length,
			},
			environments: details.environments,
			connection: runtimeConnection
				? {
					...details.connection,
					...runtimeConnection,
					projectId,
					connection: details.connection,
					executionOwner: details.connection?.executionOwner ?? null,
				}
				: details.connection,
			hosting: details.hosting,
			repositories: details.repositories,
			contentSource: details.contentSource,
			capabilityGrants: details.capabilityGrants,
			latestLaunch: details.latestLaunch,
			latestLaunchEvents: details.latestLaunchEvents,
			summarySnapshot,
			docsAutomation: summarySnapshot?.summary?.docsAutomation ?? null,
			agentPools: details.agentPools,
			latestProdDeployment: summarizeDeploymentStatus(latestProdDeployment),
			latestStagingDeployment: summarizeDeploymentStatus(latestStagingDeployment),
			recentActivity: Array.isArray(runtimeSummary?.recentActivity) && runtimeSummary.recentActivity.length > 0 ? runtimeSummary.recentActivity : activity,
			nextBestAction: typeof runtimeSummary?.nextBestAction === 'string' && runtimeSummary.nextBestAction.trim()
				? runtimeSummary.nextBestAction
				: health.state === 'setup_needed'
				? 'Configure hosting and connect a project runtime.'
				: health.state === 'release_ready'
					? 'Review the latest staging candidate and decide whether to release.'
					: health.state === 'verification_failing'
						? 'Inspect the latest failed deployment or workflow run.'
						: 'Open Direct or Workstreams to continue knowledge work.',
		};
	}

	async getProjectDirectSummary(projectId, principal = null) {
		const project = await this.getProject(projectId);
		if (!project) {
			return null;
		}
		const runtimeSummary = await this.requestProjectRuntime(projectId, principal, '/v1/direct/summary');
		if (runtimeSummary) {
			return {
				...runtimeSummary,
				items: Array.isArray(runtimeSummary.items)
					? runtimeSummary.items.map((item) => ({
						...item,
						kind: item.model,
						status: item.status ?? null,
					}))
					: [],
			};
		}
		const metadata = project.metadata ?? {};
		return {
			projectId,
			objectiveCount: Number(metadata.objectiveCount ?? 0),
			questionCount: Number(metadata.questionCount ?? 0),
			noteCount: Number(metadata.noteCount ?? 0),
			proposalCount: Number(metadata.proposalCount ?? 0),
			decisionCount: Number(metadata.decisionCount ?? 0),
			savedViews: Array.isArray(metadata.directViews) && metadata.directViews.length > 0
				? metadata.directViews
				: ['Now', 'Blocked', 'Ready for research', 'Ready for build', 'Release-linked'],
			items: Array.isArray(metadata.directItems) ? metadata.directItems : [],
		};
	}

	async getProjectWorkstreamsSummary(projectId, principal = null) {
		const project = await this.getProject(projectId);
		if (!project) {
			return null;
		}
		const [runtimeSummary, jobs] = await Promise.all([
			this.requestProjectRuntime(projectId, principal, '/v1/workstreams'),
			this.listRecentJobsForProject(projectId, 12),
		]);
		if (runtimeSummary) {
			return {
				projectId,
				items: Array.isArray(runtimeSummary.items)
					? runtimeSummary.items.map((item) => ({
						...item,
						status: item.state ?? item.status ?? null,
					}))
					: [],
				recentJobs: jobs,
				columns: Array.isArray(runtimeSummary.columns) ? runtimeSummary.columns : ['Drafting', 'Active locally', 'Verifying', 'Saved remotely', 'In staging', 'Archived'],
			};
		}
		const metadata = project.metadata ?? {};
		return {
			projectId,
			items: Array.isArray(metadata.workstreams) ? metadata.workstreams : [],
			recentJobs: jobs,
			columns: ['Drafting', 'Active locally', 'Verifying', 'Saved remotely', 'In staging', 'Archived'],
		};
	}

	async collectControlPlaneGeneratedArtifacts(projectId) {
		const tasks = await this.listRuntimeTasks(projectId, { limit: 1000 }).catch(() => []);
		const items = [];
		for (const task of tasks) {
			const outputs = await this.listRuntimeTaskOutputs(projectId, task.id).catch(() => []);
			for (const output of outputs) {
				const parsedOutput = output?.output && typeof output.output === 'object'
					? output.output
					: parseJson(output?.outputJson, {});
				const body = parsedOutput && typeof parsedOutput === 'object' ? parsedOutput : {};
				const generated = Array.isArray(body.generatedArtifacts) ? body.generatedArtifacts : [];
				for (const artifact of generated) {
					items.push({
						...artifact,
						taskId: artifact.taskId ?? task.id,
						workDayId: artifact.workDayId ?? task.workDayId ?? task.work_day_id ?? null,
						taskState: task.state ?? null,
						outputRef: artifact.outputRef ?? output.outputRef ?? body.outputRef ?? null,
					});
				}
				if (body.artifactKind && generated.length === 0) {
					items.push({
						...body,
						id: body.id ?? `${task.id}:${body.artifactKind}`,
						taskId: task.id,
						workDayId: task.workDayId ?? task.work_day_id ?? null,
						taskState: task.state ?? null,
						outputRef: output.outputRef ?? body.outputRef ?? null,
					});
				}
			}
		}
		const jobs = await this.listRecentJobsForProject(projectId, 50).catch(() => []);
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

	async getProjectAgentsSummary(projectId, principal = null) {
		const details = await this.getProjectDetails(projectId);
		if (!details) {
			return null;
		}
		const [
			statusPayload,
			messagePayload,
			artifactPayload,
			approvalPayload,
			operationGrantPayload,
			operationEventPayload,
			codexReadiness,
			currentWorkday,
			runtimeReportsPayload,
			researchNotePayload,
			knowledgeDraftPayload,
			optimizationReportPayload,
			workdaySummaries,
		] = await Promise.all([
			this.requestProjectRuntime(projectId, principal, '/v1/agents/status'),
			this.requestProjectRuntime(projectId, principal, '/v1/agents/messages'),
			this.requestProjectRuntime(projectId, principal, '/v1/agent-artifacts'),
			this.requestProjectRuntime(projectId, principal, '/v1/approvals'),
			this.requestProjectRuntime(projectId, principal, '/v1/operations/grants'),
			this.requestProjectRuntime(projectId, principal, '/v1/operations/events'),
			this.requestProjectRuntime(projectId, principal, '/v1/providers/codex/readiness'),
			this.requestProjectRuntime(projectId, principal, '/v1/workdays/current'),
			this.requestProjectRuntime(projectId, principal, '/v1/workdays/reports'),
			this.requestProjectRuntime(projectId, principal, '/v1/research-notes'),
			this.requestProjectRuntime(projectId, principal, '/v1/knowledge-drafts'),
			this.requestProjectRuntime(projectId, principal, '/v1/optimization-reports'),
			this.all(
				`SELECT * FROM project_workday_summaries WHERE project_id = ? ORDER BY created_at DESC LIMIT 6`,
				[projectId],
			),
		]);
		const runtimeUnavailableWarning = 'Project runtime is not connected or unavailable.';
		const controlPlaneGeneratedArtifacts = Array.isArray(artifactPayload?.items) && artifactPayload.items.length > 0
			? []
			: await this.collectControlPlaneGeneratedArtifacts(projectId);
		const generatedArtifacts = [
			...(Array.isArray(artifactPayload?.items) ? artifactPayload.items : []),
			...controlPlaneGeneratedArtifacts,
		];
		const approvals = Array.isArray(approvalPayload?.items) ? approvalPayload.items : [];
		const operationGrants = Array.isArray(operationGrantPayload?.items) ? operationGrantPayload.items : [];
		const operationEvents = Array.isArray(operationEventPayload?.items) ? operationEventPayload.items : [];
		const operationLifecycle = operationEventPayload?.lifecycle && typeof operationEventPayload.lifecycle === 'object' ? operationEventPayload.lifecycle : {
			worktreeSnapshots: [],
			stagingMerges: [],
			mergeFailures: [],
			repairTasks: [],
			releaseApprovals: [],
			releaseResults: [],
			codexUsage: [],
		};
		const runtimeReports = Array.isArray(runtimeReportsPayload?.items) ? runtimeReportsPayload.items : [];
		const researchNotes = Array.isArray(researchNotePayload?.items) ? researchNotePayload.items : [];
		const knowledgeDrafts = Array.isArray(knowledgeDraftPayload?.items) ? knowledgeDraftPayload.items : [];
		const optimizationReports = Array.isArray(optimizationReportPayload?.items) ? optimizationReportPayload.items : [];
		const taskHealth = artifactPayload?.taskHealth && typeof artifactPayload.taskHealth === 'object' ? artifactPayload.taskHealth : {
			activeTasks: [],
			staleTasks: [],
			recoveredTaskCount: 0,
			failedStaleTaskCount: 0,
			retryBackoffPolicy: { baseSeconds: 15, maxSeconds: 300 },
		};
		const workerRunners = Array.isArray(artifactPayload?.workerRunners) ? artifactPayload.workerRunners : [];
		const managerLease = artifactPayload?.managerLease && typeof artifactPayload.managerLease === 'object' ? artifactPayload.managerLease : null;
		const docsMutationArtifacts = generatedArtifacts.filter((artifact) => artifact?.artifactKind === 'docs_mutation_result');
		const pendingApprovals = approvals.filter((approval) => ['pending', 'waiting_for_approval', 'human_approval_pending'].includes(String(approval?.state ?? 'pending')));
		const verificationFailures = [
			...docsMutationArtifacts.filter((artifact) => String(artifact?.verificationStatus ?? '').toLowerCase() === 'failed'),
			...(Array.isArray(operationLifecycle.mergeFailures) ? operationLifecycle.mergeFailures : []),
			...(Array.isArray(operationLifecycle.repairTasks) ? operationLifecycle.repairTasks : []),
		];
		const docsAutomation = {
			activeWorkdayId: currentWorkday?.id ?? currentWorkday?.workDayId ?? null,
			activeWorkdayState: currentWorkday?.state ?? currentWorkday?.status ?? null,
			generatedArtifactCount: generatedArtifacts.length,
			researchNoteCount: researchNotes.length,
			knowledgeDraftCount: knowledgeDrafts.length,
			optimizationReportCount: optimizationReports.length,
			pendingApprovalCount: pendingApprovals.length,
			docsMutationCount: docsMutationArtifacts.length,
			verificationFailureCount: verificationFailures.length,
			repairTaskCount: Array.isArray(operationLifecycle.repairTasks) ? operationLifecycle.repairTasks.length : 0,
			staleTaskCount: Array.isArray(taskHealth.staleTasks) ? taskHealth.staleTasks.length : 0,
			recoveredTaskCount: Number(taskHealth.recoveredTaskCount ?? 0),
			failedStaleTaskCount: Number(taskHealth.failedStaleTaskCount ?? 0),
			workerRunnerCount: workerRunners.length,
			activeWorkerRunnerCount: workerRunners.filter((runner) => ['active', 'idle', 'waking'].includes(String(runner?.state ?? ''))).length,
			queuePolicy: {
				maxQueuedTasks: details.agentPools?.[0]?.maxQueuedTasks ?? null,
				maxQueuedCredits: details.agentPools?.[0]?.maxQueuedCredits ?? null,
			},
			latestReport: runtimeReports[0] ?? workdaySummaries[0] ?? null,
		};
		const runtimeWarnings = [
			...(Array.isArray(artifactPayload?.warnings) ? artifactPayload.warnings : artifactPayload ? [] : [runtimeUnavailableWarning]),
			...(Array.isArray(approvalPayload?.warnings) ? approvalPayload.warnings : []),
			...(Array.isArray(operationGrantPayload?.warnings) ? operationGrantPayload.warnings : []),
			...(Array.isArray(operationEventPayload?.warnings) ? operationEventPayload.warnings : []),
			...(Array.isArray(runtimeReportsPayload?.warnings) ? runtimeReportsPayload.warnings : []),
			...(Array.isArray(researchNotePayload?.warnings) ? researchNotePayload.warnings : []),
			...(Array.isArray(knowledgeDraftPayload?.warnings) ? knowledgeDraftPayload.warnings : []),
			...(Array.isArray(optimizationReportPayload?.warnings) ? optimizationReportPayload.warnings : []),
			...(Array.isArray(codexReadiness?.warnings) ? codexReadiness.warnings : []),
			...(Array.isArray(codexReadiness?.blockingIssues) ? codexReadiness.blockingIssues : []),
		].filter(Boolean);
		return {
			projectId,
			pools: details.agentPools,
			agents: Array.isArray(statusPayload?.agents) ? statusPayload.agents : [],
			messages: Array.isArray(messagePayload) ? messagePayload : [],
			generatedArtifacts,
			researchNotes,
			knowledgeDrafts,
			optimizationReports,
			approvals,
			operationGrants,
			operationEvents,
			operationLifecycle,
			taskHealth,
			workerRunners,
			managerLease,
			docsAutomation,
			codexReadiness: codexReadiness ?? {
				ok: false,
				providerSelected: false,
				sdkInstalled: false,
				nodeVersionOk: true,
				authDetected: false,
				subscriptionPlan: 'unknown',
				warnings: [runtimeUnavailableWarning],
				blockingIssues: [],
			},
			currentWorkday: currentWorkday ?? null,
			runtimeReports,
			runtimeWarnings,
			workdaySummaries: workdaySummaries.map((row) => ({
				id: row.id,
				environment: row.environment,
				kind: row.kind,
				state: row.state,
				summary: parseJson(row.summary_json, {}),
				createdAt: row.created_at,
			})),
		};
	}

	async getProjectReleasesSummary(projectId, principal = null) {
		const details = await this.getProjectDetails(projectId);
		if (!details) {
			return null;
		}
		const runtimeSummary = await this.requestProjectRuntime(projectId, principal, '/v1/releases');
		if (runtimeSummary) {
			return runtimeSummary;
		}
		const deployments = [...details.deployments].sort((left, right) =>
			compareDatesDesc(latestDate(left.finishedAt, left.startedAt, left.createdAt), latestDate(right.finishedAt, right.startedAt, right.createdAt)),
		);
		return {
			projectId,
			currentProd: summarizeDeploymentStatus(deployments.find((deployment) => deployment.environment === 'prod') ?? null),
			stagingCandidates: deployments
				.filter((deployment) => deployment.environment === 'staging')
				.map(summarizeDeploymentStatus)
				.filter(Boolean),
			history: deployments.map(summarizeDeploymentStatus).filter(Boolean),
		};
	}

	async getProjectShareSummary(projectId, principal = null) {
		const [project, item, artifacts, runtimeSummary] = await Promise.all([
			this.getProject(projectId),
			this.getCatalogItem(projectId),
			this.listCatalogArtifactVersions(projectId),
			this.requestProjectRuntime(projectId, principal, '/v1/share/status'),
		]);
		if (!project) {
			return null;
		}
		return {
			projectId,
			project,
			listing: runtimeSummary?.listing ?? item,
			artifacts,
			packages: Array.isArray(runtimeSummary?.packages) ? runtimeSummary.packages : [],
			canPublish: runtimeSummary?.canPublish === true || Boolean(item && item.listingEnabled),
		};
	}

	async listPersistedTeamInboxItems(teamId) {
		await this.ensureInitialized();
		const rows = await this.all(
			`SELECT * FROM team_inbox_items WHERE team_id = ? ORDER BY created_at DESC`,
			[teamId],
		);
		return rows.map(serializeTeamInboxItem);
	}

	async getProjectSummarySnapshot(projectId) {
		await this.ensureInitialized();
		return serializeProjectSummarySnapshot(await this.first(
			`SELECT * FROM project_summary_snapshots WHERE project_id = ? LIMIT 1`,
			[projectId],
		));
	}

	async upsertProjectSummarySnapshot(projectId, teamId, summary) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		await this.run(
			`INSERT OR REPLACE INTO project_summary_snapshots (
				project_id, team_id, summary_json, generated_at, created_at, updated_at
			) VALUES (
				?, ?, ?, ?,
				COALESCE((SELECT created_at FROM project_summary_snapshots WHERE project_id = ?), ?),
				?
			)`,
			[
				projectId,
				teamId,
				JSON.stringify(summary ?? {}),
				timestamp,
				projectId,
				timestamp,
				timestamp,
			],
		);
		return this.getProjectSummarySnapshot(projectId);
	}

	async upsertTeamInboxItem(teamId, input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT OR REPLACE INTO team_inbox_items (
				id, team_id, project_id, kind, state, title, summary, href, item_key, metadata_json, created_at, updated_at
			) VALUES (
				?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
				COALESCE((SELECT created_at FROM team_inbox_items WHERE id = ?), ?),
				?
			)`,
			[
				id,
				teamId,
				input.projectId ?? null,
				input.kind,
				input.state,
				input.title,
				input.summary ?? null,
				input.href ?? null,
				input.itemKey ?? null,
				JSON.stringify(input.metadata ?? {}),
				id,
				timestamp,
				timestamp,
			],
		);
		return serializeTeamInboxItem(await this.first(`SELECT * FROM team_inbox_items WHERE id = ? LIMIT 1`, [id]));
	}

	async deleteTeamInboxItem(id) {
		await this.ensureInitialized();
		await this.run(`DELETE FROM team_inbox_items WHERE id = ?`, [id]);
	}

	async deleteTeamInboxItemsByItemKey(teamId, itemKey) {
		await this.ensureInitialized();
		await this.run(`DELETE FROM team_inbox_items WHERE team_id = ? AND item_key = ?`, [teamId, itemKey]);
	}

	async listTeamInboxItems(teamId, principal = null) {
		const team = await this.getTeam(teamId);
		if (!team) {
			return [];
		}
		const projects = await this.listTeamProjects(teamId);
		const [persistedItems] = await Promise.all([
			this.listPersistedTeamInboxItems(teamId),
		]);
		const items = [...persistedItems];
		for (const project of projects) {
			const [summary, jobs, products] = await Promise.all([
				this.getProjectSummary(project.id, principal),
				this.listRecentJobsForProject(project.id, 10),
				this.listCatalogArtifactVersions(project.id),
			]);
			const failedJob = jobs.find((job) => job.status === 'failed');
			if (failedJob) {
				items.push({
					id: `job:${failedJob.id}`,
					teamId,
					projectId: project.id,
					kind: 'failure',
					state: 'action_required',
					title: `${project.name}: ${failedJob.operation} failed`,
					summary: `The latest ${failedJob.namespace}:${failedJob.operation} run failed and needs review.`,
					href: `/app/projects/${project.id}/settings`,
					createdAt: latestDate(failedJob.finishedAt, failedJob.updatedAt, failedJob.createdAt),
				});
			}
			if (summary?.latestStagingDeployment?.status === 'succeeded') {
				const releaseTag = summary.latestStagingDeployment.releaseTag;
				if (!summary.latestProdDeployment || summary.latestProdDeployment.releaseTag !== releaseTag) {
					items.push({
						id: `release:${project.id}:${releaseTag ?? summary.latestStagingDeployment.id}`,
						teamId,
						projectId: project.id,
						kind: 'release',
						state: 'waiting_for_approval',
						title: `${project.name}: staging candidate ready`,
						summary: 'A verified staging deployment is ready for human release review.',
						href: '/app/work/decisions',
						createdAt: latestDate(summary.latestStagingDeployment.finishedAt, summary.latestStagingDeployment.startedAt),
					});
				}
			}
			if (products.length > 0 && !(summary?.latestProdDeployment?.releaseTag ?? null)) {
				items.push({
					id: `share:${project.id}`,
					teamId,
					projectId: project.id,
					kind: 'share',
					state: 'informational',
					title: `${project.name}: artifacts available`,
					summary: 'Release artifacts exist for this project and can be packaged as operational resources.',
					href: '/app/knowledge/artifacts',
					createdAt: products[0].publishedAt,
				});
			}
		}
		return items
			.filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index)
			.filter((item) => item.createdAt)
			.sort((left, right) => compareDatesDesc(left.createdAt, right.createdAt))
			.slice(0, 20);
	}

	async getTeamHomeSummary(teamId, principal = null) {
		const team = await this.getTeam(teamId);
		if (!team) {
			return null;
		}
		if (principal && !(await this.principalCanAccessTeam(principal, teamId))) {
			return null;
		}

		const [members, projects, products, inbox] = await Promise.all([
			this.listTeamMembers(teamId),
			this.listTeamProjects(teamId),
			this.listTeamProducts(teamId, principal),
			this.listTeamInboxItems(teamId, principal),
		]);
		const projectSummaries = (await Promise.all(projects.map((project) => this.getProjectSummary(project.id, principal)))).filter(Boolean);
		const publishedProducts = products.filter((item) => item.visibility === 'public' && item.listingEnabled);
		const activeAgents = projectSummaries.flatMap((summary) =>
			Array.isArray(summary?.agentPools)
				? summary.agentPools.filter((pool) => ['active', 'degraded'].includes(pool.status))
				: [],
		);
		const readyToRelease = projectSummaries.filter((summary) =>
			summary?.latestStagingDeployment?.status === 'succeeded'
			&& (!summary.latestProdDeployment || summary.latestProdDeployment.releaseTag !== summary.latestStagingDeployment.releaseTag),
		);
		return {
			team,
			members,
			counts: {
				projects: projects.length,
				releaseReady: readyToRelease.length,
				activeAgents: activeAgents.length,
				liveListings: publishedProducts.length,
				inbox: inbox.length,
			},
			continueWorking: projectSummaries.slice(0, 6),
			readyToRelease,
			activeAgents,
			publishedProducts,
			inbox,
		};
	}

	async createKnowledgePack(teamId, input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO knowledge_packs (
				id, team_id, slug, name, summary, source_kind, source_ref, install_strategy, visibility, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				teamId,
				input.slug,
				input.name,
				input.summary ?? null,
				input.sourceKind ?? 'market_import',
				input.sourceRef ?? null,
				input.installStrategy ?? 'import_export',
				input.visibility ?? 'private',
				JSON.stringify(input.metadata ?? {}),
				timestamp,
				timestamp,
			],
		);
		await this.upsertCatalogItem(teamId, {
			id,
			kind: 'knowledge_pack',
			slug: input.slug,
			title: input.name,
			summary: input.summary ?? null,
			visibility: input.visibility ?? 'private',
			listingEnabled: input.metadata?.listingEnabled === true,
			offerMode: input.metadata?.offerMode ?? (input.visibility === 'public' ? 'free' : 'private'),
			manifestKey: input.metadata?.manifestKey ?? null,
			artifactKey: input.metadata?.artifactKey ?? null,
			searchText: [input.name, input.summary].filter(Boolean).join(' ').trim() || null,
			metadata: {
				sourceKind: input.sourceKind ?? 'market_import',
				sourceRef: input.sourceRef ?? null,
				installStrategy: input.installStrategy ?? 'import_export',
				...(input.metadata ?? {}),
			},
		});
		return serializeKnowledgePack(await this.first(`SELECT * FROM knowledge_packs WHERE id = ?`, [id]));
	}

	async listKnowledgePacks(principal) {
		await this.ensureInitialized();
		const teamIds = await this.teamIdsForPrincipal(principal);
		const rows = await this.all(`SELECT * FROM knowledge_packs ORDER BY created_at ASC`);
		return rows
			.map(serializeKnowledgePack)
			.filter((pack) => pack.visibility === 'public' || principalIsAdmin(principal) || teamIds.includes(pack.teamId));
	}

	async appendPlatformOperationEvent(operationId, kind, data = {}) {
		await this.ensureInitialized();
		const row = await this.first(
			`SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM platform_operation_events WHERE operation_id = ?`,
			[operationId],
		);
		const seq = Number(row?.next_seq ?? 1);
		const timestamp = isoNow();
		const id = randomUUID();
		await this.run(
			`INSERT INTO platform_operation_events (id, operation_id, seq, kind, data_json, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			[id, operationId, seq, kind, JSON.stringify(data ?? {}), timestamp],
		);
		return serializePlatformOperationEvent(await this.first(`SELECT * FROM platform_operation_events WHERE id = ?`, [id]));
	}

	async listPlatformOperationEvents(operationId) {
		await this.ensureInitialized();
		const rows = await this.all(
			`SELECT * FROM platform_operation_events WHERE operation_id = ? ORDER BY seq ASC`,
			[operationId],
		);
		return rows.map(serializePlatformOperationEvent);
	}

	async findPlatformOperationById(operationId) {
		await this.ensureInitialized();
		return serializePlatformOperation(await this.first(`SELECT * FROM platform_operations WHERE id = ?`, [operationId]));
	}

	async listPlatformOperations(input = {}) {
		await this.ensureInitialized();
		const limit = Math.max(1, Math.min(Number(input.limit ?? 50), 200));
		const rows = await this.all(
			`SELECT * FROM platform_operations ORDER BY created_at DESC LIMIT ?`,
			[limit],
		);
		return rows.map(serializePlatformOperation);
	}

	async createPlatformOperation(input) {
		await this.ensureInitialized();
		if (input.idempotencyKey) {
			const existing = await this.first(
				`SELECT * FROM platform_operations
				 WHERE namespace = ? AND operation = ? AND idempotency_key = ?
				 ORDER BY created_at DESC LIMIT 1`,
				[input.namespace, input.operation, input.idempotencyKey],
			);
			if (existing) {
				return serializePlatformOperation(existing);
			}
		}
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		const status = typeof input.status === 'string' && input.status.trim() ? input.status.trim() : 'queued';
		await this.run(
			`INSERT INTO platform_operations (
				id, namespace, operation, status, target, idempotency_key, input_json, output_json, error_json,
				requested_by_type, requested_by_id, assigned_runner_id, lease_expires_at,
				created_at, updated_at, started_at, finished_at, cancelled_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, ?, ?, NULL, NULL, NULL)`,
			[
				id,
				input.namespace,
				input.operation,
				status,
				input.target ?? 'market_operations_runner',
				input.idempotencyKey ?? null,
				JSON.stringify(input.input ?? {}),
				input.requestedByType ?? input.requestedBy?.type ?? 'service',
				input.requestedById ?? input.requestedBy?.id ?? null,
				timestamp,
				timestamp,
			],
		);
		await this.appendPlatformOperationEvent(id, 'created', {
			namespace: input.namespace,
			operation: input.operation,
			target: input.target ?? 'market_operations_runner',
			status,
		});
		return this.findPlatformOperationById(id);
	}

	async cancelPlatformOperation(operationId) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		await this.run(
			`UPDATE platform_operations
			 SET status = CASE
			 	WHEN status IN ('succeeded', 'failed', 'cancelled') THEN status
			 	ELSE 'cancelled'
			 END,
			     cancelled_at = CASE
			     	WHEN status IN ('succeeded', 'failed', 'cancelled') THEN cancelled_at
			     	ELSE ?
			     END,
			     updated_at = ?
			 WHERE id = ?`,
			[timestamp, timestamp, operationId],
		);
		await this.appendPlatformOperationEvent(operationId, 'cancelled', {});
		return this.findPlatformOperationById(operationId);
	}

	async retryPlatformOperation(operationId, input = {}) {
		await this.ensureInitialized();
		const existing = await this.findPlatformOperationById(operationId);
		if (!existing) return null;
		const timestamp = isoNow();
		const nextInput = {
			...(existing.input ?? {}),
			...(input.inputPatch && typeof input.inputPatch === 'object' ? input.inputPatch : {}),
		};
		await this.run(
			`UPDATE platform_operations
			 SET status = 'queued',
			     input_json = ?,
			     output_json = NULL,
			     error_json = NULL,
			     assigned_runner_id = NULL,
			     lease_expires_at = NULL,
			     updated_at = ?,
			     started_at = NULL,
			     finished_at = NULL,
			     cancelled_at = NULL
			 WHERE id = ?`,
			[JSON.stringify(nextInput), timestamp, operationId],
		);
		await this.appendPlatformOperationEvent(operationId, 'retry_queued', {
			status: 'queued',
		});
		return this.findPlatformOperationById(operationId);
	}

	async assertPlatformOperationRunnerUpdate(operationId, runnerId) {
		const operation = await this.findPlatformOperationById(operationId);
		if (!operation) {
			const error = new Error(`Unknown platform operation "${operationId}".`);
			error.status = 404;
			throw error;
		}
		if (!runnerId) {
			const error = new Error('runnerId is required.');
			error.status = 400;
			throw error;
		}
		if (operation.assignedRunnerId !== runnerId) {
			const error = new Error('Platform operation is assigned to a different runner.');
			error.status = 409;
			error.details = { assignedRunnerId: operation.assignedRunnerId };
			throw error;
		}
		if (['succeeded', 'failed', 'cancelled'].includes(operation.status)) {
			const error = new Error(`Platform operation is already ${operation.status}.`);
			error.status = 409;
			error.details = { status: operation.status };
			throw error;
		}
		return operation;
	}

	async upsertMarketOperationRunner(input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.runnerId ?? input.id;
		const runnerKey = input.runnerKey ?? id;
		await this.run(
			`INSERT INTO market_operation_runners (
				id, runner_key, name, environment, status, version, capabilities_json,
				active_job_count, max_concurrent_jobs, heartbeat_at, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				runner_key = excluded.runner_key,
				name = excluded.name,
				environment = excluded.environment,
				status = excluded.status,
				version = excluded.version,
				capabilities_json = excluded.capabilities_json,
				active_job_count = excluded.active_job_count,
				max_concurrent_jobs = excluded.max_concurrent_jobs,
				heartbeat_at = excluded.heartbeat_at,
				metadata_json = excluded.metadata_json,
				updated_at = excluded.updated_at`,
			[
				id,
				runnerKey,
				input.name ?? id,
				input.environment ?? 'unknown',
				input.status ?? 'online',
				input.version ?? null,
				JSON.stringify(Array.isArray(input.capabilities) ? input.capabilities : []),
				Math.max(0, Number(input.activeJobCount ?? 0) || 0),
				Math.max(1, Number(input.maxConcurrentJobs ?? 1) || 1),
				input.heartbeatAt ?? timestamp,
				JSON.stringify(input.metadata ?? {}),
				timestamp,
				timestamp,
			],
		);
		return serializeMarketOperationRunner(await this.first(`SELECT * FROM market_operation_runners WHERE id = ?`, [id]));
	}

	async findMarketOperationRunnerById(runnerId) {
		await this.ensureInitialized();
		return serializeMarketOperationRunner(await this.first(`SELECT * FROM market_operation_runners WHERE id = ?`, [runnerId]));
	}

	async listMarketOperationRunners(input = {}) {
		await this.ensureInitialized();
		const limit = Math.max(1, Math.min(Number(input.limit ?? 20) || 20, 100));
		const rows = await this.all(
			`SELECT * FROM market_operation_runners ORDER BY heartbeat_at DESC, updated_at DESC LIMIT ?`,
			[limit],
		);
		return rows.map(serializeMarketOperationRunner);
	}

	async upsertPlatformRepositoryClaim(input = {}) {
		await this.ensureInitialized();
		const repository = input.repository && typeof input.repository === 'object' ? input.repository : {};
		const repositoryKey = input.repositoryKey ?? platformRepositoryKey(repository);
		const runnerId = input.runnerId;
		if (!runnerId) {
			const error = new Error('runnerId is required for platform repository claims.');
			error.status = 400;
			throw error;
		}
		const timestamp = isoNow();
		const leaseSeconds = Math.max(30, Math.min(Number(input.leaseSeconds ?? 300), 3600));
		const leaseExpiresAt = input.leaseExpiresAt ?? new Date(Date.now() + leaseSeconds * 1000).toISOString();
		const existing = await this.first(
			`SELECT * FROM platform_repository_claims
			 WHERE repository_key = ? AND runner_id = ? AND claim_state = 'active'
			 LIMIT 1`,
			[repositoryKey, runnerId],
		);
		if (existing) {
			await this.run(
				`UPDATE platform_repository_claims
				 SET workspace_path = ?,
				     branch = ?,
				     commit_sha = ?,
				     lease_expires_at = ?,
				     metadata_json = ?,
				     updated_at = ?
				 WHERE id = ?`,
				[
					input.workspacePath ?? existing.workspace_path,
					input.branch ?? existing.branch,
					input.commitSha ?? existing.commit_sha,
					leaseExpiresAt,
					JSON.stringify(input.metadata ?? parseJson(existing.metadata_json, {})),
					timestamp,
					existing.id,
				],
			);
			return serializePlatformRepositoryClaim(await this.first(`SELECT * FROM platform_repository_claims WHERE id = ?`, [existing.id]));
		}
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO platform_repository_claims (
				id, repository_key, runner_id, workspace_path, branch, commit_sha,
				claim_state, lease_expires_at, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
			[
				id,
				repositoryKey,
				runnerId,
				input.workspacePath ?? platformRepositoryWorkspacePath(input.workspaceRoot ?? '/data', repository),
				input.branch ?? repository.defaultBranch ?? null,
				input.commitSha ?? null,
				leaseExpiresAt,
				JSON.stringify(input.metadata ?? {}),
				timestamp,
				timestamp,
			],
		);
		return serializePlatformRepositoryClaim(await this.first(`SELECT * FROM platform_repository_claims WHERE id = ?`, [id]));
	}

	async renewPlatformRepositoryClaimsForRunner(runnerId, leaseSeconds = 300) {
		await this.ensureInitialized();
		if (!runnerId) return [];
		const timestamp = isoNow();
		const boundedLeaseSeconds = Math.max(30, Math.min(Number(leaseSeconds ?? 300), 3600));
		const leaseExpiresAt = new Date(Date.now() + boundedLeaseSeconds * 1000).toISOString();
		await this.run(
			`UPDATE platform_repository_claims
			 SET lease_expires_at = ?,
			     updated_at = ?
			 WHERE runner_id = ? AND claim_state = 'active'`,
			[leaseExpiresAt, timestamp, runnerId],
		);
		const rows = await this.all(
			`SELECT * FROM platform_repository_claims WHERE runner_id = ? AND claim_state = 'active' ORDER BY updated_at DESC`,
			[runnerId],
		);
		return rows.map(serializePlatformRepositoryClaim);
	}

	async releasePlatformRepositoryClaimsForRunner(runnerId, input = {}) {
		await this.ensureInitialized();
		if (!runnerId) return [];
		const timestamp = isoNow();
		const metadataPatch = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
		const rows = await this.all(
			`SELECT * FROM platform_repository_claims WHERE runner_id = ? AND claim_state = 'active'`,
			[runnerId],
		);
		for (const row of rows) {
			await this.run(
				`UPDATE platform_repository_claims
				 SET claim_state = ?,
				     branch = COALESCE(?, branch),
				     commit_sha = COALESCE(?, commit_sha),
				     lease_expires_at = NULL,
				     metadata_json = ?,
				     updated_at = ?
				 WHERE id = ?`,
				[
					input.claimState ?? 'released',
					input.branch ?? null,
					input.commitSha ?? null,
					JSON.stringify({ ...parseJson(row.metadata_json, {}), ...metadataPatch }),
					timestamp,
					row.id,
				],
			);
		}
		return rows.map((row) => serializePlatformRepositoryClaim({ ...row, claim_state: input.claimState ?? 'released', updated_at: timestamp }));
	}

	async claimPlatformOperation(input = {}) {
		await this.ensureInitialized();
		const runnerId = input.runnerId;
		const limit = Math.max(1, Math.min(Number(input.limit ?? 1), 1));
		const leaseSeconds = Math.max(30, Math.min(Number(input.leaseSeconds ?? 300), 3600));
		const now = isoNow();
		const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
		const capabilities = normalizeOperationCapabilities(input.capabilities);
		const capabilityWhere = capabilities.length > 0
			? ` AND (${capabilities.map(() => `(namespace || ':' || operation) = ?`).join(' OR ')})`
			: '';
		const rows = input.operationId
			? await this.all(
				`SELECT * FROM platform_operations
				 WHERE id = ? AND (
				    status = 'queued'
				    OR (status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?)
				 )
				 ${capabilityWhere}
				 ORDER BY created_at ASC LIMIT ?`,
				[input.operationId, now, ...capabilities, limit],
			)
			: await this.all(
				`SELECT * FROM platform_operations
				 WHERE (
				    status = 'queued'
				    OR (status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?)
				 )
				 ${capabilityWhere}
				 ORDER BY created_at ASC LIMIT ?`,
				[now, ...capabilities, limit],
			);
		const row = rows[0];
		if (!row) return null;
		await this.run(
			`UPDATE platform_operations
			 SET status = 'leased',
			     assigned_runner_id = ?,
			     lease_expires_at = ?,
			     started_at = COALESCE(started_at, ?),
			     updated_at = ?
			 WHERE id = ?`,
			[runnerId, leaseExpiresAt, now, now, row.id],
		);
		await this.appendPlatformOperationEvent(row.id, 'claimed', {
			runnerId,
			leaseExpiresAt,
		});
		const operation = await this.findPlatformOperationById(row.id);
		if (operation?.input?.repository && typeof operation.input.repository === 'object') {
			const runner = await this.findMarketOperationRunnerById(runnerId);
			const workspaceRoot = runner?.metadata?.dataDir ?? '/data';
			const claim = await this.upsertPlatformRepositoryClaim({
				runnerId,
				repository: operation.input.repository,
				workspaceRoot,
				branch: operation.input.repository.defaultBranch,
				leaseSeconds,
				metadata: {
					operationId: operation.id,
					namespace: operation.namespace,
					operation: operation.operation,
				},
			});
			await this.appendPlatformOperationEvent(row.id, 'repository.claimed', {
				repositoryKey: claim.repositoryKey,
				runnerId,
				workspaceRoot: claim.workspacePath.startsWith('/data/') ? '/data' : null,
			});
		}
		return operation;
	}

	async renewPlatformOperationLease(operationId, input = {}) {
		await this.ensureInitialized();
		await this.assertPlatformOperationRunnerUpdate(operationId, input.runnerId);
		const leaseSeconds = Math.max(30, Math.min(Number(input.leaseSeconds ?? 300), 3600));
		const timestamp = isoNow();
		const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
		await this.run(
			`UPDATE platform_operations
			 SET lease_expires_at = ?,
			     updated_at = ?
			 WHERE id = ?`,
			[leaseExpiresAt, timestamp, operationId],
		);
		await this.appendPlatformOperationEvent(operationId, input.event?.kind ?? 'runner.lease_renewed', input.event?.data ?? { runnerId: input.runnerId, leaseExpiresAt });
		await this.renewPlatformRepositoryClaimsForRunner(input.runnerId, leaseSeconds);
		return this.findPlatformOperationById(operationId);
	}

	async checkpointPlatformOperation(operationId, input = {}) {
		await this.ensureInitialized();
		await this.assertPlatformOperationRunnerUpdate(operationId, input.runnerId);
		const timestamp = isoNow();
		await this.run(
			`UPDATE platform_operations
			 SET status = 'running',
			     output_json = ?,
			     updated_at = ?
			 WHERE id = ?`,
			[JSON.stringify(input.output ?? null), timestamp, operationId],
		);
		if (input.event) {
			await this.appendPlatformOperationEvent(operationId, input.event.kind ?? 'checkpoint', input.event.data ?? {});
		} else {
			await this.appendPlatformOperationEvent(operationId, 'checkpoint', { runnerId: input.runnerId ?? null });
		}
		return this.findPlatformOperationById(operationId);
	}

	async completePlatformOperation(operationId, input = {}) {
		await this.ensureInitialized();
		await this.assertPlatformOperationRunnerUpdate(operationId, input.runnerId);
		const timestamp = isoNow();
		await this.run(
			`UPDATE platform_operations
			 SET status = 'succeeded',
			     output_json = ?,
			     error_json = NULL,
			     lease_expires_at = NULL,
			     updated_at = ?,
			     finished_at = ?
			 WHERE id = ?`,
			[JSON.stringify(input.output ?? null), timestamp, timestamp, operationId],
		);
		await this.appendPlatformOperationEvent(operationId, input.event?.kind ?? 'completed', input.event?.data ?? {});
		const output = input.output && typeof input.output === 'object' ? input.output : {};
		await this.releasePlatformRepositoryClaimsForRunner(input.runnerId, {
			branch: output.operationBranch ?? output.branch ?? null,
			commitSha: output.commitSha ?? null,
			metadata: { operationId, status: 'succeeded' },
		});
		return this.findPlatformOperationById(operationId);
	}

	async failPlatformOperation(operationId, input = {}) {
		await this.ensureInitialized();
		await this.assertPlatformOperationRunnerUpdate(operationId, input.runnerId);
		const timestamp = isoNow();
		await this.run(
			`UPDATE platform_operations
			 SET status = 'failed',
			     error_json = ?,
			     lease_expires_at = NULL,
			     updated_at = ?,
			     finished_at = ?
			 WHERE id = ?`,
			[JSON.stringify(input.error ?? { message: 'Platform operation failed.' }), timestamp, timestamp, operationId],
		);
		await this.appendPlatformOperationEvent(operationId, input.event?.kind ?? 'failed', input.event?.data ?? {});
		await this.releasePlatformRepositoryClaimsForRunner(input.runnerId, {
			claimState: 'released',
			metadata: { operationId, status: 'failed' },
		});
		return this.findPlatformOperationById(operationId);
	}

	async appendJobEvent(jobId, kind, data = {}) {
		await this.ensureInitialized();
		const row = await this.first(
			`SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM remote_job_events WHERE job_id = ?`,
			[jobId],
		);
		const seq = Number(row?.next_seq ?? 1);
		const timestamp = isoNow();
		const id = randomUUID();
		await this.run(
			`INSERT INTO remote_job_events (id, job_id, seq, kind, data_json, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			[id, jobId, seq, kind, JSON.stringify(data), timestamp],
		);
		return serializeJobEvent(await this.first(`SELECT * FROM remote_job_events WHERE id = ?`, [id]));
	}

	async listJobEvents(jobId) {
		await this.ensureInitialized();
		const rows = await this.all(
			`SELECT * FROM remote_job_events WHERE job_id = ? ORDER BY seq ASC`,
			[jobId],
		);
		return rows.map(serializeJobEvent);
	}

	async recordAuditEvent(input = {}) {
		await this.ensureInitialized();
		const timestamp = input.createdAt ?? isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO audit_events (id, actor_type, actor_id, event_type, target_type, target_id, data_json, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				input.actorType ?? input.actor?.type ?? 'system',
				input.actorId ?? input.actor?.id ?? null,
				input.eventType,
				input.targetType ?? null,
				input.targetId ?? null,
				JSON.stringify(redactDeploymentValue(input.data ?? {})),
				timestamp,
			],
		);
		return serializeAuditEvent(await this.first(`SELECT * FROM audit_events WHERE id = ?`, [id]));
	}

	async recordProjectDeploymentAudit(deploymentOrId, eventType, input = {}) {
		const deployment = typeof deploymentOrId === 'string'
			? await this.findProjectDeploymentById(deploymentOrId)
			: deploymentOrId;
		if (!deployment || !eventType) return null;
		return this.recordAuditEvent({
			eventType,
			actorType: input.actorType ?? input.actor?.type ?? 'system',
			actorId: input.actorId ?? input.actor?.id ?? null,
			targetType: 'project',
			targetId: deployment.projectId,
			data: projectDeploymentAuditPayload(deployment, {
				actorUserId: input.actorUserId ?? input.actorId ?? input.actor?.id ?? null,
				operationId: input.operationId ?? deployment.platformOperationId ?? null,
				status: input.status ?? deployment.status,
				summary: input.summary ?? deployment.summary ?? null,
			}),
		});
	}

	async listAuditEventsForTarget(targetType, targetId, limit = 50) {
		await this.ensureInitialized();
		const rows = await this.all(
			`SELECT * FROM audit_events
			 WHERE target_type = ? AND target_id = ?
			 ORDER BY created_at DESC LIMIT ?`,
			[targetType, targetId, Math.max(1, Math.min(200, Number(limit) || 50))],
		);
		return rows.map(serializeAuditEvent);
	}

	async listRecentAuditEvents(limit = 50) {
		await this.ensureInitialized();
		const rows = await this.all(
			`SELECT * FROM audit_events
			 ORDER BY created_at DESC LIMIT ?`,
			[Math.max(1, Math.min(200, Number(limit) || 50))],
		);
		return rows.map(serializeAuditEvent);
	}

	async findJobById(jobId) {
		await this.ensureInitialized();
		return serializeJob(await this.first(`SELECT * FROM remote_jobs WHERE id = ?`, [jobId]));
	}

	async createJob(input) {
		await this.ensureInitialized();
		if (input.idempotencyKey) {
			const existing = await this.first(
				`SELECT * FROM remote_jobs WHERE project_id = ? AND idempotency_key = ? ORDER BY created_at DESC LIMIT 1`,
				[input.projectId, input.idempotencyKey],
			);
			if (existing) {
				return serializeJob(existing);
			}
		}
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		const initialStatus = typeof input.status === 'string' && input.status.trim() ? input.status.trim() : 'pending';
		await this.run(
			`INSERT INTO remote_jobs (
				id, project_id, namespace, operation, status, preferred_mode, selected_target, capability_json,
				input_json, output_json, error_json, requested_by_type, requested_by_id, assigned_runner_id,
				idempotency_key, created_at, updated_at, started_at, finished_at, cancelled_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL)`,
			[
				id,
				input.projectId,
				input.namespace,
				input.operation,
				initialStatus,
				input.preferredMode ?? 'auto',
				input.selectedTarget,
				JSON.stringify(input.capability ?? null),
				JSON.stringify(input.input ?? {}),
				input.requestedByType,
				input.requestedById ?? null,
				input.idempotencyKey ?? null,
				timestamp,
				timestamp,
			],
		);
		await this.appendJobEvent(id, 'created', {
			namespace: input.namespace,
			operation: input.operation,
			selectedTarget: input.selectedTarget,
			status: initialStatus,
		});
		return this.findJobById(id);
	}

	async cancelJob(jobId) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		await this.run(
			`UPDATE remote_jobs
			 SET status = CASE
			 	WHEN status IN ('completed', 'failed', 'cancelled') THEN status
			 	ELSE 'cancelled'
			 END,
			     cancelled_at = CASE
			     	WHEN status IN ('completed', 'failed', 'cancelled') THEN cancelled_at
			     	ELSE ?
			     END,
			     updated_at = ?
			 WHERE id = ?`,
			[timestamp, timestamp, jobId],
		);
		await this.appendJobEvent(jobId, 'cancelled', {});
		return this.findJobById(jobId);
	}

	async retryJob(jobId, input = {}) {
		await this.ensureInitialized();
		const existing = await this.findJobById(jobId);
		if (!existing) return null;
		const timestamp = isoNow();
		const nextInput = {
			...(existing.input ?? {}),
			...(input.inputPatch && typeof input.inputPatch === 'object' ? input.inputPatch : {}),
		};
		await this.run(
			`UPDATE remote_jobs
			 SET status = ?,
			     input_json = ?,
			     output_json = NULL,
			     error_json = NULL,
			     assigned_runner_id = NULL,
			     updated_at = ?,
			     started_at = NULL,
			     finished_at = NULL,
			     cancelled_at = NULL
			 WHERE id = ?`,
			[
				input.status ?? 'pending',
				JSON.stringify(nextInput),
				timestamp,
				jobId,
			],
		);
		await this.appendJobEvent(jobId, input.eventType ?? 'retry_queued', {
			status: input.status ?? 'pending',
			resume: nextInput.resume === true,
		});
		return this.findJobById(jobId);
	}

	async pullJobsForRunner(projectId, input = {}) {
		await this.ensureInitialized();
		const limit = Math.max(1, Math.min(Number(input.limit ?? 1), 20));
		const rows = await this.all(
			`SELECT * FROM remote_jobs
			 WHERE project_id = ? AND status = 'pending'
			 ORDER BY created_at ASC
			 LIMIT ?`,
			[projectId, limit],
		);
		const claimed = [];
		for (const row of rows) {
			const timestamp = isoNow();
			await this.run(
				`UPDATE remote_jobs
				 SET status = 'claimed',
				     assigned_runner_id = ?,
				     started_at = COALESCE(started_at, ?),
				     updated_at = ?
				 WHERE id = ?`,
				[input.runnerId ?? `runner-${projectId}`, timestamp, timestamp, row.id],
			);
			await this.appendJobEvent(row.id, 'claimed', {
				runnerId: input.runnerId ?? `runner-${projectId}`,
			});
			claimed.push(await this.findJobById(row.id));
		}
		return claimed;
	}

	async pullManagedLaunchJobs(input = {}) {
		await this.ensureInitialized();
		const limit = Math.max(1, Math.min(Number(input.limit ?? 1), 20));
		const rows = await this.all(
			`SELECT * FROM remote_jobs
			 WHERE namespace = 'workflow'
			   AND operation = 'launch_project'
			   AND status = 'pending'
			   AND selected_target IN ('market_operations_runner', 'project_runner')
			 ORDER BY created_at ASC
			 LIMIT ?`,
			[limit * 4],
		);
		const claimed = [];
		for (const row of rows) {
			const job = serializeJob(row);
			const inputJson = job.input && typeof job.input === 'object' ? job.input : {};
			if (inputJson.hostingMode && inputJson.hostingMode !== 'managed') continue;
			if (inputJson.launchIntent?.hosting?.mode && inputJson.launchIntent.hosting.mode !== 'treeseed_managed') continue;
			const timestamp = isoNow();
			await this.run(
				`UPDATE remote_jobs
				 SET status = 'claimed',
				     selected_target = 'market_operations_runner',
				     assigned_runner_id = ?,
				     started_at = COALESCE(started_at, ?),
				     updated_at = ?
				 WHERE id = ? AND status = 'pending'`,
				[input.runnerId ?? 'operations-runner', timestamp, timestamp, row.id],
			);
			await this.appendJobEvent(row.id, 'claimed', {
				runnerId: input.runnerId ?? 'operations-runner',
				target: 'market_operations_runner',
			});
			const next = await this.findJobById(row.id);
			if (next) claimed.push(next);
			if (claimed.length >= limit) break;
		}
		return claimed;
	}

	async pullCapacityProviderJobs(capacityProviderId, projectId, input = {}) {
		await this.ensureInitialized();
		const limit = Math.max(1, Math.min(Number(input.limit ?? 1), 20));
		const rows = await this.all(
			`SELECT * FROM remote_jobs
			 WHERE project_id = ?
			   AND status = 'pending'
			   AND json_extract(input_json, '$.capacity.providerId') = ?
			 ORDER BY created_at ASC
			 LIMIT ?`,
			[projectId, capacityProviderId, limit],
		);
		const claimed = [];
		for (const row of rows) {
			const timestamp = isoNow();
			await this.run(
				`UPDATE remote_jobs
				 SET status = 'claimed',
				     assigned_runner_id = ?,
				     started_at = COALESCE(started_at, ?),
				     updated_at = ?
				 WHERE id = ? AND status = 'pending'`,
				[input.runnerId ?? `provider-${capacityProviderId}`, timestamp, timestamp, row.id],
			);
			await this.appendJobEvent(row.id, 'claimed', {
				runnerId: input.runnerId ?? `provider-${capacityProviderId}`,
				capacityProviderId,
			});
			claimed.push(await this.findJobById(row.id));
		}
		return claimed;
	}

	async recordJobProgress(jobId, input = {}) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		await this.run(
			`UPDATE remote_jobs
			 SET status = CASE WHEN status IN ('pending', 'claimed', 'waiting_for_approval') THEN 'running' ELSE status END,
			     updated_at = ?
			 WHERE id = ?`,
			[timestamp, jobId],
		);
		await this.appendJobEvent(jobId, 'progress', {
			summary: input.summary ?? null,
			...(input.data ?? {}),
		});
		return this.findJobById(jobId);
	}

	async completeJob(jobId, input = {}) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		await this.run(
			`UPDATE remote_jobs
			 SET status = 'completed',
			     output_json = ?,
			     error_json = NULL,
			     finished_at = ?,
			     updated_at = ?
			 WHERE id = ?`,
			[JSON.stringify(input.output ?? null), timestamp, timestamp, jobId],
		);
		await this.appendJobEvent(jobId, 'completed', {});
		return this.findJobById(jobId);
	}

	async failJob(jobId, input) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		await this.run(
			`UPDATE remote_jobs
			 SET status = 'failed',
			     error_json = ?,
			     finished_at = ?,
			     updated_at = ?
			 WHERE id = ?`,
			[JSON.stringify({ code: input.code ?? null, message: input.message }), timestamp, timestamp, jobId],
		);
		await this.appendJobEvent(jobId, 'failed', {
			code: input.code ?? null,
			message: input.message,
		});
		return this.findJobById(jobId);
	}
}

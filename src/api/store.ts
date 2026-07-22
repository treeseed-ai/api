// @ts-nocheck
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { governanceVotingProvider } from '@treeseed/sdk';
import {
	containsTreeseedPlaintextSecretMaterial,
	validateTreeseedClientEncryptedEscrowMetadata,
	validateTreeseedSecretsCapabilityRegistry,
	validateTreeseedWritableSecretMetadata,
} from '@treeseed/sdk/secrets-capability';
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

function missingSchemaError(error) {
	const message = String(error?.message ?? error ?? '').toLowerCase();
	return message.includes('no such table')
		|| message.includes('no such column')
		|| message.includes('does not exist')
		|| message.includes('undefined column');
}

function objectValue(value, fallback = {}) {
	return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function arrayValue(value) {
	return Array.isArray(value) ? value : [];
}

function governanceContentHash(input = {}) {
	const payload = {
		title: String(input.title ?? '').trim(),
		summary: String(input.summary ?? '').trim(),
		body: String(input.body ?? '').trim(),
		proposalType: String(input.proposalType ?? input.proposal_type ?? '').trim(),
		relatedObjectives: arrayValue(input.relatedObjectives ?? input.related_objectives).map(String).sort(),
		relatedQuestions: arrayValue(input.relatedQuestions ?? input.related_questions).map(String).sort(),
		relatedNotes: arrayValue(input.relatedNotes ?? input.related_notes).map(String).sort(),
		relatedBooks: arrayValue(input.relatedBooks ?? input.related_books).map(String).sort(),
	};
	return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function governanceSlug(value, fallback = 'proposal') {
	return safeIdPart(value, fallback).replace(/_+/gu, '-');
}


const PROJECT_ARCHITECTURE_TOPOLOGIES = new Set(['single_repository_site', 'split_site_content', 'parent_workspace']);
const CONTENT_RUNTIME_SOURCES = new Set(['local_directory', 'treedx_snapshot', 'r2_published_manifest', 'r2_preview_overlay']);
const LOCAL_CONTENT_MATERIALIZATIONS = new Set(['none', 'existing_path', 'managed_clone', 'submodule']);
const CONTENT_PUBLISH_TARGETS = new Set(['none', 'cloudflare_r2']);
const LEGACY_PROJECT_TOPOLOGIES = new Set(['split_software_content', 'combined_compatibility']);

function projectArchitectureError(message, code = 'invalid_project_architecture') {
	const error = new Error(message);
	error.code = code;
	return error;
}

function normalizeProjectPath(value, fallback) {
	const text = typeof value === 'string' ? value.trim() : '';
	return text || fallback;
}

function normalizeProjectContentPublishTarget(value) {
	if (value === undefined || value === null) return undefined;
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw projectArchitectureError('contentPublishTarget must be an object when provided.');
	}
	const kind = normalizeProjectPath(value.kind, '');
	if (!CONTENT_PUBLISH_TARGETS.has(kind)) {
		throw projectArchitectureError(`Unsupported content publish target: ${kind || String(value.kind)}.`);
	}
	const target = { kind };
	if (typeof value.bucket === 'string' && value.bucket.trim()) target.bucket = value.bucket.trim();
	if (typeof value.prefix === 'string' && value.prefix.trim()) target.prefix = value.prefix.trim();
	if (typeof value.manifestPath === 'string' && value.manifestPath.trim()) target.manifestPath = value.manifestPath.trim();
	if (value.metadata && typeof value.metadata === 'object' && !Array.isArray(value.metadata)) target.metadata = value.metadata;
	return target;
}

function normalizeProjectArchitecture(input) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw projectArchitectureError('Project architecture must be an object.');
	}
	if (
		input.repositoryTopology !== undefined
		|| input.contentRoot !== undefined
		|| input.metadata?.repositoryTopology !== undefined
		|| input.metadata?.contentRoot !== undefined
		|| input.metadata?.sitePath !== undefined
		|| input.metadata?.contentPath !== undefined
	) {
		throw projectArchitectureError('Project topology must be declared as canonical architecture, not legacy metadata.', 'legacy_project_topology_rejected');
	}
	if (containsTreeseedPlaintextSecretMaterial(input)) {
		throw projectArchitectureError('Project architecture cannot contain plaintext credentials, tokens, or secret material.', 'project_architecture_secret_material_rejected');
	}
	const topology = normalizeProjectPath(input.topology, '');
	if (LEGACY_PROJECT_TOPOLOGIES.has(topology)) {
		throw projectArchitectureError(`Unsupported legacy project topology: ${topology}.`, 'legacy_project_topology_rejected');
	}
	if (!PROJECT_ARCHITECTURE_TOPOLOGIES.has(topology)) {
		throw projectArchitectureError(`Unsupported project topology: ${topology || String(input.topology)}.`);
	}
	const contentRuntimeSource = normalizeProjectPath(input.contentRuntimeSource, '');
	if (!CONTENT_RUNTIME_SOURCES.has(contentRuntimeSource)) {
		throw projectArchitectureError(`Unsupported content runtime source: ${contentRuntimeSource || String(input.contentRuntimeSource)}.`);
	}
	const localContentMaterialization = normalizeProjectPath(input.localContentMaterialization, '');
	if (!LOCAL_CONTENT_MATERIALIZATIONS.has(localContentMaterialization)) {
		throw projectArchitectureError(`Unsupported local content materialization: ${localContentMaterialization || String(input.localContentMaterialization)}.`);
	}
	const sitePath = normalizeProjectPath(input.sitePath, '');
	if (!sitePath) {
		throw projectArchitectureError('Project architecture requires sitePath.');
	}
	const architecture = {
		topology,
		rootPath: normalizeProjectPath(input.rootPath, '.'),
		sitePath,
		contentPath: normalizeProjectPath(input.contentPath, ''),
		contentRuntimeSource,
		localContentMaterialization,
	};
	if (!architecture.contentPath) delete architecture.contentPath;
	const contentPublishTarget = normalizeProjectContentPublishTarget(input.contentPublishTarget);
	if (contentPublishTarget) architecture.contentPublishTarget = contentPublishTarget;
	if (typeof input.requiresLocalContentForCi === 'boolean') architecture.requiresLocalContentForCi = input.requiresLocalContentForCi;
	if (typeof input.requiresLocalContentForDeploy === 'boolean') architecture.requiresLocalContentForDeploy = input.requiresLocalContentForDeploy;
	if (architecture.topology === 'split_site_content' && architecture.contentRuntimeSource === 'local_directory' && !architecture.contentPath) {
		throw projectArchitectureError('split_site_content projects using local_directory content must declare contentPath.');
	}
	if (
		!architecture.requiresLocalContentForCi
		&& !architecture.requiresLocalContentForDeploy
		&& architecture.contentRuntimeSource !== 'local_directory'
		&& ['managed_clone', 'submodule'].includes(architecture.localContentMaterialization)
	) {
		throw projectArchitectureError('CI/deploy defaults must not require managed_clone or submodule content unless explicitly requested.');
	}
	if (architecture.contentPublishTarget?.kind === 'cloudflare_r2' && architecture.contentRuntimeSource === 'local_directory' && !architecture.contentPath) {
		throw projectArchitectureError('Cloudflare R2 content publish targets need a contentPath when runtime source is local_directory.');
	}
	return architecture;
}

function projectArchitectureContentSource(architecture) {
	if (!architecture) return null;
	if (architecture.contentRuntimeSource === 'treedx_snapshot') return 'treedx';
	if (architecture.contentRuntimeSource === 'r2_published_manifest' || architecture.contentRuntimeSource === 'r2_preview_overlay') return 'r2_published_artifacts';
	return 'local_directory';
}

function stringValue(value, fallback = '') {
	const next = typeof value === 'string' ? value.trim() : '';
	return next || fallback;
}

function optionalStringValue(value, fallback = null) {
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

function enumValue(value, allowed, fallback) {
	const next = typeof value === 'string' ? value.trim() : '';
	return allowed.has(next) ? next : fallback;
}

function requireEnumValue(value, allowed, label) {
	const next = typeof value === 'string' ? value.trim() : '';
	if (allowed.has(next)) return next;
	const error = new Error(`Invalid ${label}.`);
	error.status = 400;
	error.details = { label, value };
	throw error;
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

const COMMERCE_PRODUCT_KINDS = [
	'template',
	'knowledge_pack',
	'ui_library',
	'admin_interface',
	'api_platform',
	'hosted_project',
	'professional_hosting',
	'scoped_service',
	'capacity_listing',
];
const COMMERCE_OFFER_MODES = [
	'free',
	'private',
	'contact',
	'one_time',
	'one_time_current_version',
	'subscription',
	'subscription_updates',
	'professional_hosting',
	'scoped_contract',
	'external',
];
const COMMERCE_VENDOR_TRUST_LEVELS = [
	'public_publisher',
	'verified_seller',
	'trusted_service_vendor',
	'trusted_capacity_vendor',
	'integration_partner',
];
const COMMERCE_GOVERNANCE_STATES = [
	'draft',
	'submitted',
	'approved',
	'rejected',
	'suspended',
	'archived',
];
const COMMERCE_OWNERSHIP_MODELS = [
	'team_owned',
	'individual_contributor_owned',
	'multi_contributor_attributed',
	'steward_maintained',
	'cooperative_owned',
	'community_governed',
	'foundation_or_trust_held',
	'transferred_or_succeeded',
];
const COMMERCE_STEWARDSHIP_ROLES = [
	'owner',
	'seller',
	'maintainer',
	'governance_steward',
	'support_steward',
	'security_steward',
	'community_steward',
	'successor',
];
const COMMERCE_STRIPE_ACCOUNT_STATUSES = [
	'not_started',
	'pending',
	'restricted',
	'enabled',
	'disabled',
];
const COMMERCE_STRIPE_ONBOARDING_STATUSES = [
	'not_started',
	'started',
	'returned',
	'completed',
	'expired',
];
const COMMERCE_STRIPE_ENVIRONMENTS = ['test', 'live'];
const COMMERCE_STRIPE_SYNC_STATUSES = [
	'not_synced',
	'pending',
	'synced',
	'blocked',
	'drifted',
	'failed',
];
const COMMERCE_ENTITLEMENT_STATUSES = ['pending', 'active', 'past_due', 'expired', 'revoked', 'refunded', 'canceled'];
const COMMERCE_CART_STATUSES = ['active', 'checkout_pending', 'converted', 'abandoned'];
const COMMERCE_CHECKOUT_STATUSES = ['draft', 'requires_confirmation', 'processing', 'partially_confirmed', 'confirmed', 'completed', 'canceled', 'failed'];
const COMMERCE_ORDER_STATUSES = ['draft', 'pending_payment', 'requires_action', 'processing', 'paid', 'partially_refunded', 'refunded', 'canceled', 'failed'];
const COMMERCE_ORDER_ITEM_STATUSES = ['pending', 'paid', 'fulfilled', 'refunded', 'revoked', 'canceled'];
const COMMERCE_SUBSCRIPTION_STATUSES = ['incomplete', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused'];
const COMMERCE_PAYMENT_GROUP_STATUSES = ['pending', 'requires_confirmation', 'requires_action', 'processing', 'succeeded', 'failed', 'canceled'];
const COMMERCE_WEBHOOK_EVENT_STATUSES = ['received', 'processing', 'processed', 'ignored', 'failed'];
const COMMERCE_REFUND_STATUSES = ['processing', 'succeeded', 'failed', 'canceled'];
const COMMERCE_FULFILLMENT_STATUSES = ['pending', 'ready', 'delivered', 'failed', 'revoked'];
const COMMERCE_FULFILLMENT_EVENT_TYPES = ['artifact_released', 'artifact_delivered', 'manual_status', 'revoked'];
const COMMERCE_SERVICE_REQUEST_STATUSES = ['requested', 'scoping', 'quoted', 'buyer_approved', 'vendor_approved', 'checkout_pending', 'active', 'fulfilled', 'declined', 'canceled', 'expired'];
const COMMERCE_SERVICE_QUOTE_STATUSES = ['draft', 'submitted', 'buyer_approved', 'vendor_approved', 'accepted', 'rejected', 'expired', 'superseded', 'canceled'];
const COMMERCE_SERVICE_CONTRACT_STATUSES = ['pending_checkout', 'active', 'fulfilled', 'canceled', 'disputed'];
const COMMERCE_SERVICE_EVENT_TYPES = ['requested', 'scoping_started', 'scope_updated', 'quote_created', 'quote_submitted', 'quote_buyer_approved', 'quote_vendor_approved', 'quote_rejected', 'quote_expired', 'checkout_created', 'contract_activated', 'work_linked', 'manual_update', 'fulfilled', 'declined', 'canceled'];
const COMMERCE_CAPACITY_LISTING_STATUSES = ['draft', 'submitted', 'approved', 'rejected', 'suspended', 'archived'];
const COMMERCE_CAPACITY_INQUIRY_STATUSES = ['requested', 'reviewing', 'approved_for_scoping', 'declined', 'canceled'];
const COMMERCE_CAPACITY_ACCESS_LEVELS = ['public_summary', 'buyer_gated', 'governance_required', 'private_invite'];
const COMMERCE_CAPACITY_RUNTIME_ISOLATION_LEVELS = ['none', 'project_scoped', 'tenant_isolated', 'dedicated_runtime', 'external_only'];
const COMMERCE_CAPACITY_HUMAN_INVOLVEMENT_LEVELS = ['none', 'review_only', 'operator_assisted', 'human_delivered'];
const COMMERCE_CAPACITY_AI_INVOLVEMENT_LEVELS = ['none', 'assistive', 'agentic', 'model_hosted'];
const COMMERCE_CAPACITY_DATA_ACCESS_LEVELS = ['none', 'public_only', 'buyer_provided', 'project_scoped', 'sensitive_review_required'];
const COMMERCE_CAPACITY_SECRET_ACCESS_LEVELS = ['none', 'buyer_managed', 'delegated_scoped', 'market_admin_review_required'];

const COMMERCE_PRODUCT_KIND_SET = new Set(COMMERCE_PRODUCT_KINDS);
const COMMERCE_OFFER_MODE_SET = new Set(COMMERCE_OFFER_MODES);
const COMMERCE_VENDOR_TRUST_LEVEL_SET = new Set(COMMERCE_VENDOR_TRUST_LEVELS);
const COMMERCE_GOVERNANCE_STATE_SET = new Set(COMMERCE_GOVERNANCE_STATES);
const COMMERCE_OWNERSHIP_MODEL_SET = new Set(COMMERCE_OWNERSHIP_MODELS);
const COMMERCE_STEWARDSHIP_ROLE_SET = new Set(COMMERCE_STEWARDSHIP_ROLES);
const COMMERCE_STRIPE_ACCOUNT_STATUS_SET = new Set(COMMERCE_STRIPE_ACCOUNT_STATUSES);
const COMMERCE_STRIPE_ONBOARDING_STATUS_SET = new Set(COMMERCE_STRIPE_ONBOARDING_STATUSES);
const COMMERCE_STRIPE_ENVIRONMENT_SET = new Set(COMMERCE_STRIPE_ENVIRONMENTS);
const COMMERCE_STRIPE_SYNC_STATUS_SET = new Set(COMMERCE_STRIPE_SYNC_STATUSES);
const COMMERCE_ENTITLEMENT_STATUS_SET = new Set(COMMERCE_ENTITLEMENT_STATUSES);
const COMMERCE_CART_STATUS_SET = new Set(COMMERCE_CART_STATUSES);
const COMMERCE_CHECKOUT_STATUS_SET = new Set(COMMERCE_CHECKOUT_STATUSES);
const COMMERCE_ORDER_STATUS_SET = new Set(COMMERCE_ORDER_STATUSES);
const COMMERCE_ORDER_ITEM_STATUS_SET = new Set(COMMERCE_ORDER_ITEM_STATUSES);
const COMMERCE_SUBSCRIPTION_STATUS_SET = new Set(COMMERCE_SUBSCRIPTION_STATUSES);
const COMMERCE_PAYMENT_GROUP_STATUS_SET = new Set(COMMERCE_PAYMENT_GROUP_STATUSES);
const COMMERCE_WEBHOOK_EVENT_STATUS_SET = new Set(COMMERCE_WEBHOOK_EVENT_STATUSES);
const COMMERCE_REFUND_STATUS_SET = new Set(COMMERCE_REFUND_STATUSES);
const COMMERCE_FULFILLMENT_STATUS_SET = new Set(COMMERCE_FULFILLMENT_STATUSES);
const COMMERCE_FULFILLMENT_EVENT_TYPE_SET = new Set(COMMERCE_FULFILLMENT_EVENT_TYPES);
const COMMERCE_SERVICE_REQUEST_STATUS_SET = new Set(COMMERCE_SERVICE_REQUEST_STATUSES);
const COMMERCE_SERVICE_QUOTE_STATUS_SET = new Set(COMMERCE_SERVICE_QUOTE_STATUSES);
const COMMERCE_SERVICE_CONTRACT_STATUS_SET = new Set(COMMERCE_SERVICE_CONTRACT_STATUSES);
const COMMERCE_SERVICE_EVENT_TYPE_SET = new Set(COMMERCE_SERVICE_EVENT_TYPES);
const COMMERCE_CAPACITY_LISTING_STATUS_SET = new Set(COMMERCE_CAPACITY_LISTING_STATUSES);
const COMMERCE_CAPACITY_INQUIRY_STATUS_SET = new Set(COMMERCE_CAPACITY_INQUIRY_STATUSES);
const COMMERCE_CAPACITY_ACCESS_LEVEL_SET = new Set(COMMERCE_CAPACITY_ACCESS_LEVELS);
const COMMERCE_CAPACITY_RUNTIME_ISOLATION_LEVEL_SET = new Set(COMMERCE_CAPACITY_RUNTIME_ISOLATION_LEVELS);
const COMMERCE_CAPACITY_HUMAN_INVOLVEMENT_LEVEL_SET = new Set(COMMERCE_CAPACITY_HUMAN_INVOLVEMENT_LEVELS);
const COMMERCE_CAPACITY_AI_INVOLVEMENT_LEVEL_SET = new Set(COMMERCE_CAPACITY_AI_INVOLVEMENT_LEVELS);
const COMMERCE_CAPACITY_DATA_ACCESS_LEVEL_SET = new Set(COMMERCE_CAPACITY_DATA_ACCESS_LEVELS);
const COMMERCE_CAPACITY_SECRET_ACCESS_LEVEL_SET = new Set(COMMERCE_CAPACITY_SECRET_ACCESS_LEVELS);
const COMMERCE_VISIBILITY_SET = new Set(['public', 'authenticated', 'team', 'private']);
const COMMERCE_FULFILLMENT_MODE_SET = new Set(['automatic', 'manual', 'scoped', 'external']);
const COMMERCE_PRICE_STATUS_SET = new Set(['draft', 'active', 'archived']);
const COMMERCE_PRICE_INTERVAL_SET = new Set(['one_time', 'month', 'year', 'custom']);
const COMMERCE_TAX_BEHAVIOR_SET = new Set(['exclusive', 'inclusive', 'unspecified']);
const COMMERCE_COMMERCIAL_OFFER_MODES = new Set([
	'one_time',
	'one_time_current_version',
	'subscription',
	'subscription_updates',
	'professional_hosting',
	'scoped_contract',
]);
const COMMERCE_ZERO_PRICE_OFFER_MODES = new Set(['free', 'private', 'contact', 'external']);
const COMMERCE_CAPACITY_LISTING_OFFER_MODES = new Set(['contact', 'private', 'external']);

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
	viewer: [],
};

const TEAM_ROLE_DESCRIPTIONS = {
	team_owner: 'Own the team portfolio and all project capabilities.',
	market_steward: 'Manage market products and publish listings.',
	project_lead: 'Lead projects, workstreams, and release promotion.',
	contributor: 'Edit direction and move workstreams forward.',
	reviewer: 'Review staged work and approve remote execution.',
	finance: 'Manage billing and commercial product settings.',
	viewer: 'Read-only participant in team and Commons governance surfaces.',
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
const TREESEED_COMMONS_TEAM_SLUG = 'treeseed';
const COMMONS_WEIGHT_POLICY_VERSION = 'commons-v1';
const COMMONS_BACKING_THRESHOLD = 3;
const COMMONS_WEIGHT_THRESHOLD = 3;
const COMMONS_TOTAL_WEIGHT_CAP = 5;
const COMMONS_DELEGATED_WEIGHT_CAP = 2;

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
	const preferredOrder = ['team_owner', 'project_lead', 'market_steward', 'contributor', 'reviewer', 'finance', 'viewer'];
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
		?? 'https://api.treeseed.dev/treedx',
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

function normalizedStrings(values) {
	return arrayValue(values).map((value) => String(value ?? '').trim()).filter(Boolean);
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

function serializeCommonsParticipant(row) {
	if (!row) return null;
	return {
		id: row.id,
		userId: row.user_id,
		teamId: row.team_id,
		status: row.status,
		displayName: row.display_name,
		verifiedEmail: Number(row.verified_email ?? 0) === 1,
		baseWeight: Number(row.base_weight ?? 1),
		trustWeight: Number(row.trust_weight ?? 0),
		contributionWeight: Number(row.contribution_weight ?? 0),
		stakeholderWeight: Number(row.stakeholder_weight ?? 0),
		delegatedWeight: Number(row.delegated_weight ?? 0),
		totalWeight: Number(row.total_weight ?? 1),
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeCommonsQuestion(row) {
	if (!row) return null;
	return {
		id: row.id,
		participantId: row.participant_id,
		userId: row.user_id,
		teamId: row.team_id,
		status: row.status,
		title: row.title,
		body: row.body,
		answer: row.answer,
		convertedProposalId: row.converted_proposal_id,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeCommonsProposal(row) {
	if (!row) return null;
	return {
		id: row.id,
		participantId: row.participant_id,
		userId: row.user_id,
		teamId: row.team_id,
		status: row.status,
		title: row.title,
		summary: row.summary,
		body: row.body,
		scope: row.scope,
		decisionType: row.decision_type,
		contentProposalSlug: row.content_proposal_slug,
		contentDecisionSlug: row.content_decision_slug,
		backingCount: Number(row.backing_count ?? 0),
		voteSupportWeight: Number(row.vote_support_weight ?? 0),
		voteObjectWeight: Number(row.vote_object_weight ?? 0),
		voteAbstainWeight: Number(row.vote_abstain_weight ?? 0),
		qualifiedAt: row.qualified_at,
		votingStartsAt: row.voting_starts_at,
		votingEndsAt: row.voting_ends_at,
		stewardDecisionAt: row.steward_decision_at,
		stewardDecisionBy: row.steward_decision_by,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeCommonsWeightSnapshot(row) {
	if (!row) return null;
	return {
		id: row.id,
		participantId: row.participant_id,
		policyVersion: row.policy_version,
		baseWeight: Number(row.base_weight ?? 1),
		verifiedEmailWeight: Number(row.verified_email_weight ?? 0),
		accountAgeWeight: Number(row.account_age_weight ?? 0),
		contributionWeight: Number(row.contribution_weight ?? 0),
		stakeholderWeight: Number(row.stakeholder_weight ?? 0),
		trustRoleWeight: Number(row.trust_role_weight ?? 0),
		delegatedWeight: Number(row.delegated_weight ?? 0),
		totalWeight: Number(row.total_weight ?? 1),
		evidence: parseJson(row.evidence_json, {}),
		createdAt: row.created_at,
	};
}

function serializeCommonsProposalBacking(row) {
	if (!row) return null;
	return {
		id: row.id,
		proposalId: row.proposal_id,
		participantId: row.participant_id,
		userId: row.user_id,
		weightSnapshotId: row.weight_snapshot_id,
		weight: Number(row.weight ?? 0),
		reason: row.reason,
		createdAt: row.created_at,
	};
}

function serializeCommonsProposalVote(row) {
	if (!row) return null;
	return {
		id: row.id,
		proposalId: row.proposal_id,
		participantId: row.participant_id,
		userId: row.user_id,
		vote: row.vote,
		weightSnapshotId: row.weight_snapshot_id,
		weight: Number(row.weight ?? 0),
		reason: row.reason,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeCommonsDelegation(row) {
	if (!row) return null;
	return {
		id: row.id,
		fromParticipantId: row.from_participant_id,
		toParticipantId: row.to_participant_id,
		scope: row.scope,
		status: row.status,
		weightLimit: row.weight_limit == null ? null : Number(row.weight_limit),
		reason: row.reason,
		createdAt: row.created_at,
		revokedAt: row.revoked_at,
	};
}

function serializeCommonsDecision(row) {
	if (!row) return null;
	return {
		id: row.id,
		proposalId: row.proposal_id,
		status: row.status,
		decisionRecordId: row.decision_record_id,
		decisionRecordSlug: row.decision_record_slug,
		title: row.title,
		summary: row.summary,
		stewardReason: row.steward_reason,
		capacityBudget: row.capacity_budget,
		scheduledFor: row.scheduled_for,
		implementedAt: row.implemented_at,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeCommonsGovernanceEvent(row) {
	if (!row) return null;
	return {
		id: row.id,
		eventType: row.event_type,
		actorType: row.actor_type,
		actorId: row.actor_id,
		participantId: row.participant_id,
		proposalId: row.proposal_id,
		questionId: row.question_id,
		decisionId: row.decision_id,
		priorState: row.prior_state,
		nextState: row.next_state,
		message: row.message,
		evidence: parseJson(row.evidence_json, {}),
		createdAt: row.created_at,
	};
}

function serializeGovernancePolicy(row) {
	if (!row) return null;
	return {
		id: row.id,
		teamId: row.team_id,
		projectId: row.project_id ?? null,
		scope: row.scope ?? 'team',
		providerId: row.provider_id,
		providerVersion: row.provider_version,
		config: parseJson(row.config_json, {}),
		active: Number(row.active ?? 1) === 1,
		createdBy: row.created_by ?? null,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		supersededAt: row.superseded_at ?? null,
	};
}

function serializeGovernanceProposal(row) {
	if (!row) return null;
	return {
		id: row.id,
		teamId: row.team_id,
		projectId: row.project_id,
		scope: row.scope,
		status: row.status,
		title: row.title,
		summary: row.summary,
		body: row.body,
		proposalType: row.proposal_type,
		contentProposalSlug: row.content_proposal_slug,
		contentDecisionSlug: row.content_decision_slug,
		activeVersion: Number(row.active_version ?? 1),
		activeContentHash: row.active_content_hash,
		governanceProviderId: row.governance_provider_id,
		governanceProviderVersion: row.governance_provider_version,
		governancePolicyId: row.governance_policy_id,
		decisionId: row.decision_id,
		votingStartsAt: row.voting_starts_at,
		votingEndsAt: row.voting_ends_at,
		closedAt: row.closed_at,
		closedReason: row.closed_reason,
		createdByType: row.created_by_type,
		createdById: row.created_by_id,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeGovernanceElectorateSnapshot(row) {
	if (!row) return null;
	return {
		id: row.id,
		proposalId: row.proposal_id,
		proposalVersion: Number(row.proposal_version ?? 1),
		providerId: row.provider_id,
		providerVersion: row.provider_version,
		ruleSnapshot: parseJson(row.rule_snapshot_json, {}),
		chambers: parseJson(row.chambers_json, []),
		eligibleVoters: parseJson(row.eligible_voters_json, []),
		delegations: parseJson(row.delegations_json, []),
		eligibleWeightTotal: Number(row.eligible_weight_total ?? 0),
		activeWeightTotal: Number(row.active_weight_total ?? 0),
		createdAt: row.created_at,
	};
}

function serializeGovernanceVote(row) {
	if (!row) return null;
	return {
		id: row.id,
		proposalId: row.proposal_id,
		proposalVersion: Number(row.proposal_version ?? 1),
		userId: row.user_id,
		vote: row.vote,
		reason: row.reason,
		chamberVotes: parseJson(row.chamber_votes_json, {}),
		effectiveWeights: parseJson(row.effective_weights_json, {}),
		delegatedFrom: parseJson(row.delegated_from_json, []),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeGovernanceDelegation(row) {
	if (!row) return null;
	return {
		id: row.id,
		teamId: row.team_id,
		scope: row.scope,
		fromUserId: row.from_user_id,
		toUserId: row.to_user_id,
		chambers: parseJson(row.chambers_json, []),
		status: row.status,
		reason: row.reason,
		createdAt: row.created_at,
		revokedAt: row.revoked_at,
		expiresAt: row.expires_at,
		metadata: parseJson(row.metadata_json, {}),
	};
}

function serializeGovernanceDecision(row) {
	if (!row) return null;
	return {
		id: row.id,
		teamId: row.team_id,
		projectId: row.project_id,
		proposalId: row.proposal_id,
		proposalVersion: Number(row.proposal_version ?? 1),
		proposalContentHash: row.proposal_content_hash,
		status: row.status,
		title: row.title,
		summary: row.summary,
		contentDecisionSlug: row.content_decision_slug,
		governanceProviderId: row.governance_provider_id,
		governanceRule: parseJson(row.governance_rule_json, {}),
		electorateSnapshotId: row.electorate_snapshot_id,
		voteResult: parseJson(row.vote_result_json, {}),
		voterReasons: parseJson(row.voter_reasons_json, []),
		proposalSnapshot: parseJson(row.proposal_snapshot_json, {}),
		decisionRecord: parseJson(row.decision_record_json, {}),
		createdByType: row.created_by_type,
		createdById: row.created_by_id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		supersededAt: row.superseded_at,
	};
}

function serializeGovernanceEvent(row) {
	if (!row) return null;
	return {
		id: row.id,
		eventType: row.event_type,
		actorType: row.actor_type,
		actorId: row.actor_id,
		teamId: row.team_id,
		projectId: row.project_id,
		proposalId: row.proposal_id,
		decisionId: row.decision_id,
		proposalVersion: row.proposal_version == null ? null : Number(row.proposal_version),
		priorState: row.prior_state,
		nextState: row.next_state,
		message: row.message,
		evidence: parseJson(row.evidence_json, {}),
		createdAt: row.created_at,
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

function serializeSecretMetadataRecord(row) {
	if (!row) return null;
	return {
		id: row.id,
		teamId: row.team_id,
		projectId: row.project_id,
		name: row.name,
		secretClass: row.secret_class,
		custodyMode: row.custody_mode,
		owner: { kind: row.owner_kind, teamId: row.team_id, projectId: row.project_id },
		status: row.status,
		githubSecretTarget: parseJson(row.github_secret_target_json, {}),
		escrowRecordId: row.escrow_record_id,
		apiDecryptable: Number(row.api_decryptable ?? 0) === 1,
		plaintextAllowed: Number(row.plaintext_allowed ?? 0) === 1,
		failClosedCode: row.fail_closed_code,
		metadata: redactDeploymentValue(parseJson(row.metadata_json, {})),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		tombstonedAt: row.tombstoned_at,
	};
}

function serializeClientEncryptedEscrowRecord(row) {
	if (!row) return null;
	const rawMetadata = parseJson(row.metadata_json, {});
	const rawEnvelope = rawMetadata?.envelope && typeof rawMetadata.envelope === 'object' ? rawMetadata.envelope : {};
	const metadata = {
		...redactDeploymentValue(rawMetadata),
		envelope: {
			ciphertext: rawEnvelope.ciphertext ?? null,
			nonce: rawEnvelope.nonce ?? null,
			salt: rawEnvelope.salt ?? null,
			kdf: rawEnvelope.kdf ?? null,
			kdfParams: rawEnvelope.kdfParams ?? null,
			encryptionVersion: rawEnvelope.encryptionVersion ?? null,
			deploymentIntent: rawEnvelope.deploymentIntent ?? null,
		},
	};
	const envelope = metadata.envelope;
	return {
		id: row.id,
		teamId: row.team_id,
		projectId: row.project_id,
		secretId: row.secret_id,
		status: row.status,
		ciphertext: envelope.ciphertext ?? null,
		ciphertextRef: row.ciphertext_ref,
		algorithm: row.algorithm,
		nonce: envelope.nonce ?? null,
		salt: envelope.salt ?? null,
		kdf: envelope.kdf ?? null,
		kdfParams: envelope.kdfParams ?? null,
		wrappingKeyId: row.wrapping_key_id,
		encryptionVersion: envelope.encryptionVersion ?? null,
		createdByClientId: row.created_by_client_id,
		expiresAt: row.expires_at,
		deploymentIntent: envelope.deploymentIntent ?? null,
		migratedTo: row.migrated_to,
		metadata,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		tombstonedAt: row.tombstoned_at,
	};
}

function serializeGitHubRepositoryGrant(row) {
	if (!row) return null;
	return {
		id: row.id,
		teamId: row.team_id,
		projectId: row.project_id,
		repository: row.repository,
		installationId: row.installation_id,
		accountLogin: row.account_login,
		accountId: row.account_id,
		status: row.status,
		permissions: parseJson(row.permissions_json, {}),
		environments: parseJson(row.environments_json, []),
		driftCode: row.drift_code,
		observedAt: row.observed_at,
		revokedAt: row.revoked_at,
		metadata: redactDeploymentValue(parseJson(row.metadata_json, {})),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeGitHubAppInstallationRecord(row) {
	if (!row) return null;
	return {
		id: row.id,
		teamId: row.team_id,
		installationId: row.installation_id,
		accountLogin: row.account_login,
		accountId: row.account_id,
		accountType: row.account_type,
		status: row.status,
		permissions: parseJson(row.permissions_json, {}),
		repositorySelection: row.repository_selection,
		driftCode: row.drift_code,
		observedAt: row.observed_at,
		revokedAt: row.revoked_at,
		suspendedAt: row.suspended_at,
		metadata: redactDeploymentValue(parseJson(row.metadata_json, {})),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeGitHubAppTokenIssuanceRecord(row) {
	if (!row) return null;
	return {
		id: row.id,
		teamId: row.team_id,
		projectId: row.project_id,
		assignmentId: row.assignment_id,
		providerId: row.provider_id,
		workdayId: row.workday_id,
		operationId: row.operation_id,
		repository: row.repository,
		installationId: row.installation_id,
		status: row.status,
		tokenPrefix: row.token_prefix,
		tokenHash: row.token_hash,
		permissions: parseJson(row.permissions_json, {}),
		allowedOperations: parseJson(row.allowed_operations_json, []),
		expiresAt: row.expires_at,
		issuedAt: row.issued_at,
		revokedAt: row.revoked_at,
		failClosedCode: row.fail_closed_code,
		metadata: redactDeploymentValue(parseJson(row.metadata_json, {})),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeWorkflowOperationRecord(row) {
	if (!row) return null;
	return {
		id: row.id,
		teamId: row.team_id,
		projectId: row.project_id,
		name: row.name,
		repository: row.repository,
		workflowFile: row.workflow_file,
		secretBearing: Number(row.secret_bearing ?? 0) === 1,
		trustedExecutionSetId: row.trusted_execution_set_id,
		dispatch: parseJson(row.dispatch_json, {}),
		inputs: parseJson(row.inputs_json, []),
		secretClasses: parseJson(row.secret_classes_json, []),
		status: row.status,
		failClosedCode: row.fail_closed_code,
		metadata: redactDeploymentValue(parseJson(row.metadata_json, {})),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		blockedAt: row.blocked_at,
	};
}

function serializeWorkflowDispatchRecord(row) {
	if (!row) return null;
	return {
		id: row.id,
		teamId: row.team_id,
		projectId: row.project_id,
		workflowOperationId: row.workflow_operation_id,
		platformOperationId: row.platform_operation_id,
		repository: row.repository,
		workflowFile: row.workflow_file,
		ref: row.ref,
		status: row.status,
		inputs: redactDeploymentValue(parseJson(row.inputs_json, {})),
		result: redactDeploymentValue(parseJson(row.result_json, {})),
		failClosedCode: row.fail_closed_code,
		metadata: redactDeploymentValue(parseJson(row.metadata_json, {})),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		dispatchedAt: row.dispatched_at,
		completedAt: row.completed_at,
	};
}

function serializeTreeDxCredentialIssuanceRecord(row) {
	if (!row) return null;
	return {
		id: row.id,
		teamId: row.team_id,
		projectId: row.project_id,
		assignmentId: row.assignment_id,
		repository: row.repository,
		credentialProvider: row.credential_provider,
		status: row.status,
		tokenPrefix: row.token_prefix,
		tokenHash: row.token_hash,
		scopes: parseJson(row.scopes_json, []),
		allowedOperations: parseJson(row.allowed_operations_json, []),
		expiresAt: row.expires_at,
		issuedAt: row.issued_at,
		revokedAt: row.revoked_at,
		failClosedCode: row.fail_closed_code,
		metadata: redactDeploymentValue(parseJson(row.metadata_json, {})),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function secretCapabilityValidationError(problems, message = 'Invalid secret capability record.') {
	const error = new Error(message);
	error.status = 400;
	error.code = problems?.[0]?.code ?? 'invalid_secret_capability_record';
	error.details = { problems };
	return error;
}

function rejectSecretCapabilityPlaintext(input, path = '$') {
	if (!containsTreeseedPlaintextSecretMaterial(input)) return;
	throw secretCapabilityValidationError([{
		path,
		code: 'plaintext_escrow_material',
		message: 'Secret capability records must not include plaintext secret material.',
	}], 'Secret capability records must not include plaintext secret material.');
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

function serializeCommerceVendor(row) {
	if (!row) return null;
	return {
		id: row.id,
		teamId: row.team_id,
		displayName: row.display_name,
		slug: row.slug,
		status: row.status,
		trustLevel: row.trust_level,
		professionalEntitlementId: row.professional_entitlement_id,
		stripeAccountId: row.stripe_account_id,
		salesEnabled: Boolean(row.sales_enabled),
		serviceSalesEnabled: Boolean(row.service_sales_enabled),
		capacityListingsEnabled: Boolean(row.capacity_listings_enabled),
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeCommerceVendorStripeAccount(row) {
	if (!row) return null;
	return {
		id: row.id,
		vendorId: row.vendor_id,
		teamId: row.team_id,
		environment: row.environment,
		stripeAccountId: row.stripe_account_id,
		accountStatus: row.account_status,
		onboardingStatus: row.onboarding_status,
		chargesEnabled: Boolean(row.charges_enabled),
		payoutsEnabled: Boolean(row.payouts_enabled),
		detailsSubmitted: Boolean(row.details_submitted),
		requirementsCurrentlyDue: parseJson(row.requirements_currently_due_json, []),
		requirementsEventuallyDue: parseJson(row.requirements_eventually_due_json, []),
		requirementsPastDue: parseJson(row.requirements_past_due_json, []),
		requirementsDisabledReason: row.requirements_disabled_reason,
		capabilities: parseJson(row.capabilities_json, {}),
		onboardingStartedAt: row.onboarding_started_at,
		onboardingCompletedAt: row.onboarding_completed_at,
		lastSyncedAt: row.last_synced_at,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeCommerceProduct(row) {
	if (!row) return null;
	return {
		id: row.id,
		vendorId: row.vendor_id,
		sellerTeamId: row.seller_team_id,
		kind: row.kind,
		slug: row.slug,
		title: row.title,
		summary: row.summary,
		description: row.description,
		status: row.status,
		visibility: row.visibility,
		catalogItemId: row.catalog_item_id,
		currentVersionId: row.current_version_id,
		ownershipModel: row.ownership_model,
		ownershipRecordId: row.ownership_record_id,
		supportPolicy: row.support_policy,
		license: row.license,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeCommerceOwnershipRecord(row) {
	if (!row) return null;
	return {
		id: row.id,
		productId: row.product_id,
		model: row.model,
		canonicalOwnerType: row.canonical_owner_type,
		canonicalOwnerId: row.canonical_owner_id,
		sellerTeamId: row.seller_team_id,
		stewardTeamId: row.steward_team_id,
		governancePolicyId: row.governance_policy_id,
		publicSummary: row.public_summary,
		buyerVisible: Boolean(row.buyer_visible),
		effectiveAt: row.effective_at,
		supersededAt: row.superseded_at,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeCommerceStewardshipAssignment(row) {
	if (!row) return null;
	return {
		id: row.id,
		ownershipRecordId: row.ownership_record_id,
		productId: row.product_id,
		role: row.role,
		assigneeType: row.assignee_type,
		assigneeId: row.assignee_id,
		displayName: row.display_name,
		responsibilities: parseJson(row.responsibilities_json, []),
		visibleToBuyers: Boolean(row.visible_to_buyers),
		startsAt: row.starts_at,
		endsAt: row.ends_at,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeCommerceContribution(row) {
	if (!row) return null;
	return {
		id: row.id,
		productId: row.product_id,
		productVersionId: row.product_version_id,
		contributorType: row.contributor_type,
		contributorId: row.contributor_id,
		displayName: row.display_name,
		role: row.role,
		summary: row.summary,
		attributionVisibility: row.attribution_visibility,
		agreementRef: row.agreement_ref,
		benefitWeight: numberValue(row.benefit_weight, null),
		effectiveAt: row.effective_at,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeCommerceGovernancePolicy(row) {
	if (!row) return null;
	return {
		id: row.id,
		productId: row.product_id,
		teamId: row.team_id,
		policyKind: row.policy_kind,
		title: row.title,
		approvalRules: parseJson(row.approval_rules_json, {}),
		quorumRules: parseJson(row.quorum_rules_json, {}),
		buyerVisibleSummary: row.buyer_visible_summary,
		status: row.status,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeCommerceOwnershipTransfer(row) {
	if (!row) return null;
	return {
		id: row.id,
		productId: row.product_id,
		fromOwnershipRecordId: row.from_ownership_record_id,
		toOwnershipRecordId: row.to_ownership_record_id,
		status: row.status ?? 'draft',
		reason: row.reason,
		approvalEvidence: parseJson(row.approval_evidence_json, {}),
		buyerVisibleImpact: row.buyer_visible_impact,
		effectiveAt: row.effective_at,
		requestedByType: row.requested_by_type ?? 'user',
		requestedById: row.requested_by_id ?? 'system',
		approvedByType: row.approved_by_type ?? null,
		approvedById: row.approved_by_id ?? null,
		approvedAt: row.approved_at ?? null,
		rejectedAt: row.rejected_at ?? null,
		supersededAt: row.superseded_at ?? null,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
	};
}

function serializeCommerceSuccessionEvent(row) {
	if (!row) return null;
	return {
		id: row.id,
		productId: row.product_id,
		ownershipRecordId: row.ownership_record_id,
		stewardshipAssignmentId: row.stewardship_assignment_id,
		successorType: row.successor_type,
		successorId: row.successor_id,
		eventType: row.event_type,
		status: row.status,
		reason: row.reason,
		evidence: parseJson(row.evidence_json, {}),
		effectiveAt: row.effective_at,
		createdByType: row.created_by_type,
		createdById: row.created_by_id,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
	};
}

function serializeCommerceOwnershipWorkflowSummary(input = {}) {
	return {
		productId: input.productId,
		currentOwnershipRecord: input.currentOwnershipRecord ?? null,
		buyerVisibleOwnershipRecords: input.buyerVisibleOwnershipRecords ?? [],
		stewardshipAssignments: input.stewardshipAssignments ?? [],
		contributions: input.contributions ?? [],
		governancePolicies: input.governancePolicies ?? [],
		pendingTransfers: input.pendingTransfers ?? [],
		successionEvents: input.successionEvents ?? [],
	};
}

function serializeCommerceProductVersion(row) {
	if (!row) return null;
	return {
		id: row.id,
		productId: row.product_id,
		version: row.version,
		status: row.status,
		catalogArtifactVersionId: row.catalog_artifact_version_id,
		manifestKey: row.manifest_key,
		artifactKey: row.artifact_key,
		integrity: row.integrity,
		releaseNotes: row.release_notes,
		compatibility: parseJson(row.compatibility_json, {}),
		metadata: parseJson(row.metadata_json, {}),
		publishedAt: row.published_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeCommerceOffer(row) {
	if (!row) return null;
	return {
		id: row.id,
		productId: row.product_id,
		productVersionId: row.product_version_id,
		vendorId: row.vendor_id,
		sellerTeamId: row.seller_team_id,
		mode: row.mode,
		status: row.status,
		title: row.title,
		termsSummary: row.terms_summary,
		accessScope: parseJson(row.access_scope_json, {}),
		supportScope: parseJson(row.support_scope_json, {}),
		fulfillmentMode: row.fulfillment_mode,
		activePriceId: row.active_price_id,
		stripeProductId: row.stripe_product_id,
		stripeProductStatus: row.stripe_product_status ?? 'not_synced',
		stripeProductSyncedAt: row.stripe_product_synced_at,
		stripeProductSyncError: row.stripe_product_sync_error,
		stripeProductMetadata: parseJson(row.stripe_product_metadata_json, {}),
		startsAt: row.starts_at,
		endsAt: row.ends_at,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeCommercePrice(row) {
	if (!row) return null;
	return {
		id: row.id,
		offerId: row.offer_id,
		amount: Number(row.amount ?? 0),
		currency: row.currency,
		billingInterval: row.billing_interval,
		status: row.status,
		stripeProductId: row.stripe_product_id,
		stripePriceId: row.stripe_price_id,
		stripeLookupKey: row.stripe_lookup_key,
		stripeSyncStatus: row.stripe_sync_status ?? 'not_synced',
		stripeSyncedAt: row.stripe_synced_at,
		stripeSyncError: row.stripe_sync_error,
		stripeMetadata: parseJson(row.stripe_metadata_json, {}),
		priceVersion: Number(row.price_version ?? 1),
		taxBehavior: row.tax_behavior,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeCommerceGovernanceEvent(row) {
	if (!row) return null;
	return {
		id: row.id,
		actorType: row.actor_type,
		actorId: row.actor_id,
		action: row.action,
		objectType: row.object_type,
		objectId: row.object_id,
		priorState: row.prior_state,
		nextState: row.next_state,
		reason: row.reason,
		evidence: parseJson(row.evidence_json, {}),
		relatedOrderId: row.related_order_id,
		relatedOfferId: row.related_offer_id,
		relatedProductId: row.related_product_id,
		relatedTeamId: row.related_team_id,
		createdAt: row.created_at,
	};
}

function serializeCommerceCart(row) {
	if (!row) return null;
	return {
		id: row.id,
		buyerTeamId: row.buyer_team_id,
		buyerUserId: row.buyer_user_id,
		status: row.status,
		currency: row.currency,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeCommerceCartItem(row) {
	if (!row) return null;
	return {
		id: row.id,
		cartId: row.cart_id,
		vendorId: row.vendor_id,
		sellerTeamId: row.seller_team_id,
		productId: row.product_id,
		productVersionId: row.product_version_id,
		offerId: row.offer_id,
		priceId: row.price_id,
		quantity: Number(row.quantity ?? 1),
		unitAmount: Number(row.unit_amount ?? 0),
		currency: row.currency,
		mode: row.mode,
		status: row.status,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeCommerceCheckout(row) {
	if (!row) return null;
	return {
		id: row.id,
		cartId: row.cart_id,
		buyerTeamId: row.buyer_team_id,
		buyerUserId: row.buyer_user_id,
		status: row.status,
		checkoutMode: row.checkout_mode,
		groupCount: Number(row.group_count ?? 0),
		completedGroupCount: Number(row.completed_group_count ?? 0),
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeCommerceOrder(row) {
	if (!row) return null;
	return {
		id: row.id,
		checkoutId: row.checkout_id,
		cartId: row.cart_id,
		buyerTeamId: row.buyer_team_id,
		buyerUserId: row.buyer_user_id,
		vendorId: row.vendor_id,
		sellerTeamId: row.seller_team_id,
		status: row.status,
		currency: row.currency,
		subtotalAmount: Number(row.subtotal_amount ?? 0),
		totalAmount: Number(row.total_amount ?? 0),
		refundedAmount: Number(row.refunded_amount ?? 0),
		refundStatus: row.refund_status ?? 'none',
		stripeCheckoutSessionId: row.stripe_checkout_session_id,
		stripePaymentIntentId: row.stripe_payment_intent_id,
		stripeSubscriptionId: row.stripe_subscription_id,
		stripeCustomerId: row.stripe_customer_id,
		stripeConnectedAccountId: row.stripe_connected_account_id,
		ownershipSnapshot: parseJson(row.ownership_snapshot_json, {}),
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeCommerceOrderItem(row) {
	if (!row) return null;
	return {
		id: row.id,
		orderId: row.order_id,
		vendorId: row.vendor_id,
		sellerTeamId: row.seller_team_id,
		productId: row.product_id,
		productVersionId: row.product_version_id,
		offerId: row.offer_id,
		priceId: row.price_id,
		mode: row.mode,
		quantity: Number(row.quantity ?? 1),
		unitAmount: Number(row.unit_amount ?? 0),
		totalAmount: Number(row.total_amount ?? 0),
		refundedAmount: Number(row.refunded_amount ?? 0),
		refundStatus: row.refund_status ?? 'none',
		currency: row.currency,
		status: row.status,
		entitlementId: row.entitlement_id,
		ownershipSnapshot: parseJson(row.ownership_snapshot_json, {}),
		accessScope: parseJson(row.access_scope_json, {}),
		supportScope: parseJson(row.support_scope_json, {}),
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeCommerceRefund(row) {
	if (!row) return null;
	return {
		id: row.id,
		orderId: row.order_id,
		orderItemId: row.order_item_id,
		paymentGroupId: row.payment_group_id,
		vendorId: row.vendor_id,
		sellerTeamId: row.seller_team_id,
		buyerTeamId: row.buyer_team_id,
		buyerUserId: row.buyer_user_id,
		amount: Number(row.amount ?? 0),
		currency: row.currency,
		status: row.status,
		reason: row.reason,
		stripeRefundId: row.stripe_refund_id,
		stripePaymentIntentId: row.stripe_payment_intent_id,
		stripeConnectedAccountId: row.stripe_connected_account_id,
		idempotencyKey: row.idempotency_key,
		requestedByType: row.requested_by_type,
		requestedById: row.requested_by_id,
		failureReason: row.failure_reason,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeCommerceFulfillmentEvent(row) {
	if (!row) return null;
	return {
		id: row.id,
		orderId: row.order_id,
		orderItemId: row.order_item_id,
		entitlementId: row.entitlement_id,
		vendorId: row.vendor_id,
		sellerTeamId: row.seller_team_id,
		productId: row.product_id,
		productVersionId: row.product_version_id,
		catalogItemId: row.catalog_item_id,
		catalogArtifactVersionId: row.catalog_artifact_version_id,
		eventType: row.event_type,
		status: row.status,
		artifactRefs: parseJson(row.artifact_refs_json, []),
		deliveryRefs: parseJson(row.delivery_refs_json, []),
		message: row.message,
		actorType: row.actor_type,
		actorId: row.actor_id,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
	};
}

function serializeCommerceServiceRequest(row) {
	if (!row) return null;
	return {
		id: row.id,
		buyerTeamId: row.buyer_team_id,
		buyerUserId: row.buyer_user_id,
		vendorId: row.vendor_id,
		sellerTeamId: row.seller_team_id,
		productId: row.product_id,
		offerId: row.offer_id,
		status: row.status,
		requestedScope: row.requested_scope,
		approvedScope: row.approved_scope,
		accessNeeds: parseJson(row.access_needs_json, {}),
		buyerVisibleSummary: row.buyer_visible_summary,
		vendorPrivateNotes: row.vendor_private_notes,
		activeQuoteId: row.active_quote_id,
		approvedQuoteId: row.approved_quote_id,
		contractId: row.contract_id,
		relatedProjectId: row.related_project_id,
		relatedWorkdayId: row.related_workday_id,
		orderId: row.order_id,
		entitlementId: row.entitlement_id,
		ownershipSnapshot: parseJson(row.ownership_snapshot_json, {}),
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeCommerceServiceQuote(row) {
	if (!row) return null;
	return {
		id: row.id,
		requestId: row.request_id,
		vendorId: row.vendor_id,
		sellerTeamId: row.seller_team_id,
		buyerTeamId: row.buyer_team_id,
		buyerUserId: row.buyer_user_id,
		quoteVersion: Number(row.quote_version ?? 1),
		status: row.status,
		title: row.title,
		scopeSummary: row.scope_summary,
		deliverables: parseJson(row.deliverables_json, []),
		assumptions: parseJson(row.assumptions_json, []),
		accessRequirements: parseJson(row.access_requirements_json, {}),
		governanceRequirements: parseJson(row.governance_requirements_json, {}),
		amount: Number(row.amount ?? 0),
		currency: row.currency,
		expiresAt: row.expires_at,
		buyerApprovedAt: row.buyer_approved_at,
		vendorApprovedAt: row.vendor_approved_at,
		acceptedAt: row.accepted_at,
		rejectedAt: row.rejected_at,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeCommerceServiceContract(row) {
	if (!row) return null;
	return {
		id: row.id,
		requestId: row.request_id,
		quoteId: row.quote_id,
		vendorId: row.vendor_id,
		sellerTeamId: row.seller_team_id,
		buyerTeamId: row.buyer_team_id,
		buyerUserId: row.buyer_user_id,
		productId: row.product_id,
		offerId: row.offer_id,
		status: row.status,
		amount: Number(row.amount ?? 0),
		currency: row.currency,
		orderId: row.order_id,
		orderItemId: row.order_item_id,
		paymentGroupId: row.payment_group_id,
		entitlementId: row.entitlement_id,
		relatedProjectId: row.related_project_id,
		relatedWorkdayId: row.related_workday_id,
		ownershipSnapshot: parseJson(row.ownership_snapshot_json, {}),
		accessApprovalSnapshot: parseJson(row.access_approval_snapshot_json, {}),
		fulfillmentSummary: row.fulfillment_summary,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeCommerceServiceEvent(row) {
	if (!row) return null;
	return {
		id: row.id,
		requestId: row.request_id,
		quoteId: row.quote_id,
		contractId: row.contract_id,
		eventType: row.event_type,
		actorType: row.actor_type,
		actorId: row.actor_id,
		priorState: row.prior_state,
		nextState: row.next_state,
		message: row.message,
		evidence: parseJson(row.evidence_json, {}),
		createdAt: row.created_at,
	};
}

function serializeCommerceCapacityListing(row, options = {}) {
	if (!row) return null;
	const listing = {
		id: row.id,
		productId: row.product_id,
		vendorId: row.vendor_id,
		sellerTeamId: row.seller_team_id,
		capacityProviderId: row.capacity_provider_id,
		executionProviderId: row.execution_provider_id,
		status: row.status,
		accessLevel: row.access_level,
		runtimeIsolationLevel: row.runtime_isolation_level,
		humanInvolvementLevel: row.human_involvement_level,
		aiInvolvementLevel: row.ai_involvement_level,
		dataAccessLevel: row.data_access_level,
		secretAccessLevel: row.secret_access_level,
		supportedServiceTypes: parseJson(row.supported_service_types_json, []),
		supportedRegions: parseJson(row.supported_regions_json, []),
		runtimeRequirements: parseJson(row.runtime_requirements_json, {}),
		dataHandlingSummary: row.data_handling_summary,
		buyerVisibleRiskSummary: row.buyer_visible_risk_summary,
		governanceRequirements: parseJson(row.governance_requirements_json, {}),
		supportPolicy: row.support_policy,
		availabilitySummary: row.availability_summary,
		ownershipSnapshot: parseJson(row.ownership_snapshot_json, {}),
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
	if (options.publicSafe) {
		return {
			...listing,
			capacityProviderId: null,
			executionProviderId: null,
			runtimeRequirements: {},
			governanceRequirements: {},
			metadata: {},
		};
	}
	return listing;
}

function serializeCommerceCapacityListingInquiry(row, options = {}) {
	if (!row) return null;
	const inquiry = {
		id: row.id,
		listingId: row.listing_id,
		productId: row.product_id,
		vendorId: row.vendor_id,
		sellerTeamId: row.seller_team_id,
		buyerTeamId: row.buyer_team_id,
		buyerUserId: row.buyer_user_id,
		status: row.status,
		requestedServiceType: row.requested_service_type,
		requestedScope: row.requested_scope,
		dataAccessRequested: parseJson(row.data_access_requested_json, {}),
		secretAccessRequested: parseJson(row.secret_access_requested_json, {}),
		relatedProjectId: row.related_project_id,
		relatedWorkdayId: row.related_workday_id,
		governanceEvidence: parseJson(row.governance_evidence_json, {}),
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
	if (options.publicSafe) {
		return {
			...inquiry,
			governanceEvidence: {},
			metadata: {},
		};
	}
	return inquiry;
}

function redactBuyerUserId(value) {
	if (!value) return null;
	const text = String(value);
	return text.length <= 8 ? 'buyer-user' : `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function serializeCommerceVendorOrderSummary(row) {
	if (!row) return null;
	return {
		id: row.id,
		checkoutId: row.checkout_id,
		status: row.status,
		currency: row.currency,
		totalAmount: Number(row.total_amount ?? 0),
		refundedAmount: Number(row.refunded_amount ?? 0),
		buyerTeamId: row.buyer_team_id,
		buyerDisplayName: row.buyer_team_name ?? null,
		buyerUserIdRedacted: redactBuyerUserId(row.buyer_user_id),
		itemCount: Number(row.item_count ?? 0),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeCommercePaymentGroup(row, clientSecret = null) {
	if (!row) return null;
	return {
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
		clientSecret,
		clientSecretLast4: row.client_secret_last4,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeCommerceSubscription(row) {
	if (!row) return null;
	return {
		id: row.id,
		orderId: row.order_id,
		vendorId: row.vendor_id,
		sellerTeamId: row.seller_team_id,
		buyerTeamId: row.buyer_team_id,
		buyerUserId: row.buyer_user_id,
		offerId: row.offer_id,
		priceId: row.price_id,
		status: row.status,
		renewalState: row.renewal_state,
		stripeSubscriptionId: row.stripe_subscription_id,
		stripeCustomerId: row.stripe_customer_id,
		stripeConnectedAccountId: row.stripe_connected_account_id,
		currentPeriodStart: row.current_period_start,
		currentPeriodEnd: row.current_period_end,
		cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
		canceledAt: row.canceled_at,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeCommerceEntitlement(row) {
	if (!row) return null;
	return {
		id: row.id,
		buyerTeamId: row.buyer_team_id,
		buyerUserId: row.buyer_user_id,
		sellerTeamId: row.seller_team_id,
		productId: row.product_id,
		productVersionId: row.product_version_id,
		offerId: row.offer_id,
		orderId: row.order_id,
		orderItemId: row.order_item_id,
		subscriptionId: row.subscription_id,
		status: row.status,
		accessScope: parseJson(row.access_scope_json, {}),
		startsAt: row.starts_at,
		endsAt: row.ends_at,
		renewalState: row.renewal_state,
		fulfillmentArtifactRefs: parseJson(row.fulfillment_artifact_refs_json, []),
		projectId: row.project_id,
		catalogItemId: row.catalog_item_id,
		ownershipSnapshot: parseJson(row.ownership_snapshot_json, {}),
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeCommerceBuyerStripeCustomer(row) {
	if (!row) return null;
	return {
		id: row.id,
		buyerTeamId: row.buyer_team_id,
		buyerUserId: row.buyer_user_id,
		vendorId: row.vendor_id,
		connectedAccountId: row.connected_account_id,
		environment: row.environment,
		stripeCustomerId: row.stripe_customer_id,
		metadata: parseJson(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function serializeCommerceWebhookEvent(row) {
	if (!row) return null;
	return {
		id: row.id,
		provider: row.provider,
		environment: row.environment,
		eventId: row.event_id,
		eventType: row.event_type,
		connectedAccountId: row.connected_account_id,
		status: row.status,
		objectType: row.object_type,
		objectId: row.object_id,
		relatedOrderId: row.related_order_id,
		relatedSubscriptionId: row.related_subscription_id,
		payloadHash: row.payload_hash,
		processingError: row.processing_error,
		receivedAt: row.received_at,
		processedAt: row.processed_at,
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
	// This is part of the public host contract consumed by the capacity facade.
	// Declare it explicitly because this legacy store is still typechecked in
	// transpile-only mode and constructor assignment alone is not emitted in its
	// inferred declaration shape.
	declare config: Record<string, unknown>;

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

	async batch(operations) {
		if (typeof this.db.batch !== 'function') throw new Error('The configured database does not support transactional batches.');
		const statements = operations.map(({ query, params = [] }) => this.db.prepare(query).bind(...params));
		return this.db.batch(statements);
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
		try {
			const row = await this.first(
				`SELECT id FROM users WHERE LOWER(username) = LOWER(?) ${excludeUserId ? 'AND id != ?' : ''} LIMIT 1`,
				excludeUserId ? [value, excludeUserId] : [value],
			);
			return Boolean(row?.id);
		} catch (error) {
			if (!missingSchemaError(error)) throw error;
			return false;
		}
	}

	async teamPublicNameExists(name, excludeTeamId = null) {
		await this.ensureInitialized();
		const value = normalizeTeamName(name);
		if (!value) return false;
		try {
			const row = await this.first(
				`SELECT id FROM teams WHERE (LOWER(name) = LOWER(?) OR LOWER(slug) = LOWER(?)) ${excludeTeamId ? 'AND id != ?' : ''} LIMIT 1`,
				excludeTeamId ? [value, value, excludeTeamId] : [value, value],
			);
			return Boolean(row?.id);
		} catch (error) {
			if (!missingSchemaError(error)) throw error;
			return false;
		}
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
		return this.getProjectArchitecture(projectId);
	}

	async upsertProjectRepositoryTopology(projectId, topology = {}) {
		return this.upsertProjectArchitecture(projectId, topology);
	}

	async getProjectArchitecture(projectId) {
		await this.ensureInitialized();
		const project = await this.getProject(projectId);
		if (!project) return null;
		const architecture = project.metadata?.architecture;
		if (architecture && typeof architecture === 'object' && !Array.isArray(architecture)) {
			return normalizeProjectArchitecture(architecture);
		}
		return null;
	}

	async upsertProjectArchitecture(projectId, input = {}) {
		await this.ensureInitialized();
		const project = await this.getProject(projectId);
		if (!project) return null;
		const architecture = normalizeProjectArchitecture(input);
		const nextMetadata = {
			...(project.metadata ?? {}),
			architecture,
		};
		await this.updateProject(projectId, { metadata: nextMetadata });
		await this.projectArchitectureContentBindings(projectId, architecture).catch(() => null);
		return architecture;
	}

	async importProjectRepositoryPlan(teamId, input = {}) {
		await this.ensureInitialized();
		if (!input || typeof input !== 'object' || Array.isArray(input)) {
			throw projectArchitectureError('Project repository import requires a safe import plan.', 'invalid_project_import_plan');
		}
		if (containsTreeseedPlaintextSecretMaterial(input)) {
			throw projectArchitectureError('Project repository import cannot contain plaintext credentials, tokens, or secret material.', 'project_import_secret_material_rejected');
		}
		if (
			input.repositoryTopology !== undefined
			|| input.contentRoot !== undefined
			|| input.metadata?.repositoryTopology !== undefined
			|| input.metadata?.contentRoot !== undefined
		) {
			throw projectArchitectureError('Project imports must use canonical architecture, not legacy topology metadata.', 'legacy_project_topology_rejected');
		}
		const repository = objectValue(input.repository, {});
		const plannedRecords = objectValue(input.plannedRecords, {});
		const plannedProject = objectValue(plannedRecords.project, {});
		const plannedRepository = objectValue(plannedRecords.hubRepository, {});
		const architecture = normalizeProjectArchitecture(input.architecture);
		const owner = normalizeProjectPath(repository.owner ?? plannedRepository.owner, '');
		const name = normalizeProjectPath(repository.name ?? plannedRepository.name, '');
		if (!owner || !name) {
			throw projectArchitectureError('Project repository import requires repository owner and name.', 'invalid_project_import_plan');
		}
		const slugResult = validateProjectSlug(plannedProject.slug ?? name);
		if (!slugResult.ok) {
			throw projectArchitectureError(slugResult.message, 'invalid_project_import_plan');
		}
		const visibility = normalizeProjectPath(repository.visibility ?? plannedProject.visibility, 'public') === 'private' ? 'private' : 'public';
		const defaultBranch = normalizeProjectPath(repository.defaultBranch ?? plannedRepository.defaultBranch, 'main');
		const url = normalizeProjectPath(repository.htmlUrl ?? plannedRepository.url, `https://github.com/${owner}/${name}`);
		const cloneUrl = normalizeProjectPath(repository.cloneUrl, `${url}.git`);
		const credentialRef = normalizeProjectPath(input.credentialRef ?? plannedRepository.credentialRef, '');
		if (credentialRef && !credentialRef.startsWith('env:TREESEED_GITHUB_TOKEN')) {
			throw projectArchitectureError('Project repository import credentialRef must be an env:TREESEED_GITHUB_TOKEN reference.', 'invalid_project_import_plan');
		}
		const existing = await this.getProjectByTeamAndSlug(teamId, slugResult.slug);
		const metadata = {
			...(existing?.metadata ?? {}),
			architecture,
			visibility,
			import: {
				provider: 'github',
				importedAt: isoNow(),
				repository: `${owner}/${name}`,
				credentialRef: credentialRef || null,
				source: 'project_repository_import',
			},
		};
		const details = existing
			? await this.updateProject(existing.id, {
				name: normalizeProjectPath(plannedProject.name, existing.name),
				description: existing.description,
				metadata,
			}).then(() => this.getProjectDetails(existing.id))
			: await this.createProject(teamId, {
				slug: slugResult.slug,
				name: normalizeProjectPath(plannedProject.name, name),
				description: input.description ?? null,
				metadata,
			});
		const project = details?.project ?? details;
		if (!project?.id) {
			throw projectArchitectureError('Project repository import could not create or update the project.', 'invalid_project_import_plan');
		}
		const hubRepository = await this.upsertHubRepository(project.id, {
			teamId,
			role: 'software',
			provider: 'github',
			owner,
			name,
			url,
			defaultBranch,
			currentBranch: defaultBranch,
			status: 'active',
			metadata: {
				credentialRef: credentialRef || null,
				cloneUrl,
				importedFromExistingRepository: true,
				projectArchitecture: architecture,
			},
		});
		const normalizedArchitecture = await this.upsertProjectArchitecture(project.id, architecture);
		const treeDxLibrary = await this.upsertProjectTreeDxLibrary(project.id, {
			libraryId: plannedRecords.treeDxLibrary?.libraryId ?? `${teamId}/${slugResult.slug}`,
			contentPath: architecture.contentPath ?? null,
			contentRepositoryUrl: url,
			contentRepositoryDefaultBranch: defaultBranch,
			contentRepositoryRef: defaultBranch,
			r2BucketName: architecture.contentPublishTarget?.kind === 'cloudflare_r2' ? architecture.contentPublishTarget.bucket ?? null : null,
			r2ManifestKey: architecture.contentPublishTarget?.kind === 'cloudflare_r2'
				? architecture.contentPublishTarget.manifestPath ?? architecture.contentPublishTarget.prefix ?? null
				: null,
			metadata: {
				projectArchitecture: architecture,
				importedFromExistingRepository: true,
			},
		}).catch(() => null);
		const contentSource = await this.getHubContentSource(project.id);
		return {
			project: (await this.getProjectDetails(project.id))?.project ?? project,
			architecture: normalizedArchitecture,
			hubRepository,
			contentSource,
			treeDxLibrary,
			diagnostics: Array.isArray(input.diagnostics) ? input.diagnostics : [],
			plannedRecords,
		};
	}

	async projectArchitectureContentBindings(projectId, architecture) {
		const project = await this.getProject(projectId);
		if (!project || !architecture) return null;
		const repositories = await this.listHubRepositories(projectId);
		const contentRepository = repositories.find((entry) => entry.role === 'content') ?? null;
		const publishTarget = architecture.contentPublishTarget ?? {};
		await this.upsertHubContentSource(projectId, {
			teamId: project.teamId,
			contentRepositoryId: contentRepository?.id ?? null,
			productionSource: projectArchitectureContentSource(architecture),
			overlayPolicy: architecture.contentRuntimeSource,
			r2BucketName: publishTarget.kind === 'cloudflare_r2' ? publishTarget.bucket ?? null : null,
			r2ManifestKey: publishTarget.kind === 'cloudflare_r2' ? publishTarget.manifestPath ?? publishTarget.prefix ?? null : null,
			metadata: {
				projectArchitecture: architecture,
				contentPath: architecture.contentPath ?? null,
				localContentMaterialization: architecture.localContentMaterialization,
			},
		});
		const binding = await this.getProjectTreeDxLibrary(projectId);
		if (binding) {
			await this.upsertProjectTreeDxLibrary(projectId, {
				contentPath: architecture.contentPath ?? binding.contentPath ?? 'src/content',
				r2BucketName: publishTarget.kind === 'cloudflare_r2' ? publishTarget.bucket ?? binding.r2BucketName ?? null : binding.r2BucketName ?? null,
				r2ManifestKey: publishTarget.kind === 'cloudflare_r2' ? publishTarget.manifestPath ?? publishTarget.prefix ?? binding.r2ManifestKey ?? null : binding.r2ManifestKey ?? null,
				metadata: {
					projectArchitecture: architecture,
				},
			});
		}
		return this.getHubContentSource(projectId);
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
						treeDxRepositoryBinding: topology,
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
						treeDxRepositoryBinding: topology,
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








































































	async recordGovernanceEvent(input = {}) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO governance_events (
				id, event_type, actor_type, actor_id, team_id, project_id, proposal_id, decision_id,
				proposal_version, prior_state, next_state, message, evidence_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				stringValue(input.eventType, 'governance.updated'),
				stringValue(input.actorType, 'system'),
				input.actorId ?? null,
				input.teamId,
				input.projectId ?? null,
				input.proposalId ?? null,
				input.decisionId ?? null,
				input.proposalVersion ?? null,
				input.priorState ?? null,
				input.nextState ?? null,
				input.message ?? null,
				JSON.stringify(input.evidence ?? {}),
				timestamp,
			],
		);
		return serializeGovernanceEvent(await this.first(`SELECT * FROM governance_events WHERE id = ? LIMIT 1`, [id]));
	}

	async getTeamGovernancePolicy(teamId, scope = 'team') {
		await this.ensureInitialized();
		const row = await this.first(
			`SELECT * FROM team_governance_policies
			 WHERE team_id = ? AND scope = ? AND active = 1
			 ORDER BY updated_at DESC LIMIT 1`,
			[teamId, scope],
		);
		if (row) return serializeGovernancePolicy(row);
		return this.ensureDefaultTeamGovernancePolicy(teamId, scope);
	}

	async ensureDefaultTeamGovernancePolicy(teamId, scope = 'team') {
		await this.ensureInitialized();
		const existing = await this.first(
			`SELECT * FROM team_governance_policies
			 WHERE team_id = ? AND scope = ? AND active = 1
			 ORDER BY updated_at DESC LIMIT 1`,
			[teamId, scope],
		);
		if (existing) return serializeGovernancePolicy(existing);
		const timestamp = isoNow();
		const providerId = teamId === TREESEED_COMMONS_TEAM_SLUG || scope === 'commons' ? 'treeseed_bicameral_v1' : 'admin_approval_v1';
		const provider = governanceVotingProvider(providerId);
		const id = `governance-policy:${teamId}:${scope}`;
		await this.run(
			`INSERT INTO team_governance_policies (
				id, team_id, scope, provider_id, provider_version, config_json, active, created_by, created_at, updated_at, superseded_at
			) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, NULL)`,
			[id, teamId, scope, provider.id, provider.version, JSON.stringify({}), timestamp, timestamp],
		);
		return serializeGovernancePolicy(await this.first(`SELECT * FROM team_governance_policies WHERE id = ? LIMIT 1`, [id]));
	}

	async setTeamGovernancePolicy(teamId, input = {}) {
		await this.ensureInitialized();
		const scope = optionalStringValue(input.scope, 'team');
		const provider = governanceVotingProvider(optionalStringValue(input.providerId, 'admin_approval_v1'));
		const timestamp = isoNow();
		await this.run(
			`UPDATE team_governance_policies SET active = 0, superseded_at = ?, updated_at = ?
			 WHERE team_id = ? AND scope = ? AND active = 1`,
			[timestamp, timestamp, teamId, scope],
		);
		const id = input.id ?? `governance-policy:${teamId}:${scope}:${Date.parse(timestamp)}`;
		await this.run(
			`INSERT INTO team_governance_policies (
				id, team_id, scope, provider_id, provider_version, config_json, active, created_by, created_at, updated_at, superseded_at
			) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL)`,
			[id, teamId, scope, provider.id, provider.version, JSON.stringify(objectValue(input.config, {})), input.createdBy ?? null, timestamp, timestamp],
		);
		return serializeGovernancePolicy(await this.first(`SELECT * FROM team_governance_policies WHERE id = ? LIMIT 1`, [id]));
	}

	async getProjectGovernancePolicy(projectId) {
		await this.ensureInitialized();
		const row = await this.first(
			`SELECT * FROM project_governance_policies
			 WHERE project_id = ? AND active = 1
			 ORDER BY updated_at DESC LIMIT 1`,
			[projectId],
		);
		if (row) return serializeGovernancePolicy(row);
		const project = await this.getProject(projectId);
		if (!project) return null;
		return this.getTeamGovernancePolicy(project.teamId, 'project_default');
	}

	async setProjectGovernancePolicy(projectId, input = {}) {
		await this.ensureInitialized();
		const project = await this.getProject(projectId);
		if (!project) return null;
		const provider = governanceVotingProvider(optionalStringValue(input.providerId, 'admin_approval_v1'));
		const timestamp = isoNow();
		await this.run(
			`UPDATE project_governance_policies SET active = 0, superseded_at = ?, updated_at = ?
			 WHERE project_id = ? AND active = 1`,
			[timestamp, timestamp, projectId],
		);
		const id = input.id ?? `governance-policy:${projectId}:${Date.parse(timestamp)}`;
		await this.run(
			`INSERT INTO project_governance_policies (
				id, team_id, project_id, provider_id, provider_version, config_json, active, created_by, created_at, updated_at, superseded_at
			) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL)`,
			[id, project.teamId, project.id, provider.id, provider.version, JSON.stringify(objectValue(input.config, {})), input.createdBy ?? null, timestamp, timestamp],
		);
		return serializeGovernancePolicy(await this.first(`SELECT * FROM project_governance_policies WHERE id = ? LIMIT 1`, [id]));
	}

	async resolveGovernancePolicy(input = {}) {
		if (input.projectId) {
			const projectPolicy = await this.getProjectGovernancePolicy(input.projectId);
			if (projectPolicy) return projectPolicy;
		}
		return this.getTeamGovernancePolicy(input.teamId, input.scope === 'commons' ? 'commons' : 'team');
	}

	async createGovernanceProposal(principal, input = {}) {
		await this.ensureInitialized();
		const title = stringValue(input.title);
		const summary = stringValue(input.summary);
		const body = stringValue(input.body);
		if (!title || !summary || !body) {
			const error = new Error('Proposal title, summary, and body are required.');
			error.status = 400;
			throw error;
		}
		const project = input.projectId ? await this.getProject(input.projectId) : null;
		const teamId = input.teamId ?? project?.teamId ?? TREESEED_COMMONS_TEAM_SLUG;
		const scope = optionalStringValue(input.scope, project ? 'project' : 'commons');
		const policy = await this.resolveGovernancePolicy({ teamId, projectId: project?.id ?? null, scope });
		const provider = governanceVotingProvider(policy?.providerId);
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		const proposalType = optionalStringValue(input.proposalType ?? input.decisionType, 'implementation');
		const contentHash = governanceContentHash({ title, summary, body, proposalType });
		const contentProposalSlug = optionalStringValue(input.contentProposalSlug) ?? governanceSlug(title, 'proposal');
		await this.run(
			`INSERT INTO governance_proposals (
				id, team_id, project_id, scope, status, title, summary, body, proposal_type,
				content_proposal_slug, content_decision_slug, active_version, active_content_hash,
				governance_provider_id, governance_provider_version, governance_policy_id, decision_id,
				voting_starts_at, voting_ends_at, closed_at, closed_reason, created_by_type, created_by_id,
				metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?)`,
			[
				id,
				teamId,
				project?.id ?? input.projectId ?? null,
				scope,
				input.status === 'open' || input.status === 'submitted' ? 'open' : 'draft',
				title,
				summary,
				body,
				proposalType,
				contentProposalSlug,
				contentHash,
				provider.id,
				provider.version,
				policy?.id ?? null,
				input.createdByType ?? 'user',
				input.createdById ?? principal?.id ?? null,
				JSON.stringify(input.metadata ?? {}),
				timestamp,
				timestamp,
			],
		);
		await this.run(
			`INSERT INTO governance_proposal_versions (
				id, proposal_id, version, title, summary, body, content_hash, change_reason,
				created_by_type, created_by_id, created_at
			) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[randomUUID(), id, title, summary, body, contentHash, 'Initial proposal version.', input.createdByType ?? 'user', input.createdById ?? principal?.id ?? null, timestamp],
		);
		await this.recordGovernanceEvent({
			eventType: 'proposal.created',
			actorType: input.createdByType ?? 'user',
			actorId: input.createdById ?? principal?.id ?? null,
			teamId,
			projectId: project?.id ?? input.projectId ?? null,
			proposalId: id,
			proposalVersion: 1,
			nextState: input.status === 'open' || input.status === 'submitted' ? 'open' : 'draft',
			evidence: { providerId: provider.id, policyId: policy?.id ?? null },
		});
		return this.getGovernanceProposal(id);
	}

	async getGovernanceProposal(proposalId) {
		await this.ensureInitialized();
		return serializeGovernanceProposal(await this.first(`SELECT * FROM governance_proposals WHERE id = ? LIMIT 1`, [proposalId]));
	}

	async listGovernanceProposals(filters = {}) {
		await this.ensureInitialized();
		const limit = Math.max(1, Math.min(200, Number(filters.limit) || 100));
		const clauses = [];
		const params = [];
		for (const [key, column] of [['teamId', 'team_id'], ['projectId', 'project_id'], ['scope', 'scope'], ['status', 'status']]) {
			if (filters[key]) {
				clauses.push(`${column} = ?`);
				params.push(filters[key]);
			}
		}
		params.push(limit);
		const rows = await this.all(
			`SELECT * FROM governance_proposals ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
			 ORDER BY updated_at DESC LIMIT ?`,
			params,
		);
		return rows.map(serializeGovernanceProposal);
	}

	async updateGovernanceProposalDraft(principal, proposalId, input = {}) {
		await this.ensureInitialized();
		const existing = await this.getGovernanceProposal(proposalId);
		if (!existing) return null;
		if (['accepted', 'rejected', 'withdrawn', 'superseded', 'no_decision_quorum_failed'].includes(existing.status)) {
			const error = new Error('Closed proposals cannot be edited. Create a revised proposal instead.');
			error.status = 409;
			throw error;
		}
		const title = optionalStringValue(input.title, existing.title);
		const summary = optionalStringValue(input.summary, existing.summary);
		const body = optionalStringValue(input.body, existing.body);
		const proposalType = optionalStringValue(input.proposalType, existing.proposalType);
		const nextHash = governanceContentHash({ title, summary, body, proposalType });
		const materialChange = nextHash !== existing.activeContentHash;
		const timestamp = isoNow();
		const nextVersion = existing.status === 'voting' && materialChange ? existing.activeVersion + 1 : existing.activeVersion;
		const nextStatus = existing.status === 'voting' && materialChange ? 'open' : existing.status;
		if (nextVersion !== existing.activeVersion) {
			await this.run(
				`INSERT INTO governance_proposal_versions (
					id, proposal_id, version, title, summary, body, content_hash, change_reason,
					created_by_type, created_by_id, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'user', ?, ?)`,
				[randomUUID(), proposalId, nextVersion, title, summary, body, nextHash, optionalStringValue(input.changeReason, 'Material edit reset voting.'), principal?.id ?? null, timestamp],
			);
		}
		await this.run(
			`UPDATE governance_proposals
			 SET title = ?, summary = ?, body = ?, proposal_type = ?, status = ?, active_version = ?,
				 active_content_hash = ?, voting_starts_at = CASE WHEN ? = 1 THEN NULL ELSE voting_starts_at END,
				 voting_ends_at = CASE WHEN ? = 1 THEN NULL ELSE voting_ends_at END, updated_at = ?
			 WHERE id = ?`,
			[title, summary, body, proposalType, nextStatus, nextVersion, nextHash, nextVersion !== existing.activeVersion ? 1 : 0, nextVersion !== existing.activeVersion ? 1 : 0, timestamp, proposalId],
		);
		await this.recordGovernanceEvent({
			eventType: nextVersion !== existing.activeVersion ? 'proposal.version_reset_voting' : 'proposal.updated',
			actorType: 'user',
			actorId: principal?.id ?? null,
			teamId: existing.teamId,
			projectId: existing.projectId,
			proposalId,
			proposalVersion: nextVersion,
			priorState: existing.status,
			nextState: nextStatus,
			evidence: { priorHash: existing.activeContentHash, nextHash },
		});
		return this.getGovernanceProposal(proposalId);
	}

	async openGovernanceProposal(principal, proposalId, input = {}) {
		return this.transitionGovernanceProposal(proposalId, 'open', {
			actorType: 'user',
			actorId: principal?.id ?? null,
			reason: optionalStringValue(input.reason),
		});
	}

	async transitionGovernanceProposal(proposalId, nextState, input = {}) {
		await this.ensureInitialized();
		const existing = await this.getGovernanceProposal(proposalId);
		if (!existing) return null;
		const timestamp = isoNow();
		await this.run(
			`UPDATE governance_proposals SET status = ?, updated_at = ?, closed_at = ?, closed_reason = ? WHERE id = ?`,
			[
				nextState,
				timestamp,
				['accepted', 'rejected', 'withdrawn', 'superseded', 'no_decision_quorum_failed'].includes(nextState) ? timestamp : existing.closedAt,
				input.reason ?? existing.closedReason ?? null,
				proposalId,
			],
		);
		await this.recordGovernanceEvent({
			eventType: `proposal.${String(nextState).replace(/_/gu, '-')}`,
			actorType: input.actorType ?? 'system',
			actorId: input.actorId ?? null,
			teamId: existing.teamId,
			projectId: existing.projectId,
			proposalId,
			proposalVersion: existing.activeVersion,
			priorState: existing.status,
			nextState,
			message: input.reason ?? null,
			evidence: input.evidence ?? {},
		});
		return this.getGovernanceProposal(proposalId);
	}

	async governanceEligibleVoters(teamId, providerId = 'admin_approval_v1') {
		const members = await this.listTeamMembers(teamId);
		return members
			.filter((member) => member.status === 'active')
			.map((member) => {
				const roles = new Set(member.roles ?? []);
				const stakeWeight = roles.has('team_owner') ? 3 : roles.has('project_lead') ? 2 : roles.has('market_steward') ? 2 : 1;
				return {
					userId: member.userId,
					teamMemberId: member.id,
					activeForQuorum: true,
					chambers: [
						{ chamberId: 'member_chamber', eligible: true, weight: 1, source: 'team_membership', evidence: { roles: member.roles ?? [] } },
						{ chamberId: 'stake_chamber', eligible: providerId === 'treeseed_bicameral_v1', weight: stakeWeight, source: 'team_role_weight', evidence: { roles: member.roles ?? [] } },
						{ chamberId: 'admin_chamber', eligible: roles.has('team_owner') || roles.has('project_lead') || roles.has('market_steward'), weight: 1, source: 'team_manager_role', evidence: { roles: member.roles ?? [] } },
					],
				};
			});
	}

	async activeGovernanceDelegationSnapshots(teamId, scope = 'team') {
		const rows = await this.all(
			`SELECT * FROM governance_delegations
			 WHERE team_id = ? AND status = 'active' AND (scope = ? OR scope = 'team')
			 ORDER BY created_at ASC`,
			[teamId, scope],
		);
		return rows.map(serializeGovernanceDelegation).map((delegation) => ({
			id: delegation.id,
			fromUserId: delegation.fromUserId,
			toUserId: delegation.toUserId,
			scope: delegation.scope,
			chambers: delegation.chambers,
			status: delegation.status,
			reason: delegation.reason,
			createdAt: delegation.createdAt,
		}));
	}

	async snapshotGovernanceElectorate(proposalId) {
		await this.ensureInitialized();
		const proposal = await this.getGovernanceProposal(proposalId);
		if (!proposal) return null;
		const provider = governanceVotingProvider(proposal.governanceProviderId);
		const policy = proposal.projectId ? await this.getProjectGovernancePolicy(proposal.projectId) : await this.getTeamGovernancePolicy(proposal.teamId, proposal.scope === 'commons' ? 'commons' : 'team');
		const eligibleVoters = await this.governanceEligibleVoters(proposal.teamId, provider.id);
		const delegations = await this.activeGovernanceDelegationSnapshots(proposal.teamId, proposal.scope);
		const snapshot = await provider.snapshotElectorate({
			teamId: proposal.teamId,
			projectId: proposal.projectId,
			scope: proposal.scope,
			proposalType: proposal.proposalType,
			providerConfig: policy?.config ?? {},
			eligibleVoters,
			delegations,
			createdAt: isoNow(),
		});
		const id = randomUUID();
		await this.run(
			`INSERT INTO governance_electorate_snapshots (
				id, proposal_id, proposal_version, provider_id, provider_version, rule_snapshot_json, chambers_json,
				eligible_voters_json, delegations_json, eligible_weight_total, active_weight_total, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				proposal.id,
				proposal.activeVersion,
				snapshot.providerId,
				snapshot.providerVersion,
				JSON.stringify(snapshot.ruleSnapshot),
				JSON.stringify(snapshot.chambers),
				JSON.stringify(snapshot.eligibleVoters),
				JSON.stringify(snapshot.delegations),
				snapshot.chambers.reduce((total, chamber) => total + Number(chamber.eligibleWeightTotal ?? 0), 0),
				snapshot.chambers.reduce((total, chamber) => total + Number(chamber.activeWeightTotal ?? 0), 0),
				snapshot.createdAt,
			],
		);
		await this.recordGovernanceEvent({
			eventType: 'governance.electorate_snapshotted',
			actorType: 'system',
			teamId: proposal.teamId,
			projectId: proposal.projectId,
			proposalId: proposal.id,
			proposalVersion: proposal.activeVersion,
			evidence: { snapshotId: id, providerId: provider.id },
		});
		return serializeGovernanceElectorateSnapshot(await this.first(`SELECT * FROM governance_electorate_snapshots WHERE id = ? LIMIT 1`, [id]));
	}

	async startGovernanceProposalVoting(principal, proposalId, input = {}) {
		await this.ensureInitialized();
		const proposal = await this.getGovernanceProposal(proposalId);
		if (!proposal) return null;
		if (!['draft', 'open'].includes(proposal.status)) {
			const error = new Error('Proposal is not open for voting.');
			error.status = 409;
			throw error;
		}
		const snapshot = await this.snapshotGovernanceElectorate(proposalId);
		const timestamp = isoNow();
		const votingEndsAt = optionalStringValue(input.votingEndsAt) ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
		await this.run(
			`UPDATE governance_proposals SET status = 'voting', voting_starts_at = ?, voting_ends_at = ?, updated_at = ? WHERE id = ?`,
			[timestamp, votingEndsAt, timestamp, proposalId],
		);
		await this.recordGovernanceEvent({
			eventType: 'proposal.voting_started',
			actorType: 'user',
			actorId: principal?.id ?? null,
			teamId: proposal.teamId,
			projectId: proposal.projectId,
			proposalId,
			proposalVersion: proposal.activeVersion,
			priorState: proposal.status,
			nextState: 'voting',
			message: optionalStringValue(input.reason),
			evidence: { electorateSnapshotId: snapshot?.id ?? null },
		});
		return this.getGovernanceProposal(proposalId);
	}

	async latestGovernanceElectorateSnapshot(proposalId, version) {
		await this.ensureInitialized();
		return serializeGovernanceElectorateSnapshot(await this.first(
			`SELECT * FROM governance_electorate_snapshots
			 WHERE proposal_id = ? AND proposal_version = ?
			 ORDER BY created_at DESC LIMIT 1`,
			[proposalId, version],
		));
	}

	async listGovernanceProposalVotes(proposalId, options = {}) {
		await this.ensureInitialized();
		const version = options.proposalVersion ?? (await this.getGovernanceProposal(proposalId))?.activeVersion;
		const rows = await this.all(
			`SELECT * FROM governance_proposal_votes WHERE proposal_id = ? AND proposal_version = ? ORDER BY updated_at ASC`,
			[proposalId, version],
		);
		return rows.map(serializeGovernanceVote);
	}

	async effectiveGovernanceVotes(proposal) {
		const directVotes = await this.listGovernanceProposalVotes(proposal.id, { proposalVersion: proposal.activeVersion });
		const byUser = new Map(directVotes.map((vote) => [vote.userId, vote]));
		const snapshot = await this.latestGovernanceElectorateSnapshot(proposal.id, proposal.activeVersion);
		for (const delegation of snapshot?.delegations ?? []) {
			const delegateVote = byUser.get(delegation.toUserId);
			if (!delegateVote || byUser.has(delegation.fromUserId)) continue;
			byUser.set(delegation.fromUserId, {
				...delegateVote,
				id: `delegated:${delegateVote.id}:${delegation.fromUserId}`,
				userId: delegation.fromUserId,
				delegatedFrom: [delegation.toUserId],
			});
		}
		return [...byUser.values()];
	}

	async voteGovernanceProposal(principal, proposalId, input = {}) {
		await this.ensureInitialized();
		const proposal = await this.getGovernanceProposal(proposalId);
		if (!proposal) return null;
		if (proposal.status !== 'voting') {
			const error = new Error('Proposal is not open for voting.');
			error.status = 409;
			throw error;
		}
		const vote = requireEnumValue(input.vote, new Set(['support', 'object', 'abstain']), 'Governance vote');
		const snapshot = await this.latestGovernanceElectorateSnapshot(proposal.id, proposal.activeVersion);
		const eligible = snapshot?.eligibleVoters?.some((voter) => voter.userId === principal?.id);
		if (!eligible && !principalIsAdmin(principal)) {
			const error = new Error('User is not eligible to vote on this proposal.');
			error.status = 403;
			throw error;
		}
		const timestamp = isoNow();
		const existing = await this.first(
			`SELECT * FROM governance_proposal_votes WHERE proposal_id = ? AND proposal_version = ? AND user_id = ? LIMIT 1`,
			[proposal.id, proposal.activeVersion, principal.id],
		);
		const provider = governanceVotingProvider(proposal.governanceProviderId);
		const normalized = provider.normalizeVote({
			proposalId: proposal.id,
			proposalVersion: proposal.activeVersion,
			userId: principal.id,
			vote,
			reason: optionalStringValue(input.reason),
			chamberOverrides: objectValue(input.chamberOverrides, {}),
		});
		if (existing?.id) {
			await this.run(
				`UPDATE governance_proposal_votes
				 SET vote = ?, reason = ?, chamber_votes_json = ?, updated_at = ?
				 WHERE id = ?`,
				[normalized.vote, normalized.reason, JSON.stringify(normalized.chamberVotes), timestamp, existing.id],
			);
		} else {
			await this.run(
				`INSERT INTO governance_proposal_votes (
					id, proposal_id, proposal_version, user_id, vote, reason, chamber_votes_json,
					effective_weights_json, delegated_from_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', '[]', ?, ?)`,
				[randomUUID(), proposal.id, proposal.activeVersion, principal.id, normalized.vote, normalized.reason, JSON.stringify(normalized.chamberVotes), timestamp, timestamp],
			);
		}
		await this.run(
			`INSERT INTO governance_vote_events (
				id, proposal_id, proposal_version, user_id, prior_vote, next_vote, reason, effective_weights_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?)`,
			[randomUUID(), proposal.id, proposal.activeVersion, principal.id, existing?.vote ?? null, normalized.vote, normalized.reason, timestamp],
		);
		await this.recordGovernanceEvent({
			eventType: 'proposal.voted',
			actorType: 'user',
			actorId: principal.id,
			teamId: proposal.teamId,
			projectId: proposal.projectId,
			proposalId: proposal.id,
			proposalVersion: proposal.activeVersion,
			nextState: normalized.vote,
			message: normalized.reason,
			evidence: { priorVote: existing?.vote ?? null },
		});
		return this.evaluateGovernanceProposal(proposal.id);
	}

	async evaluateGovernanceProposal(proposalId, input = {}) {
		await this.ensureInitialized();
		const proposal = await this.getGovernanceProposal(proposalId);
		if (!proposal) return null;
		if (!['voting', 'open', 'draft'].includes(proposal.status)) return proposal;
		const snapshot = await this.latestGovernanceElectorateSnapshot(proposal.id, proposal.activeVersion) ?? await this.snapshotGovernanceElectorate(proposal.id);
		const provider = governanceVotingProvider(proposal.governanceProviderId);
		const votes = (await this.effectiveGovernanceVotes(proposal)).map((vote) => ({
			userId: vote.userId,
			vote: vote.vote,
			reason: vote.reason,
			chamberVotes: vote.chamberVotes,
			effectiveWeights: vote.effectiveWeights,
			delegatedFrom: vote.delegatedFrom,
		}));
		const outcome = provider.evaluate({
			now: input.now ?? isoNow(),
			votingEndsAt: proposal.votingEndsAt,
			electorate: {
				providerId: snapshot.providerId,
				providerVersion: snapshot.providerVersion,
				ruleSnapshot: snapshot.ruleSnapshot,
				chambers: snapshot.chambers,
				eligibleVoters: snapshot.eligibleVoters,
				delegations: snapshot.delegations,
				createdAt: snapshot.createdAt,
			},
			votes,
			adminDecision: input.adminDecision ?? null,
		});
		if (outcome.status === 'voting') return { ...proposal, outcome, votes };
		await this.transitionGovernanceProposal(proposal.id, outcome.status, {
			actorType: input.actorType ?? 'system',
			actorId: input.actorId ?? null,
			reason: outcome.reasonCode,
			evidence: outcome.voteResult,
		});
		if (outcome.status === 'accepted') {
			await this.createGovernanceDecisionFromProposal(proposal.id, {
				outcome,
				electorateSnapshotId: snapshot.id,
				actorType: input.actorType ?? 'system',
				actorId: input.actorId ?? null,
			});
		}
		return { ...(await this.getGovernanceProposal(proposal.id)), outcome, votes };
	}

	async adminDecideGovernanceProposal(principal, proposalId, input = {}) {
		const decision = input.status === 'rejected' || input.status === 'request_changes' ? input.status : 'approved';
		return this.evaluateGovernanceProposal(proposalId, {
			adminDecision: decision,
			actorType: 'user',
			actorId: principal?.id ?? null,
		});
	}

	async withdrawGovernanceProposal(principal, proposalId, input = {}) {
		return this.transitionGovernanceProposal(proposalId, 'withdrawn', {
			actorType: 'user',
			actorId: principal?.id ?? null,
			reason: optionalStringValue(input.reason, 'Proposal withdrawn.'),
			evidence: objectValue(input.evidence, {}),
		});
	}

	async supersedeGovernanceProposal(principal, proposalId, input = {}) {
		return this.transitionGovernanceProposal(proposalId, 'superseded', {
			actorType: 'user',
			actorId: principal?.id ?? null,
			reason: optionalStringValue(input.reason, 'Proposal superseded.'),
			evidence: {
				...objectValue(input.evidence, {}),
				successorProposalId: optionalStringValue(input.successorProposalId) ?? null,
			},
		});
	}

	async createGovernanceDecisionFromProposal(proposalId, input = {}) {
		await this.ensureInitialized();
		const proposal = await this.getGovernanceProposal(proposalId);
		if (!proposal) return null;
		const existing = await this.first(`SELECT * FROM governance_decisions WHERE proposal_id = ? LIMIT 1`, [proposalId]);
		if (existing?.id) return serializeGovernanceDecision(existing);
		const timestamp = isoNow();
		const id = randomUUID();
		const votes = await this.effectiveGovernanceVotes(proposal);
		const voterReasons = votes.filter((vote) => vote.reason).map((vote) => ({ userId: vote.userId, vote: vote.vote, reason: vote.reason }));
		const proposalSnapshot = {
			title: proposal.title,
			summary: proposal.summary,
			body: proposal.body,
			proposalType: proposal.proposalType,
			contentHash: proposal.activeContentHash,
			version: proposal.activeVersion,
		};
		await this.run(
			`INSERT INTO governance_decisions (
				id, team_id, project_id, proposal_id, proposal_version, proposal_content_hash, status,
				title, summary, content_decision_slug, governance_provider_id, governance_rule_json,
				electorate_snapshot_id, vote_result_json, voter_reasons_json, proposal_snapshot_json,
				decision_record_json, created_by_type, created_by_id, created_at, updated_at, superseded_at
			) VALUES (?, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, NULL)`,
			[
				id,
				proposal.teamId,
				proposal.projectId,
				proposal.id,
				proposal.activeVersion,
				proposal.activeContentHash,
				proposal.title,
				proposal.summary,
				proposal.contentDecisionSlug,
				proposal.governanceProviderId,
				JSON.stringify(input.outcome?.voteResult?.chambers ? { providerId: proposal.governanceProviderId } : {}),
				input.electorateSnapshotId ?? null,
				JSON.stringify(input.outcome?.voteResult ?? {}),
				JSON.stringify(voterReasons),
				JSON.stringify(proposalSnapshot),
				input.actorType ?? 'system',
				input.actorId ?? null,
				timestamp,
				timestamp,
			],
		);
		await this.run(`UPDATE governance_proposals SET decision_id = ?, updated_at = ? WHERE id = ?`, [id, timestamp, proposal.id]);
		await this.recordGovernanceEvent({
			eventType: 'decision.created',
			actorType: input.actorType ?? 'system',
			actorId: input.actorId ?? null,
			teamId: proposal.teamId,
			projectId: proposal.projectId,
			proposalId: proposal.id,
			decisionId: id,
			proposalVersion: proposal.activeVersion,
			nextState: 'accepted',
			evidence: { proposalContentHash: proposal.activeContentHash },
		});
		return this.getGovernanceDecision(id);
	}

	async getGovernanceDecision(decisionId) {
		await this.ensureInitialized();
		return serializeGovernanceDecision(await this.first(`SELECT * FROM governance_decisions WHERE id = ? LIMIT 1`, [decisionId]));
	}

	async listGovernanceDecisions(filters = {}) {
		await this.ensureInitialized();
		const limit = Math.max(1, Math.min(200, Number(filters.limit) || 100));
		const clauses = [];
		const params = [];
		for (const [key, column] of [['teamId', 'team_id'], ['projectId', 'project_id'], ['proposalId', 'proposal_id'], ['status', 'status']]) {
			if (filters[key]) {
				clauses.push(`${column} = ?`);
				params.push(filters[key]);
			}
		}
		params.push(limit);
		const rows = await this.all(
			`SELECT * FROM governance_decisions ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
			 ORDER BY updated_at DESC LIMIT ?`,
			params,
		);
		return rows.map(serializeGovernanceDecision);
	}

	async listGovernanceEvents(filters = {}) {
		await this.ensureInitialized();
		const limit = Math.max(1, Math.min(300, Number(filters.limit) || 100));
		const clauses = [];
		const params = [];
		for (const [key, column] of [['teamId', 'team_id'], ['projectId', 'project_id'], ['proposalId', 'proposal_id'], ['decisionId', 'decision_id'], ['eventType', 'event_type']]) {
			if (filters[key]) {
				clauses.push(`${column} = ?`);
				params.push(filters[key]);
			}
		}
		params.push(limit);
		const rows = await this.all(
			`SELECT * FROM governance_events ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
			 ORDER BY created_at DESC LIMIT ?`,
			params,
		);
		return rows.map(serializeGovernanceEvent);
	}

	async createGovernanceDelegation(principal, input = {}) {
		await this.ensureInitialized();
		const teamId = stringValue(input.teamId);
		const toUserId = stringValue(input.toUserId);
		if (!teamId || !principal?.id || !toUserId || toUserId === principal.id) {
			const error = new Error('A team and different delegate user are required.');
			error.status = 400;
			throw error;
		}
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO governance_delegations (
				id, team_id, scope, from_user_id, to_user_id, chambers_json, status, reason,
				created_at, revoked_at, expires_at, metadata_json
			) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?, ?)`,
			[
				id,
				teamId,
				optionalStringValue(input.scope, 'team'),
				principal.id,
				toUserId,
				JSON.stringify(arrayValue(input.chambers).length ? arrayValue(input.chambers) : ['member_chamber', 'stake_chamber']),
				optionalStringValue(input.reason),
				timestamp,
				input.expiresAt ?? null,
				JSON.stringify(input.metadata ?? {}),
			],
		);
		await this.recordGovernanceEvent({
			eventType: 'delegation.created',
			actorType: 'user',
			actorId: principal.id,
			teamId,
			message: optionalStringValue(input.reason),
			evidence: { toUserId },
		});
		return serializeGovernanceDelegation(await this.first(`SELECT * FROM governance_delegations WHERE id = ? LIMIT 1`, [id]));
	}

	async listGovernanceDelegations(filters = {}) {
		await this.ensureInitialized();
		const limit = Math.max(1, Math.min(300, Number(filters.limit) || 100));
		const clauses = [];
		const params = [];
		for (const [key, column] of [['teamId', 'team_id'], ['scope', 'scope'], ['status', 'status'], ['fromUserId', 'from_user_id'], ['toUserId', 'to_user_id']]) {
			if (filters[key]) {
				clauses.push(`${column} = ?`);
				params.push(filters[key]);
			}
		}
		params.push(limit);
		const rows = await this.all(
			`SELECT * FROM governance_delegations ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
			 ORDER BY created_at DESC LIMIT ?`,
			params,
		);
		return rows.map(serializeGovernanceDelegation);
	}

	async revokeGovernanceDelegation(principal, delegationId, input = {}) {
		await this.ensureInitialized();
		const existing = serializeGovernanceDelegation(await this.first(`SELECT * FROM governance_delegations WHERE id = ? LIMIT 1`, [delegationId]));
		if (!existing) return null;
		if (existing.fromUserId !== principal?.id && !principalIsAdmin(principal)) {
			const error = new Error('Permission denied.');
			error.status = 403;
			throw error;
		}
		const timestamp = isoNow();
		await this.run(`UPDATE governance_delegations SET status = 'revoked', revoked_at = ? WHERE id = ?`, [timestamp, delegationId]);
		await this.recordGovernanceEvent({
			eventType: 'delegation.revoked',
			actorType: 'user',
			actorId: principal?.id ?? null,
			teamId: existing.teamId,
			message: optionalStringValue(input.reason),
			evidence: { delegationId },
		});
		return serializeGovernanceDelegation(await this.first(`SELECT * FROM governance_delegations WHERE id = ? LIMIT 1`, [delegationId]));
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

	async ensureCommonsTreeSeedTeam() {
		await this.ensureInitialized();
		const existing = await this.getTeamBySlug(TREESEED_COMMONS_TEAM_SLUG);
		if (existing?.id) return existing;
		const timestamp = isoNow();
		await this.run(
			`INSERT INTO teams (id, slug, name, display_name, logo_url, profile_summary, metadata_json, created_at, updated_at)
			 VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
			[
				TREESEED_COMMONS_TEAM_SLUG,
				TREESEED_COMMONS_TEAM_SLUG,
				TREESEED_COMMONS_TEAM_SLUG,
				'TreeSeed',
				'Commons team for registered participants, proposals, questions, voting, and bounded steward decisions.',
				JSON.stringify({ commons: true, cooperativeGovernance: true }),
				timestamp,
				timestamp,
			],
		);
		return this.getTeam(TREESEED_COMMONS_TEAM_SLUG);
	}

	async recordCommonsGovernanceEvent(input = {}) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO commons_governance_events (
				id, event_type, actor_type, actor_id, participant_id, proposal_id, question_id, decision_id,
				prior_state, next_state, message, evidence_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				stringValue(input.eventType, 'decision.updated'),
				stringValue(input.actorType, 'system'),
				input.actorId ?? null,
				input.participantId ?? null,
				input.proposalId ?? null,
				input.questionId ?? null,
				input.decisionId ?? null,
				input.priorState ?? null,
				input.nextState ?? null,
				input.message ?? null,
				JSON.stringify(input.evidence ?? {}),
				timestamp,
			],
		);
		return serializeCommonsGovernanceEvent(await this.first(`SELECT * FROM commons_governance_events WHERE id = ?`, [id]));
	}

	async getCommonsParticipantByUserId(userId) {
		await this.ensureInitialized();
		return serializeCommonsParticipant(await this.first(`SELECT * FROM commons_participants WHERE user_id = ? LIMIT 1`, [userId]));
	}

	async getCommonsParticipant(participantId) {
		await this.ensureInitialized();
		return serializeCommonsParticipant(await this.first(`SELECT * FROM commons_participants WHERE id = ? LIMIT 1`, [participantId]));
	}

	async ensureCommonsParticipantForPrincipal(principal, input = {}) {
		await this.ensureInitialized();
		if (!principal?.id) {
			const error = new Error('Authenticated Commons participant is required.');
			error.status = 401;
			throw error;
		}
		const team = await this.ensureCommonsTreeSeedTeam();
		await this.upsertTeamMember(team.id, principal.id, 'viewer');
		const timestamp = isoNow();
		const user = await this.first(`SELECT * FROM users WHERE id = ? LIMIT 1`, [principal.id]).catch(() => null);
		const email = await this.first(
			`SELECT verified_at, status FROM user_email_addresses WHERE user_id = ? AND is_primary = 1 LIMIT 1`,
			[principal.id],
		).catch(() => null);
		const verifiedEmail = Boolean(email?.verified_at || email?.status === 'verified');
		const existing = await this.first(`SELECT * FROM commons_participants WHERE user_id = ? LIMIT 1`, [principal.id]);
		const displayName = optionalStringValue(input.displayName) ?? optionalStringValue(user?.display_name) ?? optionalStringValue(principal.displayName) ?? null;
		const weights = this.computeCommonsWeights({ verifiedEmail, participant: existing, principal });
		if (existing?.id) {
			await this.run(
				`UPDATE commons_participants
				 SET team_id = ?, status = CASE WHEN status = 'archived' THEN 'active' ELSE status END, display_name = ?,
					 verified_email = ?, base_weight = ?, trust_weight = ?, contribution_weight = ?, stakeholder_weight = ?,
					 delegated_weight = ?, total_weight = ?, metadata_json = ?, updated_at = ?
				 WHERE id = ?`,
				[
					team.id,
					displayName,
					verifiedEmail ? 1 : 0,
					weights.baseWeight,
					weights.trustWeight,
					weights.contributionWeight,
					weights.stakeholderWeight,
					weights.delegatedWeight,
					weights.totalWeight,
					JSON.stringify({ ...parseJson(existing.metadata_json, {}), ...(input.metadata ?? {}) }),
					timestamp,
					existing.id,
				],
			);
			return this.getCommonsParticipant(existing.id);
		}
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO commons_participants (
				id, user_id, team_id, status, display_name, verified_email, base_weight, trust_weight,
				contribution_weight, stakeholder_weight, delegated_weight, total_weight, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				principal.id,
				team.id,
				displayName,
				verifiedEmail ? 1 : 0,
				weights.baseWeight,
				weights.trustWeight,
				weights.contributionWeight,
				weights.stakeholderWeight,
				weights.delegatedWeight,
				weights.totalWeight,
				JSON.stringify(input.metadata ?? {}),
				timestamp,
				timestamp,
			],
		);
		await this.recordCommonsGovernanceEvent({
			eventType: 'participant.joined',
			actorType: 'user',
			actorId: principal.id,
			participantId: id,
			nextState: 'active',
			message: 'Registered participant joined TreeSeed Commons.',
			evidence: { teamId: team.id, role: 'viewer', policyVersion: COMMONS_WEIGHT_POLICY_VERSION },
		});
		return this.getCommonsParticipant(id);
	}

	computeCommonsWeights({ verifiedEmail = false, participant = null, principal = null } = {}) {
		const metadata = objectValue(principal?.metadata, {});
		const baseWeight = 1;
		const verifiedEmailWeight = verifiedEmail ? 0.25 : 0;
		const trustRoleWeight = Array.isArray(principal?.roles) && principal.roles.some((role) => ['platform_admin', 'market_admin'].includes(role)) ? 0.5 : 0;
		const contributionWeight = Math.min(1, numberValue(metadata.commonsContributionWeight, numberValue(participant?.contribution_weight, 0)) ?? 0);
		const stakeholderWeight = Math.min(1, numberValue(metadata.commonsStakeholderWeight, numberValue(participant?.stakeholder_weight, 0)) ?? 0);
		const delegatedWeight = Math.min(COMMONS_DELEGATED_WEIGHT_CAP, numberValue(participant?.delegated_weight, 0) ?? 0);
		const totalWeight = Math.min(COMMONS_TOTAL_WEIGHT_CAP, baseWeight + verifiedEmailWeight + trustRoleWeight + contributionWeight + stakeholderWeight + delegatedWeight);
		return { baseWeight, verifiedEmailWeight, accountAgeWeight: 0, trustRoleWeight, trustWeight: trustRoleWeight, contributionWeight, stakeholderWeight, delegatedWeight, totalWeight };
	}

	async createCommonsWeightSnapshot(participantId, evidence = {}) {
		await this.ensureInitialized();
		const participant = await this.getCommonsParticipant(participantId);
		if (!participant) return null;
		const timestamp = isoNow();
		const id = randomUUID();
		await this.run(
			`INSERT INTO commons_weight_snapshots (
				id, participant_id, policy_version, base_weight, verified_email_weight, account_age_weight,
				contribution_weight, stakeholder_weight, trust_role_weight, delegated_weight, total_weight, evidence_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				participantId,
				COMMONS_WEIGHT_POLICY_VERSION,
				participant.baseWeight,
				participant.verifiedEmail ? 0.25 : 0,
				0,
				participant.contributionWeight,
				participant.stakeholderWeight,
				participant.trustWeight,
				participant.delegatedWeight,
				participant.totalWeight,
				JSON.stringify({ ...evidence, participantStatus: participant.status }),
				timestamp,
			],
		);
		return serializeCommonsWeightSnapshot(await this.first(`SELECT * FROM commons_weight_snapshots WHERE id = ?`, [id]));
	}

	async listCommonsParticipants(filters = {}) {
		await this.ensureInitialized();
		const limit = Math.max(1, Math.min(200, Number(filters.limit) || 100));
		const rows = await this.all(
			`SELECT * FROM commons_participants
			 ${filters.status ? 'WHERE status = ?' : ''}
			 ORDER BY updated_at DESC LIMIT ?`,
			filters.status ? [filters.status, limit] : [limit],
		);
		return rows.map(serializeCommonsParticipant);
	}

	async createCommonsQuestion(principal, input = {}) {
		const participant = await this.ensureCommonsParticipantForPrincipal(principal);
		const title = stringValue(input.title);
		const body = stringValue(input.body);
		if (!title || !body) {
			const error = new Error('Question title and body are required.');
			error.status = 400;
			throw error;
		}
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO commons_questions (
				id, participant_id, user_id, team_id, status, title, body, answer, converted_proposal_id,
				metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, 'open', ?, ?, NULL, NULL, ?, ?, ?)`,
			[id, participant.id, participant.userId, participant.teamId, title, body, JSON.stringify(input.metadata ?? {}), timestamp, timestamp],
		);
		await this.recordCommonsGovernanceEvent({
			eventType: 'question.created',
			actorType: 'user',
			actorId: principal.id,
			participantId: participant.id,
			questionId: id,
			nextState: 'open',
			message: 'Commons question submitted.',
		});
		return this.getCommonsQuestion(id);
	}

	async getCommonsQuestion(questionId) {
		await this.ensureInitialized();
		return serializeCommonsQuestion(await this.first(`SELECT * FROM commons_questions WHERE id = ? LIMIT 1`, [questionId]));
	}

	async listCommonsQuestions(filters = {}) {
		await this.ensureInitialized();
		const limit = Math.max(1, Math.min(200, Number(filters.limit) || 100));
		const rows = await this.all(
			`SELECT * FROM commons_questions
			 ${filters.status ? 'WHERE status = ?' : ''}
			 ORDER BY updated_at DESC LIMIT ?`,
			filters.status ? [filters.status, limit] : [limit],
		);
		return rows.map(serializeCommonsQuestion);
	}

	async answerCommonsQuestion(questionId, input = {}) {
		await this.ensureInitialized();
		const existing = await this.getCommonsQuestion(questionId);
		if (!existing) return null;
		const timestamp = isoNow();
		const answer = stringValue(input.answer ?? input.message);
		await this.run(
			`UPDATE commons_questions SET status = 'answered', answer = ?, updated_at = ? WHERE id = ?`,
			[answer, timestamp, questionId],
		);
		await this.recordCommonsGovernanceEvent({
			eventType: 'question.answered',
			actorType: input.actorType ?? 'operator',
			actorId: input.actorId ?? null,
			participantId: existing.participantId,
			questionId,
			priorState: existing.status,
			nextState: 'answered',
			message: 'Commons question answered by steward.',
		});
		return this.getCommonsQuestion(questionId);
	}

	async createCommonsProposal(principal, input = {}) {
		const participant = await this.ensureCommonsParticipantForPrincipal(principal);
		const title = stringValue(input.title);
		const summary = stringValue(input.summary);
		const body = stringValue(input.body);
		if (!title || !summary || !body) {
			const error = new Error('Proposal title, summary, and body are required.');
			error.status = 400;
			throw error;
		}
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO commons_proposals (
				id, participant_id, user_id, team_id, status, title, summary, body, scope, decision_type,
				content_proposal_slug, content_decision_slug, backing_count, vote_support_weight, vote_object_weight,
				vote_abstain_weight, qualified_at, voting_starts_at, voting_ends_at, steward_decision_at,
				steward_decision_by, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
			[
				id,
				participant.id,
				participant.userId,
				participant.teamId,
				input.status === 'submitted' ? 'submitted' : 'draft',
				title,
				summary,
				body,
				optionalStringValue(input.scope, 'treeseed_commons'),
				optionalStringValue(input.decisionType, 'advisory'),
				JSON.stringify(input.metadata ?? {}),
				timestamp,
				timestamp,
			],
		);
		await this.recordCommonsGovernanceEvent({
			eventType: 'proposal.created',
			actorType: 'user',
			actorId: principal.id,
			participantId: participant.id,
			proposalId: id,
			nextState: input.status === 'submitted' ? 'submitted' : 'draft',
			message: 'Commons proposal created.',
		});
		return this.getCommonsProposal(id);
	}

	async getCommonsProposal(proposalId) {
		await this.ensureInitialized();
		return serializeCommonsProposal(await this.first(`SELECT * FROM commons_proposals WHERE id = ? LIMIT 1`, [proposalId]));
	}

	async listCommonsProposals(filters = {}) {
		await this.ensureInitialized();
		const limit = Math.max(1, Math.min(200, Number(filters.limit) || 100));
		const clauses = [];
		const params = [];
		if (filters.status) {
			clauses.push('status = ?');
			params.push(filters.status);
		}
		if (filters.scope) {
			clauses.push('scope = ?');
			params.push(filters.scope);
		}
		params.push(limit);
		const rows = await this.all(
			`SELECT * FROM commons_proposals ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ?`,
			params,
		);
		return rows.map(serializeCommonsProposal);
	}

	async transitionCommonsProposal(proposalId, nextState, input = {}) {
		await this.ensureInitialized();
		const existing = await this.getCommonsProposal(proposalId);
		if (!existing) return null;
		const timestamp = isoNow();
		const fields = ['status = ?', 'updated_at = ?'];
		const params = [nextState, timestamp];
		if (nextState === 'qualified') {
			fields.push('qualified_at = ?');
			params.push(timestamp);
		}
		if (nextState === 'voting') {
			fields.push('voting_starts_at = ?', 'voting_ends_at = ?');
			params.push(timestamp, input.votingEndsAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString());
		}
		if (['accepted', 'rejected', 'deferred'].includes(nextState)) {
			fields.push('steward_decision_at = ?', 'steward_decision_by = ?');
			params.push(timestamp, input.actorId ?? null);
		}
		params.push(proposalId);
		await this.run(`UPDATE commons_proposals SET ${fields.join(', ')} WHERE id = ?`, params);
		const eventMap = {
			submitted: 'proposal.submitted',
			qualified: 'proposal.qualified',
			under_review: 'proposal.review_started',
			voting: 'proposal.voting_started',
			accepted: 'proposal.steward_decision',
			rejected: 'proposal.steward_decision',
			deferred: 'proposal.steward_decision',
			archived: 'proposal.archived',
		};
		await this.recordCommonsGovernanceEvent({
			eventType: eventMap[nextState] ?? 'proposal.steward_decision',
			actorType: input.actorType ?? 'user',
			actorId: input.actorId ?? null,
			participantId: existing.participantId,
			proposalId,
			priorState: existing.status,
			nextState,
			message: input.reason ?? null,
			evidence: input.evidence ?? {},
		});
		return this.getCommonsProposal(proposalId);
	}

	async submitCommonsProposal(proposalId, input = {}) {
		const existing = await this.getCommonsProposal(proposalId);
		if (!existing || !['draft', 'submitted'].includes(existing.status)) return existing;
		return this.transitionCommonsProposal(proposalId, 'submitted', input);
	}

	async backCommonsProposal(principal, proposalId, input = {}) {
		const proposal = await this.getCommonsProposal(proposalId);
		if (!proposal) return null;
		if (!['submitted', 'backing', 'qualified', 'under_review', 'voting'].includes(proposal.status)) {
			const error = new Error('Proposal is not open for backing.');
			error.status = 409;
			throw error;
		}
		const participant = await this.ensureCommonsParticipantForPrincipal(principal);
		const snapshot = await this.createCommonsWeightSnapshot(participant.id, { action: 'backing', proposalId });
		const timestamp = isoNow();
		const existing = await this.first(
			`SELECT * FROM commons_proposal_backings WHERE proposal_id = ? AND participant_id = ? LIMIT 1`,
			[proposalId, participant.id],
		);
		if (!existing?.id) {
			await this.run(
				`INSERT INTO commons_proposal_backings (
					id, proposal_id, participant_id, user_id, weight_snapshot_id, weight, reason, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				[randomUUID(), proposalId, participant.id, participant.userId, snapshot.id, snapshot.totalWeight, optionalStringValue(input.reason), timestamp],
			);
		}
		const aggregates = await this.first(
			`SELECT COUNT(*) AS backing_count, COALESCE(SUM(weight), 0) AS backing_weight
			 FROM commons_proposal_backings WHERE proposal_id = ?`,
			[proposalId],
		);
		const backingCount = Number(aggregates?.backing_count ?? 0);
		const backingWeight = Number(aggregates?.backing_weight ?? 0);
		const nextState = backingCount >= COMMONS_BACKING_THRESHOLD && backingWeight >= COMMONS_WEIGHT_THRESHOLD ? 'qualified' : 'backing';
		await this.run(
			`UPDATE commons_proposals SET status = ?, backing_count = ?, qualified_at = COALESCE(qualified_at, ?), updated_at = ? WHERE id = ?`,
			[nextState, backingCount, nextState === 'qualified' ? timestamp : null, timestamp, proposalId],
		);
		await this.recordCommonsGovernanceEvent({
			eventType: nextState === 'qualified' ? 'proposal.qualified' : 'proposal.backed',
			actorType: 'user',
			actorId: principal.id,
			participantId: participant.id,
			proposalId,
			priorState: proposal.status,
			nextState,
			message: optionalStringValue(input.reason),
			evidence: { backingCount, backingWeight, weightSnapshotId: snapshot.id },
		});
		return this.getCommonsProposal(proposalId);
	}

	async voteCommonsProposal(principal, proposalId, input = {}) {
		const vote = requireEnumValue(input.vote, new Set(['support', 'object', 'abstain']), 'Commons vote');
		const proposal = await this.getCommonsProposal(proposalId);
		if (!proposal) return null;
		if (proposal.status !== 'voting') {
			const error = new Error('Proposal is not open for voting.');
			error.status = 409;
			throw error;
		}
		const participant = await this.ensureCommonsParticipantForPrincipal(principal);
		const snapshot = await this.createCommonsWeightSnapshot(participant.id, { action: 'vote', proposalId, vote });
		const timestamp = isoNow();
		const existing = await this.first(
			`SELECT * FROM commons_proposal_votes WHERE proposal_id = ? AND participant_id = ? LIMIT 1`,
			[proposalId, participant.id],
		);
		if (existing?.id) {
			await this.run(
				`UPDATE commons_proposal_votes SET vote = ?, weight_snapshot_id = ?, weight = ?, reason = ?, updated_at = ? WHERE id = ?`,
				[vote, snapshot.id, snapshot.totalWeight, optionalStringValue(input.reason), timestamp, existing.id],
			);
		} else {
			await this.run(
				`INSERT INTO commons_proposal_votes (
					id, proposal_id, participant_id, user_id, vote, weight_snapshot_id, weight, reason, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[randomUUID(), proposalId, participant.id, participant.userId, vote, snapshot.id, snapshot.totalWeight, optionalStringValue(input.reason), timestamp, timestamp],
			);
		}
		await this.recalculateCommonsProposalVoteTotals(proposalId);
		await this.recordCommonsGovernanceEvent({
			eventType: 'proposal.voted',
			actorType: 'user',
			actorId: principal.id,
			participantId: participant.id,
			proposalId,
			nextState: vote,
			message: optionalStringValue(input.reason),
			evidence: { weightSnapshotId: snapshot.id },
		});
		return this.getCommonsProposal(proposalId);
	}

	async recalculateCommonsProposalVoteTotals(proposalId) {
		await this.ensureInitialized();
		const rows = await this.all(
			`SELECT vote, COALESCE(SUM(weight), 0) AS total FROM commons_proposal_votes WHERE proposal_id = ? GROUP BY vote`,
			[proposalId],
		);
		const totals = Object.fromEntries(rows.map((row) => [row.vote, Number(row.total ?? 0)]));
		await this.run(
			`UPDATE commons_proposals SET vote_support_weight = ?, vote_object_weight = ?, vote_abstain_weight = ?, updated_at = ? WHERE id = ?`,
			[totals.support ?? 0, totals.object ?? 0, totals.abstain ?? 0, isoNow(), proposalId],
		);
	}

	async stewardDecisionForCommonsProposal(proposalId, input = {}) {
		const status = ['accepted', 'rejected', 'deferred'].includes(input.status) ? input.status : 'accepted';
		const proposal = await this.transitionCommonsProposal(proposalId, status, input);
		if (!proposal) return null;
		const timestamp = isoNow();
		let decision = await this.first(`SELECT * FROM commons_decisions WHERE proposal_id = ? LIMIT 1`, [proposalId]);
		if (!decision?.id) {
			const id = randomUUID();
			await this.run(
				`INSERT INTO commons_decisions (
					id, proposal_id, status, decision_record_id, decision_record_slug, title, summary, steward_reason,
					capacity_budget, scheduled_for, implemented_at, metadata_json, created_at, updated_at
				) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
				[
					id,
					proposalId,
					status === 'accepted' ? 'accepted' : 'rejected',
					proposal.contentDecisionSlug,
					proposal.title,
					proposal.summary,
					optionalStringValue(input.reason),
					optionalStringValue(input.capacityBudget),
					optionalStringValue(input.scheduledFor),
					JSON.stringify(input.metadata ?? {}),
					timestamp,
					timestamp,
				],
			);
			decision = await this.first(`SELECT * FROM commons_decisions WHERE id = ? LIMIT 1`, [id]);
		} else {
			await this.run(
				`UPDATE commons_decisions SET status = ?, steward_reason = ?, capacity_budget = ?, scheduled_for = ?, updated_at = ? WHERE id = ?`,
				[status === 'accepted' ? 'accepted' : 'rejected', optionalStringValue(input.reason), optionalStringValue(input.capacityBudget), optionalStringValue(input.scheduledFor), timestamp, decision.id],
			);
			decision = await this.first(`SELECT * FROM commons_decisions WHERE id = ? LIMIT 1`, [decision.id]);
		}
		await this.recordCommonsGovernanceEvent({
			eventType: 'decision.created',
			actorType: input.actorType ?? 'operator',
			actorId: input.actorId ?? null,
			participantId: proposal.participantId,
			proposalId,
			decisionId: decision.id,
			nextState: status,
			message: optionalStringValue(input.reason),
			evidence: input.evidence ?? {},
		});
		return { proposal, decision: serializeCommonsDecision(decision) };
	}

	async listCommonsProposalBackings(proposalId) {
		await this.ensureInitialized();
		const rows = await this.all(`SELECT * FROM commons_proposal_backings WHERE proposal_id = ? ORDER BY created_at ASC`, [proposalId]);
		return rows.map(serializeCommonsProposalBacking);
	}

	async listCommonsProposalVotes(proposalId) {
		await this.ensureInitialized();
		const rows = await this.all(`SELECT * FROM commons_proposal_votes WHERE proposal_id = ? ORDER BY updated_at ASC`, [proposalId]);
		return rows.map(serializeCommonsProposalVote);
	}

	async createCommonsDelegation(principal, input = {}) {
		const from = await this.ensureCommonsParticipantForPrincipal(principal);
		const toParticipantId = stringValue(input.toParticipantId);
		if (!toParticipantId || toParticipantId === from.id) {
			const error = new Error('A different delegate participant is required.');
			error.status = 400;
			throw error;
		}
		const to = await this.getCommonsParticipant(toParticipantId);
		if (!to) {
			const error = new Error('Delegate participant not found.');
			error.status = 404;
			throw error;
		}
		const scope = optionalStringValue(input.scope, 'treeseed_commons');
		const timestamp = isoNow();
		const id = randomUUID();
		await this.run(
			`INSERT INTO commons_delegations (
				id, from_participant_id, to_participant_id, scope, status, weight_limit, reason, created_at, revoked_at
			) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, NULL)`,
			[id, from.id, to.id, scope, numberValue(input.weightLimit, null), optionalStringValue(input.reason), timestamp],
		);
		await this.recordCommonsGovernanceEvent({
			eventType: 'delegation.created',
			actorType: 'user',
			actorId: principal.id,
			participantId: from.id,
			nextState: 'active',
			evidence: { toParticipantId: to.id, scope },
		});
		return serializeCommonsDelegation(await this.first(`SELECT * FROM commons_delegations WHERE id = ? LIMIT 1`, [id]));
	}

	async listCommonsDelegations(principal = null) {
		await this.ensureInitialized();
		if (!principal?.id) return [];
		const participant = await this.getCommonsParticipantByUserId(principal.id);
		if (!participant) return [];
		const rows = await this.all(
			`SELECT * FROM commons_delegations WHERE from_participant_id = ? OR to_participant_id = ? ORDER BY created_at DESC`,
			[participant.id, participant.id],
		);
		return rows.map(serializeCommonsDelegation);
	}

	async revokeCommonsDelegation(principal, delegationId, input = {}) {
		const participant = await this.ensureCommonsParticipantForPrincipal(principal);
		const existing = await this.first(`SELECT * FROM commons_delegations WHERE id = ? LIMIT 1`, [delegationId]);
		if (!existing?.id) return null;
		if (existing.from_participant_id !== participant.id && !principalIsAdmin(principal)) {
			const error = new Error('Permission denied.');
			error.status = 403;
			throw error;
		}
		const timestamp = isoNow();
		await this.run(`UPDATE commons_delegations SET status = 'revoked', revoked_at = ? WHERE id = ?`, [timestamp, delegationId]);
		await this.recordCommonsGovernanceEvent({
			eventType: 'delegation.revoked',
			actorType: 'user',
			actorId: principal.id,
			participantId: participant.id,
			priorState: existing.status,
			nextState: 'revoked',
			message: optionalStringValue(input.reason),
		});
		return serializeCommonsDelegation(await this.first(`SELECT * FROM commons_delegations WHERE id = ? LIMIT 1`, [delegationId]));
	}

	async listCommonsDecisions(filters = {}) {
		await this.ensureInitialized();
		const limit = Math.max(1, Math.min(200, Number(filters.limit) || 100));
		const rows = await this.all(`SELECT * FROM commons_decisions ORDER BY updated_at DESC LIMIT ?`, [limit]);
		return rows.map(serializeCommonsDecision);
	}

	async listCommonsGovernanceEvents(filters = {}) {
		await this.ensureInitialized();
		const limit = Math.max(1, Math.min(300, Number(filters.limit) || 100));
		const clauses = [];
		const params = [];
		for (const [key, column] of [
			['proposalId', 'proposal_id'],
			['questionId', 'question_id'],
			['participantId', 'participant_id'],
			['decisionId', 'decision_id'],
			['eventType', 'event_type'],
		]) {
			if (filters[key]) {
				clauses.push(`${column} = ?`);
				params.push(filters[key]);
			}
		}
		params.push(limit);
		const rows = await this.all(
			`SELECT * FROM commons_governance_events ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`,
			params,
		);
		return rows.map(serializeCommonsGovernanceEvent);
	}

	async commonsSummary(principal = null) {
		await this.ensureInitialized();
		const [participants, proposals, questions, decisions] = await Promise.all([
			this.first(`SELECT COUNT(*) AS count FROM commons_participants WHERE status = 'active'`),
			this.first(`SELECT COUNT(*) AS count FROM commons_proposals WHERE status NOT IN ('archived')`),
			this.first(`SELECT COUNT(*) AS count FROM commons_questions WHERE status = 'open'`),
			this.first(`SELECT COUNT(*) AS count FROM commons_decisions WHERE status IN ('accepted', 'scheduled', 'implemented')`),
		]);
		return {
			team: await this.ensureCommonsTreeSeedTeam(),
			participant: principal?.id ? await this.getCommonsParticipantByUserId(principal.id) : null,
			counts: {
				activeParticipants: Number(participants?.count ?? 0),
				activeProposals: Number(proposals?.count ?? 0),
				openQuestions: Number(questions?.count ?? 0),
				acceptedDecisions: Number(decisions?.count ?? 0),
			},
			recentProposals: await this.listCommonsProposals({ limit: 6 }),
			recentEvents: await this.listCommonsGovernanceEvents({ limit: 12 }),
		};
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

	async getPendingTeamInviteByToken(token) {
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
			const team = await this.getTeam(row.team_id);
			return { ok: true, invite: serializeTeamInvite(row), team };
		}
		return { ok: false, code: 'invalid', message: 'Invite link is invalid or expired.' };
	}

	async getTeamInviteByToken(token) {
		await this.ensureInitialized();
		const prefix = tokenPrefix(String(token ?? ''));
		const rows = await this.all(
			`SELECT * FROM team_invites WHERE token_prefix = ? ORDER BY created_at DESC`,
			[prefix],
		);
		for (const row of rows) {
			if (!equalHash(stableHash(token, this.config.authSecret), row.token_hash)) continue;
			if (row.status === 'pending' && row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
				await this.run(`UPDATE team_invites SET status = 'expired', updated_at = ? WHERE id = ?`, [isoNow(), row.id]);
				return { ok: false, code: 'expired', message: 'Invite link is invalid or expired.' };
			}
			const team = await this.getTeam(row.team_id);
			return { ok: true, invite: serializeTeamInvite(row), team };
		}
		return { ok: false, code: 'invalid', message: 'Invite link is invalid or expired.' };
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
		const rows = await this.all(`SELECT * FROM team_invites WHERE token_prefix = ? ORDER BY created_at DESC`, [prefix]);
		for (const row of rows) {
			if (!equalHash(stableHash(token, this.config.authSecret), row.token_hash)) continue;
			if (row.status === 'accepted' && row.accepted_by_user_id === userId) {
				const member = await this.first(
					`SELECT * FROM team_memberships WHERE team_id = ? AND user_id = ? AND status = 'active' LIMIT 1`,
					[row.team_id, userId],
				);
				return { ok: true, invite: serializeTeamInvite(row), member, team: await this.getTeam(row.team_id), alreadyAccepted: true };
			}
			if (row.status !== 'pending') continue;
			if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
				await this.run(`UPDATE team_invites SET status = 'expired', updated_at = ? WHERE id = ?`, [isoNow(), row.id]);
				continue;
			}
			const email = await this.first(
				`SELECT normalized_email FROM user_email_addresses WHERE user_id = ? AND normalized_email = ? AND status = 'verified' LIMIT 1`,
				[userId, row.email],
			);
			if (!email?.normalized_email) {
				return { ok: false, code: 'email_mismatch', message: `Sign in with ${row.email} to accept this invite.` };
			}
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

	async getCatalogArtifactVersionById(artifactVersionId) {
		await this.ensureInitialized();
		return serializeCatalogArtifactVersion(await this.first(`SELECT * FROM catalog_artifact_versions WHERE id = ? LIMIT 1`, [artifactVersionId]));
	}

	async getCommerceVendorForTeam(teamId) {
		await this.ensureInitialized();
		return serializeCommerceVendor(await this.first(`SELECT * FROM commerce_vendors WHERE team_id = ? LIMIT 1`, [teamId]));
	}

	async getCommerceVendor(vendorId) {
		await this.ensureInitialized();
		return serializeCommerceVendor(await this.first(`SELECT * FROM commerce_vendors WHERE id = ? LIMIT 1`, [vendorId]));
	}

	async requestCommerceVendor(teamId, input = {}) {
		await this.ensureInitialized();
		const team = await this.getTeam(teamId);
		if (!team) {
			const error = new Error(`Unknown team "${teamId}".`);
			error.status = 404;
			throw error;
		}
		const existing = await this.getCommerceVendorForTeam(teamId);
		if (existing) return existing;
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		const displayName = stringValue(input.displayName, team.displayName ?? team.name ?? team.slug ?? 'Commerce Vendor');
		const slug = safeIdPart(input.slug ?? team.slug ?? team.name ?? id, id);
		await this.run(
			`INSERT INTO commerce_vendors (
				id, team_id, display_name, slug, status, trust_level, professional_entitlement_id, stripe_account_id,
				sales_enabled, service_sales_enabled, capacity_listings_enabled, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				teamId,
				displayName,
				slug,
				'submitted',
				'public_publisher',
				input.professionalEntitlementId ?? null,
				null,
				0,
				0,
				0,
				JSON.stringify(input.metadata ?? {}),
				timestamp,
				timestamp,
			],
		);
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? 'user',
			actorId: input.actorId ?? null,
			action: 'vendor.request',
			objectType: 'commerce_vendor',
			objectId: id,
			priorState: null,
			nextState: 'submitted',
			reason: input.reason ?? null,
			evidence: input.evidence ?? {},
			relatedTeamId: teamId,
		});
		return this.getCommerceVendor(id);
	}

	async updateCommerceVendor(vendorId, input = {}) {
		await this.ensureInitialized();
		const existing = await this.getCommerceVendor(vendorId);
		if (!existing) return null;
		const timestamp = isoNow();
		await this.run(
			`UPDATE commerce_vendors
			 SET display_name = ?, slug = ?, status = ?, trust_level = ?, professional_entitlement_id = ?, stripe_account_id = ?,
			     sales_enabled = ?, service_sales_enabled = ?, capacity_listings_enabled = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`,
			[
				stringValue(input.displayName, existing.displayName),
				safeIdPart(input.slug ?? existing.slug, existing.slug),
				enumValue(input.status, COMMERCE_GOVERNANCE_STATE_SET, existing.status),
				enumValue(input.trustLevel, COMMERCE_VENDOR_TRUST_LEVEL_SET, existing.trustLevel),
				input.professionalEntitlementId === undefined ? existing.professionalEntitlementId : input.professionalEntitlementId,
				input.stripeAccountId === undefined ? existing.stripeAccountId : input.stripeAccountId,
				input.salesEnabled === undefined ? (existing.salesEnabled ? 1 : 0) : (input.salesEnabled === true ? 1 : 0),
				input.serviceSalesEnabled === undefined ? (existing.serviceSalesEnabled ? 1 : 0) : (input.serviceSalesEnabled === true ? 1 : 0),
				input.capacityListingsEnabled === undefined ? (existing.capacityListingsEnabled ? 1 : 0) : (input.capacityListingsEnabled === true ? 1 : 0),
				JSON.stringify(input.metadata ?? existing.metadata ?? {}),
				timestamp,
				vendorId,
			],
		);
		return this.getCommerceVendor(vendorId);
	}

	async approveCommerceVendor(vendorId, input = {}) {
		const existing = await this.getCommerceVendor(vendorId);
		if (!existing) return null;
		const trustLevel = enumValue(input.trustLevel, COMMERCE_VENDOR_TRUST_LEVEL_SET, 'verified_seller');
		const vendor = await this.updateCommerceVendor(vendorId, {
			...input,
			status: 'approved',
			trustLevel,
			salesEnabled: input.salesEnabled !== false,
			serviceSalesEnabled: input.serviceSalesEnabled === true,
			capacityListingsEnabled: input.capacityListingsEnabled === true,
		});
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? 'operator',
			actorId: input.actorId ?? null,
			action: 'vendor.approve',
			objectType: 'commerce_vendor',
			objectId: vendorId,
			priorState: existing.status,
			nextState: 'approved',
			reason: input.reason ?? null,
			evidence: input.evidence ?? {},
			relatedTeamId: existing.teamId,
		});
		return vendor;
	}

	async getCommerceVendorStripeAccount(vendorId, environment = 'test') {
		await this.ensureInitialized();
		const env = enumValue(environment, COMMERCE_STRIPE_ENVIRONMENT_SET, 'test');
		return serializeCommerceVendorStripeAccount(await this.first(
			`SELECT * FROM commerce_vendor_stripe_accounts WHERE vendor_id = ? AND environment = ? LIMIT 1`,
			[vendorId, env],
		));
	}

	async getCommerceVendorStripeAccountForTeam(teamId, environment = 'test') {
		await this.ensureInitialized();
		const env = enumValue(environment, COMMERCE_STRIPE_ENVIRONMENT_SET, 'test');
		return serializeCommerceVendorStripeAccount(await this.first(
			`SELECT * FROM commerce_vendor_stripe_accounts WHERE team_id = ? AND environment = ? LIMIT 1`,
			[teamId, env],
		));
	}

	async getCommerceVendorStripeAccountByStripeId(stripeAccountId, environment = 'test') {
		await this.ensureInitialized();
		const env = enumValue(environment, COMMERCE_STRIPE_ENVIRONMENT_SET, 'test');
		return serializeCommerceVendorStripeAccount(await this.first(
			`SELECT * FROM commerce_vendor_stripe_accounts WHERE stripe_account_id = ? AND environment = ? LIMIT 1`,
			[stripeAccountId, env],
		));
	}

	async createCommerceVendorStripeAccount(vendorId, input = {}) {
		await this.ensureInitialized();
		const vendor = await this.getCommerceVendor(vendorId);
		if (!vendor) {
			const error = new Error(`Unknown commerce vendor "${vendorId}".`);
			error.status = 404;
			throw error;
		}
		if (vendor.status !== 'approved') {
			const error = new Error('Commerce vendor approval is required before Stripe onboarding.');
			error.status = 409;
			throw error;
		}
		const environment = enumValue(input.environment, COMMERCE_STRIPE_ENVIRONMENT_SET, 'test');
		const stripeAccountId = stringValue(input.stripeAccountId, '');
		if (!stripeAccountId) {
			const error = new Error('stripeAccountId is required.');
			error.status = 400;
			throw error;
		}
		const existing = await this.getCommerceVendorStripeAccount(vendorId, environment);
		if (existing) return existing;
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO commerce_vendor_stripe_accounts (
				id, vendor_id, team_id, environment, stripe_account_id, account_status, onboarding_status,
				charges_enabled, payouts_enabled, details_submitted,
				requirements_currently_due_json, requirements_eventually_due_json, requirements_past_due_json, requirements_disabled_reason,
				capabilities_json, onboarding_started_at, onboarding_completed_at, last_synced_at, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				vendorId,
				vendor.teamId,
				environment,
				stripeAccountId,
				enumValue(input.accountStatus, COMMERCE_STRIPE_ACCOUNT_STATUS_SET, 'pending'),
				enumValue(input.onboardingStatus, COMMERCE_STRIPE_ONBOARDING_STATUS_SET, 'not_started'),
				input.chargesEnabled === true ? 1 : 0,
				input.payoutsEnabled === true ? 1 : 0,
				input.detailsSubmitted === true ? 1 : 0,
				JSON.stringify(arrayValue(input.requirementsCurrentlyDue)),
				JSON.stringify(arrayValue(input.requirementsEventuallyDue)),
				JSON.stringify(arrayValue(input.requirementsPastDue)),
				input.requirementsDisabledReason ?? null,
				JSON.stringify(objectValue(input.capabilities, {})),
				input.onboardingStartedAt ?? null,
				input.onboardingCompletedAt ?? null,
				input.lastSyncedAt ?? null,
				JSON.stringify(objectValue(input.metadata, {})),
				timestamp,
				timestamp,
			],
		);
		await this.updateCommerceVendor(vendorId, { stripeAccountId });
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? 'system',
			actorId: input.actorId ?? null,
			action: 'commerce_vendor.stripe_account.created',
			objectType: 'commerce_vendor',
			objectId: vendorId,
			priorState: vendor.stripeAccountId ? 'linked' : null,
			nextState: 'linked',
			reason: input.reason ?? null,
			evidence: input.evidence ?? { environment },
			relatedTeamId: vendor.teamId,
		});
		return this.getCommerceVendorStripeAccount(vendorId, environment);
	}

	async updateCommerceVendorStripeAccount(accountId, input = {}) {
		await this.ensureInitialized();
		const existing = serializeCommerceVendorStripeAccount(await this.first(`SELECT * FROM commerce_vendor_stripe_accounts WHERE id = ? LIMIT 1`, [accountId]));
		if (!existing) return null;
		const timestamp = isoNow();
		const accountStatus = enumValue(input.accountStatus, COMMERCE_STRIPE_ACCOUNT_STATUS_SET, existing.accountStatus);
		const onboardingStatus = enumValue(input.onboardingStatus, COMMERCE_STRIPE_ONBOARDING_STATUS_SET, existing.onboardingStatus);
		const onboardingCompletedAt = input.onboardingCompletedAt === undefined
			? (onboardingStatus === 'completed' && !existing.onboardingCompletedAt ? timestamp : existing.onboardingCompletedAt)
			: input.onboardingCompletedAt;
		await this.run(
			`UPDATE commerce_vendor_stripe_accounts
			 SET account_status = ?, onboarding_status = ?, charges_enabled = ?, payouts_enabled = ?, details_submitted = ?,
			     requirements_currently_due_json = ?, requirements_eventually_due_json = ?, requirements_past_due_json = ?,
			     requirements_disabled_reason = ?, capabilities_json = ?, onboarding_started_at = ?, onboarding_completed_at = ?,
			     last_synced_at = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`,
			[
				accountStatus,
				onboardingStatus,
				input.chargesEnabled === undefined ? (existing.chargesEnabled ? 1 : 0) : (input.chargesEnabled === true ? 1 : 0),
				input.payoutsEnabled === undefined ? (existing.payoutsEnabled ? 1 : 0) : (input.payoutsEnabled === true ? 1 : 0),
				input.detailsSubmitted === undefined ? (existing.detailsSubmitted ? 1 : 0) : (input.detailsSubmitted === true ? 1 : 0),
				JSON.stringify(input.requirementsCurrentlyDue === undefined ? existing.requirementsCurrentlyDue : arrayValue(input.requirementsCurrentlyDue)),
				JSON.stringify(input.requirementsEventuallyDue === undefined ? existing.requirementsEventuallyDue : arrayValue(input.requirementsEventuallyDue)),
				JSON.stringify(input.requirementsPastDue === undefined ? existing.requirementsPastDue : arrayValue(input.requirementsPastDue)),
				input.requirementsDisabledReason === undefined ? existing.requirementsDisabledReason : input.requirementsDisabledReason,
				JSON.stringify(input.capabilities === undefined ? existing.capabilities : objectValue(input.capabilities, {})),
				input.onboardingStartedAt === undefined ? existing.onboardingStartedAt : input.onboardingStartedAt,
				onboardingCompletedAt,
				input.lastSyncedAt === undefined ? existing.lastSyncedAt : input.lastSyncedAt,
				JSON.stringify(input.metadata === undefined ? existing.metadata : objectValue(input.metadata, {})),
				timestamp,
				accountId,
			],
		);
		if (existing.stripeAccountId) {
			await this.updateCommerceVendor(existing.vendorId, { stripeAccountId: existing.stripeAccountId });
		}
		return serializeCommerceVendorStripeAccount(await this.first(`SELECT * FROM commerce_vendor_stripe_accounts WHERE id = ? LIMIT 1`, [accountId]));
	}

	async upsertCommerceVendorStripeAccount(vendorId, input = {}) {
		const environment = enumValue(input.environment, COMMERCE_STRIPE_ENVIRONMENT_SET, 'test');
		const existing = await this.getCommerceVendorStripeAccount(vendorId, environment);
		if (existing) return this.updateCommerceVendorStripeAccount(existing.id, input);
		return this.createCommerceVendorStripeAccount(vendorId, input);
	}

	async markCommerceStripeOnboardingStarted(accountId, input = {}) {
		const existing = serializeCommerceVendorStripeAccount(await this.first(`SELECT * FROM commerce_vendor_stripe_accounts WHERE id = ? LIMIT 1`, [accountId]));
		if (!existing) return null;
		const timestamp = isoNow();
		const account = await this.updateCommerceVendorStripeAccount(accountId, {
			onboardingStatus: 'started',
			onboardingStartedAt: existing.onboardingStartedAt ?? timestamp,
		});
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? 'user',
			actorId: input.actorId ?? null,
			action: 'commerce_vendor.stripe_onboarding.started',
			objectType: 'commerce_vendor',
			objectId: existing.vendorId,
			priorState: existing.onboardingStatus,
			nextState: 'started',
			reason: input.reason ?? null,
			evidence: input.evidence ?? { environment: existing.environment },
			relatedTeamId: existing.teamId,
		});
		return account;
	}

	async markCommerceStripeOnboardingReturned(accountId, input = {}) {
		const existing = serializeCommerceVendorStripeAccount(await this.first(`SELECT * FROM commerce_vendor_stripe_accounts WHERE id = ? LIMIT 1`, [accountId]));
		if (!existing) return null;
		const account = await this.updateCommerceVendorStripeAccount(accountId, {
			onboardingStatus: 'returned',
		});
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? 'user',
			actorId: input.actorId ?? null,
			action: 'commerce_vendor.stripe_onboarding.returned',
			objectType: 'commerce_vendor',
			objectId: existing.vendorId,
			priorState: existing.onboardingStatus,
			nextState: 'returned',
			reason: input.reason ?? null,
			evidence: input.evidence ?? { environment: existing.environment },
			relatedTeamId: existing.teamId,
		});
		return account;
	}

	async recordCommerceStripeAccountStatus(accountId, input = {}) {
		const existing = serializeCommerceVendorStripeAccount(await this.first(`SELECT * FROM commerce_vendor_stripe_accounts WHERE id = ? LIMIT 1`, [accountId]));
		if (!existing) return null;
		const account = await this.updateCommerceVendorStripeAccount(accountId, input);
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? 'system',
			actorId: input.actorId ?? null,
			action: 'commerce_vendor.stripe_status.synced',
			objectType: 'commerce_vendor',
			objectId: existing.vendorId,
			priorState: existing.accountStatus,
			nextState: account?.accountStatus ?? existing.accountStatus,
			reason: input.reason ?? null,
			evidence: input.evidence ?? {
				environment: existing.environment,
				chargesEnabled: account?.chargesEnabled ?? false,
				payoutsEnabled: account?.payoutsEnabled ?? false,
				detailsSubmitted: account?.detailsSubmitted ?? false,
			},
			relatedTeamId: existing.teamId,
		});
		return account;
	}

	async createCommerceProductDraft(teamId, input = {}) {
		await this.ensureInitialized();
		const vendor = await this.getCommerceVendorForTeam(teamId);
		if (!vendor) {
			const error = new Error('Commerce vendor capability is required before creating products.');
			error.status = 409;
			throw error;
		}
		const kind = requireEnumValue(input.kind, COMMERCE_PRODUCT_KIND_SET, 'commerce product kind');
		const title = stringValue(input.title, '');
		if (!title) {
			const error = new Error('Product title is required.');
			error.status = 400;
			throw error;
		}
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		const slug = safeIdPart(input.slug ?? title, id);
		const ownershipModel = enumValue(input.ownershipModel, COMMERCE_OWNERSHIP_MODEL_SET, 'team_owned');
		await this.run(
			`INSERT INTO commerce_products (
				id, vendor_id, seller_team_id, kind, slug, title, summary, description, status, visibility, catalog_item_id,
				current_version_id, ownership_model, ownership_record_id, support_policy, license, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				vendor.id,
				teamId,
				kind,
				slug,
				title,
				input.summary ?? null,
				input.description ?? null,
				'draft',
				enumValue(input.visibility, COMMERCE_VISIBILITY_SET, 'private'),
				null,
				null,
				ownershipModel,
				null,
				input.supportPolicy ?? null,
				input.license ?? null,
				JSON.stringify(input.metadata ?? {}),
				timestamp,
				timestamp,
			],
		);
		const ownership = await this.createCommerceOwnershipRecord(id, {
			...(input.ownership ?? {}),
			model: input.ownership?.model ?? ownershipModel,
			canonicalOwnerType: input.ownership?.canonicalOwnerType ?? 'team',
			canonicalOwnerId: input.ownership?.canonicalOwnerId ?? teamId,
			sellerTeamId: teamId,
			stewardTeamId: input.ownership?.stewardTeamId ?? teamId,
			publicSummary: input.ownership?.publicSummary ?? 'Owned and stewarded by the seller team.',
			buyerVisible: input.ownership?.buyerVisible ?? true,
			effectiveAt: input.ownership?.effectiveAt ?? timestamp,
		});
		await this.setCurrentCommerceOwnershipRecord(id, ownership.id);
		return this.getCommerceProduct(id);
	}

	async getCommerceProduct(productId) {
		await this.ensureInitialized();
		return serializeCommerceProduct(await this.first(`SELECT * FROM commerce_products WHERE id = ? LIMIT 1`, [productId]));
	}

	async listCommerceProducts(principal, filters = {}) {
		await this.ensureInitialized();
		const clauses = [];
		const params = [];
		if (filters.teamId) {
			clauses.push('seller_team_id = ?');
			params.push(filters.teamId);
		}
		if (filters.vendorId) {
			clauses.push('vendor_id = ?');
			params.push(filters.vendorId);
		}
		if (filters.kind) {
			clauses.push('kind = ?');
			params.push(filters.kind);
		}
		if (filters.status) {
			clauses.push('status = ?');
			params.push(filters.status);
		}
		if (filters.slug) {
			clauses.push('slug = ?');
			params.push(filters.slug);
		}
		const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
		const rows = await this.all(`SELECT * FROM commerce_products ${where} ORDER BY updated_at DESC, created_at DESC`, params);
		const teamIds = await this.teamIdsForPrincipal(principal);
		return rows
			.map(serializeCommerceProduct)
			.filter((product) =>
				(product.visibility === 'public' && product.status === 'approved')
				|| principalIsAdmin(principal)
				|| teamIds.includes(product.sellerTeamId),
			);
	}

	async commerceMarketplaceProductSummary(product, options = {}) {
		if (!product) return null;
		const vendor = await this.getCommerceVendor(product.vendorId).catch(() => null);
		const ownershipRecords = await this.listCommerceOwnershipRecords(product.id).catch(() => []);
		const currentOwnership = ownershipRecords.find((record) => record.id === product.ownershipRecordId)
			?? ownershipRecords.find((record) => record.buyerVisible)
			?? null;
		const stewards = await this.listCommerceStewardshipAssignments(product.id).catch(() => []);
		const offers = (await this.listCommerceOffers({ productId: product.id, status: 'approved' }).catch(() => []))
			.map(async (offer) => {
				const price = offer.activePriceId ? await this.getCommercePrice(offer.activePriceId).catch(() => null) : null;
				const checkoutEligible = ['free', 'one_time', 'one_time_current_version', 'subscription', 'subscription_updates'].includes(offer.mode)
					&& (offer.mode === 'free' || price?.status === 'active');
				const serviceEligible = product.kind === 'scoped_service' && ['contact', 'scoped_contract'].includes(offer.mode);
				const capacityInquiryEligible = product.kind === 'capacity_listing' && ['contact', 'private', 'external'].includes(offer.mode);
				return {
					id: offer.id,
					mode: offer.mode,
					title: offer.title,
					status: offer.status,
					priceId: price?.id ?? null,
					unitAmount: price?.amount ?? null,
					currency: price?.currency ?? null,
					billingInterval: price?.billingInterval ?? null,
					checkoutEligible,
					serviceEligible,
					capacityInquiryEligible,
					stripeSyncStatus: price?.stripeSyncStatus ?? null,
				};
			});
		const resolvedOffers = await Promise.all(offers);
		const capacityListing = product.kind === 'capacity_listing'
			? await this.getCommerceCapacityListingForProduct(product.id, { publicSafe: options.publicSafe }).catch(() => null)
			: null;
		const publicStewards = stewards
			.filter((assignment) => assignment.visibleToBuyers !== false)
			.map((assignment) => ({
				id: assignment.id,
				role: assignment.role,
				displayName: assignment.displayName,
				responsibilities: assignment.responsibilities,
			}));
		return {
			id: product.id,
			kind: product.kind,
			title: product.title,
			slug: product.slug,
			summary: product.summary,
			status: product.status,
			vendorId: product.vendorId,
			sellerTeamId: product.sellerTeamId,
			vendorDisplayName: vendor?.displayName ?? null,
			ownershipModel: product.ownershipModel ?? null,
			buyerVisibleOwnershipSummary: currentOwnership?.buyerVisible === false ? null : currentOwnership?.publicSummary ?? null,
			stewardshipSummary: publicStewards,
			offers: resolvedOffers,
			capacityListingId: capacityListing?.status === 'approved' ? capacityListing.id : null,
			serviceRequestEligible: product.kind === 'scoped_service' && resolvedOffers.some((offer) => offer.serviceEligible),
			checkoutEligible: resolvedOffers.some((offer) => offer.checkoutEligible),
			updatedAt: product.updatedAt,
		};
	}

	async listCommerceMarketplaceProducts(principal, filters = {}) {
		await this.ensureInitialized();
		const products = await this.listCommerceProducts(principal, {
			kind: filters.kind,
			status: filters.status ?? 'approved',
		});
		const summaries = await Promise.all(
			products
				.filter((product) => product.status === 'approved' && product.visibility === 'public')
				.map((product) => this.commerceMarketplaceProductSummary(product, { publicSafe: true })),
		);
		return { products: summaries.filter(Boolean) };
	}

	async getCommerceMarketplaceProduct(productId, principal = null) {
		await this.ensureInitialized();
		const product = await this.getCommerceProduct(productId);
		if (!product) return null;
		const teamIds = await this.teamIdsForPrincipal(principal);
		const canSeePrivate = principalIsAdmin(principal) || teamIds.includes(product.sellerTeamId);
		if (!canSeePrivate && (product.status !== 'approved' || product.visibility !== 'public')) return null;
		return this.commerceMarketplaceProductSummary(product, { publicSafe: !canSeePrivate });
	}

	async updateCommerceProduct(productId, input = {}) {
		await this.ensureInitialized();
		const existing = await this.getCommerceProduct(productId);
		if (!existing) return null;
		if (!['draft', 'rejected'].includes(existing.status)) {
			const error = new Error('Approved or submitted products cannot be edited through draft update.');
			error.status = 409;
			throw error;
		}
		const timestamp = isoNow();
		await this.run(
			`UPDATE commerce_products
			 SET kind = ?, slug = ?, title = ?, summary = ?, description = ?, visibility = ?, ownership_model = ?,
			     support_policy = ?, license = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`,
			[
				enumValue(input.kind, COMMERCE_PRODUCT_KIND_SET, existing.kind),
				safeIdPart(input.slug ?? existing.slug, existing.slug),
				stringValue(input.title, existing.title),
				input.summary === undefined ? existing.summary : input.summary,
				input.description === undefined ? existing.description : input.description,
				enumValue(input.visibility, COMMERCE_VISIBILITY_SET, existing.visibility),
				enumValue(input.ownershipModel, COMMERCE_OWNERSHIP_MODEL_SET, existing.ownershipModel),
				input.supportPolicy === undefined ? existing.supportPolicy : input.supportPolicy,
				input.license === undefined ? existing.license : input.license,
				JSON.stringify(input.metadata ?? existing.metadata ?? {}),
				timestamp,
				productId,
			],
		);
		return this.getCommerceProduct(productId);
	}

	async transitionCommerceProduct(productId, nextState, input = {}) {
		await this.ensureInitialized();
		const existing = await this.getCommerceProduct(productId);
		if (!existing) return null;
		const timestamp = isoNow();
		await this.run(`UPDATE commerce_products SET status = ?, updated_at = ? WHERE id = ?`, [nextState, timestamp, productId]);
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? 'user',
			actorId: input.actorId ?? null,
			action: `product.${nextState}`,
			objectType: 'commerce_product',
			objectId: productId,
			priorState: existing.status,
			nextState,
			reason: input.reason ?? null,
			evidence: input.evidence ?? {},
			relatedProductId: productId,
			relatedTeamId: existing.sellerTeamId,
		});
		return this.getCommerceProduct(productId);
	}

	async submitCommerceProduct(productId, input = {}) {
		return this.transitionCommerceProduct(productId, 'submitted', input);
	}

	async approveCommerceProduct(productId, input = {}) {
		const existing = await this.getCommerceProduct(productId);
		if (!existing) return null;
		const vendor = await this.getCommerceVendor(existing.vendorId);
		if (vendor?.status !== 'approved') {
			const error = new Error('Vendor must be approved before product approval.');
			error.status = 409;
			throw error;
		}
		const approvedOffer = (await this.listCommerceOffers({ productId, status: 'approved' }))[0] ?? null;
		const catalogItem = await this.upsertCatalogItem(existing.sellerTeamId, {
			id: existing.catalogItemId ?? undefined,
			kind: existing.kind,
			slug: existing.slug,
			title: existing.title,
			summary: existing.summary,
			visibility: existing.visibility,
			listingEnabled: existing.visibility === 'public',
			offerMode: approvedOffer?.mode ?? 'private',
			metadata: {
				...(existing.metadata ?? {}),
				commerceProductId: existing.id,
				commerceVendorId: existing.vendorId,
				ownershipModel: existing.ownershipModel,
			},
		});
		await this.run(
			`UPDATE commerce_products SET status = ?, catalog_item_id = ?, updated_at = ? WHERE id = ?`,
			['approved', catalogItem.id, isoNow(), productId],
		);
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? 'operator',
			actorId: input.actorId ?? null,
			action: 'product.approve',
			objectType: 'commerce_product',
			objectId: productId,
			priorState: existing.status,
			nextState: 'approved',
			reason: input.reason ?? null,
			evidence: input.evidence ?? {},
			relatedProductId: productId,
			relatedTeamId: existing.sellerTeamId,
		});
		return this.getCommerceProduct(productId);
	}

	async archiveCommerceProduct(productId, input = {}) {
		return this.transitionCommerceProduct(productId, 'archived', input);
	}

	async createCommerceOwnershipRecord(productId, input = {}) {
		await this.ensureInitialized();
		const product = await this.getCommerceProduct(productId);
		if (!product) return null;
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO commerce_ownership_records (
				id, product_id, model, canonical_owner_type, canonical_owner_id, seller_team_id, steward_team_id,
				governance_policy_id, public_summary, buyer_visible, effective_at, superseded_at, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				productId,
				enumValue(input.model, COMMERCE_OWNERSHIP_MODEL_SET, product.ownershipModel),
				stringValue(input.canonicalOwnerType, 'team'),
				input.canonicalOwnerId ?? product.sellerTeamId,
				input.sellerTeamId ?? product.sellerTeamId,
				input.stewardTeamId ?? product.sellerTeamId,
				input.governancePolicyId ?? null,
				input.publicSummary ?? null,
				input.buyerVisible === false ? 0 : 1,
				input.effectiveAt ?? timestamp,
				input.supersededAt ?? null,
				JSON.stringify(input.metadata ?? {}),
				timestamp,
				timestamp,
			],
		);
		return serializeCommerceOwnershipRecord(await this.first(`SELECT * FROM commerce_ownership_records WHERE id = ?`, [id]));
	}

	async listCommerceOwnershipRecords(productId) {
		await this.ensureInitialized();
		const rows = await this.all(`SELECT * FROM commerce_ownership_records WHERE product_id = ? ORDER BY effective_at DESC, created_at DESC`, [productId]);
		return rows.map(serializeCommerceOwnershipRecord);
	}

	async updateCommerceOwnershipRecord(ownershipRecordId, input = {}) {
		await this.ensureInitialized();
		const existing = await this.first(`SELECT * FROM commerce_ownership_records WHERE id = ?`, [ownershipRecordId]);
		if (!existing) return null;
		const timestamp = isoNow();
		await this.run(
			`UPDATE commerce_ownership_records
			 SET public_summary = ?, buyer_visible = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`,
			[
				input.publicSummary === undefined ? existing.public_summary : input.publicSummary,
				input.buyerVisible === undefined ? existing.buyer_visible : input.buyerVisible ? 1 : 0,
				input.metadata === undefined ? existing.metadata_json : JSON.stringify(input.metadata ?? {}),
				timestamp,
				ownershipRecordId,
			],
		);
		const updated = serializeCommerceOwnershipRecord(await this.first(`SELECT * FROM commerce_ownership_records WHERE id = ?`, [ownershipRecordId]));
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? 'system',
			actorId: input.actorId ?? null,
			action: 'commerce_ownership.record.updated',
			objectType: 'commerce_ownership_record',
			objectId: ownershipRecordId,
			priorState: existing.buyer_visible ? 'buyer_visible' : 'private',
			nextState: updated.buyerVisible ? 'buyer_visible' : 'private',
			reason: input.reason ?? null,
			evidence: input.evidence ?? {},
			relatedProductId: existing.product_id,
			relatedTeamId: existing.seller_team_id,
		});
		return updated;
	}

	async setCurrentCommerceOwnershipRecord(productId, ownershipRecordId) {
		await this.ensureInitialized();
		const ownership = await this.first(`SELECT * FROM commerce_ownership_records WHERE id = ? AND product_id = ? LIMIT 1`, [ownershipRecordId, productId]);
		if (!ownership) return null;
		await this.run(
			`UPDATE commerce_products SET ownership_record_id = ?, ownership_model = ?, updated_at = ? WHERE id = ?`,
			[ownershipRecordId, ownership.model, isoNow(), productId],
		);
		return this.getCommerceProduct(productId);
	}

	async createCommerceStewardshipAssignment(productId, input = {}) {
		await this.ensureInitialized();
		const product = await this.getCommerceProduct(productId);
		if (!product) return null;
		const timestamp = isoNow();
		const ownershipRecordId = input.ownershipRecordId ?? product.ownershipRecordId;
		if (!ownershipRecordId) {
			const error = new Error('Ownership record is required for stewardship assignments.');
			error.status = 409;
			throw error;
		}
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO commerce_stewardship_assignments (
				id, ownership_record_id, product_id, role, assignee_type, assignee_id, display_name, responsibilities_json,
				visible_to_buyers, starts_at, ends_at, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				ownershipRecordId,
				productId,
				enumValue(input.role, COMMERCE_STEWARDSHIP_ROLE_SET, 'governance_steward'),
				stringValue(input.assigneeType, 'team'),
				input.assigneeId ?? product.sellerTeamId,
				input.displayName ?? null,
				JSON.stringify(arrayValue(input.responsibilities)),
				input.visibleToBuyers === false ? 0 : 1,
				input.startsAt ?? timestamp,
				input.endsAt ?? null,
				JSON.stringify(input.metadata ?? {}),
				timestamp,
				timestamp,
			],
		);
		return serializeCommerceStewardshipAssignment(await this.first(`SELECT * FROM commerce_stewardship_assignments WHERE id = ?`, [id]));
	}

	async listCommerceStewardshipAssignments(productId) {
		await this.ensureInitialized();
		const rows = await this.all(`SELECT * FROM commerce_stewardship_assignments WHERE product_id = ? ORDER BY created_at ASC`, [productId]);
		return rows.map(serializeCommerceStewardshipAssignment);
	}

	async updateCommerceStewardshipAssignment(assignmentId, input = {}) {
		await this.ensureInitialized();
		const existing = await this.first(`SELECT * FROM commerce_stewardship_assignments WHERE id = ?`, [assignmentId]);
		if (!existing) return null;
		const timestamp = isoNow();
		await this.run(
			`UPDATE commerce_stewardship_assignments
			 SET display_name = ?, responsibilities_json = ?, visible_to_buyers = ?, ends_at = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`,
			[
				input.displayName === undefined ? existing.display_name : input.displayName,
				input.responsibilities === undefined ? existing.responsibilities_json : JSON.stringify(input.responsibilities ?? []),
				input.visibleToBuyers === undefined ? existing.visible_to_buyers : input.visibleToBuyers ? 1 : 0,
				input.endsAt === undefined ? existing.ends_at : input.endsAt,
				input.metadata === undefined ? existing.metadata_json : JSON.stringify(input.metadata ?? {}),
				timestamp,
				assignmentId,
			],
		);
		const updated = serializeCommerceStewardshipAssignment(await this.first(`SELECT * FROM commerce_stewardship_assignments WHERE id = ?`, [assignmentId]));
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? 'system',
			actorId: input.actorId ?? null,
			action: 'commerce_stewardship.assignment.updated',
			objectType: 'commerce_stewardship_assignment',
			objectId: assignmentId,
			priorState: existing.ends_at ? 'ended' : 'active',
			nextState: updated.endsAt ? 'ended' : 'active',
			reason: input.reason ?? null,
			evidence: input.evidence ?? {},
			relatedProductId: existing.product_id,
		});
		return updated;
	}

	async endCommerceStewardshipAssignment(assignmentId, input = {}) {
		return this.updateCommerceStewardshipAssignment(assignmentId, {
			...input,
			endsAt: input.endsAt ?? isoNow(),
			evidence: input.evidence ?? { ended: true },
		}).then(async (updated) => {
			if (updated) {
				await this.recordCommerceGovernanceEvent({
					actorType: input.actorType ?? 'system',
					actorId: input.actorId ?? null,
					action: 'commerce_stewardship.assignment.ended',
					objectType: 'commerce_stewardship_assignment',
					objectId: assignmentId,
					priorState: 'active',
					nextState: 'ended',
					reason: input.reason ?? null,
					evidence: input.evidence ?? {},
					relatedProductId: updated.productId,
				});
			}
			return updated;
		});
	}

	async createCommerceContribution(productId, input = {}) {
		await this.ensureInitialized();
		const product = await this.getCommerceProduct(productId);
		if (!product) return null;
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO commerce_contributions (
				id, product_id, product_version_id, contributor_type, contributor_id, display_name, role, summary,
				attribution_visibility, agreement_ref, benefit_weight, effective_at, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				productId,
				input.productVersionId ?? null,
				stringValue(input.contributorType, 'team'),
				input.contributorId ?? product.sellerTeamId,
				input.displayName ?? null,
				stringValue(input.role, 'contributor'),
				input.summary ?? null,
				enumValue(input.attributionVisibility, new Set(['public', 'buyer', 'vendor', 'private']), 'public'),
				input.agreementRef ?? null,
				numberValue(input.benefitWeight, null),
				input.effectiveAt ?? timestamp,
				JSON.stringify(input.metadata ?? {}),
				timestamp,
				timestamp,
			],
		);
		return serializeCommerceContribution(await this.first(`SELECT * FROM commerce_contributions WHERE id = ?`, [id]));
	}

	async listCommerceContributions(productId) {
		await this.ensureInitialized();
		const rows = await this.all(`SELECT * FROM commerce_contributions WHERE product_id = ? ORDER BY effective_at DESC, created_at DESC`, [productId]);
		return rows.map(serializeCommerceContribution);
	}

	async updateCommerceContribution(contributionId, input = {}) {
		await this.ensureInitialized();
		const existing = await this.first(`SELECT * FROM commerce_contributions WHERE id = ?`, [contributionId]);
		if (!existing) return null;
		const timestamp = isoNow();
		await this.run(
			`UPDATE commerce_contributions
			 SET summary = ?, attribution_visibility = ?, benefit_weight = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`,
			[
				input.summary === undefined ? existing.summary : input.summary,
				input.attributionVisibility === undefined ? existing.attribution_visibility : enumValue(input.attributionVisibility, new Set(['public', 'buyer', 'vendor', 'private']), existing.attribution_visibility),
				input.benefitWeight === undefined ? existing.benefit_weight : numberValue(input.benefitWeight, null),
				input.metadata === undefined ? existing.metadata_json : JSON.stringify(input.metadata ?? {}),
				timestamp,
				contributionId,
			],
		);
		const updated = serializeCommerceContribution(await this.first(`SELECT * FROM commerce_contributions WHERE id = ?`, [contributionId]));
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? 'system',
			actorId: input.actorId ?? null,
			action: 'commerce_contribution.updated',
			objectType: 'commerce_contribution',
			objectId: contributionId,
			priorState: existing.attribution_visibility,
			nextState: updated.attributionVisibility,
			reason: input.reason ?? null,
			evidence: input.evidence ?? {},
			relatedProductId: existing.product_id,
		});
		return updated;
	}

	async createCommerceGovernancePolicy(input = {}) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO commerce_governance_policies (
				id, product_id, team_id, policy_kind, title, approval_rules_json, quorum_rules_json, buyer_visible_summary, status, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				input.productId ?? null,
				input.teamId ?? null,
				enumValue(input.policyKind, new Set(['product', 'vendor', 'cooperative', 'community']), 'product'),
				stringValue(input.title, 'Commerce Governance Policy'),
				JSON.stringify(input.approvalRules ?? {}),
				JSON.stringify(input.quorumRules ?? {}),
				input.buyerVisibleSummary ?? null,
				enumValue(input.status, new Set(['draft', 'active', 'superseded', 'archived']), 'draft'),
				timestamp,
				timestamp,
			],
		);
		return serializeCommerceGovernancePolicy(await this.first(`SELECT * FROM commerce_governance_policies WHERE id = ?`, [id]));
	}

	async listCommerceGovernancePolicies(filters = {}) {
		await this.ensureInitialized();
		const clauses = [];
		const params = [];
		if (filters.productId) {
			clauses.push('product_id = ?');
			params.push(filters.productId);
		}
		if (filters.teamId) {
			clauses.push('team_id = ?');
			params.push(filters.teamId);
		}
		const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
		const rows = await this.all(`SELECT * FROM commerce_governance_policies ${where} ORDER BY updated_at DESC`, params);
		return rows.map(serializeCommerceGovernancePolicy);
	}

	async updateCommerceGovernancePolicy(policyId, input = {}) {
		await this.ensureInitialized();
		const existing = await this.first(`SELECT * FROM commerce_governance_policies WHERE id = ?`, [policyId]);
		if (!existing) return null;
		const timestamp = isoNow();
		await this.run(
			`UPDATE commerce_governance_policies
			 SET title = ?, approval_rules_json = ?, quorum_rules_json = ?, buyer_visible_summary = ?, status = ?, updated_at = ?
			 WHERE id = ?`,
			[
				input.title === undefined ? existing.title : stringValue(input.title, existing.title),
				input.approvalRules === undefined ? existing.approval_rules_json : JSON.stringify(input.approvalRules ?? {}),
				input.quorumRules === undefined ? existing.quorum_rules_json : JSON.stringify(input.quorumRules ?? {}),
				input.buyerVisibleSummary === undefined ? existing.buyer_visible_summary : input.buyerVisibleSummary,
				input.status === undefined ? existing.status : enumValue(input.status, new Set(['draft', 'active', 'superseded', 'archived']), existing.status),
				timestamp,
				policyId,
			],
		);
		const updated = serializeCommerceGovernancePolicy(await this.first(`SELECT * FROM commerce_governance_policies WHERE id = ?`, [policyId]));
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? 'system',
			actorId: input.actorId ?? null,
			action: 'commerce_governance_policy.updated',
			objectType: 'commerce_governance_policy',
			objectId: policyId,
			priorState: existing.status,
			nextState: updated.status,
			reason: input.reason ?? null,
			evidence: input.evidence ?? {},
			relatedProductId: existing.product_id,
			relatedTeamId: existing.team_id,
		});
		return updated;
	}

	async createCommerceOwnershipTransfer(productId, input = {}) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		const product = await this.getCommerceProduct(productId);
		if (!product) return null;
		const status = enumValue(input.status, new Set(['draft', 'submitted']), 'draft');
		await this.run(
			`INSERT INTO commerce_ownership_transfers (
				id, product_id, from_ownership_record_id, to_ownership_record_id, status, reason, approval_evidence_json,
				buyer_visible_impact, effective_at, requested_by_type, requested_by_id, metadata_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				productId,
				input.fromOwnershipRecordId,
				input.toOwnershipRecordId,
				status,
				stringValue(input.reason, 'Ownership transfer'),
				JSON.stringify(input.approvalEvidence ?? {}),
				input.buyerVisibleImpact ?? null,
				input.effectiveAt ?? timestamp,
				stringValue(input.requestedByType ?? input.actorType, 'user'),
				stringValue(input.requestedById ?? input.actorId, 'system'),
				JSON.stringify(input.metadata ?? {}),
				timestamp,
			],
		);
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? input.requestedByType ?? 'system',
			actorId: input.actorId ?? input.requestedById ?? null,
			action: 'commerce_ownership_transfer.created',
			objectType: 'commerce_ownership_transfer',
			objectId: id,
			nextState: status,
			reason: input.reason ?? null,
			evidence: input.approvalEvidence ?? {},
			relatedProductId: productId,
			relatedTeamId: product.sellerTeamId,
		});
		return serializeCommerceOwnershipTransfer(await this.first(`SELECT * FROM commerce_ownership_transfers WHERE id = ?`, [id]));
	}

	async updateCommerceOwnershipTransferState(transferId, nextState, input = {}) {
		await this.ensureInitialized();
		const existing = await this.first(`SELECT * FROM commerce_ownership_transfers WHERE id = ?`, [transferId]);
		if (!existing) return null;
		const product = await this.getCommerceProduct(existing.product_id);
		const timestamp = isoNow();
		const approvalFields = nextState === 'approved'
			? `, approved_by_type = ?, approved_by_id = ?, approved_at = ?`
			: nextState === 'rejected'
				? `, rejected_at = ?`
				: '';
		const params = [
			nextState,
			JSON.stringify(input.evidence ?? parseJson(existing.approval_evidence_json, {})),
			input.reason ?? existing.reason,
			...(nextState === 'approved'
				? [input.actorType ?? 'system', input.actorId ?? 'system', timestamp]
				: nextState === 'rejected'
					? [timestamp]
					: []),
			transferId,
		];
		await this.run(
			`UPDATE commerce_ownership_transfers
			 SET status = ?, approval_evidence_json = ?, reason = ?${approvalFields}
			 WHERE id = ?`,
			params,
		);
		if (nextState === 'approved') {
			await this.run(
				`UPDATE commerce_ownership_records SET superseded_at = ?, updated_at = ? WHERE id = ? AND superseded_at IS NULL`,
				[timestamp, timestamp, existing.from_ownership_record_id],
			);
			await this.setCurrentCommerceOwnershipRecord(existing.product_id, existing.to_ownership_record_id);
		}
		const updated = serializeCommerceOwnershipTransfer(await this.first(`SELECT * FROM commerce_ownership_transfers WHERE id = ?`, [transferId]));
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? 'system',
			actorId: input.actorId ?? null,
			action: `commerce_ownership_transfer.${nextState}`,
			objectType: 'commerce_ownership_transfer',
			objectId: transferId,
			priorState: existing.status ?? 'draft',
			nextState,
			reason: input.reason ?? existing.reason,
			evidence: input.evidence ?? {},
			relatedProductId: existing.product_id,
			relatedTeamId: product?.sellerTeamId ?? null,
		});
		return updated;
	}

	async submitCommerceOwnershipTransfer(transferId, input = {}) {
		return this.updateCommerceOwnershipTransferState(transferId, 'submitted', input);
	}

	async approveCommerceOwnershipTransfer(transferId, input = {}) {
		return this.updateCommerceOwnershipTransferState(transferId, 'approved', input);
	}

	async rejectCommerceOwnershipTransfer(transferId, input = {}) {
		return this.updateCommerceOwnershipTransferState(transferId, 'rejected', input);
	}

	async cancelCommerceOwnershipTransfer(transferId, input = {}) {
		return this.updateCommerceOwnershipTransferState(transferId, 'canceled', input);
	}

	async createCommerceSuccessionEvent(productId, input = {}) {
		await this.ensureInitialized();
		const product = await this.getCommerceProduct(productId);
		if (!product) return null;
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO commerce_succession_events (
				id, product_id, ownership_record_id, stewardship_assignment_id, successor_type, successor_id, event_type,
				status, reason, evidence_json, effective_at, created_by_type, created_by_id, metadata_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				productId,
				input.ownershipRecordId ?? product.ownershipRecordId ?? null,
				input.stewardshipAssignmentId ?? null,
				stringValue(input.successorType, 'team'),
				stringValue(input.successorId, product.sellerTeamId),
				enumValue(input.eventType, new Set(['successor_named', 'successor_accepted', 'succession_triggered', 'succession_completed', 'succession_canceled']), 'successor_named'),
				enumValue(input.status, new Set(['draft', 'submitted', 'approved', 'rejected', 'canceled', 'superseded']), 'submitted'),
				input.reason ?? null,
				JSON.stringify(input.evidence ?? {}),
				input.effectiveAt ?? null,
				stringValue(input.createdByType ?? input.actorType, 'user'),
				stringValue(input.createdById ?? input.actorId, 'system'),
				JSON.stringify(input.metadata ?? {}),
				timestamp,
			],
		);
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? input.createdByType ?? 'system',
			actorId: input.actorId ?? input.createdById ?? null,
			action: 'commerce_succession_event.created',
			objectType: 'commerce_succession_event',
			objectId: id,
			nextState: input.status ?? 'submitted',
			reason: input.reason ?? null,
			evidence: input.evidence ?? {},
			relatedProductId: productId,
			relatedTeamId: product.sellerTeamId,
		});
		return serializeCommerceSuccessionEvent(await this.first(`SELECT * FROM commerce_succession_events WHERE id = ?`, [id]));
	}

	async listCommerceSuccessionEvents(productId) {
		await this.ensureInitialized();
		const rows = await this.all(`SELECT * FROM commerce_succession_events WHERE product_id = ? ORDER BY created_at DESC`, [productId]);
		return rows.map(serializeCommerceSuccessionEvent);
	}

	async getCommerceOwnershipWorkflowSummary(productId) {
		await this.ensureInitialized();
		const product = await this.getCommerceProduct(productId);
		if (!product) return null;
		const ownershipRecords = await this.listCommerceOwnershipRecords(productId);
		const currentOwnershipRecord = ownershipRecords.find((record) => record.id === product.ownershipRecordId) ?? null;
		const transfers = (await this.all(`SELECT * FROM commerce_ownership_transfers WHERE product_id = ? ORDER BY created_at DESC`, [productId]))
			.map(serializeCommerceOwnershipTransfer);
		return serializeCommerceOwnershipWorkflowSummary({
			productId,
			currentOwnershipRecord,
			buyerVisibleOwnershipRecords: ownershipRecords.filter((record) => record.buyerVisible),
			stewardshipAssignments: await this.listCommerceStewardshipAssignments(productId),
			contributions: await this.listCommerceContributions(productId),
			governancePolicies: await this.listCommerceGovernancePolicies({ productId }),
			pendingTransfers: transfers,
			successionEvents: await this.listCommerceSuccessionEvents(productId),
		});
	}

	async commerceCapacityOwnershipSnapshot(product) {
		const ownershipRecords = await this.listCommerceOwnershipRecords(product.id).catch(() => []);
		const currentOwnershipRecord = ownershipRecords.find((record) => record.id === product.ownershipRecordId) ?? ownershipRecords[0] ?? null;
		const stewards = await this.listCommerceStewardshipAssignments(product.id).catch(() => []);
		return {
			capturedAt: isoNow(),
			productId: product.id,
			ownershipModel: product.ownershipModel,
			ownershipRecord: currentOwnershipRecord,
			stewards: stewards.filter((assignment) => assignment.visibleToBuyers !== false),
			sellerTeamId: product.sellerTeamId,
			vendorId: product.vendorId,
		};
	}

	async validateCommerceCapacityProviderDisclosure(product, input = {}, capacity) {
		if (!input.capacityProviderId && !input.executionProviderId) return;
		if (!input.capacityProviderId) {
			const error = new Error('capacityProviderId is required when linking an execution provider.');
			error.status = 400;
			throw error;
		}
		const provider = await capacity.getCapacityProvider(product.sellerTeamId, input.capacityProviderId);
		if (!provider && !input.marketAdmin) {
			const error = new Error('Capacity provider must be controlled by the seller team.');
			error.status = 403;
			throw error;
		}
		if (input.executionProviderId) {
			const executionProvider = (await capacity.listProviderExecutionSnapshots(product.sellerTeamId, input.capacityProviderId))
				.find((entry) => entry.id === input.executionProviderId);
			if (!executionProvider) {
				const error = new Error('Execution provider must be declared by an active availability session for the linked provider.');
				error.status = 400;
				throw error;
			}
		}
	}

	async ensureCommerceCapacityListingEligibility(product, input = {}, capacity) {
		if (!product) {
			const error = new Error('Unknown commerce product.');
			error.status = 404;
			throw error;
		}
		if (product.kind !== 'capacity_listing') {
			const error = new Error('Capacity listing metadata requires a capacity_listing product.');
			error.status = 409;
			throw error;
		}
		const vendor = await this.getCommerceVendor(product.vendorId);
		if (!vendor || vendor.status !== 'approved') {
			const error = new Error('Approved vendor capability is required for capacity listings.');
			error.status = 409;
			throw error;
		}
		if (vendor.capacityListingsEnabled !== true) {
			const error = new Error('Vendor capacity listing capability is required.');
			error.status = 409;
			throw error;
		}
		if (!input.marketAdmin && vendor.trustLevel !== 'trusted_capacity_vendor') {
			const error = new Error('trusted_capacity_vendor trust is required for capacity marketplace listings.');
			error.status = 409;
			throw error;
		}
		await this.validateCommerceCapacityProviderDisclosure(product, input, capacity);
		return vendor;
	}

	async createCommerceCapacityListing(productId, input = {}, capacity) {
		await this.ensureInitialized();
		const product = await this.getCommerceProduct(productId);
		const vendor = await this.ensureCommerceCapacityListingEligibility(product, input, capacity);
		const existing = await this.getCommerceCapacityListingForProduct(productId);
		if (existing) return existing;
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		const ownershipSnapshot = input.ownershipSnapshot ?? await this.commerceCapacityOwnershipSnapshot(product);
		await this.run(
			`INSERT INTO commerce_capacity_listings (
				id, product_id, vendor_id, seller_team_id, capacity_provider_id, execution_provider_id, status,
				access_level, runtime_isolation_level, human_involvement_level, ai_involvement_level,
				data_access_level, secret_access_level, supported_service_types_json, supported_regions_json,
				runtime_requirements_json, data_handling_summary, buyer_visible_risk_summary,
				governance_requirements_json, support_policy, availability_summary, ownership_snapshot_json,
				metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				product.id,
				vendor.id,
				product.sellerTeamId,
				input.capacityProviderId ?? null,
				input.executionProviderId ?? null,
				'draft',
				enumValue(input.accessLevel, COMMERCE_CAPACITY_ACCESS_LEVEL_SET, 'public_summary'),
				enumValue(input.runtimeIsolationLevel, COMMERCE_CAPACITY_RUNTIME_ISOLATION_LEVEL_SET, 'none'),
				enumValue(input.humanInvolvementLevel, COMMERCE_CAPACITY_HUMAN_INVOLVEMENT_LEVEL_SET, 'none'),
				enumValue(input.aiInvolvementLevel, COMMERCE_CAPACITY_AI_INVOLVEMENT_LEVEL_SET, 'none'),
				enumValue(input.dataAccessLevel, COMMERCE_CAPACITY_DATA_ACCESS_LEVEL_SET, 'none'),
				enumValue(input.secretAccessLevel, COMMERCE_CAPACITY_SECRET_ACCESS_LEVEL_SET, 'none'),
				JSON.stringify(arrayValue(input.supportedServiceTypes)),
				JSON.stringify(arrayValue(input.supportedRegions)),
				JSON.stringify(objectValue(input.runtimeRequirements, {})),
				input.dataHandlingSummary ?? null,
				input.buyerVisibleRiskSummary ?? null,
				JSON.stringify(objectValue(input.governanceRequirements, {})),
				input.supportPolicy ?? product.supportPolicy ?? null,
				input.availabilitySummary ?? null,
				JSON.stringify(ownershipSnapshot),
				JSON.stringify(objectValue(input.metadata, {})),
				timestamp,
				timestamp,
			],
		);
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? 'user',
			actorId: input.actorId ?? null,
			action: 'commerce_capacity_listing.created',
			objectType: 'commerce_capacity_listing',
			objectId: id,
			nextState: 'draft',
			reason: input.reason ?? null,
			evidence: input.evidence ?? {
				productId: product.id,
				capacityProviderId: input.capacityProviderId ?? null,
				executionProviderId: input.executionProviderId ?? null,
			},
			relatedProductId: product.id,
			relatedTeamId: product.sellerTeamId,
		});
		if (input.capacityProviderId) {
			await this.recordCommerceGovernanceEvent({
				actorType: input.actorType ?? 'user',
				actorId: input.actorId ?? null,
				action: 'commerce_capacity_listing.provider_linked',
				objectType: 'commerce_capacity_listing',
				objectId: id,
				nextState: 'linked',
				evidence: {
					capacityProviderId: input.capacityProviderId,
					executionProviderId: input.executionProviderId ?? null,
				},
				relatedProductId: product.id,
				relatedTeamId: product.sellerTeamId,
			});
		}
		return this.getCommerceCapacityListing(id);
	}

	async getCommerceCapacityListing(listingId, options = {}) {
		await this.ensureInitialized();
		return serializeCommerceCapacityListing(
			await this.first(`SELECT * FROM commerce_capacity_listings WHERE id = ? LIMIT 1`, [listingId]),
			options,
		);
	}

	async getCommerceCapacityListingForProduct(productId, options = {}) {
		await this.ensureInitialized();
		return serializeCommerceCapacityListing(
			await this.first(`SELECT * FROM commerce_capacity_listings WHERE product_id = ? LIMIT 1`, [productId]),
			options,
		);
	}

	async listCommerceCapacityListings(principal, filters = {}) {
		await this.ensureInitialized();
		const clauses = [];
		const params = [];
		for (const [key, column] of [
			['productId', 'product_id'],
			['vendorId', 'vendor_id'],
			['sellerTeamId', 'seller_team_id'],
			['status', 'status'],
			['accessLevel', 'access_level'],
		]) {
			if (filters[key]) {
				clauses.push(`${column} = ?`);
				params.push(filters[key]);
			}
		}
		const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
		const rows = await this.all(`SELECT * FROM commerce_capacity_listings ${where} ORDER BY updated_at DESC, created_at DESC`, params);
		const teamIds = await this.teamIdsForPrincipal(principal);
		return rows
			.map((row) => {
				const sellerVisible = principalIsAdmin(principal) || teamIds.includes(row.seller_team_id);
				if (sellerVisible) return serializeCommerceCapacityListing(row);
				if (row.status === 'approved' && row.access_level === 'public_summary') return serializeCommerceCapacityListing(row, { publicSafe: true });
				return null;
			})
			.filter(Boolean);
	}

	async updateCommerceCapacityListing(listingId, input = {}, capacity) {
		await this.ensureInitialized();
		const existingRow = await this.first(`SELECT * FROM commerce_capacity_listings WHERE id = ? LIMIT 1`, [listingId]);
		const existing = serializeCommerceCapacityListing(existingRow);
		if (!existing) return null;
		const product = await this.getCommerceProduct(existing.productId);
		await this.ensureCommerceCapacityListingEligibility(product, {
			...input,
			capacityProviderId: input.capacityProviderId === undefined ? existing.capacityProviderId : input.capacityProviderId,
			executionProviderId: input.executionProviderId === undefined ? existing.executionProviderId : input.executionProviderId,
		}, capacity);
		const timestamp = isoNow();
		await this.run(
			`UPDATE commerce_capacity_listings
			 SET capacity_provider_id = ?, execution_provider_id = ?, access_level = ?, runtime_isolation_level = ?,
			     human_involvement_level = ?, ai_involvement_level = ?, data_access_level = ?, secret_access_level = ?,
			     supported_service_types_json = ?, supported_regions_json = ?, runtime_requirements_json = ?,
			     data_handling_summary = ?, buyer_visible_risk_summary = ?, governance_requirements_json = ?,
			     support_policy = ?, availability_summary = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`,
			[
				input.capacityProviderId === undefined ? existing.capacityProviderId : input.capacityProviderId,
				input.executionProviderId === undefined ? existing.executionProviderId : input.executionProviderId,
				enumValue(input.accessLevel, COMMERCE_CAPACITY_ACCESS_LEVEL_SET, existing.accessLevel),
				enumValue(input.runtimeIsolationLevel, COMMERCE_CAPACITY_RUNTIME_ISOLATION_LEVEL_SET, existing.runtimeIsolationLevel),
				enumValue(input.humanInvolvementLevel, COMMERCE_CAPACITY_HUMAN_INVOLVEMENT_LEVEL_SET, existing.humanInvolvementLevel),
				enumValue(input.aiInvolvementLevel, COMMERCE_CAPACITY_AI_INVOLVEMENT_LEVEL_SET, existing.aiInvolvementLevel),
				enumValue(input.dataAccessLevel, COMMERCE_CAPACITY_DATA_ACCESS_LEVEL_SET, existing.dataAccessLevel),
				enumValue(input.secretAccessLevel, COMMERCE_CAPACITY_SECRET_ACCESS_LEVEL_SET, existing.secretAccessLevel),
				JSON.stringify(input.supportedServiceTypes === undefined ? existing.supportedServiceTypes : arrayValue(input.supportedServiceTypes)),
				JSON.stringify(input.supportedRegions === undefined ? existing.supportedRegions : arrayValue(input.supportedRegions)),
				JSON.stringify(input.runtimeRequirements === undefined ? existing.runtimeRequirements : objectValue(input.runtimeRequirements, {})),
				input.dataHandlingSummary === undefined ? existing.dataHandlingSummary : input.dataHandlingSummary,
				input.buyerVisibleRiskSummary === undefined ? existing.buyerVisibleRiskSummary : input.buyerVisibleRiskSummary,
				JSON.stringify(input.governanceRequirements === undefined ? existing.governanceRequirements : objectValue(input.governanceRequirements, {})),
				input.supportPolicy === undefined ? existing.supportPolicy : input.supportPolicy,
				input.availabilitySummary === undefined ? existing.availabilitySummary : input.availabilitySummary,
				JSON.stringify(input.metadata === undefined ? existing.metadata : objectValue(input.metadata, {})),
				timestamp,
				listingId,
			],
		);
		const updated = await this.getCommerceCapacityListing(listingId);
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? 'user',
			actorId: input.actorId ?? null,
			action: 'commerce_capacity_listing.updated',
			objectType: 'commerce_capacity_listing',
			objectId: listingId,
			priorState: existing.status,
			nextState: updated.status,
			reason: input.reason ?? null,
			evidence: input.evidence ?? {},
			relatedProductId: existing.productId,
			relatedTeamId: existing.sellerTeamId,
		});
		if (input.capacityProviderId && input.capacityProviderId !== existing.capacityProviderId) {
			await this.recordCommerceGovernanceEvent({
				actorType: input.actorType ?? 'user',
				actorId: input.actorId ?? null,
				action: 'commerce_capacity_listing.provider_linked',
				objectType: 'commerce_capacity_listing',
				objectId: listingId,
				evidence: {
					capacityProviderId: input.capacityProviderId,
					executionProviderId: input.executionProviderId ?? null,
				},
				relatedProductId: existing.productId,
				relatedTeamId: existing.sellerTeamId,
			});
		}
		return updated;
	}

	async transitionCommerceCapacityListing(listingId, nextState, input = {}, capacity) {
		await this.ensureInitialized();
		const existing = await this.getCommerceCapacityListing(listingId);
		if (!existing) return null;
		const product = await this.getCommerceProduct(existing.productId);
		await this.ensureCommerceCapacityListingEligibility(product, input, capacity);
		const state = enumValue(nextState, COMMERCE_CAPACITY_LISTING_STATUS_SET, existing.status);
		await this.run(`UPDATE commerce_capacity_listings SET status = ?, updated_at = ? WHERE id = ?`, [state, isoNow(), listingId]);
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? 'user',
			actorId: input.actorId ?? null,
			action: input.action ?? `commerce_capacity_listing.${state}`,
			objectType: 'commerce_capacity_listing',
			objectId: listingId,
			priorState: existing.status,
			nextState: state,
			reason: input.reason ?? null,
			evidence: input.evidence ?? {},
			relatedProductId: existing.productId,
			relatedTeamId: existing.sellerTeamId,
		});
		return this.getCommerceCapacityListing(listingId);
	}

	async submitCommerceCapacityListing(listingId, input = {}, capacity) {
		return this.transitionCommerceCapacityListing(listingId, 'submitted', input, capacity);
	}

	async approveCommerceCapacityListing(listingId, input = {}, capacity) {
		return this.transitionCommerceCapacityListing(listingId, 'approved', { ...input, marketAdmin: true }, capacity);
	}

	async rejectCommerceCapacityListing(listingId, input = {}, capacity) {
		return this.transitionCommerceCapacityListing(listingId, 'rejected', { ...input, marketAdmin: true }, capacity);
	}

	async suspendCommerceCapacityListing(listingId, input = {}, capacity) {
		return this.transitionCommerceCapacityListing(listingId, 'suspended', { ...input, marketAdmin: true }, capacity);
	}

	async archiveCommerceCapacityListing(listingId, input = {}, capacity) {
		return this.transitionCommerceCapacityListing(listingId, 'archived', input, capacity);
	}

	async createCommerceCapacityListingInquiry(principal, listingId, input = {}) {
		await this.ensureInitialized();
		const listing = await this.getCommerceCapacityListing(listingId);
		if (!listing) {
			const error = new Error(`Unknown commerce capacity listing "${listingId}".`);
			error.status = 404;
			throw error;
		}
		if (listing.status !== 'approved') {
			const error = new Error('Capacity listing inquiries require an approved listing.');
			error.status = 409;
			throw error;
		}
		const product = await this.getCommerceProduct(listing.productId);
		if (!product || product.status !== 'approved' || product.visibility !== 'public') {
			const error = new Error('Capacity listing inquiries require an approved public product.');
			error.status = 409;
			throw error;
		}
		if (!principal?.id && !input.buyerTeamId) {
			const error = new Error('Authenticated buyer identity is required for capacity inquiries.');
			error.status = 401;
			throw error;
		}
		const requestedScope = stringValue(input.requestedScope, '');
		if (!requestedScope) {
			const error = new Error('requestedScope is required for capacity inquiries.');
			error.status = 400;
			throw error;
		}
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO commerce_capacity_listing_inquiries (
				id, listing_id, product_id, vendor_id, seller_team_id, buyer_team_id, buyer_user_id, status,
				requested_service_type, requested_scope, data_access_requested_json, secret_access_requested_json,
				related_project_id, related_workday_id, governance_evidence_json, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				listing.id,
				listing.productId,
				listing.vendorId,
				listing.sellerTeamId,
				input.buyerTeamId ?? null,
				input.buyerUserId ?? principal?.id ?? null,
				'requested',
				input.requestedServiceType ?? null,
				requestedScope,
				JSON.stringify(objectValue(input.dataAccessRequested, {})),
				JSON.stringify(objectValue(input.secretAccessRequested, {})),
				input.relatedProjectId ?? null,
				input.relatedWorkdayId ?? null,
				JSON.stringify(objectValue(input.governanceEvidence ?? input.evidence, {})),
				JSON.stringify(objectValue(input.metadata, {})),
				timestamp,
				timestamp,
			],
		);
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? 'user',
			actorId: input.actorId ?? principal?.id ?? null,
			action: 'commerce_capacity_inquiry.created',
			objectType: 'commerce_capacity_listing_inquiry',
			objectId: id,
			nextState: 'requested',
			reason: input.reason ?? null,
			evidence: {
				listingId: listing.id,
				requestedServiceType: input.requestedServiceType ?? null,
				relatedProjectId: input.relatedProjectId ?? null,
				relatedWorkdayId: input.relatedWorkdayId ?? null,
			},
			relatedProductId: listing.productId,
			relatedTeamId: listing.sellerTeamId,
		});
		return this.getCommerceCapacityListingInquiry(id);
	}

	async getCommerceCapacityListingInquiry(inquiryId, options = {}) {
		await this.ensureInitialized();
		return serializeCommerceCapacityListingInquiry(
			await this.first(`SELECT * FROM commerce_capacity_listing_inquiries WHERE id = ? LIMIT 1`, [inquiryId]),
			options,
		);
	}

	async listCommerceCapacityListingInquiries(principal, filters = {}) {
		await this.ensureInitialized();
		const clauses = [];
		const params = [];
		for (const [key, column] of [
			['listingId', 'listing_id'],
			['productId', 'product_id'],
			['vendorId', 'vendor_id'],
			['sellerTeamId', 'seller_team_id'],
			['buyerTeamId', 'buyer_team_id'],
			['buyerUserId', 'buyer_user_id'],
			['status', 'status'],
		]) {
			if (filters[key]) {
				clauses.push(`${column} = ?`);
				params.push(filters[key]);
			}
		}
		const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
		const rows = await this.all(`SELECT * FROM commerce_capacity_listing_inquiries ${where} ORDER BY updated_at DESC, created_at DESC`, params);
		const teamIds = await this.teamIdsForPrincipal(principal);
		return rows
			.map((row) => {
				const sellerVisible = principalIsAdmin(principal) || teamIds.includes(row.seller_team_id);
				const buyerVisible = (row.buyer_team_id && teamIds.includes(row.buyer_team_id)) || (row.buyer_user_id && row.buyer_user_id === principal?.id);
				if (sellerVisible || buyerVisible) return serializeCommerceCapacityListingInquiry(row, { publicSafe: !sellerVisible });
				return null;
			})
			.filter(Boolean);
	}

	async transitionCommerceCapacityInquiry(inquiryId, nextState, input = {}) {
		await this.ensureInitialized();
		const existing = await this.getCommerceCapacityListingInquiry(inquiryId);
		if (!existing) return null;
		const state = enumValue(nextState, COMMERCE_CAPACITY_INQUIRY_STATUS_SET, existing.status);
		await this.run(
			`UPDATE commerce_capacity_listing_inquiries
			 SET status = ?, governance_evidence_json = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`,
			[
				state,
				JSON.stringify(input.evidence ?? existing.governanceEvidence ?? {}),
				JSON.stringify(input.metadata ?? existing.metadata ?? {}),
				isoNow(),
				inquiryId,
			],
		);
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? 'user',
			actorId: input.actorId ?? null,
			action: input.action ?? `commerce_capacity_inquiry.${state}`,
			objectType: 'commerce_capacity_listing_inquiry',
			objectId: inquiryId,
			priorState: existing.status,
			nextState: state,
			reason: input.reason ?? null,
			evidence: input.evidence ?? {},
			relatedProductId: existing.productId,
			relatedTeamId: existing.sellerTeamId,
		});
		return this.getCommerceCapacityListingInquiry(inquiryId);
	}

	async markCommerceCapacityInquiryReviewing(inquiryId, input = {}) {
		return this.transitionCommerceCapacityInquiry(inquiryId, 'reviewing', input);
	}

	async approveCommerceCapacityInquiryForScoping(inquiryId, input = {}) {
		return this.transitionCommerceCapacityInquiry(inquiryId, 'approved_for_scoping', input);
	}

	async declineCommerceCapacityInquiry(inquiryId, input = {}) {
		return this.transitionCommerceCapacityInquiry(inquiryId, 'declined', input);
	}

	async cancelCommerceCapacityInquiry(inquiryId, input = {}) {
		const existing = await this.getCommerceCapacityListingInquiry(inquiryId);
		if (existing && !['requested', 'reviewing'].includes(existing.status)) {
			const error = new Error('Capacity inquiry can only be canceled before seller approval or decline.');
			error.status = 409;
			throw error;
		}
		return this.transitionCommerceCapacityInquiry(inquiryId, 'canceled', input);
	}

	async createCommerceProductVersion(productId, input = {}) {
		await this.ensureInitialized();
		const product = await this.getCommerceProduct(productId);
		if (!product) return null;
		const timestamp = isoNow();
		const version = stringValue(input.version, '');
		if (!version) {
			const error = new Error('Product version is required.');
			error.status = 400;
			throw error;
		}
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO commerce_product_versions (
				id, product_id, version, status, catalog_artifact_version_id, manifest_key, artifact_key, integrity,
				release_notes, compatibility_json, metadata_json, published_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				productId,
				version,
				'draft',
				null,
				input.manifestKey ?? null,
				input.artifactKey ?? null,
				input.integrity ?? null,
				input.releaseNotes ?? null,
				JSON.stringify(input.compatibility ?? {}),
				JSON.stringify(input.metadata ?? {}),
				null,
				timestamp,
				timestamp,
			],
		);
		return serializeCommerceProductVersion(await this.first(`SELECT * FROM commerce_product_versions WHERE id = ?`, [id]));
	}

	async getCommerceProductVersion(productId, version) {
		await this.ensureInitialized();
		return serializeCommerceProductVersion(await this.first(
			`SELECT * FROM commerce_product_versions WHERE product_id = ? AND (id = ? OR version = ?) LIMIT 1`,
			[productId, version, version],
		));
	}

	async getCommerceProductVersionById(versionId) {
		await this.ensureInitialized();
		return serializeCommerceProductVersion(await this.first(`SELECT * FROM commerce_product_versions WHERE id = ? LIMIT 1`, [versionId]));
	}

	async listCommerceProductVersions(productId) {
		await this.ensureInitialized();
		const rows = await this.all(`SELECT * FROM commerce_product_versions WHERE product_id = ? ORDER BY created_at DESC`, [productId]);
		return rows.map(serializeCommerceProductVersion);
	}

	async transitionCommerceProductVersion(versionId, nextState, input = {}) {
		await this.ensureInitialized();
		const existing = serializeCommerceProductVersion(await this.first(`SELECT * FROM commerce_product_versions WHERE id = ? LIMIT 1`, [versionId]));
		if (!existing) return null;
		await this.run(`UPDATE commerce_product_versions SET status = ?, updated_at = ? WHERE id = ?`, [nextState, isoNow(), versionId]);
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? 'user',
			actorId: input.actorId ?? null,
			action: `product_version.${nextState}`,
			objectType: 'commerce_product_version',
			objectId: versionId,
			priorState: existing.status,
			nextState,
			reason: input.reason ?? null,
			evidence: input.evidence ?? {},
			relatedProductId: existing.productId,
		});
		return serializeCommerceProductVersion(await this.first(`SELECT * FROM commerce_product_versions WHERE id = ?`, [versionId]));
	}

	async submitCommerceProductVersion(versionId, input = {}) {
		return this.transitionCommerceProductVersion(versionId, 'submitted', input);
	}

	async approveCommerceProductVersion(versionId, input = {}) {
		await this.ensureInitialized();
		const existing = serializeCommerceProductVersion(await this.first(`SELECT * FROM commerce_product_versions WHERE id = ? LIMIT 1`, [versionId]));
		if (!existing) return null;
		const product = await this.getCommerceProduct(existing.productId);
		if (product?.status !== 'approved') {
			const error = new Error('Product must be approved before version approval.');
			error.status = 409;
			throw error;
		}
		let catalogArtifact = null;
		if (existing.artifactKey && product.catalogItemId) {
			catalogArtifact = await this.upsertCatalogArtifactVersion(product.sellerTeamId, product.catalogItemId, {
				kind: `${product.kind}_artifact`,
				version: existing.version,
				contentKey: existing.artifactKey,
				manifestKey: existing.manifestKey,
				metadata: {
					...(existing.metadata ?? {}),
					commerceProductId: product.id,
					commerceProductVersionId: existing.id,
					integrity: existing.integrity,
				},
				publishedAt: input.publishedAt ?? isoNow(),
			});
		}
		const timestamp = isoNow();
		await this.run(
			`UPDATE commerce_product_versions
			 SET status = ?, catalog_artifact_version_id = ?, published_at = ?, updated_at = ?
			 WHERE id = ?`,
			['approved', catalogArtifact?.id ?? existing.catalogArtifactVersionId, input.publishedAt ?? timestamp, timestamp, versionId],
		);
		await this.run(`UPDATE commerce_products SET current_version_id = ?, updated_at = ? WHERE id = ?`, [versionId, timestamp, product.id]);
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? 'operator',
			actorId: input.actorId ?? null,
			action: 'product_version.approve',
			objectType: 'commerce_product_version',
			objectId: versionId,
			priorState: existing.status,
			nextState: 'approved',
			reason: input.reason ?? null,
			evidence: input.evidence ?? {},
			relatedProductId: product.id,
			relatedTeamId: product.sellerTeamId,
		});
		return serializeCommerceProductVersion(await this.first(`SELECT * FROM commerce_product_versions WHERE id = ?`, [versionId]));
	}

	async createCommerceOffer(input = {}) {
		await this.ensureInitialized();
		const product = await this.getCommerceProduct(input.productId);
		if (!product) return null;
		const mode = requireEnumValue(input.mode, COMMERCE_OFFER_MODE_SET, 'commerce offer mode');
		if (product.kind === 'capacity_listing' && !COMMERCE_CAPACITY_LISTING_OFFER_MODES.has(mode)) {
			const error = new Error('Capacity listing products only support contact, private, or external discovery offers in Phase 9.');
			error.status = 409;
			throw error;
		}
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO commerce_offers (
				id, product_id, product_version_id, vendor_id, seller_team_id, mode, status, title, terms_summary,
				access_scope_json, support_scope_json, fulfillment_mode, active_price_id, stripe_product_id, stripe_product_status,
				stripe_product_synced_at, stripe_product_sync_error, stripe_product_metadata_json, starts_at, ends_at, metadata_json,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				product.id,
				input.productVersionId ?? null,
				product.vendorId,
				product.sellerTeamId,
				mode,
				'draft',
				stringValue(input.title, product.title),
				input.termsSummary ?? null,
				JSON.stringify(input.accessScope ?? {}),
				JSON.stringify(input.supportScope ?? {}),
				enumValue(input.fulfillmentMode, COMMERCE_FULFILLMENT_MODE_SET, 'automatic'),
				null,
				null,
				'not_synced',
				null,
				null,
				'{}',
				input.startsAt ?? null,
				input.endsAt ?? null,
				JSON.stringify(input.metadata ?? {}),
				timestamp,
				timestamp,
			],
		);
		return this.getCommerceOffer(id);
	}

	async getCommerceOffer(offerId) {
		await this.ensureInitialized();
		return serializeCommerceOffer(await this.first(`SELECT * FROM commerce_offers WHERE id = ? LIMIT 1`, [offerId]));
	}

	async listCommerceOffers(filters = {}) {
		await this.ensureInitialized();
		const clauses = [];
		const params = [];
		for (const [key, column] of [
			['productId', 'product_id'],
			['vendorId', 'vendor_id'],
			['sellerTeamId', 'seller_team_id'],
			['status', 'status'],
			['mode', 'mode'],
		]) {
			if (filters[key]) {
				clauses.push(`${column} = ?`);
				params.push(filters[key]);
			}
		}
		const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
		const rows = await this.all(`SELECT * FROM commerce_offers ${where} ORDER BY updated_at DESC, created_at DESC`, params);
		return rows.map(serializeCommerceOffer);
	}

	async updateCommerceOffer(offerId, input = {}) {
		await this.ensureInitialized();
		const existing = await this.getCommerceOffer(offerId);
		if (!existing) return null;
		const product = await this.getCommerceProduct(existing.productId);
		if (!['draft', 'rejected'].includes(existing.status)) {
			const error = new Error('Only draft or rejected offers can be edited.');
			error.status = 409;
			throw error;
		}
		const nextMode = enumValue(input.mode, COMMERCE_OFFER_MODE_SET, existing.mode);
		if (product?.kind === 'capacity_listing' && !COMMERCE_CAPACITY_LISTING_OFFER_MODES.has(nextMode)) {
			const error = new Error('Capacity listing products only support contact, private, or external discovery offers in Phase 9.');
			error.status = 409;
			throw error;
		}
		await this.run(
			`UPDATE commerce_offers
			 SET mode = ?, product_version_id = ?, title = ?, terms_summary = ?, access_scope_json = ?, support_scope_json = ?,
			     fulfillment_mode = ?, starts_at = ?, ends_at = ?, metadata_json = ?, updated_at = ?
			WHERE id = ?`,
			[
				nextMode,
				input.productVersionId === undefined ? existing.productVersionId : input.productVersionId,
				stringValue(input.title, existing.title),
				input.termsSummary === undefined ? existing.termsSummary : input.termsSummary,
				JSON.stringify(input.accessScope ?? existing.accessScope ?? {}),
				JSON.stringify(input.supportScope ?? existing.supportScope ?? {}),
				enumValue(input.fulfillmentMode, COMMERCE_FULFILLMENT_MODE_SET, existing.fulfillmentMode),
				input.startsAt === undefined ? existing.startsAt : input.startsAt,
				input.endsAt === undefined ? existing.endsAt : input.endsAt,
				JSON.stringify(input.metadata ?? existing.metadata ?? {}),
				isoNow(),
				offerId,
			],
		);
		return this.getCommerceOffer(offerId);
	}

	async transitionCommerceOffer(offerId, nextState, input = {}) {
		await this.ensureInitialized();
		const existing = await this.getCommerceOffer(offerId);
		if (!existing) return null;
		await this.run(`UPDATE commerce_offers SET status = ?, updated_at = ? WHERE id = ?`, [nextState, isoNow(), offerId]);
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? 'user',
			actorId: input.actorId ?? null,
			action: `offer.${nextState}`,
			objectType: 'commerce_offer',
			objectId: offerId,
			priorState: existing.status,
			nextState,
			reason: input.reason ?? null,
			evidence: input.evidence ?? {},
			relatedOfferId: offerId,
			relatedProductId: existing.productId,
			relatedTeamId: existing.sellerTeamId,
		});
		return this.getCommerceOffer(offerId);
	}

	async submitCommerceOffer(offerId, input = {}) {
		return this.transitionCommerceOffer(offerId, 'submitted', input);
	}

	async approveCommerceOffer(offerId, input = {}) {
		await this.ensureInitialized();
		const existing = await this.getCommerceOffer(offerId);
		if (!existing) return null;
		const product = await this.getCommerceProduct(existing.productId);
		const vendor = await this.getCommerceVendor(existing.vendorId);
		if (product?.status !== 'approved' || vendor?.status !== 'approved') {
			const error = new Error('Product and vendor must be approved before offer approval.');
			error.status = 409;
			throw error;
		}
		await this.run(`UPDATE commerce_offers SET status = ?, updated_at = ? WHERE id = ?`, ['approved', isoNow(), offerId]);
		if (product.catalogItemId) {
			const catalogItem = await this.getCatalogItem(product.catalogItemId);
			if (catalogItem) {
				await this.upsertCatalogItem(product.sellerTeamId, {
					...catalogItem,
					offerMode: existing.mode,
					metadata: {
						...(catalogItem.metadata ?? {}),
						primaryCommerceOfferId: offerId,
					},
				});
			}
		}
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? 'operator',
			actorId: input.actorId ?? null,
			action: 'offer.approve',
			objectType: 'commerce_offer',
			objectId: offerId,
			priorState: existing.status,
			nextState: 'approved',
			reason: input.reason ?? null,
			evidence: input.evidence ?? {},
			relatedOfferId: offerId,
			relatedProductId: existing.productId,
			relatedTeamId: existing.sellerTeamId,
		});
		return this.getCommerceOffer(offerId);
	}

	async archiveCommerceOffer(offerId, input = {}) {
		return this.transitionCommerceOffer(offerId, 'archived', input);
	}

	async createCommercePrice(offerId, input = {}) {
		await this.ensureInitialized();
		const offer = await this.getCommerceOffer(offerId);
		if (!offer) return null;
		const amount = numberValue(input.amount, 0);
		if (amount < 0) {
			const error = new Error('Price amount must be non-negative.');
			error.status = 400;
			throw error;
		}
		if (COMMERCE_ZERO_PRICE_OFFER_MODES.has(offer.mode) && amount !== 0) {
			const error = new Error('Non-checkout offer modes must use zero display prices in Phase 2.');
			error.status = 400;
			throw error;
		}
		const billingInterval = enumValue(input.billingInterval, COMMERCE_PRICE_INTERVAL_SET, COMMERCE_COMMERCIAL_OFFER_MODES.has(offer.mode) && offer.mode !== 'one_time' && offer.mode !== 'one_time_current_version' ? 'month' : 'one_time');
		if (['one_time', 'one_time_current_version'].includes(offer.mode) && billingInterval !== 'one_time') {
			const error = new Error('One-time offers must use one_time billing interval.');
			error.status = 400;
			throw error;
		}
		if (['subscription', 'subscription_updates', 'professional_hosting', 'scoped_contract'].includes(offer.mode) && billingInterval === 'one_time') {
			const error = new Error('Recurring or scoped offers must use month, year, or custom billing interval.');
			error.status = 400;
			throw error;
		}
		const currency = stringValue(input.currency, 'usd').toLowerCase();
		if (!/^[a-z]{3}$/u.test(currency)) {
			const error = new Error('Currency must be a lowercase 3-letter code.');
			error.status = 400;
			throw error;
		}
		const latest = await this.first(`SELECT MAX(price_version) AS max_version FROM commerce_prices WHERE offer_id = ?`, [offerId]);
		const priceVersion = Number(latest?.max_version ?? 0) + 1;
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO commerce_prices (
				id, offer_id, amount, currency, billing_interval, status, stripe_product_id, stripe_price_id,
				stripe_lookup_key, stripe_sync_status, stripe_synced_at, stripe_sync_error, stripe_metadata_json, price_version,
				tax_behavior, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				offerId,
				amount,
				currency,
				billingInterval,
				enumValue(input.status, COMMERCE_PRICE_STATUS_SET, 'draft'),
				null,
				null,
				null,
				'not_synced',
				null,
				null,
				'{}',
				priceVersion,
				enumValue(input.taxBehavior, COMMERCE_TAX_BEHAVIOR_SET, 'unspecified'),
				JSON.stringify(input.metadata ?? {}),
				timestamp,
				timestamp,
			],
		);
		return serializeCommercePrice(await this.first(`SELECT * FROM commerce_prices WHERE id = ?`, [id]));
	}

	async listCommercePrices(offerId) {
		await this.ensureInitialized();
		const rows = await this.all(`SELECT * FROM commerce_prices WHERE offer_id = ? ORDER BY price_version DESC`, [offerId]);
		return rows.map(serializeCommercePrice);
	}

	async getCommercePrice(priceId) {
		await this.ensureInitialized();
		return serializeCommercePrice(await this.first(`SELECT * FROM commerce_prices WHERE id = ? LIMIT 1`, [priceId]));
	}

	async activateCommercePrice(priceId, input = {}) {
		await this.ensureInitialized();
		const existing = await this.getCommercePrice(priceId);
		if (!existing) return null;
		await this.run(`UPDATE commerce_prices SET status = 'archived', updated_at = ? WHERE offer_id = ? AND status = 'active'`, [isoNow(), existing.offerId]);
		await this.run(`UPDATE commerce_prices SET status = 'active', updated_at = ? WHERE id = ?`, [isoNow(), priceId]);
		await this.run(`UPDATE commerce_offers SET active_price_id = ?, updated_at = ? WHERE id = ?`, [priceId, isoNow(), existing.offerId]);
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? 'operator',
			actorId: input.actorId ?? null,
			action: 'price.activate',
			objectType: 'commerce_price',
			objectId: priceId,
			priorState: existing.status,
			nextState: 'active',
			reason: input.reason ?? null,
			evidence: input.evidence ?? {},
			relatedOfferId: existing.offerId,
		});
		return serializeCommercePrice(await this.first(`SELECT * FROM commerce_prices WHERE id = ?`, [priceId]));
	}

	async updateCommerceOfferStripeProductSync(offerId, input = {}) {
		await this.ensureInitialized();
		const existing = await this.getCommerceOffer(offerId);
		if (!existing) return null;
		const timestamp = isoNow();
		const nextStatus = enumValue(input.stripeProductStatus ?? input.status, COMMERCE_STRIPE_SYNC_STATUS_SET, existing.stripeProductStatus ?? 'not_synced');
		await this.run(
			`UPDATE commerce_offers
			 SET stripe_product_id = ?, stripe_product_status = ?, stripe_product_synced_at = ?, stripe_product_sync_error = ?,
			     stripe_product_metadata_json = ?, updated_at = ?
			 WHERE id = ?`,
			[
				input.stripeProductId === undefined ? existing.stripeProductId : input.stripeProductId,
				nextStatus,
				input.stripeProductSyncedAt === undefined ? (nextStatus === 'synced' ? timestamp : existing.stripeProductSyncedAt) : input.stripeProductSyncedAt,
				input.stripeProductSyncError === undefined ? null : input.stripeProductSyncError,
				JSON.stringify(input.stripeProductMetadata ?? existing.stripeProductMetadata ?? {}),
				timestamp,
				offerId,
			],
		);
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? 'system',
			actorId: input.actorId ?? null,
			action: input.action ?? (nextStatus === 'blocked'
				? 'commerce_offer.stripe_product.sync_blocked'
				: nextStatus === 'drifted'
					? 'commerce_offer.stripe_product.drifted'
					: nextStatus === 'failed'
						? 'commerce_offer.stripe_product.failed'
						: 'commerce_offer.stripe_product.synced'),
			objectType: 'commerce_offer',
			objectId: offerId,
			priorState: existing.stripeProductStatus ?? 'not_synced',
			nextState: nextStatus,
			reason: input.reason ?? null,
			evidence: input.evidence ?? {},
			relatedOfferId: offerId,
			relatedProductId: existing.productId,
			relatedTeamId: existing.sellerTeamId,
		});
		return this.getCommerceOffer(offerId);
	}

	async markCommerceOfferStripeSyncBlocked(offerId, input = {}) {
		return this.updateCommerceOfferStripeProductSync(offerId, {
			...input,
			stripeProductStatus: 'blocked',
			stripeProductSyncError: input.reason ?? input.stripeProductSyncError ?? 'Stripe product sync is blocked.',
			action: 'commerce_offer.stripe_product.sync_blocked',
		});
	}

	async updateCommercePriceStripeSync(priceId, input = {}) {
		await this.ensureInitialized();
		const existing = await this.getCommercePrice(priceId);
		if (!existing) return null;
		const offer = await this.getCommerceOffer(existing.offerId);
		const timestamp = isoNow();
		const nextStatus = enumValue(input.stripeSyncStatus ?? input.status, COMMERCE_STRIPE_SYNC_STATUS_SET, existing.stripeSyncStatus ?? 'not_synced');
		await this.run(
			`UPDATE commerce_prices
			 SET stripe_product_id = ?, stripe_price_id = ?, stripe_lookup_key = ?, stripe_sync_status = ?, stripe_synced_at = ?,
			     stripe_sync_error = ?, stripe_metadata_json = ?, updated_at = ?
			 WHERE id = ?`,
			[
				input.stripeProductId === undefined ? existing.stripeProductId : input.stripeProductId,
				input.stripePriceId === undefined ? existing.stripePriceId : input.stripePriceId,
				input.stripeLookupKey === undefined ? existing.stripeLookupKey : input.stripeLookupKey,
				nextStatus,
				input.stripeSyncedAt === undefined ? (nextStatus === 'synced' ? timestamp : existing.stripeSyncedAt) : input.stripeSyncedAt,
				input.stripeSyncError === undefined ? null : input.stripeSyncError,
				JSON.stringify(input.stripeMetadata ?? existing.stripeMetadata ?? {}),
				timestamp,
				priceId,
			],
		);
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? 'system',
			actorId: input.actorId ?? null,
			action: input.action ?? (nextStatus === 'blocked'
				? 'commerce_price.stripe_price.sync_blocked'
				: nextStatus === 'drifted'
					? 'commerce_price.stripe_price.drifted'
					: nextStatus === 'failed'
						? 'commerce_price.stripe_price.failed'
						: 'commerce_price.stripe_price.synced'),
			objectType: 'commerce_price',
			objectId: priceId,
			priorState: existing.stripeSyncStatus ?? 'not_synced',
			nextState: nextStatus,
			reason: input.reason ?? null,
			evidence: input.evidence ?? {},
			relatedOfferId: existing.offerId,
			relatedProductId: offer?.productId ?? null,
			relatedTeamId: offer?.sellerTeamId ?? null,
		});
		return this.getCommercePrice(priceId);
	}

	async markCommercePriceStripeSyncBlocked(priceId, input = {}) {
		return this.updateCommercePriceStripeSync(priceId, {
			...input,
			stripeSyncStatus: 'blocked',
			stripeSyncError: input.reason ?? input.stripeSyncError ?? 'Stripe price sync is blocked.',
			action: 'commerce_price.stripe_price.sync_blocked',
		});
	}

	async recordCommerceGovernanceEvent(input = {}) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO commerce_governance_events (
				id, actor_type, actor_id, action, object_type, object_id, prior_state, next_state, reason, evidence_json,
				related_order_id, related_offer_id, related_product_id, related_team_id, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				stringValue(input.actorType, 'system'),
				input.actorId ?? null,
				stringValue(input.action, 'commerce.event'),
				stringValue(input.objectType, 'commerce'),
				stringValue(input.objectId, id),
				input.priorState ?? null,
				input.nextState ?? null,
				input.reason ?? null,
				JSON.stringify(input.evidence ?? {}),
				input.relatedOrderId ?? null,
				input.relatedOfferId ?? null,
				input.relatedProductId ?? null,
				input.relatedTeamId ?? null,
				timestamp,
			],
		);
		return serializeCommerceGovernanceEvent(await this.first(`SELECT * FROM commerce_governance_events WHERE id = ?`, [id]));
	}

	async listCommerceGovernanceEvents(filters = {}) {
		await this.ensureInitialized();
		const clauses = [];
		const params = [];
		for (const [key, column] of [
			['objectType', 'object_type'],
			['objectId', 'object_id'],
			['productId', 'related_product_id'],
			['offerId', 'related_offer_id'],
			['teamId', 'related_team_id'],
		]) {
			if (filters[key]) {
				clauses.push(`${column} = ?`);
				params.push(filters[key]);
			}
		}
		const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
		const rows = await this.all(`SELECT * FROM commerce_governance_events ${where} ORDER BY created_at DESC`, params);
		return rows.map(serializeCommerceGovernanceEvent);
	}

	async createCommerceCart(principal = null, input = {}) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		const buyerTeamId = input.buyerTeamId ?? null;
		const buyerUserId = input.buyerUserId ?? principal?.id ?? null;
		await this.run(
			`INSERT INTO commerce_carts (id, buyer_team_id, buyer_user_id, status, currency, metadata_json, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				buyerTeamId,
				buyerUserId,
				enumValue(input.status, COMMERCE_CART_STATUS_SET, 'active'),
				input.currency ?? null,
				JSON.stringify(input.metadata ?? {}),
				timestamp,
				timestamp,
			],
		);
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? 'user',
			actorId: input.actorId ?? principal?.id ?? null,
			action: 'commerce_cart.created',
			objectType: 'commerce_cart',
			objectId: id,
			nextState: 'active',
			relatedTeamId: buyerTeamId,
		});
		return this.getCommerceCart(id);
	}

	async getCommerceCart(cartId) {
		await this.ensureInitialized();
		return serializeCommerceCart(await this.first(`SELECT * FROM commerce_carts WHERE id = ? LIMIT 1`, [cartId]));
	}

	async listCommerceCartItems(cartId) {
		await this.ensureInitialized();
		const rows = await this.all(`SELECT * FROM commerce_cart_items WHERE cart_id = ? ORDER BY created_at ASC`, [cartId]);
		return rows.map(serializeCommerceCartItem);
	}

	async addCommerceCartItem(cartId, input = {}) {
		await this.ensureInitialized();
		const cart = await this.getCommerceCart(cartId);
		if (!cart) {
			const error = new Error(`Unknown commerce cart "${cartId}".`);
			error.status = 404;
			throw error;
		}
		const offer = await this.getCommerceOffer(input.offerId);
		if (!offer) {
			const error = new Error(`Unknown commerce offer "${input.offerId}".`);
			error.status = 404;
			throw error;
		}
		const product = await this.getCommerceProduct(offer.productId);
		const price = input.priceId ? await this.getCommercePrice(input.priceId) : (offer.activePriceId ? await this.getCommercePrice(offer.activePriceId) : null);
		const quantity = Math.max(1, Number(input.quantity ?? 1));
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO commerce_cart_items (
				id, cart_id, vendor_id, seller_team_id, product_id, product_version_id, offer_id, price_id,
				quantity, unit_amount, currency, mode, status, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				cartId,
				offer.vendorId,
				offer.sellerTeamId,
				offer.productId,
				offer.productVersionId ?? product?.currentVersionId ?? null,
				offer.id,
				price?.id ?? null,
				quantity,
				Number(price?.amount ?? 0),
				price?.currency ?? cart.currency ?? 'usd',
				offer.mode,
				'active',
				JSON.stringify(input.metadata ?? {}),
				timestamp,
				timestamp,
			],
		);
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? 'user',
			actorId: input.actorId ?? cart.buyerUserId,
			action: 'commerce_cart.item_added',
			objectType: 'commerce_cart_item',
			objectId: id,
			nextState: 'active',
			relatedOfferId: offer.id,
			relatedProductId: offer.productId,
			relatedTeamId: cart.buyerTeamId,
		});
		return serializeCommerceCartItem(await this.first(`SELECT * FROM commerce_cart_items WHERE id = ?`, [id]));
	}

	async removeCommerceCartItem(cartItemId) {
		await this.ensureInitialized();
		await this.run(`UPDATE commerce_cart_items SET status = 'removed', updated_at = ? WHERE id = ?`, [isoNow(), cartItemId]);
		return serializeCommerceCartItem(await this.first(`SELECT * FROM commerce_cart_items WHERE id = ?`, [cartItemId]));
	}

	async clearCommerceCart(cartId) {
		await this.ensureInitialized();
		await this.run(`UPDATE commerce_cart_items SET status = 'removed', updated_at = ? WHERE cart_id = ? AND status = 'active'`, [isoNow(), cartId]);
		return this.listCommerceCartItems(cartId);
	}

	async markCommerceCartConverted(cartId, checkoutId) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		await this.run(`UPDATE commerce_carts SET status = 'converted', updated_at = ? WHERE id = ?`, [timestamp, cartId]);
		await this.run(`UPDATE commerce_cart_items SET status = 'converted', updated_at = ? WHERE cart_id = ? AND status = 'active'`, [timestamp, cartId]);
		return this.getCommerceCart(cartId);
	}

	async createCommerceCheckout(input = {}) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO commerce_checkouts (
				id, cart_id, buyer_team_id, buyer_user_id, status, checkout_mode, group_count, completed_group_count,
				metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				input.cartId,
				input.buyerTeamId ?? null,
				input.buyerUserId ?? null,
				enumValue(input.status, COMMERCE_CHECKOUT_STATUS_SET, 'draft'),
				'stripe_elements_grouped_vendor',
				Number(input.groupCount ?? 0),
				Number(input.completedGroupCount ?? 0),
				JSON.stringify(input.metadata ?? {}),
				timestamp,
				timestamp,
			],
		);
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? 'user',
			actorId: input.actorId ?? input.buyerUserId ?? null,
			action: 'commerce_checkout.created',
			objectType: 'commerce_checkout',
			objectId: id,
			nextState: 'draft',
			relatedTeamId: input.buyerTeamId ?? null,
		});
		return this.getCommerceCheckout(id);
	}

	async getCommerceCheckout(checkoutId) {
		await this.ensureInitialized();
		return serializeCommerceCheckout(await this.first(`SELECT * FROM commerce_checkouts WHERE id = ? LIMIT 1`, [checkoutId]));
	}

	async listCommerceCheckoutOrders(checkoutId) {
		await this.ensureInitialized();
		const rows = await this.all(`SELECT * FROM commerce_orders WHERE checkout_id = ? ORDER BY created_at ASC`, [checkoutId]);
		return rows.map(serializeCommerceOrder);
	}

	async updateCommerceCheckoutStatus(checkoutId, input = {}) {
		await this.ensureInitialized();
		const existing = await this.getCommerceCheckout(checkoutId);
		if (!existing) return null;
		const status = enumValue(input.status, COMMERCE_CHECKOUT_STATUS_SET, existing.status);
		const completedGroupCount = input.completedGroupCount === undefined ? existing.completedGroupCount : Number(input.completedGroupCount);
		await this.run(
			`UPDATE commerce_checkouts SET status = ?, completed_group_count = ?, metadata_json = ?, updated_at = ? WHERE id = ?`,
			[
				status,
				completedGroupCount,
				JSON.stringify(input.metadata ?? existing.metadata ?? {}),
				isoNow(),
				checkoutId,
			],
		);
		return this.getCommerceCheckout(checkoutId);
	}

	async createCommerceOrder(input = {}) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO commerce_orders (
				id, checkout_id, cart_id, buyer_team_id, buyer_user_id, vendor_id, seller_team_id, status, currency,
				subtotal_amount, total_amount, refunded_amount, refund_status, stripe_checkout_session_id, stripe_payment_intent_id, stripe_subscription_id,
				stripe_customer_id, stripe_connected_account_id, ownership_snapshot_json, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				input.checkoutId ?? null,
				input.cartId ?? null,
				input.buyerTeamId ?? null,
				input.buyerUserId ?? null,
				input.vendorId ?? null,
				input.sellerTeamId ?? null,
				enumValue(input.status, COMMERCE_ORDER_STATUS_SET, 'draft'),
				stringValue(input.currency, 'usd'),
				Number(input.subtotalAmount ?? 0),
				Number(input.totalAmount ?? 0),
				Number(input.refundedAmount ?? 0),
				input.refundStatus ?? 'none',
				null,
				input.stripePaymentIntentId ?? null,
				input.stripeSubscriptionId ?? null,
				input.stripeCustomerId ?? null,
				input.stripeConnectedAccountId ?? null,
				JSON.stringify(input.ownershipSnapshot ?? {}),
				JSON.stringify(input.metadata ?? {}),
				timestamp,
				timestamp,
			],
		);
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? 'system',
			actorId: input.actorId ?? null,
			action: 'commerce_order.created',
			objectType: 'commerce_order',
			objectId: id,
			nextState: input.status ?? 'draft',
			relatedOrderId: id,
			relatedTeamId: input.buyerTeamId ?? input.sellerTeamId ?? null,
		});
		return this.getCommerceOrder(id);
	}

	async getCommerceOrder(orderId) {
		await this.ensureInitialized();
		return serializeCommerceOrder(await this.first(`SELECT * FROM commerce_orders WHERE id = ? LIMIT 1`, [orderId]));
	}

	async listCommerceOrders(principal = null, filters = {}) {
		await this.ensureInitialized();
		const clauses = [];
		const params = [];
		for (const [key, column] of [
			['buyerTeamId', 'buyer_team_id'],
			['vendorId', 'vendor_id'],
			['status', 'status'],
			['checkoutId', 'checkout_id'],
		]) {
			if (filters[key]) {
				clauses.push(`${column} = ?`);
				params.push(filters[key]);
			}
		}
		if (filters.buyerUserId) {
			clauses.push(`buyer_user_id = ?`);
			params.push(filters.buyerUserId);
		}
		const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
		const rows = await this.all(`SELECT * FROM commerce_orders ${where} ORDER BY updated_at DESC, created_at DESC`, params);
		return rows.map(serializeCommerceOrder);
	}

	async updateCommerceOrderStatus(orderId, input = {}) {
		await this.ensureInitialized();
		const existing = await this.getCommerceOrder(orderId);
		if (!existing) return null;
		const status = enumValue(input.status, COMMERCE_ORDER_STATUS_SET, existing.status);
		await this.run(
			`UPDATE commerce_orders
			 SET status = ?, refunded_amount = ?, refund_status = ?, stripe_payment_intent_id = ?, stripe_subscription_id = ?, stripe_customer_id = ?,
			     stripe_connected_account_id = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`,
			[
				status,
				input.refundedAmount === undefined ? existing.refundedAmount : Number(input.refundedAmount),
				input.refundStatus === undefined ? existing.refundStatus : input.refundStatus,
				input.stripePaymentIntentId === undefined ? existing.stripePaymentIntentId : input.stripePaymentIntentId,
				input.stripeSubscriptionId === undefined ? existing.stripeSubscriptionId : input.stripeSubscriptionId,
				input.stripeCustomerId === undefined ? existing.stripeCustomerId : input.stripeCustomerId,
				input.stripeConnectedAccountId === undefined ? existing.stripeConnectedAccountId : input.stripeConnectedAccountId,
				JSON.stringify(input.metadata ?? existing.metadata ?? {}),
				isoNow(),
				orderId,
			],
		);
		return this.getCommerceOrder(orderId);
	}

	async createCommerceOrderItem(orderId, input = {}) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO commerce_order_items (
				id, order_id, vendor_id, seller_team_id, product_id, product_version_id, offer_id, price_id, mode,
				quantity, unit_amount, total_amount, refunded_amount, refund_status, currency, status, entitlement_id, ownership_snapshot_json,
				access_scope_json, support_scope_json, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				orderId,
				input.vendorId,
				input.sellerTeamId,
				input.productId,
				input.productVersionId ?? null,
				input.offerId,
				input.priceId,
				input.mode,
				Number(input.quantity ?? 1),
				Number(input.unitAmount ?? 0),
				Number(input.totalAmount ?? 0),
				Number(input.refundedAmount ?? 0),
				input.refundStatus ?? 'none',
				stringValue(input.currency, 'usd'),
				enumValue(input.status, COMMERCE_ORDER_ITEM_STATUS_SET, 'pending'),
				input.entitlementId ?? null,
				JSON.stringify(input.ownershipSnapshot ?? {}),
				JSON.stringify(input.accessScope ?? {}),
				JSON.stringify(input.supportScope ?? {}),
				JSON.stringify(input.metadata ?? {}),
				timestamp,
				timestamp,
			],
		);
		return serializeCommerceOrderItem(await this.first(`SELECT * FROM commerce_order_items WHERE id = ?`, [id]));
	}

	async listCommerceOrderItems(orderId) {
		await this.ensureInitialized();
		const rows = await this.all(`SELECT * FROM commerce_order_items WHERE order_id = ? ORDER BY created_at ASC`, [orderId]);
		return rows.map(serializeCommerceOrderItem);
	}

	async updateCommerceOrderItemStatus(orderItemId, input = {}) {
		await this.ensureInitialized();
		const existing = serializeCommerceOrderItem(await this.first(`SELECT * FROM commerce_order_items WHERE id = ? LIMIT 1`, [orderItemId]));
		if (!existing) return null;
		await this.run(
			`UPDATE commerce_order_items SET status = ?, refunded_amount = ?, refund_status = ?, entitlement_id = ?, metadata_json = ?, updated_at = ? WHERE id = ?`,
			[
				enumValue(input.status, COMMERCE_ORDER_ITEM_STATUS_SET, existing.status),
				input.refundedAmount === undefined ? existing.refundedAmount : Number(input.refundedAmount),
				input.refundStatus === undefined ? existing.refundStatus : input.refundStatus,
				input.entitlementId === undefined ? existing.entitlementId : input.entitlementId,
				JSON.stringify(input.metadata ?? existing.metadata ?? {}),
				isoNow(),
				orderItemId,
			],
		);
		return serializeCommerceOrderItem(await this.first(`SELECT * FROM commerce_order_items WHERE id = ?`, [orderItemId]));
	}

	async createCommercePaymentGroup(input = {}) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		const clientSecret = input.clientSecret ?? null;
		await this.run(
			`INSERT INTO commerce_payment_groups (
				id, checkout_id, order_id, vendor_id, seller_team_id, connected_account_id, group_kind, billing_interval, status,
				currency, subtotal_amount, total_amount, stripe_payment_intent_id, stripe_subscription_id, stripe_customer_id,
				client_secret_last4, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				input.checkoutId,
				input.orderId,
				input.vendorId,
				input.sellerTeamId,
				input.connectedAccountId ?? null,
				input.groupKind,
				input.billingInterval ?? null,
				enumValue(input.status, COMMERCE_PAYMENT_GROUP_STATUS_SET, 'pending'),
				stringValue(input.currency, 'usd'),
				Number(input.subtotalAmount ?? 0),
				Number(input.totalAmount ?? 0),
				input.stripePaymentIntentId ?? null,
				input.stripeSubscriptionId ?? null,
				input.stripeCustomerId ?? null,
				clientSecret ? clientSecret.slice(-4) : null,
				JSON.stringify(input.metadata ?? {}),
				timestamp,
				timestamp,
			],
		);
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? 'system',
			actorId: input.actorId ?? null,
			action: 'commerce_payment_group.created',
			objectType: 'commerce_payment_group',
			objectId: id,
			nextState: input.status ?? 'pending',
			evidence: {
				connectedAccountId: input.connectedAccountId ?? null,
				stripePaymentIntentId: input.stripePaymentIntentId ?? null,
				stripeSubscriptionId: input.stripeSubscriptionId ?? null,
			},
			relatedOrderId: input.orderId,
			relatedTeamId: input.sellerTeamId,
		});
		return serializeCommercePaymentGroup(await this.first(`SELECT * FROM commerce_payment_groups WHERE id = ?`, [id]), clientSecret);
	}

	async getCommercePaymentGroup(groupId) {
		await this.ensureInitialized();
		return serializeCommercePaymentGroup(await this.first(`SELECT * FROM commerce_payment_groups WHERE id = ? LIMIT 1`, [groupId]));
	}

	async getCommercePaymentGroupByStripePaymentIntent(paymentIntentId, connectedAccountId = null) {
		await this.ensureInitialized();
		const clauses = ['stripe_payment_intent_id = ?'];
		const params = [paymentIntentId];
		if (connectedAccountId) {
			clauses.push('connected_account_id = ?');
			params.push(connectedAccountId);
		}
		return serializeCommercePaymentGroup(await this.first(`SELECT * FROM commerce_payment_groups WHERE ${clauses.join(' AND ')} LIMIT 1`, params));
	}

	async getCommercePaymentGroupByStripeSubscription(subscriptionId, connectedAccountId = null) {
		await this.ensureInitialized();
		const clauses = ['stripe_subscription_id = ?'];
		const params = [subscriptionId];
		if (connectedAccountId) {
			clauses.push('connected_account_id = ?');
			params.push(connectedAccountId);
		}
		return serializeCommercePaymentGroup(await this.first(`SELECT * FROM commerce_payment_groups WHERE ${clauses.join(' AND ')} LIMIT 1`, params));
	}

	async updateCommercePaymentGroup(groupId, input = {}) {
		await this.ensureInitialized();
		const existing = await this.getCommercePaymentGroup(groupId);
		if (!existing) return null;
		const status = enumValue(input.status, COMMERCE_PAYMENT_GROUP_STATUS_SET, existing.status);
		const clientSecret = input.clientSecret ?? null;
		await this.run(
			`UPDATE commerce_payment_groups
			 SET status = ?, stripe_payment_intent_id = ?, stripe_subscription_id = ?, stripe_customer_id = ?,
			     client_secret_last4 = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`,
			[
				status,
				input.stripePaymentIntentId === undefined ? existing.stripePaymentIntentId : input.stripePaymentIntentId,
				input.stripeSubscriptionId === undefined ? existing.stripeSubscriptionId : input.stripeSubscriptionId,
				input.stripeCustomerId === undefined ? existing.stripeCustomerId : input.stripeCustomerId,
				clientSecret ? clientSecret.slice(-4) : existing.clientSecretLast4,
				JSON.stringify(input.metadata ?? existing.metadata ?? {}),
				isoNow(),
				groupId,
			],
		);
		return serializeCommercePaymentGroup(await this.first(`SELECT * FROM commerce_payment_groups WHERE id = ?`, [groupId]), clientSecret);
	}

	async createCommerceSubscription(input = {}) {
		await this.ensureInitialized();
		const existing = await this.getCommerceSubscriptionByStripeId(input.stripeSubscriptionId, input.stripeConnectedAccountId);
		if (existing) return existing;
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO commerce_subscriptions (
				id, order_id, vendor_id, seller_team_id, buyer_team_id, buyer_user_id, offer_id, price_id, status, renewal_state,
				stripe_subscription_id, stripe_customer_id, stripe_connected_account_id, current_period_start, current_period_end,
				cancel_at_period_end, canceled_at, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				input.orderId,
				input.vendorId,
				input.sellerTeamId,
				input.buyerTeamId ?? null,
				input.buyerUserId ?? null,
				input.offerId,
				input.priceId,
				enumValue(input.status, COMMERCE_SUBSCRIPTION_STATUS_SET, 'incomplete'),
				input.renewalState ?? 'active',
				input.stripeSubscriptionId,
				input.stripeCustomerId ?? null,
				input.stripeConnectedAccountId,
				input.currentPeriodStart ?? null,
				input.currentPeriodEnd ?? null,
				input.cancelAtPeriodEnd === true ? 1 : 0,
				input.canceledAt ?? null,
				JSON.stringify(input.metadata ?? {}),
				timestamp,
				timestamp,
			],
		);
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? 'system',
			actorId: input.actorId ?? null,
			action: 'commerce_subscription.created',
			objectType: 'commerce_subscription',
			objectId: id,
			nextState: input.status ?? 'incomplete',
			relatedOrderId: input.orderId,
			relatedOfferId: input.offerId,
			relatedTeamId: input.sellerTeamId,
		});
		return this.getCommerceSubscription(id);
	}

	async getCommerceSubscription(subscriptionId) {
		await this.ensureInitialized();
		return serializeCommerceSubscription(await this.first(`SELECT * FROM commerce_subscriptions WHERE id = ? LIMIT 1`, [subscriptionId]));
	}

	async getCommerceSubscriptionByStripeId(stripeSubscriptionId, connectedAccountId = null) {
		await this.ensureInitialized();
		const clauses = ['stripe_subscription_id = ?'];
		const params = [stripeSubscriptionId];
		if (connectedAccountId) {
			clauses.push('stripe_connected_account_id = ?');
			params.push(connectedAccountId);
		}
		return serializeCommerceSubscription(await this.first(`SELECT * FROM commerce_subscriptions WHERE ${clauses.join(' AND ')} LIMIT 1`, params));
	}

	async updateCommerceSubscriptionFromStripe(subscriptionId, input = {}) {
		await this.ensureInitialized();
		const existing = await this.getCommerceSubscription(subscriptionId);
		if (!existing) return null;
		await this.run(
			`UPDATE commerce_subscriptions
			 SET status = ?, renewal_state = ?, current_period_start = ?, current_period_end = ?,
			     cancel_at_period_end = ?, canceled_at = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`,
			[
				enumValue(input.status, COMMERCE_SUBSCRIPTION_STATUS_SET, existing.status),
				input.renewalState ?? existing.renewalState,
				input.currentPeriodStart === undefined ? existing.currentPeriodStart : input.currentPeriodStart,
				input.currentPeriodEnd === undefined ? existing.currentPeriodEnd : input.currentPeriodEnd,
				input.cancelAtPeriodEnd === undefined ? (existing.cancelAtPeriodEnd ? 1 : 0) : (input.cancelAtPeriodEnd === true ? 1 : 0),
				input.canceledAt === undefined ? existing.canceledAt : input.canceledAt,
				JSON.stringify(input.metadata ?? existing.metadata ?? {}),
				isoNow(),
				subscriptionId,
			],
		);
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? 'system',
			actorId: input.actorId ?? null,
			action: 'commerce_subscription.updated',
			objectType: 'commerce_subscription',
			objectId: subscriptionId,
			priorState: existing.status,
			nextState: input.status ?? existing.status,
			relatedOrderId: existing.orderId,
			relatedOfferId: existing.offerId,
			relatedTeamId: existing.sellerTeamId,
		});
		return this.getCommerceSubscription(subscriptionId);
	}

	async createCommerceEntitlement(input = {}) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO commerce_entitlements (
				id, buyer_team_id, buyer_user_id, seller_team_id, product_id, product_version_id, offer_id, order_id,
				order_item_id, subscription_id, status, access_scope_json, starts_at, ends_at, renewal_state,
				fulfillment_artifact_refs_json, project_id, catalog_item_id, ownership_snapshot_json, metadata_json,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				input.buyerTeamId ?? null,
				input.buyerUserId ?? null,
				input.sellerTeamId,
				input.productId,
				input.productVersionId ?? null,
				input.offerId,
				input.orderId ?? null,
				input.orderItemId ?? null,
				input.subscriptionId ?? null,
				enumValue(input.status, COMMERCE_ENTITLEMENT_STATUS_SET, 'pending'),
				JSON.stringify(input.accessScope ?? {}),
				input.startsAt ?? timestamp,
				input.endsAt ?? null,
				input.renewalState ?? 'none',
				JSON.stringify(input.fulfillmentArtifactRefs ?? []),
				input.projectId ?? null,
				input.catalogItemId ?? null,
				JSON.stringify(input.ownershipSnapshot ?? {}),
				JSON.stringify(input.metadata ?? {}),
				timestamp,
				timestamp,
			],
		);
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? 'system',
			actorId: input.actorId ?? null,
			action: 'commerce_entitlement.created',
			objectType: 'commerce_entitlement',
			objectId: id,
			nextState: input.status ?? 'pending',
			relatedOrderId: input.orderId ?? null,
			relatedOfferId: input.offerId,
			relatedProductId: input.productId,
			relatedTeamId: input.buyerTeamId ?? input.sellerTeamId,
		});
		return this.getCommerceEntitlement(id);
	}

	async getCommerceEntitlement(entitlementId) {
		await this.ensureInitialized();
		return serializeCommerceEntitlement(await this.first(`SELECT * FROM commerce_entitlements WHERE id = ? LIMIT 1`, [entitlementId]));
	}

	async listCommerceEntitlements(principal = null, filters = {}) {
		await this.ensureInitialized();
		const clauses = [];
		const params = [];
		for (const [key, column] of [
			['buyerTeamId', 'buyer_team_id'],
			['buyerUserId', 'buyer_user_id'],
			['productId', 'product_id'],
			['offerId', 'offer_id'],
			['sellerTeamId', 'seller_team_id'],
			['status', 'status'],
			['orderId', 'order_id'],
		]) {
			if (filters[key]) {
				clauses.push(`${column} = ?`);
				params.push(filters[key]);
			}
		}
		const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
		const rows = await this.all(`SELECT * FROM commerce_entitlements ${where} ORDER BY updated_at DESC, created_at DESC`, params);
		return rows.map(serializeCommerceEntitlement);
	}

	async updateCommerceEntitlementStatus(entitlementId, input = {}) {
		await this.ensureInitialized();
		const existing = await this.getCommerceEntitlement(entitlementId);
		if (!existing) return null;
		const status = enumValue(input.status, COMMERCE_ENTITLEMENT_STATUS_SET, existing.status);
		await this.run(
			`UPDATE commerce_entitlements
			 SET status = ?, starts_at = ?, ends_at = ?, renewal_state = ?, fulfillment_artifact_refs_json = ?,
			     metadata_json = ?, updated_at = ?
			 WHERE id = ?`,
			[
				status,
				input.startsAt === undefined ? existing.startsAt : input.startsAt,
				input.endsAt === undefined ? existing.endsAt : input.endsAt,
				input.renewalState ?? existing.renewalState,
				JSON.stringify(input.fulfillmentArtifactRefs ?? existing.fulfillmentArtifactRefs ?? []),
				JSON.stringify(input.metadata ?? existing.metadata ?? {}),
				isoNow(),
				entitlementId,
			],
		);
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? 'system',
			actorId: input.actorId ?? null,
			action: input.action ?? `commerce_entitlement.${status}`,
			objectType: 'commerce_entitlement',
			objectId: entitlementId,
			priorState: existing.status,
			nextState: status,
			relatedOrderId: existing.orderId,
			relatedOfferId: existing.offerId,
			relatedProductId: existing.productId,
			relatedTeamId: existing.buyerTeamId ?? existing.sellerTeamId,
		});
		return this.getCommerceEntitlement(entitlementId);
	}

	async activateCommerceEntitlement(entitlementId, input = {}) {
		return this.updateCommerceEntitlementStatus(entitlementId, { ...input, status: 'active', action: 'commerce_entitlement.activated' });
	}

	async suspendCommerceEntitlement(entitlementId, input = {}) {
		return this.updateCommerceEntitlementStatus(entitlementId, { ...input, status: 'past_due', action: 'commerce_entitlement.suspended' });
	}

	async revokeCommerceEntitlement(entitlementId, input = {}) {
		return this.updateCommerceEntitlementStatus(entitlementId, { ...input, status: 'revoked', action: 'commerce_entitlement.revoked' });
	}

	async upsertCommerceEntitlementForOrderItem(orderItemId, input = {}) {
		await this.ensureInitialized();
		const existing = serializeCommerceEntitlement(await this.first(`SELECT * FROM commerce_entitlements WHERE order_item_id = ? LIMIT 1`, [orderItemId]));
		if (existing) {
			return this.updateCommerceEntitlementStatus(existing.id, {
				...input,
				status: input.status ?? existing.status,
				action: input.status === 'active' ? 'commerce_entitlement.activated' : undefined,
			});
		}
		const entitlement = await this.createCommerceEntitlement({ ...input, orderItemId });
		await this.run(`UPDATE commerce_order_items SET entitlement_id = ?, updated_at = ? WHERE id = ?`, [entitlement.id, isoNow(), orderItemId]);
		return entitlement;
	}

	async updateEntitlementsForSubscription(subscriptionId, input = {}) {
		await this.ensureInitialized();
		const rows = await this.all(`SELECT * FROM commerce_entitlements WHERE subscription_id = ?`, [subscriptionId]);
		const updated = [];
		for (const row of rows) {
			const entitlement = serializeCommerceEntitlement(row);
			updated.push(await this.updateCommerceEntitlementStatus(entitlement.id, input));
		}
		return updated;
	}

	async createCommerceRefund(input = {}) {
		await this.ensureInitialized();
		if (input.idempotencyKey) {
			const existing = await this.getCommerceRefundByIdempotencyKey(input.idempotencyKey);
			if (existing) return existing;
		}
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO commerce_refunds (
				id, order_id, order_item_id, payment_group_id, vendor_id, seller_team_id, buyer_team_id, buyer_user_id,
				amount, currency, status, reason, stripe_refund_id, stripe_payment_intent_id, stripe_connected_account_id,
				idempotency_key, requested_by_type, requested_by_id, failure_reason, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				input.orderId,
				input.orderItemId ?? null,
				input.paymentGroupId ?? null,
				input.vendorId,
				input.sellerTeamId,
				input.buyerTeamId ?? null,
				input.buyerUserId ?? null,
				Number(input.amount ?? 0),
				stringValue(input.currency, 'usd'),
				enumValue(input.status, COMMERCE_REFUND_STATUS_SET, 'processing'),
				input.reason ?? null,
				input.stripeRefundId ?? null,
				input.stripePaymentIntentId ?? null,
				input.stripeConnectedAccountId ?? null,
				input.idempotencyKey ?? randomUUID(),
				input.requestedByType ?? 'user',
				input.requestedById ?? 'system',
				input.failureReason ?? null,
				JSON.stringify(input.metadata ?? {}),
				timestamp,
				timestamp,
			],
		);
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? 'user',
			actorId: input.actorId ?? null,
			action: 'commerce_refund.created',
			objectType: 'commerce_refund',
			objectId: id,
			nextState: input.status ?? 'processing',
			evidence: {
				amount: Number(input.amount ?? 0),
				currency: stringValue(input.currency, 'usd'),
				stripePaymentIntentId: input.stripePaymentIntentId ?? null,
				stripeConnectedAccountId: input.stripeConnectedAccountId ?? null,
			},
			relatedOrderId: input.orderId,
			relatedTeamId: input.sellerTeamId,
		});
		return this.getCommerceRefund(id);
	}

	async getCommerceRefund(refundId) {
		await this.ensureInitialized();
		return serializeCommerceRefund(await this.first(`SELECT * FROM commerce_refunds WHERE id = ? LIMIT 1`, [refundId]));
	}

	async getCommerceRefundByStripeId(stripeRefundId, connectedAccountId = null) {
		await this.ensureInitialized();
		const clauses = ['stripe_refund_id = ?'];
		const params = [stripeRefundId];
		if (connectedAccountId) {
			clauses.push('stripe_connected_account_id = ?');
			params.push(connectedAccountId);
		}
		return serializeCommerceRefund(await this.first(`SELECT * FROM commerce_refunds WHERE ${clauses.join(' AND ')} LIMIT 1`, params));
	}

	async getCommerceRefundByIdempotencyKey(idempotencyKey) {
		await this.ensureInitialized();
		if (!idempotencyKey) return null;
		return serializeCommerceRefund(await this.first(`SELECT * FROM commerce_refunds WHERE idempotency_key = ? LIMIT 1`, [idempotencyKey]));
	}

	async listCommerceRefunds(principal = null, filters = {}) {
		await this.ensureInitialized();
		const clauses = [];
		const params = [];
		for (const [key, column] of [
			['orderId', 'order_id'],
			['vendorId', 'vendor_id'],
			['sellerTeamId', 'seller_team_id'],
			['buyerTeamId', 'buyer_team_id'],
			['buyerUserId', 'buyer_user_id'],
			['status', 'status'],
		]) {
			if (filters[key]) {
				clauses.push(`${column} = ?`);
				params.push(filters[key]);
			}
		}
		const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
		const rows = await this.all(`SELECT * FROM commerce_refunds ${where} ORDER BY created_at DESC`, params);
		return rows.map(serializeCommerceRefund);
	}

	async updateCommerceRefundFromStripe(refundId, input = {}) {
		await this.ensureInitialized();
		const existing = await this.getCommerceRefund(refundId);
		if (!existing) return null;
		const status = enumValue(input.status, COMMERCE_REFUND_STATUS_SET, existing.status);
		await this.run(
			`UPDATE commerce_refunds
			 SET status = ?, stripe_refund_id = ?, failure_reason = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`,
			[
				status,
				input.stripeRefundId === undefined ? existing.stripeRefundId : input.stripeRefundId,
				input.failureReason === undefined ? existing.failureReason : input.failureReason,
				JSON.stringify(input.metadata ?? existing.metadata ?? {}),
				isoNow(),
				refundId,
			],
		);
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? 'system',
			actorId: input.actorId ?? null,
			action: status === 'failed' ? 'commerce_refund.failed' : 'commerce_refund.succeeded',
			objectType: 'commerce_refund',
			objectId: refundId,
			priorState: existing.status,
			nextState: status,
			evidence: {
				stripeRefundId: input.stripeRefundId ?? existing.stripeRefundId,
				failureReason: input.failureReason ?? null,
			},
			relatedOrderId: existing.orderId,
			relatedTeamId: existing.sellerTeamId,
		});
		return this.getCommerceRefund(refundId);
	}

	async markCommerceOrderRefundState(orderId, input = {}) {
		return this.updateCommerceOrderStatus(orderId, {
			status: input.status,
			refundedAmount: input.refundedAmount,
			refundStatus: input.refundStatus,
			metadata: input.metadata,
		});
	}

	async markCommerceOrderItemRefundState(orderItemId, input = {}) {
		return this.updateCommerceOrderItemStatus(orderItemId, {
			status: input.status,
			refundedAmount: input.refundedAmount,
			refundStatus: input.refundStatus,
			metadata: input.metadata,
		});
	}

	async createCommerceFulfillmentEvent(input = {}) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO commerce_fulfillment_events (
				id, order_id, order_item_id, entitlement_id, vendor_id, seller_team_id, product_id, product_version_id,
				catalog_item_id, catalog_artifact_version_id, event_type, status, artifact_refs_json, delivery_refs_json,
				message, actor_type, actor_id, metadata_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				input.orderId,
				input.orderItemId ?? null,
				input.entitlementId ?? null,
				input.vendorId,
				input.sellerTeamId,
				input.productId,
				input.productVersionId ?? null,
				input.catalogItemId ?? null,
				input.catalogArtifactVersionId ?? null,
				enumValue(input.eventType, COMMERCE_FULFILLMENT_EVENT_TYPE_SET, 'manual_status'),
				enumValue(input.status, COMMERCE_FULFILLMENT_STATUS_SET, 'pending'),
				JSON.stringify(input.artifactRefs ?? []),
				JSON.stringify(input.deliveryRefs ?? []),
				input.message ?? null,
				input.actorType ?? 'user',
				input.actorId ?? 'system',
				JSON.stringify(input.metadata ?? {}),
				timestamp,
			],
		);
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? 'user',
			actorId: input.actorId ?? null,
			action: input.eventType === 'artifact_delivered' ? 'commerce_fulfillment.artifact_delivered' : 'commerce_fulfillment.artifact_released',
			objectType: 'commerce_fulfillment_event',
			objectId: id,
			nextState: input.status ?? 'pending',
			relatedOrderId: input.orderId,
			relatedProductId: input.productId,
			relatedTeamId: input.sellerTeamId,
		});
		return serializeCommerceFulfillmentEvent(await this.first(`SELECT * FROM commerce_fulfillment_events WHERE id = ?`, [id]));
	}

	async listCommerceFulfillmentEvents(filters = {}) {
		await this.ensureInitialized();
		const clauses = [];
		const params = [];
		for (const [key, column] of [
			['orderId', 'order_id'],
			['orderItemId', 'order_item_id'],
			['entitlementId', 'entitlement_id'],
			['vendorId', 'vendor_id'],
			['sellerTeamId', 'seller_team_id'],
			['productId', 'product_id'],
			['status', 'status'],
		]) {
			if (filters[key]) {
				clauses.push(`${column} = ?`);
				params.push(filters[key]);
			}
		}
		const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
		const rows = await this.all(`SELECT * FROM commerce_fulfillment_events ${where} ORDER BY created_at DESC`, params);
		return rows.map(serializeCommerceFulfillmentEvent);
	}

	async markCommerceOrderItemFulfilled(orderItemId, input = {}) {
		return this.updateCommerceOrderItemStatus(orderItemId, {
			status: 'fulfilled',
			metadata: input.metadata,
		});
	}

	async updateCommerceEntitlementFulfillment(entitlementId, input = {}) {
		const existing = await this.getCommerceEntitlement(entitlementId);
		if (!existing) return null;
		return this.updateCommerceEntitlementStatus(entitlementId, {
			status: input.status ?? existing.status,
			fulfillmentArtifactRefs: input.fulfillmentArtifactRefs ?? existing.fulfillmentArtifactRefs ?? [],
			metadata: input.metadata ?? existing.metadata ?? {},
			action: 'commerce_entitlement.fulfilled',
		});
	}

	async buildCommerceOwnershipSnapshot(productId) {
		const product = await this.getCommerceProduct(productId);
		if (!product) return {};
		const records = await this.listCommerceOwnershipRecords(productId).catch(() => []);
		const stewards = await this.listCommerceStewardshipAssignments(productId).catch(() => []);
		const ownership = records.find((record) => record.id === product.ownershipRecordId) ?? records[0] ?? null;
		return {
			capturedAt: isoNow(),
			productId,
			ownershipModel: product.ownershipModel,
			ownershipRecord: ownership,
			stewards: stewards.filter((assignment) => assignment.visibleToBuyers !== false),
			sellerTeamId: product.sellerTeamId,
			vendorId: product.vendorId,
		};
	}

	async recordCommerceServiceEvent(input = {}) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		const eventType = enumValue(input.eventType, COMMERCE_SERVICE_EVENT_TYPE_SET, 'manual_update');
		await this.run(
			`INSERT INTO commerce_service_events (
				id, request_id, quote_id, contract_id, event_type, actor_type, actor_id,
				prior_state, next_state, message, evidence_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				input.requestId,
				input.quoteId ?? null,
				input.contractId ?? null,
				eventType,
				input.actorType ?? 'system',
				input.actorId ?? null,
				input.priorState ?? null,
				input.nextState ?? null,
				input.message ?? null,
				JSON.stringify(input.evidence ?? {}),
				timestamp,
			],
		);
		return serializeCommerceServiceEvent(await this.first(`SELECT * FROM commerce_service_events WHERE id = ? LIMIT 1`, [id]));
	}

	async recordCommerceServiceGovernance(input = {}) {
		await this.recordCommerceServiceEvent(input);
		await this.recordCommerceGovernanceEvent({
			actorType: input.actorType ?? 'system',
			actorId: input.actorId ?? null,
			action: input.action ?? `commerce_service.${input.eventType ?? 'manual_update'}`,
			objectType: input.objectType ?? 'commerce_service_request',
			objectId: input.objectId ?? input.requestId,
			priorState: input.priorState ?? null,
			nextState: input.nextState ?? null,
			reason: input.message ?? input.reason ?? null,
			evidence: input.evidence ?? {},
			relatedOrderId: input.relatedOrderId ?? null,
			relatedOfferId: input.relatedOfferId ?? null,
			relatedProductId: input.relatedProductId ?? null,
			relatedTeamId: input.relatedTeamId ?? null,
		});
	}

	async createCommerceServiceRequest(principal, input = {}) {
		await this.ensureInitialized();
		const offer = await this.getCommerceOffer(input.offerId);
		if (!offer || offer.status !== 'approved') {
			const error = new Error('Service request requires an approved contact or scoped contract offer.');
			error.status = offer ? 409 : 404;
			throw error;
		}
		if (!['contact', 'scoped_contract'].includes(offer.mode)) {
			const error = new Error('Service request requires a contact or scoped contract offer.');
			error.status = 409;
			throw error;
		}
		const product = await this.getCommerceProduct(offer.productId);
		if (!product || product.status !== 'approved' || product.kind !== 'scoped_service') {
			const error = new Error('Service request requires an approved scoped service product.');
			error.status = product ? 409 : 404;
			throw error;
		}
		const vendor = await this.getCommerceVendor(offer.vendorId);
		if (!vendor || vendor.status !== 'approved' || vendor.serviceSalesEnabled !== true) {
			const error = new Error('Service request requires an approved service-enabled vendor.');
			error.status = 409;
			throw error;
		}
		const requestedScope = stringValue(input.requestedScope, '');
		if (!requestedScope) {
			const error = new Error('requestedScope is required.');
			error.status = 400;
			throw error;
		}
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		const ownershipSnapshot = await this.buildCommerceOwnershipSnapshot(product.id);
		await this.run(
			`INSERT INTO commerce_service_requests (
				id, buyer_team_id, buyer_user_id, vendor_id, seller_team_id, product_id, offer_id, status,
				requested_scope, approved_scope, access_needs_json, buyer_visible_summary, vendor_private_notes,
				active_quote_id, approved_quote_id, contract_id, related_project_id, related_workday_id,
				order_id, entitlement_id, ownership_snapshot_json, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				input.buyerTeamId ?? null,
				principal?.id ?? input.buyerUserId ?? null,
				vendor.id,
				product.sellerTeamId,
				product.id,
				offer.id,
				'requested',
				requestedScope,
				null,
				JSON.stringify(objectValue(input.accessNeeds, {})),
				input.buyerVisibleSummary ?? null,
				null,
				null,
				null,
				null,
				input.relatedProjectId ?? null,
				input.relatedWorkdayId ?? null,
				null,
				null,
				JSON.stringify(ownershipSnapshot),
				JSON.stringify(objectValue(input.metadata, {})),
				timestamp,
				timestamp,
			],
		);
		await this.recordCommerceServiceGovernance({
			requestId: id,
			eventType: 'requested',
			action: 'commerce_service.requested',
			objectId: id,
			actorType: input.actorType ?? 'user',
			actorId: input.actorId ?? principal?.id ?? null,
			nextState: 'requested',
			evidence: { offerId: offer.id, productId: product.id, vendorId: vendor.id },
			relatedOfferId: offer.id,
			relatedProductId: product.id,
			relatedTeamId: product.sellerTeamId,
		});
		return this.getCommerceServiceRequest(id);
	}

	async getCommerceServiceRequest(requestId) {
		await this.ensureInitialized();
		return serializeCommerceServiceRequest(await this.first(`SELECT * FROM commerce_service_requests WHERE id = ? LIMIT 1`, [requestId]));
	}

	async listCommerceServiceRequests(principal = null, filters = {}) {
		await this.ensureInitialized();
		const clauses = [];
		const params = [];
		for (const [key, column] of [
			['buyerTeamId', 'buyer_team_id'],
			['buyerUserId', 'buyer_user_id'],
			['vendorId', 'vendor_id'],
			['sellerTeamId', 'seller_team_id'],
			['status', 'status'],
			['offerId', 'offer_id'],
			['relatedProjectId', 'related_project_id'],
			['relatedWorkdayId', 'related_workday_id'],
		]) {
			if (filters[key]) {
				clauses.push(`${column} = ?`);
				params.push(filters[key]);
			}
		}
		const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
		const rows = await this.all(`SELECT * FROM commerce_service_requests ${where} ORDER BY updated_at DESC, created_at DESC`, params);
		return rows.map(serializeCommerceServiceRequest);
	}

	async updateCommerceServiceRequest(requestId, input = {}) {
		await this.ensureInitialized();
		const existing = await this.getCommerceServiceRequest(requestId);
		if (!existing) return null;
		const timestamp = isoNow();
		await this.run(
			`UPDATE commerce_service_requests
			 SET status = ?, approved_scope = ?, access_needs_json = ?, buyer_visible_summary = ?, vendor_private_notes = ?,
			     active_quote_id = ?, approved_quote_id = ?, contract_id = ?, related_project_id = ?, related_workday_id = ?,
			     order_id = ?, entitlement_id = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`,
			[
				enumValue(input.status, COMMERCE_SERVICE_REQUEST_STATUS_SET, existing.status),
				input.approvedScope === undefined ? existing.approvedScope : input.approvedScope,
				JSON.stringify(input.accessNeeds === undefined ? existing.accessNeeds : objectValue(input.accessNeeds, {})),
				input.buyerVisibleSummary === undefined ? existing.buyerVisibleSummary : input.buyerVisibleSummary,
				input.vendorPrivateNotes === undefined ? existing.vendorPrivateNotes : input.vendorPrivateNotes,
				input.activeQuoteId === undefined ? existing.activeQuoteId : input.activeQuoteId,
				input.approvedQuoteId === undefined ? existing.approvedQuoteId : input.approvedQuoteId,
				input.contractId === undefined ? existing.contractId : input.contractId,
				input.relatedProjectId === undefined ? existing.relatedProjectId : input.relatedProjectId,
				input.relatedWorkdayId === undefined ? existing.relatedWorkdayId : input.relatedWorkdayId,
				input.orderId === undefined ? existing.orderId : input.orderId,
				input.entitlementId === undefined ? existing.entitlementId : input.entitlementId,
				JSON.stringify(input.metadata ?? existing.metadata ?? {}),
				timestamp,
				requestId,
			],
		);
		if (input.recordEvent !== false) {
			await this.recordCommerceServiceGovernance({
				requestId,
				eventType: input.eventType ?? 'scope_updated',
				action: input.action ?? 'commerce_service.scope_updated',
				objectId: requestId,
				actorType: input.actorType ?? 'user',
				actorId: input.actorId ?? null,
				priorState: existing.status,
				nextState: input.status ?? existing.status,
				message: input.reason ?? null,
				evidence: input.evidence ?? {},
				relatedOfferId: existing.offerId,
				relatedProductId: existing.productId,
				relatedTeamId: existing.sellerTeamId,
			});
		}
		return this.getCommerceServiceRequest(requestId);
	}

	async transitionCommerceServiceRequest(requestId, nextState, input = {}) {
		return this.updateCommerceServiceRequest(requestId, {
			...input,
			status: nextState,
			eventType: input.eventType ?? (nextState === 'canceled' ? 'canceled' : 'manual_update'),
			action: input.action ?? `commerce_service.${nextState}`,
		});
	}

	async createCommerceServiceQuote(requestId, input = {}) {
		await this.ensureInitialized();
		const request = await this.getCommerceServiceRequest(requestId);
		if (!request) return null;
		if (!['requested', 'scoping'].includes(request.status)) {
			const error = new Error('Quotes can only be created while a service request is requested or scoping.');
			error.status = 409;
			throw error;
		}
		const title = stringValue(input.title, '');
		const scopeSummary = stringValue(input.scopeSummary, '');
		const amount = Number(input.amount ?? 0);
		const currency = stringValue(input.currency, '').toLowerCase();
		if (!title || !scopeSummary) {
			const error = new Error('Quote title and scope summary are required.');
			error.status = 400;
			throw error;
		}
		if (!Number.isInteger(amount) || amount <= 0) {
			const error = new Error('Quote amount must be a positive integer minor-unit amount.');
			error.status = 400;
			throw error;
		}
		if (!/^[a-z]{3}$/u.test(currency)) {
			const error = new Error('Quote currency must be a lowercase 3-letter code.');
			error.status = 400;
			throw error;
		}
		const priorActive = request.activeQuoteId ? await this.getCommerceServiceQuote(request.activeQuoteId) : null;
		if (priorActive && ['draft', 'submitted', 'buyer_approved'].includes(priorActive.status)) {
			await this.updateCommerceServiceQuoteState(priorActive.id, 'superseded', {
				recordEvent: false,
			});
		}
		const last = await this.first(`SELECT MAX(quote_version) AS version FROM commerce_service_quotes WHERE request_id = ?`, [requestId]);
		const quoteVersion = Number(last?.version ?? 0) + 1;
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		const status = enumValue(input.status, COMMERCE_SERVICE_QUOTE_STATUS_SET, 'draft');
		await this.run(
			`INSERT INTO commerce_service_quotes (
				id, request_id, vendor_id, seller_team_id, buyer_team_id, buyer_user_id, quote_version, status,
				title, scope_summary, deliverables_json, assumptions_json, access_requirements_json, governance_requirements_json,
				amount, currency, expires_at, buyer_approved_at, vendor_approved_at, accepted_at, rejected_at,
				metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				request.id,
				request.vendorId,
				request.sellerTeamId,
				request.buyerTeamId,
				request.buyerUserId,
				quoteVersion,
				status,
				title,
				scopeSummary,
				JSON.stringify(arrayValue(input.deliverables)),
				JSON.stringify(arrayValue(input.assumptions)),
				JSON.stringify(objectValue(input.accessRequirements, {})),
				JSON.stringify(objectValue(input.governanceRequirements, {})),
				amount,
				currency,
				input.expiresAt ?? null,
				null,
				null,
				null,
				null,
				JSON.stringify(objectValue(input.metadata, {})),
				timestamp,
				timestamp,
			],
		);
		await this.updateCommerceServiceRequest(request.id, {
			status: status === 'submitted' ? 'quoted' : request.status,
			activeQuoteId: id,
			recordEvent: false,
		});
		await this.recordCommerceServiceGovernance({
			requestId: request.id,
			quoteId: id,
			eventType: 'quote_created',
			action: 'commerce_service.quote_created',
			objectType: 'commerce_service_quote',
			objectId: id,
			actorType: input.actorType ?? 'user',
			actorId: input.actorId ?? null,
			nextState: status,
			evidence: { quoteVersion, amount, currency },
			relatedOfferId: request.offerId,
			relatedProductId: request.productId,
			relatedTeamId: request.sellerTeamId,
		});
		return this.getCommerceServiceQuote(id);
	}

	async getCommerceServiceQuote(quoteId) {
		await this.ensureInitialized();
		return serializeCommerceServiceQuote(await this.first(`SELECT * FROM commerce_service_quotes WHERE id = ? LIMIT 1`, [quoteId]));
	}

	async listCommerceServiceQuotes(requestId) {
		await this.ensureInitialized();
		const rows = await this.all(`SELECT * FROM commerce_service_quotes WHERE request_id = ? ORDER BY quote_version DESC`, [requestId]);
		return rows.map(serializeCommerceServiceQuote);
	}

	async updateCommerceServiceQuoteState(quoteId, status, input = {}) {
		await this.ensureInitialized();
		const existing = await this.getCommerceServiceQuote(quoteId);
		if (!existing) return null;
		const timestamp = isoNow();
		await this.run(
			`UPDATE commerce_service_quotes
			 SET status = ?, buyer_approved_at = ?, vendor_approved_at = ?, accepted_at = ?, rejected_at = ?,
			     metadata_json = ?, updated_at = ?
			 WHERE id = ?`,
			[
				enumValue(status, COMMERCE_SERVICE_QUOTE_STATUS_SET, existing.status),
				input.buyerApprovedAt === undefined ? existing.buyerApprovedAt : input.buyerApprovedAt,
				input.vendorApprovedAt === undefined ? existing.vendorApprovedAt : input.vendorApprovedAt,
				input.acceptedAt === undefined ? existing.acceptedAt : input.acceptedAt,
				input.rejectedAt === undefined ? existing.rejectedAt : input.rejectedAt,
				JSON.stringify(input.metadata ?? existing.metadata ?? {}),
				timestamp,
				quoteId,
			],
		);
		if (input.recordEvent !== false) {
			await this.recordCommerceServiceGovernance({
				requestId: existing.requestId,
				quoteId,
				eventType: input.eventType ?? 'manual_update',
				action: input.action ?? `commerce_service.quote_${status}`,
				objectType: 'commerce_service_quote',
				objectId: quoteId,
				actorType: input.actorType ?? 'user',
				actorId: input.actorId ?? null,
				priorState: existing.status,
				nextState: status,
				message: input.reason ?? null,
				evidence: input.evidence ?? {},
				relatedTeamId: existing.sellerTeamId,
			});
		}
		return this.getCommerceServiceQuote(quoteId);
	}

	async submitCommerceServiceQuote(quoteId, input = {}) {
		const quote = await this.getCommerceServiceQuote(quoteId);
		if (!quote) return null;
		if (quote.status !== 'draft') {
			const error = new Error('Only draft service quotes can be submitted.');
			error.status = 409;
			throw error;
		}
		const updated = await this.updateCommerceServiceQuoteState(quoteId, 'submitted', {
			...input,
			eventType: 'quote_submitted',
			action: 'commerce_service.quote_submitted',
		});
		await this.updateCommerceServiceRequest(quote.requestId, {
			status: 'quoted',
			activeQuoteId: quoteId,
			recordEvent: false,
		});
		return updated;
	}

	async approveCommerceServiceQuoteByBuyer(quoteId, input = {}) {
		const quote = await this.getCommerceServiceQuote(quoteId);
		if (!quote) return null;
		if (quote.status !== 'submitted') {
			const error = new Error('Only submitted service quotes can be buyer-approved.');
			error.status = 409;
			throw error;
		}
		const timestamp = isoNow();
		const updated = await this.updateCommerceServiceQuoteState(quoteId, 'buyer_approved', {
			...input,
			buyerApprovedAt: timestamp,
			eventType: 'quote_buyer_approved',
			action: 'commerce_service.quote_buyer_approved',
		});
		await this.updateCommerceServiceRequest(quote.requestId, {
			status: 'buyer_approved',
			recordEvent: false,
		});
		return updated;
	}

	async approveCommerceServiceQuoteByVendor(quoteId, input = {}) {
		const quote = await this.getCommerceServiceQuote(quoteId);
		if (!quote) return null;
		if (quote.status !== 'buyer_approved') {
			const error = new Error('Only buyer-approved service quotes can be vendor-approved.');
			error.status = 409;
			throw error;
		}
		const timestamp = isoNow();
		const updated = await this.updateCommerceServiceQuoteState(quoteId, 'accepted', {
			...input,
			vendorApprovedAt: timestamp,
			acceptedAt: timestamp,
			eventType: 'quote_vendor_approved',
			action: 'commerce_service.quote_vendor_approved',
		});
		await this.updateCommerceServiceRequest(quote.requestId, {
			status: 'checkout_pending',
			approvedQuoteId: quoteId,
			recordEvent: false,
		});
		await this.createCommerceServiceContractFromQuote(quoteId, input);
		return updated;
	}

	async rejectCommerceServiceQuote(quoteId, input = {}) {
		const quote = await this.getCommerceServiceQuote(quoteId);
		if (!quote) return null;
		const updated = await this.updateCommerceServiceQuoteState(quoteId, 'rejected', {
			...input,
			rejectedAt: isoNow(),
			eventType: 'quote_rejected',
			action: 'commerce_service.quote_rejected',
		});
		await this.updateCommerceServiceRequest(quote.requestId, {
			status: 'scoping',
			recordEvent: false,
		});
		return updated;
	}

	async expireCommerceServiceQuote(quoteId, input = {}) {
		const quote = await this.getCommerceServiceQuote(quoteId);
		if (!quote) return null;
		const updated = await this.updateCommerceServiceQuoteState(quoteId, 'expired', {
			...input,
			eventType: 'quote_expired',
			action: 'commerce_service.quote_expired',
		});
		await this.updateCommerceServiceRequest(quote.requestId, {
			status: 'expired',
			recordEvent: false,
		});
		return updated;
	}

	async createCommerceServiceContractFromQuote(quoteId, input = {}) {
		await this.ensureInitialized();
		const quote = await this.getCommerceServiceQuote(quoteId);
		if (!quote) return null;
		const existing = await this.getCommerceServiceContractForRequest(quote.requestId);
		if (existing) return existing;
		const request = await this.getCommerceServiceRequest(quote.requestId);
		if (!request) return null;
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		const accessApprovalSnapshot = {
			quoteId,
			accessRequirements: quote.accessRequirements,
			governanceRequirements: quote.governanceRequirements,
			approvedAt: timestamp,
		};
		await this.run(
			`INSERT INTO commerce_service_contracts (
				id, request_id, quote_id, vendor_id, seller_team_id, buyer_team_id, buyer_user_id, product_id, offer_id,
				status, amount, currency, order_id, order_item_id, payment_group_id, entitlement_id,
				related_project_id, related_workday_id, ownership_snapshot_json, access_approval_snapshot_json,
				fulfillment_summary, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				request.id,
				quote.id,
				request.vendorId,
				request.sellerTeamId,
				request.buyerTeamId,
				request.buyerUserId,
				request.productId,
				request.offerId,
				'pending_checkout',
				quote.amount,
				quote.currency,
				null,
				null,
				null,
				null,
				request.relatedProjectId,
				request.relatedWorkdayId,
				JSON.stringify(request.ownershipSnapshot ?? {}),
				JSON.stringify(accessApprovalSnapshot),
				null,
				JSON.stringify(input.metadata ?? {}),
				timestamp,
				timestamp,
			],
		);
		await this.updateCommerceServiceRequest(request.id, {
			contractId: id,
			recordEvent: false,
		});
		await this.recordCommerceServiceGovernance({
			requestId: request.id,
			quoteId: quote.id,
			contractId: id,
			eventType: 'quote_vendor_approved',
			action: 'commerce_service.contract_created',
			objectType: 'commerce_service_contract',
			objectId: id,
			actorType: input.actorType ?? 'user',
			actorId: input.actorId ?? null,
			nextState: 'pending_checkout',
			evidence: { quoteId, amount: quote.amount, currency: quote.currency },
			relatedOfferId: request.offerId,
			relatedProductId: request.productId,
			relatedTeamId: request.sellerTeamId,
		});
		return this.getCommerceServiceContract(id);
	}

	async getCommerceServiceContract(contractId) {
		await this.ensureInitialized();
		return serializeCommerceServiceContract(await this.first(`SELECT * FROM commerce_service_contracts WHERE id = ? LIMIT 1`, [contractId]));
	}

	async getCommerceServiceContractForRequest(requestId) {
		await this.ensureInitialized();
		return serializeCommerceServiceContract(await this.first(`SELECT * FROM commerce_service_contracts WHERE request_id = ? LIMIT 1`, [requestId]));
	}

	async updateCommerceServiceContract(contractId, input = {}) {
		await this.ensureInitialized();
		const existing = await this.getCommerceServiceContract(contractId);
		if (!existing) return null;
		await this.run(
			`UPDATE commerce_service_contracts
			 SET status = ?, order_id = ?, order_item_id = ?, payment_group_id = ?, entitlement_id = ?,
			     related_project_id = ?, related_workday_id = ?, fulfillment_summary = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`,
			[
				enumValue(input.status, COMMERCE_SERVICE_CONTRACT_STATUS_SET, existing.status),
				input.orderId === undefined ? existing.orderId : input.orderId,
				input.orderItemId === undefined ? existing.orderItemId : input.orderItemId,
				input.paymentGroupId === undefined ? existing.paymentGroupId : input.paymentGroupId,
				input.entitlementId === undefined ? existing.entitlementId : input.entitlementId,
				input.relatedProjectId === undefined ? existing.relatedProjectId : input.relatedProjectId,
				input.relatedWorkdayId === undefined ? existing.relatedWorkdayId : input.relatedWorkdayId,
				input.fulfillmentSummary === undefined ? existing.fulfillmentSummary : input.fulfillmentSummary,
				JSON.stringify(input.metadata ?? existing.metadata ?? {}),
				isoNow(),
				contractId,
			],
		);
		return this.getCommerceServiceContract(contractId);
	}

	async attachCommerceServiceOrder(contractId, input = {}) {
		const contract = await this.updateCommerceServiceContract(contractId, {
			orderId: input.orderId ?? null,
			orderItemId: input.orderItemId ?? null,
			paymentGroupId: input.paymentGroupId ?? null,
			metadata: input.metadata,
		});
		if (contract) {
			await this.updateCommerceServiceRequest(contract.requestId, {
				orderId: input.orderId ?? null,
				recordEvent: false,
			});
			await this.recordCommerceServiceGovernance({
				requestId: contract.requestId,
				contractId,
				eventType: 'checkout_created',
				action: 'commerce_service.checkout_created',
				objectType: 'commerce_service_contract',
				objectId: contractId,
				actorType: input.actorType ?? 'user',
				actorId: input.actorId ?? null,
				nextState: contract.status,
				evidence: { orderId: input.orderId, orderItemId: input.orderItemId, paymentGroupId: input.paymentGroupId },
				relatedOrderId: input.orderId ?? null,
				relatedOfferId: contract.offerId,
				relatedProductId: contract.productId,
				relatedTeamId: contract.sellerTeamId,
			});
		}
		return contract;
	}

	async activateCommerceServiceContract(contractId, input = {}) {
		const existing = await this.getCommerceServiceContract(contractId);
		if (!existing) return null;
		const contract = await this.updateCommerceServiceContract(contractId, {
			status: 'active',
			entitlementId: input.entitlementId ?? existing.entitlementId,
			metadata: input.metadata ?? existing.metadata,
		});
		await this.updateCommerceServiceRequest(existing.requestId, {
			status: 'active',
			entitlementId: input.entitlementId ?? existing.entitlementId,
			orderId: input.orderId ?? existing.orderId,
			recordEvent: false,
		});
		await this.recordCommerceServiceGovernance({
			requestId: existing.requestId,
			quoteId: existing.quoteId,
			contractId,
			eventType: 'contract_activated',
			action: 'commerce_service.contract_activated',
			objectType: 'commerce_service_contract',
			objectId: contractId,
			actorType: input.actorType ?? 'system',
			actorId: input.actorId ?? null,
			priorState: existing.status,
			nextState: 'active',
			evidence: { entitlementId: input.entitlementId ?? existing.entitlementId },
			relatedOrderId: input.orderId ?? existing.orderId,
			relatedOfferId: existing.offerId,
			relatedProductId: existing.productId,
			relatedTeamId: existing.sellerTeamId,
		});
		return contract;
	}

	async fulfillCommerceServiceContract(contractId, input = {}) {
		const existing = await this.getCommerceServiceContract(contractId);
		if (!existing) return null;
		const contract = await this.updateCommerceServiceContract(contractId, {
			status: 'fulfilled',
			fulfillmentSummary: input.summary ?? existing.fulfillmentSummary,
			metadata: input.metadata ?? existing.metadata,
		});
		await this.updateCommerceServiceRequest(existing.requestId, {
			status: 'fulfilled',
			recordEvent: false,
		});
		await this.recordCommerceServiceGovernance({
			requestId: existing.requestId,
			quoteId: existing.quoteId,
			contractId,
			eventType: 'fulfilled',
			action: 'commerce_service.fulfilled',
			objectType: 'commerce_service_contract',
			objectId: contractId,
			actorType: input.actorType ?? 'user',
			actorId: input.actorId ?? null,
			priorState: existing.status,
			nextState: 'fulfilled',
			message: input.summary ?? null,
			evidence: input.evidence ?? {},
			relatedOrderId: existing.orderId,
			relatedOfferId: existing.offerId,
			relatedProductId: existing.productId,
			relatedTeamId: existing.sellerTeamId,
		});
		return contract;
	}

	async cancelCommerceServiceContract(contractId, input = {}) {
		const existing = await this.getCommerceServiceContract(contractId);
		if (!existing) return null;
		const contract = await this.updateCommerceServiceContract(contractId, {
			status: 'canceled',
			metadata: input.metadata ?? existing.metadata,
		});
		await this.updateCommerceServiceRequest(existing.requestId, {
			status: 'canceled',
			recordEvent: false,
		});
		await this.recordCommerceServiceGovernance({
			requestId: existing.requestId,
			quoteId: existing.quoteId,
			contractId,
			eventType: 'canceled',
			action: 'commerce_service.canceled',
			objectType: 'commerce_service_contract',
			objectId: contractId,
			actorType: input.actorType ?? 'user',
			actorId: input.actorId ?? null,
			priorState: existing.status,
			nextState: 'canceled',
			message: input.reason ?? null,
			evidence: input.evidence ?? {},
			relatedOfferId: existing.offerId,
			relatedProductId: existing.productId,
			relatedTeamId: existing.sellerTeamId,
		});
		return contract;
	}

	async linkCommerceServiceContractWork(contractId, input = {}) {
		const existing = await this.getCommerceServiceContract(contractId);
		if (!existing) return null;
		const contract = await this.updateCommerceServiceContract(contractId, {
			relatedProjectId: input.relatedProjectId ?? existing.relatedProjectId,
			relatedWorkdayId: input.relatedWorkdayId ?? existing.relatedWorkdayId,
			metadata: input.metadata ?? existing.metadata,
		});
		await this.updateCommerceServiceRequest(existing.requestId, {
			relatedProjectId: input.relatedProjectId ?? existing.relatedProjectId,
			relatedWorkdayId: input.relatedWorkdayId ?? existing.relatedWorkdayId,
			recordEvent: false,
		});
		await this.recordCommerceServiceGovernance({
			requestId: existing.requestId,
			quoteId: existing.quoteId,
			contractId,
			eventType: 'work_linked',
			action: 'commerce_service.work_linked',
			objectType: 'commerce_service_contract',
			objectId: contractId,
			actorType: input.actorType ?? 'user',
			actorId: input.actorId ?? null,
			priorState: existing.status,
			nextState: contract?.status ?? existing.status,
			evidence: {
				relatedProjectId: input.relatedProjectId ?? existing.relatedProjectId,
				relatedWorkdayId: input.relatedWorkdayId ?? existing.relatedWorkdayId,
			},
			relatedOfferId: existing.offerId,
			relatedProductId: existing.productId,
			relatedTeamId: existing.sellerTeamId,
		});
		return contract;
	}

	async listCommerceServiceEvents(filters = {}) {
		await this.ensureInitialized();
		const clauses = [];
		const params = [];
		for (const [key, column] of [
			['requestId', 'request_id'],
			['quoteId', 'quote_id'],
			['contractId', 'contract_id'],
			['eventType', 'event_type'],
		]) {
			if (filters[key]) {
				clauses.push(`${column} = ?`);
				params.push(filters[key]);
			}
		}
		const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
		const rows = await this.all(`SELECT * FROM commerce_service_events ${where} ORDER BY created_at ASC`, params);
		return rows.map(serializeCommerceServiceEvent);
	}

	async getCommerceVendorSalesSummary(teamId, filters = {}) {
		await this.ensureInitialized();
		const vendor = await this.getCommerceVendorForTeam(teamId);
		if (!vendor) return null;
		const orderRows = await this.all(`SELECT * FROM commerce_orders WHERE seller_team_id = ?`, [teamId]);
		const subscriptionRows = await this.all(`SELECT * FROM commerce_subscriptions WHERE seller_team_id = ? AND status IN ('active', 'trialing')`, [teamId]);
		const entitlementRows = await this.all(`SELECT * FROM commerce_entitlements WHERE seller_team_id = ? AND status = 'active'`, [teamId]);
		const itemRows = await this.all(`SELECT * FROM commerce_order_items WHERE seller_team_id = ? AND status = 'paid'`, [teamId]);
		const grossPaidAmount = orderRows
			.filter((row) => ['paid', 'partially_refunded', 'refunded'].includes(row.status))
			.reduce((sum, row) => sum + Number(row.total_amount ?? 0), 0);
		const refundedAmount = orderRows.reduce((sum, row) => sum + Number(row.refunded_amount ?? 0), 0);
		return {
			vendorId: vendor.id,
			sellerTeamId: teamId,
			currency: orderRows[0]?.currency ?? null,
			grossPaidAmount,
			refundedAmount,
			netPaidAmount: Math.max(0, grossPaidAmount - refundedAmount),
			paidOrderCount: orderRows.filter((row) => ['paid', 'partially_refunded', 'refunded'].includes(row.status)).length,
			refundedOrderCount: orderRows.filter((row) => ['partially_refunded', 'refunded'].includes(row.status)).length,
			activeSubscriptionCount: subscriptionRows.length,
			activeEntitlementCount: entitlementRows.length,
			pendingFulfillmentCount: itemRows.length,
		};
	}

	async getCommerceVendorCommerceMonitor(teamId, filters = {}) {
		await this.ensureInitialized();
		const vendor = await this.getCommerceVendorForTeam(teamId);
		const stripeAccount = vendor
			? await this.first(
				`SELECT * FROM commerce_vendor_stripe_accounts WHERE vendor_id = ? ORDER BY updated_at DESC LIMIT 1`,
				[vendor.id],
			)
			: null;
		const [
			blockedSync,
			driftedSync,
			pendingFulfillment,
			failedRefunds,
			failedWebhooks,
			pendingServices,
			pendingCapacity,
			pendingTransfers,
		] = await Promise.all([
			this.first(
				`SELECT COUNT(*) AS count
				 FROM commerce_prices p
				 JOIN commerce_offers o ON o.id = p.offer_id
				 WHERE o.seller_team_id = ? AND p.stripe_sync_status = 'blocked'`,
				[teamId],
			),
			this.first(
				`SELECT COUNT(*) AS count
				 FROM commerce_prices p
				 JOIN commerce_offers o ON o.id = p.offer_id
				 WHERE o.seller_team_id = ? AND p.stripe_sync_status = 'drifted'`,
				[teamId],
			),
			this.first(`SELECT COUNT(*) AS count FROM commerce_order_items WHERE seller_team_id = ? AND status = 'paid'`, [teamId]),
			this.first(`SELECT COUNT(*) AS count FROM commerce_refunds WHERE seller_team_id = ? AND status = 'failed'`, [teamId]),
			this.first(
				`SELECT COUNT(*) AS count FROM commerce_webhook_events WHERE status = 'failed'`,
				[],
			),
			this.first(
				`SELECT COUNT(*) AS count FROM commerce_service_requests WHERE seller_team_id = ? AND status IN ('requested', 'scoping', 'quoted', 'buyer_approved', 'checkout_pending')`,
				[teamId],
			),
			this.first(
				`SELECT COUNT(*) AS count FROM commerce_capacity_listing_inquiries WHERE seller_team_id = ? AND status IN ('requested', 'reviewing')`,
				[teamId],
			),
			this.first(
				`SELECT COUNT(*) AS count FROM commerce_ownership_transfers WHERE product_id IN (SELECT id FROM commerce_products WHERE seller_team_id = ?) AND status IN ('draft', 'submitted')`,
				[teamId],
			),
		]);
		return {
			vendorId: vendor?.id ?? null,
			sellerTeamId: teamId,
			stripeReady: Boolean(stripeAccount?.account_status === 'enabled' && stripeAccount?.charges_enabled),
			blockedStripeSyncCount: Number(blockedSync?.count ?? 0),
			driftedStripeSyncCount: Number(driftedSync?.count ?? 0),
			pendingFulfillmentCount: Number(pendingFulfillment?.count ?? 0),
			failedRefundCount: Number(failedRefunds?.count ?? 0),
			failedWebhookCount: Number(failedWebhooks?.count ?? 0),
			pendingServiceRequestCount: Number(pendingServices?.count ?? 0),
			pendingCapacityInquiryCount: Number(pendingCapacity?.count ?? 0),
			pendingGovernanceTransferCount: Number(pendingTransfers?.count ?? 0),
			recentGovernanceEvents: await this.listCommerceGovernanceEvents({ teamId }).then((events) => events.slice(0, 8)),
			updatedAt: isoNow(),
		};
	}

	async listCommerceVendorSalesOrders(teamId, filters = {}) {
		await this.ensureInitialized();
		const clauses = ['seller_team_id = ?'];
		const params = [teamId];
		if (filters.status) {
			clauses.push('status = ?');
			params.push(filters.status);
		}
		const rows = await this.all(
			`SELECT * FROM commerce_orders WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC, created_at DESC`,
			params,
		);
		const summaries = [];
		for (const row of rows) {
			const itemCount = await this.first(`SELECT COUNT(*) AS count FROM commerce_order_items WHERE order_id = ?`, [row.id]);
			const buyerTeam = row.buyer_team_id ? await this.first(`SELECT display_name FROM teams WHERE id = ? LIMIT 1`, [row.buyer_team_id]) : null;
			summaries.push(serializeCommerceVendorOrderSummary({
				...row,
				item_count: itemCount?.count ?? 0,
				buyer_team_name: buyerTeam?.display_name ?? null,
			}));
		}
		return summaries;
	}

	async listCommerceVendorSalesSubscriptions(teamId, filters = {}) {
		await this.ensureInitialized();
		const rows = await this.all(`SELECT * FROM commerce_subscriptions WHERE seller_team_id = ? ORDER BY updated_at DESC, created_at DESC`, [teamId]);
		return rows.map(serializeCommerceSubscription);
	}

	async listCommerceVendorSalesEntitlements(teamId, filters = {}) {
		await this.ensureInitialized();
		return this.listCommerceEntitlements(null, { ...filters, sellerTeamId: teamId });
	}

	async getCommerceBuyerStripeCustomer(input = {}) {
		await this.ensureInitialized();
		const environment = enumValue(input.environment, COMMERCE_STRIPE_ENVIRONMENT_SET, 'test');
		if (input.buyerTeamId) {
			return serializeCommerceBuyerStripeCustomer(await this.first(
				`SELECT * FROM commerce_buyer_stripe_customers WHERE vendor_id = ? AND environment = ? AND buyer_team_id = ? LIMIT 1`,
				[input.vendorId, environment, input.buyerTeamId],
			));
		}
		return serializeCommerceBuyerStripeCustomer(await this.first(
			`SELECT * FROM commerce_buyer_stripe_customers WHERE vendor_id = ? AND environment = ? AND buyer_user_id = ? LIMIT 1`,
			[input.vendorId, environment, input.buyerUserId ?? null],
		));
	}

	async upsertCommerceBuyerStripeCustomer(input = {}) {
		await this.ensureInitialized();
		const existing = await this.getCommerceBuyerStripeCustomer(input);
		if (existing) return existing;
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		const environment = enumValue(input.environment, COMMERCE_STRIPE_ENVIRONMENT_SET, 'test');
		await this.run(
			`INSERT INTO commerce_buyer_stripe_customers (
				id, buyer_team_id, buyer_user_id, vendor_id, connected_account_id, environment, stripe_customer_id,
				metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				input.buyerTeamId ?? null,
				input.buyerUserId ?? null,
				input.vendorId,
				input.connectedAccountId,
				environment,
				input.stripeCustomerId,
				JSON.stringify(input.metadata ?? {}),
				timestamp,
				timestamp,
			],
		);
		return serializeCommerceBuyerStripeCustomer(await this.first(`SELECT * FROM commerce_buyer_stripe_customers WHERE id = ?`, [id]));
	}

	async recordCommerceWebhookEvent(input = {}) {
		await this.ensureInitialized();
		const existing = serializeCommerceWebhookEvent(await this.first(
			`SELECT * FROM commerce_webhook_events WHERE provider = ? AND environment = ? AND event_id = ? LIMIT 1`,
			[input.provider ?? 'stripe', input.environment ?? 'test', input.eventId],
		));
		if (existing) return existing;
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO commerce_webhook_events (
				id, provider, environment, event_id, event_type, connected_account_id, status, object_type, object_id,
				related_order_id, related_subscription_id, payload_hash, processing_error, received_at, processed_at,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				input.provider ?? 'stripe',
				enumValue(input.environment, COMMERCE_STRIPE_ENVIRONMENT_SET, 'test'),
				input.eventId,
				input.eventType,
				input.connectedAccountId ?? null,
				enumValue(input.status, COMMERCE_WEBHOOK_EVENT_STATUS_SET, 'received'),
				input.objectType ?? null,
				input.objectId ?? null,
				input.relatedOrderId ?? null,
				input.relatedSubscriptionId ?? null,
				input.payloadHash,
				input.processingError ?? null,
				input.receivedAt ?? timestamp,
				input.processedAt ?? null,
				timestamp,
				timestamp,
			],
		);
		await this.recordCommerceGovernanceEvent({
			actorType: 'system',
			action: 'commerce_webhook.received',
			objectType: 'commerce_webhook_event',
			objectId: id,
			nextState: 'received',
			evidence: {
				provider: input.provider ?? 'stripe',
				eventId: input.eventId,
				eventType: input.eventType,
				connectedAccountId: input.connectedAccountId ?? null,
			},
		});
		return serializeCommerceWebhookEvent(await this.first(`SELECT * FROM commerce_webhook_events WHERE id = ?`, [id]));
	}

	async updateCommerceWebhookEventStatus(eventId, input = {}) {
		await this.ensureInitialized();
		const existing = serializeCommerceWebhookEvent(await this.first(`SELECT * FROM commerce_webhook_events WHERE id = ? LIMIT 1`, [eventId]));
		if (!existing) return null;
		const status = enumValue(input.status, COMMERCE_WEBHOOK_EVENT_STATUS_SET, existing.status);
		const processedAt = ['processed', 'ignored', 'failed'].includes(status) ? isoNow() : existing.processedAt;
		await this.run(
			`UPDATE commerce_webhook_events
			 SET status = ?, related_order_id = ?, related_subscription_id = ?, processing_error = ?, processed_at = ?, updated_at = ?
			 WHERE id = ?`,
			[
				status,
				input.relatedOrderId === undefined ? existing.relatedOrderId : input.relatedOrderId,
				input.relatedSubscriptionId === undefined ? existing.relatedSubscriptionId : input.relatedSubscriptionId,
				input.processingError === undefined ? existing.processingError : input.processingError,
				processedAt,
				isoNow(),
				eventId,
			],
		);
		return serializeCommerceWebhookEvent(await this.first(`SELECT * FROM commerce_webhook_events WHERE id = ?`, [eventId]));
	}

	async claimCommerceWebhookEvent(eventId) {
		return this.updateCommerceWebhookEventStatus(eventId, { status: 'processing' });
	}

	async markCommerceWebhookEventProcessed(eventId, input = {}) {
		return this.updateCommerceWebhookEventStatus(eventId, { ...input, status: 'processed' });
	}

	async markCommerceWebhookEventIgnored(eventId, input = {}) {
		return this.updateCommerceWebhookEventStatus(eventId, { ...input, status: 'ignored' });
	}

	async markCommerceWebhookEventFailed(eventId, input = {}) {
		return this.updateCommerceWebhookEventStatus(eventId, { ...input, status: 'failed' });
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
			...profileTeams.map((team) => team.id),
			...catalogItems.map((item) => item.teamId),
			...knowledgePacks.map((pack) => pack.teamId),
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
		const [projectRows, catalogItems, knowledgePacks, jobs] = await Promise.all([
			this.all(`SELECT id, slug, name, metadata_json FROM projects WHERE team_id = ? ORDER BY created_at ASC LIMIT 20`, [teamId]),
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
		const deletedProjectIds = new Set(projectRows
			.filter((row) => parseJson(row.metadata_json, {})?.deletion?.status === 'succeeded')
			.map((row) => row.id));
		const projects = projectRows.filter((row) => !deletedProjectIds.has(row.id));
		const activeCatalogItems = catalogItems.filter((row) => !deletedProjectIds.has(row.id));
		return [
			...projects.map((row) => ({ code: 'project', id: row.id, label: row.name, href: `/app/projects/${row.id}/settings` })),
			...activeCatalogItems.map((row) => ({ code: 'catalog_item', id: row.id, label: row.title, href: '/app/knowledge/templates' })),
			...knowledgePacks.map((row) => ({ code: 'knowledge_pack', id: row.id, label: row.name, href: '/app/knowledge/packs' })),
			...jobs.map((row) => ({ code: 'active_job', id: row.id, label: `${row.project_name}: ${row.operation}`, href: '/app/work/objectives' })),
		];
	}

	async prepareTeamDeletion(teamId, confirmation) {
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
		return { ok: true, team };
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
		if (input.metadata?.architecture) {
			await this.projectArchitectureContentBindings(id, normalizeProjectArchitecture(input.metadata.architecture)).catch(() => null);
		}
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
		if (metadata?.architecture) {
			await this.projectArchitectureContentBindings(projectId, normalizeProjectArchitecture(metadata.architecture)).catch(() => null);
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
					 SET deployment_profile = ?, base_url = ?, cloudflare_account_id = ?, pages_project_name = ?, worker_name = ?, r2_bucket_name = ?, d1_database_name = ?, railway_project_name = ?, metadata_json = ?, updated_at = ?
					 WHERE project_id = ? AND environment = ?`,
					[
						input.deploymentProfile,
					input.baseUrl ?? null,
					input.cloudflareAccountId ?? null,
					input.pagesProjectName ?? null,
						input.workerName ?? null,
						input.r2BucketName ?? null,
						input.d1DatabaseName ?? null,
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
						id, project_id, environment, deployment_profile, base_url, cloudflare_account_id, pages_project_name, worker_name, r2_bucket_name, d1_database_name, railway_project_name, metadata_json, created_at, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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









		async uploadRuntimeArtifact(projectId, input) {
			await this.ensureInitialized();
			const fs = getNodeBuiltin('fs');
			const path = getNodeBuiltin('path');
			const root = artifactStorageRoot(this.config);
			const objectKey = safeStoragePathSegment(input.objectKey);
			if (!fs || !path || !root || !objectKey) return null;
			const contentType = typeof input.contentType === 'string' && input.contentType.trim()
				? input.contentType.trim()
				: 'application/octet-stream';
			const bytes = typeof input.contentBase64 === 'string' && input.contentBase64
				? Buffer.from(input.contentBase64, 'base64')
				: Buffer.from(typeof input.content === 'string' ? input.content : JSON.stringify(input.content ?? {}));
			const destination = path.resolve(root, projectId, objectKey);
			if (!destination.startsWith(path.resolve(root, projectId) + path.sep)) return null;
			await fs.promises.mkdir(path.dirname(destination), { recursive: true });
			await fs.promises.writeFile(destination, bytes);
			return {
				artifactStorage: 'r2',
				storageMode: 'local_r2_emulation',
				outputRef: `r2:${objectKey}`,
				objectKey,
				contentType,
				sizeBytes: bytes.byteLength,
				sha256: createHash('sha256').update(bytes).digest('hex'),
				teamId: null,
				projectId,
				createdAt: isoNow(),
				};
			}

			async readRuntimeArtifactContent(projectId, outputRef) {
				const fs = getNodeBuiltin('fs');
				const path = getNodeBuiltin('path');
				const root = artifactStorageRoot(this.config);
				if (!fs || !path || !root || typeof outputRef !== 'string' || !outputRef.startsWith('r2:')) return null;
				const objectKey = safeStoragePathSegment(outputRef.slice(3));
				if (!objectKey) return null;
				const filePath = path.resolve(root, projectId, objectKey);
				if (!filePath.startsWith(path.resolve(root, projectId) + path.sep)) return null;
				try {
					return await fs.promises.readFile(filePath, 'utf8');
				} catch {
					return null;
				}
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
		const [connection, capabilityGrants, entitlement, hosting, environments, resources, deployments, repositories, contentSource, latestLaunch, architecture] = await Promise.all([
			this.getProjectConnection(projectId),
			this.listProjectCapabilities(projectId),
			(async () => serializeEntitlement(await this.first(`SELECT * FROM entitlements WHERE project_id = ? LIMIT 1`, [projectId])))(),
			this.getProjectHosting(projectId),
			this.listProjectEnvironments(projectId),
			this.listProjectInfrastructureResources(projectId),
			this.listProjectDeployments(projectId),
			this.listHubRepositories(projectId),
			this.getHubContentSource(projectId),
			this.getLatestHubLaunchForHub(projectId),
			this.getProjectArchitecture(projectId),
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
			repositories,
			contentSource,
			architecture,
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
				agents: Number(runtimeCounts.agents ?? 0),
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

	async getTeamHomeSummary(teamId, principal = null, capacity) {
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
		const agentSummaries = await Promise.all(projects.map((project) => capacity.getProjectAgentsSummary(project.id, principal)));
		const activeAgents = agentSummaries.flatMap((summary) =>
			Array.isArray(summary?.agents)
				? summary.agents.filter((agent) => ['active', 'running', 'ready'].includes(String(agent?.status ?? '').toLowerCase()))
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

	async createSecretMetadataRecord(input = {}) {
		await this.ensureInitialized();
		rejectSecretCapabilityPlaintext(input);
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		const record = {
			id,
			name: input.name,
			secretClass: input.secretClass ?? input.secret_class,
			custodyMode: input.custodyMode ?? input.custody_mode,
			owner: input.owner ?? { kind: input.ownerKind ?? input.owner_kind ?? 'customer', teamId: input.teamId, projectId: input.projectId ?? null },
			apiDecryptable: input.apiDecryptable === true,
			plaintextAllowed: input.plaintextAllowed === true,
			githubSecretTarget: input.githubSecretTarget ?? input.github_secret_target,
			escrowRecordId: input.escrowRecordId ?? input.escrow_record_id,
			metadata: input.metadata ?? {},
		};
		const problems = validateTreeseedWritableSecretMetadata(record);
		if (problems.length > 0) throw secretCapabilityValidationError(problems, 'Invalid secret metadata record.');
		await this.run(
			`INSERT INTO secret_metadata_records (
				id, team_id, project_id, name, secret_class, custody_mode, owner_kind, status,
				github_secret_target_json, escrow_record_id, api_decryptable, plaintext_allowed,
				fail_closed_code, metadata_json, created_at, updated_at, tombstoned_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
			[
				id,
				input.teamId,
				input.projectId ?? null,
				record.name,
				record.secretClass,
				record.custodyMode,
				record.owner.kind,
				input.status ?? 'active',
				JSON.stringify(record.githubSecretTarget ?? {}),
				record.escrowRecordId ?? null,
				record.apiDecryptable ? 1 : 0,
				record.plaintextAllowed ? 1 : 0,
				input.failClosedCode ?? null,
				JSON.stringify(redactDeploymentValue(record.metadata ?? {})),
				timestamp,
				timestamp,
			],
		);
		const created = await this.getSecretMetadataRecord(id);
		await this.recordSecretCapabilityAudit('secret_metadata_record.created', created);
		return created;
	}

	async getSecretMetadataRecord(id) {
		await this.ensureInitialized();
		return serializeSecretMetadataRecord(await this.first(`SELECT * FROM secret_metadata_records WHERE id = ? LIMIT 1`, [id]));
	}

	async listSecretMetadataRecords(input = {}) {
		await this.ensureInitialized();
		const clauses = [];
		const values = [];
		if (input.teamId) {
			clauses.push('team_id = ?');
			values.push(input.teamId);
		}
		if (input.projectId !== undefined) {
			clauses.push('project_id = ?');
			values.push(input.projectId);
		}
		if (input.status) {
			clauses.push('status = ?');
			values.push(input.status);
		}
		const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
		const rows = await this.all(
			`SELECT * FROM secret_metadata_records ${where} ORDER BY updated_at DESC LIMIT ?`,
			[...values, Math.max(1, Math.min(Number(input.limit ?? 100) || 100, 500))],
		);
		return rows.map(serializeSecretMetadataRecord);
	}

	async updateSecretMetadataRecord(id, patch = {}) {
		await this.ensureInitialized();
		const existing = await this.getSecretMetadataRecord(id);
		if (!existing) return null;
		const next = {
			...existing,
			...patch,
			owner: patch.owner ?? existing.owner,
			githubSecretTarget: patch.githubSecretTarget ?? existing.githubSecretTarget,
			escrowRecordId: patch.escrowRecordId ?? existing.escrowRecordId,
			metadata: patch.metadata ?? existing.metadata,
		};
		const problems = validateTreeseedWritableSecretMetadata(next);
		if (problems.length > 0) throw secretCapabilityValidationError(problems, 'Invalid secret metadata record update.');
		const timestamp = isoNow();
		await this.run(
			`UPDATE secret_metadata_records
			 SET name = ?, secret_class = ?, custody_mode = ?, owner_kind = ?, status = ?,
			     github_secret_target_json = ?, escrow_record_id = ?, api_decryptable = ?, plaintext_allowed = ?,
			     fail_closed_code = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`,
			[
				next.name,
				next.secretClass,
				next.custodyMode,
				next.owner.kind,
				next.status,
				JSON.stringify(next.githubSecretTarget ?? {}),
				next.escrowRecordId ?? null,
				next.apiDecryptable ? 1 : 0,
				next.plaintextAllowed ? 1 : 0,
				next.failClosedCode ?? null,
				JSON.stringify(redactDeploymentValue(next.metadata ?? {})),
				timestamp,
				id,
			],
		);
		const updated = await this.getSecretMetadataRecord(id);
		await this.recordSecretCapabilityAudit('secret_metadata_record.updated', updated);
		return updated;
	}

	async tombstoneSecretMetadataRecord(id, input = {}) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		await this.run(
			`UPDATE secret_metadata_records
			 SET status = 'tombstoned', tombstoned_at = ?, fail_closed_code = COALESCE(?, fail_closed_code), updated_at = ?
			 WHERE id = ?`,
			[timestamp, input.failClosedCode ?? null, timestamp, id],
		);
		const tombstoned = await this.getSecretMetadataRecord(id);
		await this.recordSecretCapabilityAudit('secret_metadata_record.tombstoned', tombstoned);
		return tombstoned;
	}

	async createClientEncryptedEscrowRecord(input = {}) {
		await this.ensureInitialized();
		rejectSecretCapabilityPlaintext(input);
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		const record = {
			id,
			secretId: input.secretId,
			ciphertext: input.ciphertext ?? null,
			ciphertextRef: input.ciphertextRef,
			algorithm: input.algorithm,
			nonce: input.nonce ?? null,
			salt: input.salt ?? null,
			kdf: input.kdf ?? null,
			kdfParams: input.kdfParams ?? null,
			wrappingKeyId: input.wrappingKeyId,
			encryptionVersion: input.encryptionVersion ?? null,
			createdByClientId: input.createdByClientId ?? null,
			expiresAt: input.expiresAt ?? null,
			deploymentIntent: input.deploymentIntent ?? null,
			migratedTo: input.migratedTo ?? null,
			metadata: {
				...(input.metadata ?? {}),
				envelope: {
					ciphertext: input.ciphertext ?? null,
					nonce: input.nonce ?? null,
					salt: input.salt ?? null,
					kdf: input.kdf ?? null,
					kdfParams: input.kdfParams ?? null,
					encryptionVersion: input.encryptionVersion ?? null,
					deploymentIntent: input.deploymentIntent ?? null,
				},
			},
		};
		const problems = validateTreeseedClientEncryptedEscrowMetadata(record);
		if (problems.length > 0) throw secretCapabilityValidationError(problems, 'Invalid client-encrypted escrow record.');
		await this.run(
			`INSERT INTO client_encrypted_escrow_records (
				id, team_id, project_id, secret_id, status, ciphertext_ref, algorithm, wrapping_key_id,
				created_by_client_id, expires_at, migrated_to, metadata_json, created_at, updated_at, tombstoned_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
			[
				id,
				input.teamId,
				input.projectId ?? null,
				record.secretId,
				input.status ?? 'active',
				record.ciphertextRef,
				record.algorithm,
				record.wrappingKeyId,
				record.createdByClientId,
				record.expiresAt,
				record.migratedTo,
				JSON.stringify(record.metadata ?? {}),
				timestamp,
				timestamp,
			],
		);
		const created = await this.getClientEncryptedEscrowRecord(id);
		await this.recordSecretCapabilityAudit('client_encrypted_escrow_record.created', created);
		return created;
	}

	async getClientEncryptedEscrowRecord(id) {
		await this.ensureInitialized();
		return serializeClientEncryptedEscrowRecord(await this.first(`SELECT * FROM client_encrypted_escrow_records WHERE id = ? LIMIT 1`, [id]));
	}

	async listClientEncryptedEscrowRecords(filters = {}) {
		await this.ensureInitialized();
		const clauses = [];
		const args = [];
		if (filters.teamId) {
			clauses.push('team_id = ?');
			args.push(filters.teamId);
		}
		if (filters.projectId) {
			clauses.push('project_id = ?');
			args.push(filters.projectId);
		}
		if (filters.secretId) {
			clauses.push('secret_id = ?');
			args.push(filters.secretId);
		}
		if (filters.status) {
			clauses.push('status = ?');
			args.push(filters.status);
		}
		const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
		const limit = Math.min(Math.max(Number(filters.limit ?? 100) || 100, 1), 250);
		const rows = await this.all(
			`SELECT * FROM client_encrypted_escrow_records ${where} ORDER BY updated_at DESC, created_at DESC LIMIT ?`,
			[...args, limit],
		);
		return rows.map(serializeClientEncryptedEscrowRecord);
	}

	async updateClientEncryptedEscrowRecord(id, patch = {}) {
		await this.ensureInitialized();
		const existing = await this.getClientEncryptedEscrowRecord(id);
		if (!existing) return null;
		const next = {
			...existing,
			...patch,
			metadata: {
				...(patch.metadata ?? existing.metadata ?? {}),
				envelope: {
					...((existing.metadata ?? {}).envelope ?? {}),
					...(patch.ciphertext !== undefined ? { ciphertext: patch.ciphertext } : {}),
					...(patch.nonce !== undefined ? { nonce: patch.nonce } : {}),
					...(patch.salt !== undefined ? { salt: patch.salt } : {}),
					...(patch.kdf !== undefined ? { kdf: patch.kdf } : {}),
					...(patch.kdfParams !== undefined ? { kdfParams: patch.kdfParams } : {}),
					...(patch.encryptionVersion !== undefined ? { encryptionVersion: patch.encryptionVersion } : {}),
					...(patch.deploymentIntent !== undefined ? { deploymentIntent: patch.deploymentIntent } : {}),
				},
			},
			ciphertext: patch.ciphertext ?? existing.metadata?.envelope?.ciphertext ?? null,
			nonce: patch.nonce ?? existing.metadata?.envelope?.nonce ?? null,
			salt: patch.salt ?? existing.metadata?.envelope?.salt ?? null,
			kdf: patch.kdf ?? existing.metadata?.envelope?.kdf ?? null,
			kdfParams: patch.kdfParams ?? existing.metadata?.envelope?.kdfParams ?? null,
			encryptionVersion: patch.encryptionVersion ?? existing.metadata?.envelope?.encryptionVersion ?? null,
			deploymentIntent: patch.deploymentIntent ?? existing.metadata?.envelope?.deploymentIntent ?? null,
		};
		const problems = validateTreeseedClientEncryptedEscrowMetadata(next);
		if (problems.length > 0) throw secretCapabilityValidationError(problems, 'Invalid client-encrypted escrow update.');
		const timestamp = isoNow();
		await this.run(
			`UPDATE client_encrypted_escrow_records
			 SET status = ?, ciphertext_ref = ?, algorithm = ?, wrapping_key_id = ?, created_by_client_id = ?,
			     expires_at = ?, migrated_to = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`,
			[
				next.status,
				next.ciphertextRef,
				next.algorithm,
				next.wrappingKeyId,
				next.createdByClientId ?? null,
				next.expiresAt ?? null,
				next.migratedTo ?? null,
				JSON.stringify(next.metadata ?? {}),
				timestamp,
				id,
			],
		);
		const updated = await this.getClientEncryptedEscrowRecord(id);
		await this.recordSecretCapabilityAudit('client_encrypted_escrow_record.updated', updated);
		return updated;
	}

	async migrateClientEncryptedEscrowRecord(id, input = {}) {
		return this.updateClientEncryptedEscrowRecord(id, {
			status: 'migrated',
			migratedTo: input.migratedTo ?? 'github_actions_secret_enclave',
			metadata: input.metadata,
		});
	}

	async tombstoneClientEncryptedEscrowRecord(id, input = {}) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		await this.run(
			`UPDATE client_encrypted_escrow_records
			 SET status = 'tombstoned', tombstoned_at = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`,
			[ timestamp, JSON.stringify(redactDeploymentValue(input.metadata ?? {})), timestamp, id ],
		);
		const tombstoned = await this.getClientEncryptedEscrowRecord(id);
		await this.recordSecretCapabilityAudit('client_encrypted_escrow_record.tombstoned', tombstoned);
		return tombstoned;
	}

	async upsertGitHubRepositoryGrant(input = {}) {
		await this.ensureInitialized();
		rejectSecretCapabilityPlaintext(input);
		const timestamp = isoNow();
		const id = input.id ?? `${input.teamId}:${safeIdPart(input.repository, 'repository')}`;
		await this.run(
			`INSERT INTO github_repository_grants (
				id, team_id, project_id, repository, installation_id, account_login, account_id, status,
				permissions_json, environments_json, drift_code, observed_at, revoked_at, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				project_id = excluded.project_id,
				repository = excluded.repository,
				installation_id = excluded.installation_id,
				account_login = excluded.account_login,
				account_id = excluded.account_id,
				status = excluded.status,
				permissions_json = excluded.permissions_json,
				environments_json = excluded.environments_json,
				drift_code = excluded.drift_code,
				observed_at = excluded.observed_at,
				revoked_at = excluded.revoked_at,
				metadata_json = excluded.metadata_json,
				updated_at = excluded.updated_at`,
			[
				id,
				input.teamId,
				input.projectId ?? null,
				input.repository,
				input.installationId ?? null,
				input.accountLogin ?? null,
				input.accountId ?? null,
				input.status ?? 'active',
				JSON.stringify(input.permissions ?? {}),
				JSON.stringify(Array.isArray(input.environments) ? input.environments : []),
				input.driftCode ?? null,
				input.observedAt ?? timestamp,
				input.revokedAt ?? null,
				JSON.stringify(redactDeploymentValue(input.metadata ?? {})),
				timestamp,
				timestamp,
			],
		);
		const grant = serializeGitHubRepositoryGrant(await this.first(`SELECT * FROM github_repository_grants WHERE id = ?`, [id]));
		await this.recordSecretCapabilityAudit('github_repository_grant.upserted', grant);
		return grant;
	}

	async listGitHubRepositoryGrants(input = {}) {
		await this.ensureInitialized();
		const clauses = [];
		const values = [];
		if (input.teamId) {
			clauses.push('team_id = ?');
			values.push(input.teamId);
		}
		if (input.projectId !== undefined) {
			clauses.push('project_id = ?');
			values.push(input.projectId);
		}
		if (input.status) {
			clauses.push('status = ?');
			values.push(input.status);
		}
		const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
		const rows = await this.all(
			`SELECT * FROM github_repository_grants ${where} ORDER BY updated_at DESC LIMIT ?`,
			[...values, Math.max(1, Math.min(Number(input.limit ?? 100) || 100, 500))],
		);
		return rows.map(serializeGitHubRepositoryGrant);
	}

	async updateGitHubRepositoryGrantStatus(id, status, input = {}) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		await this.run(
			`UPDATE github_repository_grants
			 SET status = ?, drift_code = ?, revoked_at = ?, observed_at = COALESCE(?, observed_at), updated_at = ?
			 WHERE id = ?`,
			[
				status,
				input.driftCode ?? input.failClosedCode ?? null,
				status === 'revoked' ? (input.revokedAt ?? timestamp) : (input.revokedAt ?? null),
				input.observedAt ?? null,
				timestamp,
				id,
			],
		);
		const grant = serializeGitHubRepositoryGrant(await this.first(`SELECT * FROM github_repository_grants WHERE id = ?`, [id]));
		await this.recordSecretCapabilityAudit(`github_repository_grant.${status}`, grant);
		return grant;
	}

	async upsertGitHubAppInstallationRecord(input = {}) {
		await this.ensureInitialized();
		rejectSecretCapabilityPlaintext(input);
		const timestamp = isoNow();
		const id = input.id ?? `${input.teamId}:github-app-installation:${input.installationId}`;
		await this.run(
			`INSERT INTO github_app_installation_records (
				id, team_id, installation_id, account_login, account_id, account_type, status,
				permissions_json, repository_selection, drift_code, observed_at, revoked_at, suspended_at,
				metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				installation_id = excluded.installation_id,
				account_login = excluded.account_login,
				account_id = excluded.account_id,
				account_type = excluded.account_type,
				status = excluded.status,
				permissions_json = excluded.permissions_json,
				repository_selection = excluded.repository_selection,
				drift_code = excluded.drift_code,
				observed_at = excluded.observed_at,
				revoked_at = excluded.revoked_at,
				suspended_at = excluded.suspended_at,
				metadata_json = excluded.metadata_json,
				updated_at = excluded.updated_at`,
			[
				id,
				input.teamId,
				String(input.installationId ?? ''),
				input.accountLogin ?? null,
				input.accountId == null ? null : String(input.accountId),
				input.accountType ?? null,
				input.status ?? 'active',
				JSON.stringify(input.permissions ?? {}),
				input.repositorySelection ?? null,
				input.driftCode ?? input.failClosedCode ?? null,
				input.observedAt ?? timestamp,
				input.revokedAt ?? null,
				input.suspendedAt ?? null,
				JSON.stringify(redactDeploymentValue(input.metadata ?? {})),
				timestamp,
				timestamp,
			],
		);
		const record = serializeGitHubAppInstallationRecord(await this.first(`SELECT * FROM github_app_installation_records WHERE id = ?`, [id]));
		await this.recordSecretCapabilityAudit('github_app_installation_record.upserted', record);
		return record;
	}

	async getGitHubAppInstallationRecord(input = {}) {
		await this.ensureInitialized();
		if (typeof input === 'string') {
			return serializeGitHubAppInstallationRecord(await this.first(`SELECT * FROM github_app_installation_records WHERE id = ? LIMIT 1`, [input]));
		}
		const teamId = input.teamId;
		const installationId = input.installationId == null ? null : String(input.installationId);
		if (!teamId || !installationId) return null;
		return serializeGitHubAppInstallationRecord(await this.first(
			`SELECT * FROM github_app_installation_records WHERE team_id = ? AND installation_id = ? LIMIT 1`,
			[teamId, installationId],
		));
	}

	async listGitHubAppInstallationRecords(input = {}) {
		await this.ensureInitialized();
		const clauses = [];
		const values = [];
		if (input.teamId) {
			clauses.push('team_id = ?');
			values.push(input.teamId);
		}
		if (input.status) {
			clauses.push('status = ?');
			values.push(input.status);
		}
		const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
		const rows = await this.all(
			`SELECT * FROM github_app_installation_records ${where} ORDER BY updated_at DESC LIMIT ?`,
			[...values, Math.max(1, Math.min(Number(input.limit ?? 100) || 100, 500))],
		);
		return rows.map(serializeGitHubAppInstallationRecord);
	}

	async updateGitHubAppInstallationRecordStatus(id, status, input = {}) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		await this.run(
			`UPDATE github_app_installation_records
			 SET status = ?, drift_code = ?, revoked_at = ?, suspended_at = ?, observed_at = COALESCE(?, observed_at), updated_at = ?
			 WHERE id = ?`,
			[
				status,
				input.driftCode ?? input.failClosedCode ?? null,
				status === 'revoked' ? (input.revokedAt ?? timestamp) : (input.revokedAt ?? null),
				status === 'suspended' ? (input.suspendedAt ?? timestamp) : (input.suspendedAt ?? null),
				input.observedAt ?? null,
				timestamp,
				id,
			],
		);
		const record = serializeGitHubAppInstallationRecord(await this.first(`SELECT * FROM github_app_installation_records WHERE id = ?`, [id]));
		await this.recordSecretCapabilityAudit(`github_app_installation_record.${status}`, record);
		return record;
	}

	async recordGitHubAppTokenIssuance(input = {}) {
		await this.ensureInitialized();
		rejectSecretCapabilityPlaintext(input);
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO github_app_token_issuance_records (
				id, team_id, project_id, assignment_id, provider_id, workday_id, operation_id, repository, installation_id,
				status, token_prefix, token_hash, permissions_json, allowed_operations_json, expires_at, issued_at,
				revoked_at, fail_closed_code, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				input.teamId,
				input.projectId ?? null,
				input.assignmentId ?? null,
				input.providerId ?? null,
				input.workdayId ?? null,
				input.operationId ?? null,
				input.repository,
				String(input.installationId ?? ''),
				input.status ?? 'issued',
				input.tokenPrefix ?? null,
				input.tokenHash ?? null,
				JSON.stringify(input.permissions ?? {}),
				JSON.stringify(Array.isArray(input.allowedOperations) ? input.allowedOperations : []),
				input.expiresAt ?? null,
				input.issuedAt ?? timestamp,
				input.revokedAt ?? null,
				input.failClosedCode ?? null,
				JSON.stringify(redactDeploymentValue(input.metadata ?? {})),
				timestamp,
				timestamp,
			],
		);
		const record = await this.getGitHubAppTokenIssuanceRecord(id);
		await this.recordSecretCapabilityAudit('github_app_token_issuance_record.created', record);
		return record;
	}

	async getGitHubAppTokenIssuanceRecord(id) {
		await this.ensureInitialized();
		return serializeGitHubAppTokenIssuanceRecord(await this.first(`SELECT * FROM github_app_token_issuance_records WHERE id = ? LIMIT 1`, [id]));
	}

	async listGitHubAppTokenIssuanceRecords(input = {}) {
		await this.ensureInitialized();
		const clauses = [];
		const values = [];
		if (input.teamId) {
			clauses.push('team_id = ?');
			values.push(input.teamId);
		}
		if (input.projectId !== undefined) {
			clauses.push('project_id = ?');
			values.push(input.projectId);
		}
		if (input.repository) {
			clauses.push('repository = ?');
			values.push(input.repository);
		}
		if (input.status) {
			clauses.push('status = ?');
			values.push(input.status);
		}
		const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
		const rows = await this.all(
			`SELECT * FROM github_app_token_issuance_records ${where} ORDER BY updated_at DESC LIMIT ?`,
			[...values, Math.max(1, Math.min(Number(input.limit ?? 100) || 100, 500))],
		);
		return rows.map(serializeGitHubAppTokenIssuanceRecord);
	}

	async updateGitHubAppTokenIssuanceStatus(id, status, input = {}) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		await this.run(
			`UPDATE github_app_token_issuance_records
			 SET status = ?, revoked_at = ?, fail_closed_code = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`,
			[
				status,
				status === 'revoked' ? (input.revokedAt ?? timestamp) : (input.revokedAt ?? null),
				input.failClosedCode ?? null,
				JSON.stringify(redactDeploymentValue(input.metadata ?? {})),
				timestamp,
				id,
			],
		);
		const record = await this.getGitHubAppTokenIssuanceRecord(id);
		await this.recordSecretCapabilityAudit(`github_app_token_issuance_record.${status}`, record);
		return record;
	}

	async upsertWorkflowOperationRecord(input = {}) {
		await this.ensureInitialized();
		rejectSecretCapabilityPlaintext(input);
		const metadata = {
			...(input.metadata ?? {}),
			...(input.trustPolicy ? { trustPolicy: input.trustPolicy } : {}),
		};
		const operation = {
			id: input.id,
			name: input.name,
			repository: input.repository,
			workflowFile: input.workflowFile,
			secretBearing: input.secretBearing === true,
			trustedExecutionSetId: input.trustedExecutionSetId,
			dispatch: input.dispatch ?? {},
			inputs: input.inputs ?? [],
			secretClasses: input.secretClasses ?? [],
			providerSuppliedCommandsAllowed: input.providerSuppliedCommandsAllowed === true,
			trustPolicy: input.trustPolicy ?? input.metadata?.trustPolicy ?? {},
			metadata,
		};
		const validation = validateTreeseedSecretsCapabilityRegistry({
			repositoryCredentialProviders: { githubApp: { type: 'github-app' } },
			workflowOperations: {
				trustedExecutionSets: input.trustedExecutionSets ?? [],
				operations: [operation],
			},
		});
		if (!validation.ok) throw secretCapabilityValidationError(validation.problems, 'Invalid workflow operation record.');
		const timestamp = isoNow();
		await this.run(
			`INSERT INTO workflow_operation_records (
				id, team_id, project_id, name, repository, workflow_file, secret_bearing, trusted_execution_set_id,
				dispatch_json, inputs_json, secret_classes_json, status, fail_closed_code, metadata_json, created_at, updated_at, blocked_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				name = excluded.name,
				repository = excluded.repository,
				workflow_file = excluded.workflow_file,
				secret_bearing = excluded.secret_bearing,
				trusted_execution_set_id = excluded.trusted_execution_set_id,
				dispatch_json = excluded.dispatch_json,
				inputs_json = excluded.inputs_json,
				secret_classes_json = excluded.secret_classes_json,
				status = excluded.status,
				fail_closed_code = excluded.fail_closed_code,
				metadata_json = excluded.metadata_json,
				updated_at = excluded.updated_at,
				blocked_at = excluded.blocked_at`,
			[
				operation.id,
				input.teamId,
				input.projectId ?? null,
				operation.name,
				operation.repository,
				operation.workflowFile,
				operation.secretBearing ? 1 : 0,
				operation.trustedExecutionSetId,
				JSON.stringify(operation.dispatch),
				JSON.stringify(operation.inputs),
				JSON.stringify(operation.secretClasses),
				input.status ?? 'active',
				input.failClosedCode ?? null,
				JSON.stringify(redactDeploymentValue(operation.metadata ?? {})),
				timestamp,
				timestamp,
				input.blockedAt ?? null,
			],
		);
		const record = serializeWorkflowOperationRecord(await this.first(`SELECT * FROM workflow_operation_records WHERE id = ?`, [operation.id]));
		await this.recordSecretCapabilityAudit('workflow_operation_record.upserted', record);
		return record;
	}

	async listWorkflowOperationRecords(input = {}) {
		await this.ensureInitialized();
		const clauses = [];
		const values = [];
		if (input.teamId) {
			clauses.push('team_id = ?');
			values.push(input.teamId);
		}
		if (input.projectId !== undefined) {
			clauses.push('project_id = ?');
			values.push(input.projectId);
		}
		if (input.status) {
			clauses.push('status = ?');
			values.push(input.status);
		}
		const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
		const rows = await this.all(
			`SELECT * FROM workflow_operation_records ${where} ORDER BY updated_at DESC LIMIT ?`,
			[...values, Math.max(1, Math.min(Number(input.limit ?? 100) || 100, 500))],
		);
		return rows.map(serializeWorkflowOperationRecord);
	}

	async getWorkflowOperationRecord(id) {
		await this.ensureInitialized();
		return serializeWorkflowOperationRecord(await this.first(`SELECT * FROM workflow_operation_records WHERE id = ? LIMIT 1`, [id]));
	}

	async updateWorkflowOperationRecordStatus(id, status, input = {}) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		await this.run(
			`UPDATE workflow_operation_records
			 SET status = ?, fail_closed_code = ?, blocked_at = ?, updated_at = ?
			 WHERE id = ?`,
			[status, input.failClosedCode ?? null, status === 'blocked' ? (input.blockedAt ?? timestamp) : (input.blockedAt ?? null), timestamp, id],
		);
		const record = serializeWorkflowOperationRecord(await this.first(`SELECT * FROM workflow_operation_records WHERE id = ?`, [id]));
		await this.recordSecretCapabilityAudit(`workflow_operation_record.${status}`, record);
		return record;
	}

	async createWorkflowDispatchRecord(input = {}) {
		await this.ensureInitialized();
		rejectSecretCapabilityPlaintext(input);
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO workflow_dispatch_records (
				id, team_id, project_id, workflow_operation_id, platform_operation_id, repository, workflow_file, ref,
				status, inputs_json, result_json, fail_closed_code, metadata_json, created_at, updated_at, dispatched_at, completed_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				input.teamId,
				input.projectId ?? null,
				input.workflowOperationId,
				input.platformOperationId ?? null,
				input.repository,
				input.workflowFile,
				input.ref ?? null,
				input.status ?? 'queued',
				JSON.stringify(redactDeploymentValue(input.inputs ?? {})),
				JSON.stringify(redactDeploymentValue(input.result ?? {})),
				input.failClosedCode ?? null,
				JSON.stringify(redactDeploymentValue(input.metadata ?? {})),
				timestamp,
				timestamp,
				input.dispatchedAt ?? null,
				input.completedAt ?? null,
			],
		);
		const record = await this.getWorkflowDispatchRecord(id);
		await this.recordSecretCapabilityAudit('workflow_dispatch_record.created', record);
		return record;
	}

	async getWorkflowDispatchRecord(id) {
		await this.ensureInitialized();
		return serializeWorkflowDispatchRecord(await this.first(`SELECT * FROM workflow_dispatch_records WHERE id = ? LIMIT 1`, [id]));
	}

	async updateWorkflowDispatchRecord(id, patch = {}) {
		await this.ensureInitialized();
		rejectSecretCapabilityPlaintext(patch);
		const existing = await this.getWorkflowDispatchRecord(id);
		if (!existing) return null;
		const timestamp = isoNow();
		await this.run(
			`UPDATE workflow_dispatch_records
			 SET status = ?, result_json = ?, fail_closed_code = ?, metadata_json = ?, updated_at = ?,
			     dispatched_at = COALESCE(?, dispatched_at), completed_at = COALESCE(?, completed_at)
			 WHERE id = ?`,
			[
				patch.status ?? existing.status,
				JSON.stringify(redactDeploymentValue(patch.result ?? existing.result ?? {})),
				patch.failClosedCode ?? existing.failClosedCode ?? null,
				JSON.stringify(redactDeploymentValue(patch.metadata ?? existing.metadata ?? {})),
				timestamp,
				patch.dispatchedAt ?? null,
				patch.completedAt ?? null,
				id,
			],
		);
		const record = await this.getWorkflowDispatchRecord(id);
		await this.recordSecretCapabilityAudit('workflow_dispatch_record.updated', record);
		return record;
	}

	async recordTreeDxCredentialIssuance(input = {}) {
		await this.ensureInitialized();
		rejectSecretCapabilityPlaintext(input);
		const timestamp = isoNow();
		const id = input.id ?? randomUUID();
		await this.run(
			`INSERT INTO treedx_credential_issuance_records (
				id, team_id, project_id, assignment_id, repository, credential_provider, status, token_prefix, token_hash,
				scopes_json, allowed_operations_json, expires_at, issued_at, revoked_at, fail_closed_code,
				metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				input.teamId,
				input.projectId,
				input.assignmentId ?? null,
				input.repository ?? null,
				input.credentialProvider ?? 'github-app',
				input.status ?? 'issued',
				input.tokenPrefix ?? null,
				input.tokenHash ?? null,
				JSON.stringify(Array.isArray(input.scopes) ? input.scopes : []),
				JSON.stringify(Array.isArray(input.allowedOperations) ? input.allowedOperations : []),
				input.expiresAt ?? null,
				input.issuedAt ?? timestamp,
				input.revokedAt ?? null,
				input.failClosedCode ?? null,
				JSON.stringify(redactDeploymentValue(input.metadata ?? {})),
				timestamp,
				timestamp,
			],
		);
		const record = await this.getTreeDxCredentialIssuanceRecord(id);
		await this.recordSecretCapabilityAudit('treedx_credential_issuance_record.created', record);
		return record;
	}

	async getTreeDxCredentialIssuanceRecord(id) {
		await this.ensureInitialized();
		return serializeTreeDxCredentialIssuanceRecord(await this.first(`SELECT * FROM treedx_credential_issuance_records WHERE id = ? LIMIT 1`, [id]));
	}

	async updateTreeDxCredentialIssuanceStatus(id, status, input = {}) {
		await this.ensureInitialized();
		const timestamp = isoNow();
		await this.run(
			`UPDATE treedx_credential_issuance_records
			 SET status = ?, revoked_at = ?, fail_closed_code = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`,
			[
				status,
				status === 'revoked' ? (input.revokedAt ?? timestamp) : (input.revokedAt ?? null),
				input.failClosedCode ?? null,
				JSON.stringify(redactDeploymentValue(input.metadata ?? {})),
				timestamp,
				id,
			],
		);
		const record = await this.getTreeDxCredentialIssuanceRecord(id);
		await this.recordSecretCapabilityAudit(`treedx_credential_issuance_record.${status}`, record);
		return record;
	}

	async recordSecretCapabilityAudit(eventType, record, input = {}) {
		if (!record) return null;
		const data = {
			teamId: record.teamId ?? input.teamId ?? null,
			projectId: record.projectId ?? input.projectId ?? null,
			repository: record.repository ?? record.githubSecretTarget?.repository ?? input.repository ?? null,
			workflowOperationId: record.workflowOperationId ?? record.id ?? null,
			workflowFile: record.workflowFile ?? null,
			providerId: input.providerId ?? record.capacityProviderId ?? null,
			assignmentId: record.assignmentId ?? input.assignmentId ?? null,
			status: record.status ?? null,
			failClosedCode: record.failClosedCode ?? record.driftCode ?? input.failClosedCode ?? null,
			record,
		};
		return this.recordAuditEvent({
			eventType,
			actorType: input.actorType ?? 'system',
			actorId: input.actorId ?? null,
			targetType: input.targetType ?? (record.projectId ? 'project' : 'team'),
			targetId: input.targetId ?? record.projectId ?? record.teamId ?? null,
			data,
		});
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

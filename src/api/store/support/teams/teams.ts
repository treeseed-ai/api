import { parseJson } from '../index.ts';

export const TEAM_ROLE_CAPABILITIES = {
    team_owner: [
        'manage_projects',
        'edit_direct',
        'manage_workstreams',
        'publish_market_listings',
        'manage_products',
        'manage_billing',
        'approve_remote_execution',
		'knowledge_read', 'knowledge_author', 'knowledge_link', 'knowledge_review',
		'knowledge_publish', 'knowledge_manage_books', 'knowledge_build_packs',
    ],
    market_steward: ['manage_products', 'publish_market_listings'],
	project_lead: ['manage_projects', 'edit_direct', 'manage_workstreams', 'approve_remote_execution', 'knowledge_read', 'knowledge_author', 'knowledge_link', 'knowledge_review', 'knowledge_publish', 'knowledge_manage_books', 'knowledge_build_packs'],
    service_admin: ['manage_services', 'use_service_credentials', 'authorize_service_operations'],
	knowledge_admin: ['knowledge_read', 'knowledge_author', 'knowledge_link', 'knowledge_review', 'knowledge_publish', 'knowledge_manage_books', 'knowledge_build_packs'],
	knowledge_author: ['knowledge_read', 'knowledge_author', 'knowledge_link'],
	knowledge_reviewer: ['knowledge_read', 'knowledge_review'],
	contributor: ['edit_direct', 'manage_workstreams', 'knowledge_read', 'knowledge_author', 'knowledge_link'],
	reviewer: ['approve_remote_execution', 'knowledge_read', 'knowledge_review'],
    finance: ['manage_billing', 'manage_products'],
	viewer: ['knowledge_read'],
};

export const TEAM_ROLE_DESCRIPTIONS = {
    team_owner: 'Own the team portfolio and all project capabilities.',
    market_steward: 'Manage market products and publish listings.',
    project_lead: 'Lead projects, workstreams, and release promotion.',
    service_admin: 'Manage provider connections, protected credentials, and authorized service operations.',
	knowledge_admin: 'Manage books, review knowledge, publish revisions, and build knowledge packs.',
	knowledge_author: 'Create and link book knowledge in authorized projects.',
	knowledge_reviewer: 'Review knowledge changes and publication diffs.',
    contributor: 'Edit direction and move workstreams forward.',
    reviewer: 'Review staged work and approve remote execution.',
    finance: 'Manage billing and commercial product settings.',
    viewer: 'Read-only participant in team and Commons governance surfaces.',
};

export const ALL_TEAM_CAPABILITIES = [...new Set(Object.values(TEAM_ROLE_CAPABILITIES).flat())];

export const CAPABILITY_PERMISSIONS = {
    manage_projects: 'project:manage',
    edit_direct: 'project:edit',
    manage_workstreams: 'project:workstream:manage',
    publish_market_listings: 'catalog:publish',
    manage_products: 'catalog:manage',
    manage_billing: 'billing:manage',
    approve_remote_execution: 'remote:execution:approve',
    manage_services: 'services:manage',
    use_service_credentials: 'services:credentials:use',
    authorize_service_operations: 'operations:authorize',
	knowledge_read: 'knowledge:read',
	knowledge_author: 'knowledge:author',
	knowledge_link: 'knowledge:link',
	knowledge_review: 'knowledge:review',
	knowledge_publish: 'knowledge:publish',
	knowledge_manage_books: 'knowledge:manage-books',
	knowledge_build_packs: 'knowledge:build-packs',
};

export const TEAM_DELETION_CONFIRMATION_PREFIX = 'DELETE ';

export const TEAM_MANAGEMENT_ROLES = new Set(['team_owner', 'project_lead']);
export const SERVICE_MANAGEMENT_ROLES = new Set(['team_owner', 'project_lead', 'service_admin']);

export const TEAM_RESERVED_NAMES = new Set([
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
    if (name.length > 39
        || !/^[a-z0-9-]+$/u.test(name)
        || name.startsWith('-')
        || name.endsWith('-')
        || name.includes('--')) {
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

export function normalizeTeamRoleKey(value, fallback = 'contributor') {
    const key = String(value ?? '').trim();
    if (key === 'owner')
        return 'team_owner';
    return TEAM_ROLE_CAPABILITIES[key] ? key : fallback;
}

export function primaryTeamRole(roles: any = []) {
	const preferredOrder = ['team_owner', 'project_lead', 'knowledge_admin', 'service_admin', 'market_steward', 'knowledge_author', 'contributor', 'knowledge_reviewer', 'reviewer', 'finance', 'viewer'];
    return preferredOrder.find((role) => roles.includes(role)) ?? roles[0] ?? null;
}

export function serializeTeam(row) {
    if (!row)
        return null;
    const metadata = parseJson(row.metadata_json, {});
    const handle = row.name ?? row.slug;
    return {
        id: row.id,
        slug: row.slug ?? handle,
        name: handle,
        displayName: row.display_name ?? metadata.displayName ?? row.name ?? row.slug,
        logoUrl: row.logo_url ?? metadata.logoUrl ?? null,
        profileSummary: row.profile_summary ?? metadata.profileSummary ?? metadata.description ?? null,
        status: row.status ?? 'active',
        archivedAt: row.archived_at ?? null,
        archivedByUserId: row.archived_by_user_id ?? null,
        restoreDeadlineAt: row.restore_deadline_at ?? null,
        lifecycleVersion: Number(row.lifecycle_version ?? 1),
        metadata,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function teamIsPrivate(team) {
    const visibility = String(team?.metadata?.visibility ?? team?.metadata?.access ?? 'private').toLowerCase();
    return team?.metadata?.privateTreeDx !== false && visibility !== 'public' && team?.metadata?.publicTeam !== true;
}

export function serializeTeamMember(row, roles: any = []) {
    if (!row)
        return null;
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

export const SUPPORTED_TEAM_HOST_PROVIDERS = new Set(['cloudflare', 'railway', 'smtp', 'openai', 'github_copilot', 'openrouter', 'custom']);

export function serializeTeamInvite(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        teamId: row.team_id,
        email: row.email,
        roleKey: row.role_key,
        status: row.status,
        invitedByUserId: row.invited_by_user_id,
        invitedByDisplayName: row.invited_by_display_name ?? null,
        invitedByEmail: row.invited_by_email ?? null,
        acceptedByUserId: row.accepted_by_user_id,
        acceptedAt: row.accepted_at,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeCapability(row) {
    if (!row)
        return null;
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

export function serializeTeamStorageLocator(row) {
    if (!row)
        return null;
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

export function serializeTeamInboxItem(row) {
    if (!row)
        return null;
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

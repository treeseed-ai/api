import { createHmac } from 'node:crypto';
import { redactSensitiveValue } from '../../../security/redact-sensitive-value.ts';
import { TEAM_ROLE_CAPABILITIES } from './index.ts';

export function getNodeBuiltin(name) {
    return globalThis.process?.getBuiltinModule?.(name) ?? null;
}

export function artifactStorageRoot(config) {
    const path = getNodeBuiltin('path');
    if (!path) return null;
    const root = String(config.agentArtifactStorageRoot ?? config.repoRoot ?? process.cwd()).trim();
    return path.resolve(root, '.treeseed/generated/hosted-artifacts');
}

export function safeStoragePathSegment(value) {
    return String(value ?? '')
        .split('/')
        .map((part) => part.trim())
        .filter((part) => part && part !== '.' && part !== '..')
        .join('/');
}

export function safeIdPart(value, fallback = 'item') {
    return String(value ?? fallback)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
        || fallback;
}

export function isoNow() {
    return new Date().toISOString();
}

export function parseJson(value, fallback) {
    if (!value)
        return fallback;
    try {
        return JSON.parse(value);
    }
    catch {
        return fallback;
    }
}

export function serializeSeedRun(row) {
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
        plan: redactSensitiveValue(parseJson(row.plan_json, null)),
        result: redactSensitiveValue(parseJson(row.result_json, null)),
        error: redactSensitiveValue(parseJson(row.error_json, null)),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at,
    };
}

export function missingSchemaError(error) {
    const message = String(error?.message ?? error ?? '').toLowerCase();
    return message.includes('no such table')
        || message.includes('no such column')
        || message.includes('does not exist')
        || message.includes('undefined column');
}

export function objectValue(value, fallback: any = {}) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

export function arrayValue(value) {
    return Array.isArray(value) ? value : [];
}

export const CONTENT_RUNTIME_SOURCES = new Set(['local_directory', 'treedx_snapshot', 'r2_published_manifest', 'r2_preview_overlay']);

export const LOCAL_CONTENT_MATERIALIZATIONS = new Set(['none', 'existing_path', 'managed_clone', 'submodule']);

export const CONTENT_PUBLISH_TARGETS = new Set(['none', 'cloudflare_r2']);

export function stringValue(value, fallback = '') {
    const next = typeof value === 'string' ? value.trim() : '';
    return next || fallback;
}

export function optionalStringValue(value, fallback = null) {
    const next = typeof value === 'string' ? value.trim() : '';
    return next || fallback;
}

export function numberValue(value, fallback = null) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return fallback;
}

export function enumValue(value, allowed, fallback) {
    const next = typeof value === 'string' ? value.trim() : '';
    return allowed.has(next) ? next : fallback;
}

export function requireEnumValue(value, allowed, label) {
    const next = typeof value === 'string' ? value.trim() : '';
    if (allowed.has(next))
        return next;
    const error: Error & Record<string, any> = new Error(`Invalid ${label}.`);
    error.status = 400;
    error.details = { label, value };
    throw error;
}

export function principalIsAdmin(principal) {
    return Boolean(principal
        && (principal.permissions?.includes?.('*:*:*')
            || principal.roles?.includes?.('platform_admin')
            || principal.roles?.includes?.('market_admin')));
}

export function normalizeBaseUrl(baseUrl) {
    return String(baseUrl ?? '').trim().replace(/\/+$/u, '');
}

export function signAssertionPayload(payload, secret) {
    return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function uniqueCapabilities(roles: any = []) {
    const capabilities = roles.flatMap((role) => TEAM_ROLE_CAPABILITIES[role] ?? []);
    return [...new Set(capabilities)];
}

export function normalizeAllocationSlices(value, fallback: any = []) {
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

export function normalizedStrings(values) {
    return arrayValue(values).map((value) => String(value ?? '').trim()).filter(Boolean);
}

export function serializeApprovalRequest(row) {
    if (!row)
        return null;
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

export function isoDate(value) {
    if (typeof value !== 'string' || !value.trim()) {
        return null;
    }
    const parsed = new Date(value);
    return Number.isFinite(parsed.valueOf()) ? parsed.toISOString() : null;
}

export function compareDatesDesc(left, right) {
    const leftTime = isoDate(left) ? new Date(left).getTime() : 0;
    const rightTime = isoDate(right) ? new Date(right).getTime() : 0;
    return rightTime - leftTime;
}

export function latestDate(...values) {
    return values
        .map((value) => isoDate(value))
        .filter(Boolean)
        .sort(compareDatesDesc)[0] ?? null;
}

export function uniqueStrings(values) {
    return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))];
}

export function toActivityItem(kind, input) {
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

export function serializeEntitlement(row) {
    if (!row)
        return null;
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

export function redactBuyerUserId(value) {
    if (!value)
        return null;
    const text = String(value);
    return text.length <= 8 ? 'buyer-user' : `${text.slice(0, 4)}...${text.slice(-4)}`;
}

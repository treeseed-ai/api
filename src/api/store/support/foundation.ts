import { createHmac, type BinaryLike, type KeyObject } from 'node:crypto';
import { redactSensitiveValue } from '../../../security/redact-sensitive-value.ts';
import { TEAM_ROLE_CAPABILITIES } from './index.ts';

export function getNodeBuiltin(name: 'fs'): typeof import('node:fs') | null;
export function getNodeBuiltin(name: 'path'): typeof import('node:path') | null;
export function getNodeBuiltin(name: 'fs' | 'path'): typeof import('node:fs') | typeof import('node:path') | null {
    return name === 'fs' ? globalThis.process?.getBuiltinModule?.('node:fs') ?? null
        : globalThis.process?.getBuiltinModule?.('node:path') ?? null;
}

export function artifactStorageRoot(config: { agentArtifactStorageRoot?: unknown; repoRoot?: unknown }) {
    const path = getNodeBuiltin('path');
    if (!path) return null;
    const root = String(config.agentArtifactStorageRoot ?? config.repoRoot ?? process.cwd()).trim();
    return path.resolve(root, '.treeseed/generated/hosted-artifacts');
}

export function safeStoragePathSegment(value: unknown) {
    return String(value ?? '')
        .split('/')
        .map((part) => part.trim())
        .filter((part) => part && part !== '.' && part !== '..')
        .join('/');
}

export function safeIdPart(value: unknown, fallback = 'item') {
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

export function parseJson(value: unknown, fallback: unknown) {
    if (!value)
        return fallback;
    try {
        return JSON.parse(String(value));
    }
    catch {
        return fallback;
    }
}

export type SeedRunRow = {
    id: string; seed_name: string; seed_version: number; environments_json: string;
    mode: string; state: string; actor_type: string | null; actor_id: string | null;
    manifest_hash: string; plan_json: string; result_json: string | null; error_json: string | null;
    created_at: string; updated_at: string; completed_at: string | null;
};

type SerializedSeedRun = {
    id: string; seedName: string; seedVersion: number; environments: ReturnType<typeof parseJson>;
    mode: string; state: string; actorType: string | null; actorId: string | null;
    manifestHash: string; plan: ReturnType<typeof redactSensitiveValue>; result: ReturnType<typeof redactSensitiveValue>;
    error: ReturnType<typeof redactSensitiveValue>; createdAt: string; updatedAt: string; completedAt: string | null;
};
export function serializeSeedRun(row: SeedRunRow): SerializedSeedRun;
export function serializeSeedRun(row: SeedRunRow | null | undefined): SerializedSeedRun | null;
export function serializeSeedRun(row: SeedRunRow | null | undefined) {
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

export function missingSchemaError(error: unknown) {
    const message = String(error && (typeof error === 'object' || typeof error === 'function') && 'message' in error
        ? error.message ?? error : error ?? '').toLowerCase();
    return message.includes('no such table')
        || message.includes('no such column')
        || message.includes('does not exist')
        || message.includes('undefined column');
}

export function objectValue(value: unknown, fallback: any = {}) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

export function arrayValue(value: unknown) {
    return Array.isArray(value) ? value : [];
}

export const CONTENT_RUNTIME_SOURCES = new Set(['local_directory', 'treedx_snapshot', 'r2_published_manifest', 'r2_preview_overlay']);

export const LOCAL_CONTENT_MATERIALIZATIONS = new Set(['none', 'existing_path', 'managed_clone', 'submodule']);

export const CONTENT_PUBLISH_TARGETS = new Set(['none', 'cloudflare_r2']);

export function stringValue(value: unknown, fallback = '') {
    const next = typeof value === 'string' ? value.trim() : '';
    return next || fallback;
}

export function optionalStringValue(value: unknown, fallback: string): string;
export function optionalStringValue(value: unknown, fallback?: null): string | null;
export function optionalStringValue(value: unknown, fallback: string | null): string | null;
export function optionalStringValue(value: unknown, fallback: string | null = null) {
    const next = typeof value === 'string' ? value.trim() : '';
    return next || fallback;
}

export function numberValue(value: unknown, fallback: number): number;
export function numberValue(value: unknown, fallback?: null): number | null;
export function numberValue(value: unknown, fallback: number | null): number | null;
export function numberValue(value: unknown, fallback: number | null = null) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return fallback;
}

export function enumValue<T>(value: unknown, allowed: ReadonlySet<string>, fallback: T) {
    const next = typeof value === 'string' ? value.trim() : '';
    return allowed.has(next) ? next : fallback;
}

export function requireEnumValue(value: unknown, allowed: ReadonlySet<string>, label: string) {
    const next = typeof value === 'string' ? value.trim() : '';
    if (allowed.has(next))
        return next;
    const error: Error & Record<string, any> = new Error(`Invalid ${label}.`);
    error.status = 400;
    error.details = { label, value };
    throw error;
}

export function principalIsAdmin(principal: { permissions?: readonly string[]; roles?: readonly string[] } | null | undefined) {
    return Boolean(principal
        && (principal.permissions?.includes?.('*:*:*')
            || principal.roles?.includes?.('platform_admin')
            || principal.roles?.includes?.('platform_admin')));
}

export function normalizeBaseUrl(baseUrl: unknown) {
    return String(baseUrl ?? '').trim().replace(/\/+$/u, '');
}

export function signAssertionPayload(payload: BinaryLike, secret: BinaryLike | KeyObject) {
    return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function uniqueCapabilities(roles: readonly string[] = []) {
    const capabilities = roles.flatMap((role) => TEAM_ROLE_CAPABILITIES[role] ?? []);
    return [...new Set(capabilities)];
}

export function normalizeAllocationSlices(value: unknown, fallback: readonly {
    id?: unknown; name?: unknown; label?: unknown; percentage?: unknown; allocationPercent?: unknown;
}[] = []) {
    const raw = Array.isArray(value) ? value : fallback;
    return raw
        .map((slice) => ({
        id: String(slice?.id ?? '').trim(),
        name: String(slice?.name ?? slice?.label ?? slice?.id ?? '').trim(),
        percentage: numberValue(slice?.percentage ?? slice?.allocationPercent, null),
    }))
        .filter((slice): slice is { id: string; name: string; percentage: number } => Boolean(slice.id && slice.name && slice.percentage !== null))
        .map((slice) => ({
        ...slice,
        percentage: Math.max(0, Math.min(100, slice.percentage)),
    }));
}

export function normalizedStrings(values: unknown) {
    return arrayValue(values).map((value) => String(value ?? '').trim()).filter(Boolean);
}

export function serializeApprovalRequest(row: Record<string, unknown> | null | undefined) {
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

export function isoDate(value: unknown) {
    if (typeof value !== 'string' || !value.trim()) {
        return null;
    }
    const parsed = new Date(value);
    return Number.isFinite(parsed.valueOf()) ? parsed.toISOString() : null;
}

export function compareDatesDesc(left: unknown, right: unknown) {
    const leftDate = isoDate(left), rightDate = isoDate(right);
    const leftTime = leftDate ? new Date(leftDate).getTime() : 0;
    const rightTime = rightDate ? new Date(rightDate).getTime() : 0;
    return rightTime - leftTime;
}

export function latestDate(...values: unknown[]) {
    return values
        .map((value) => isoDate(value))
        .filter(Boolean)
        .sort(compareDatesDesc)[0] ?? null;
}

export function uniqueStrings(values: readonly unknown[]) {
    return [...new Set(values.filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).map((value) => value.trim()))];
}

export function toActivityItem(kind: string, input: Record<string, unknown>) {
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

export function serializeEntitlement(row: Record<string, unknown> | null | undefined) {
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

export function redactBuyerUserId(value: unknown) {
    if (!value)
        return null;
    const text = String(value);
    return text.length <= 8 ? 'buyer-user' : `${text.slice(0, 4)}...${text.slice(-4)}`;
}

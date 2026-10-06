import { redactSensitiveValue } from '../../../../security/redact-sensitive-value.ts';
import { parseJson } from '../index.ts';

// Types of the existing native SQL rows, including their actual nullability.
// These do not introduce another operation or persistence representation.
export interface JobRow extends Record<string, unknown> {
    id: string;
    project_id: string;
    namespace: string;
    operation: string;
    status: string;
    preferred_mode: string;
    selected_target: string;
    capability_json: string;
    input_json: string;
    output_json: string | null;
    error_json: string | null;
    requested_by_type: string;
    requested_by_id: string | null;
    assigned_runner_id: string | null;
    idempotency_key: string | null;
    created_at: string;
    updated_at: string;
    started_at: string | null;
    finished_at: string | null;
    cancelled_at: string | null;
}

export interface JobEventRow extends Record<string, unknown> {
    id: string;
    job_id: string;
    seq: number;
    kind: string;
    data_json: string | null;
    created_at: string;
}

export interface PlatformOperationRow extends Record<string, unknown> {
    id: string;
    namespace: string;
    operation: string;
    status: string;
    target: string;
    idempotency_key: string | null;
    input_json: string;
    output_json: string | null;
    error_json: string | null;
    requested_by_type: string;
    requested_by_id: string | null;
    assigned_runner_id: string | null;
    lease_expires_at: string | null;
    created_at: string;
    updated_at: string;
    started_at: string | null;
    finished_at: string | null;
    cancelled_at: string | null;
}

export interface PlatformOperationEventRow extends Record<string, unknown> {
    id: string;
    operation_id: string;
    seq: number;
    kind: string;
    data_json: string;
    created_at: string;
}

export interface ControlPlaneOperationRunnerRow extends Record<string, unknown> {
    id: string;
    runner_key: string;
    name: string;
    environment: string;
    status: string;
    version: string | null;
    capabilities_json: string;
    active_job_count: number;
    max_concurrent_jobs: number;
    heartbeat_at: string | null;
    metadata_json: string;
    created_at: string;
    updated_at: string;
}

export function normalizeOperationCapabilities(capabilities: unknown) {
    return Array.isArray(capabilities)
        ? capabilities.map((entry) => String(entry ?? '').trim()).filter(Boolean)
        : [];
}

// The existing serializer's output, with the native row's nullability retained.
type SerializedJob = Pick<JobRow, 'id' | 'namespace' | 'operation' | 'status'> & {
    projectId: string;
    preferredMode: string;
    selectedTarget: string;
    input: ReturnType<typeof parseJson>;
    output: ReturnType<typeof parseJson>;
    error: ReturnType<typeof parseJson>;
    capability: ReturnType<typeof parseJson>;
    requestedByType: string;
    requestedById: string | null;
    assignedRunnerId: string | null;
    idempotencyKey: string | null;
    createdAt: string;
    updatedAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    cancelledAt: string | null;
};

export function serializeJob(row: JobRow): SerializedJob;
export function serializeJob(row: null | undefined): null;
export function serializeJob(row: JobRow | null | undefined): SerializedJob | null;
export function serializeJob(row: JobRow | null | undefined) {
    if (!row)
        return null;
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

export function serializeJobEvent(row: JobEventRow | null | undefined) {
    if (!row)
        return null;
    return {
        id: row.id,
        jobId: row.job_id,
        seq: Number(row.seq),
        kind: row.kind,
        data: parseJson(row.data_json, {}),
        createdAt: row.created_at,
    };
}

export function serializePlatformOperation(row: PlatformOperationRow | null | undefined) {
    if (!row)
        return null;
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

export function serializePlatformOperationEvent(row: PlatformOperationEventRow | null | undefined) {
    if (!row)
        return null;
    return {
        id: row.id,
        operationId: row.operation_id,
        seq: Number(row.seq),
        kind: row.kind,
        data: parseJson(row.data_json, {}),
        createdAt: row.created_at,
    };
}

export function serializeControlPlaneOperationRunner(row: ControlPlaneOperationRunnerRow | null | undefined) {
    if (!row)
        return null;
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

export function serializeAuditEvent(row: Record<string, unknown> | null | undefined) {
    if (!row)
        return null;
    return {
        id: row.id,
        actorType: row.actor_type,
        actorId: row.actor_id,
        eventType: row.event_type,
        targetType: row.target_type,
        targetId: row.target_id,
        data: redactSensitiveValue(parseJson(row.data_json, {})),
        createdAt: row.created_at,
    };
}

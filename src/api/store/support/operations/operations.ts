import { redactSensitiveValue } from '../../../../security/redact-sensitive-value.ts';
import { parseJson } from '../index.ts';

export function normalizeOperationCapabilities(capabilities) {
    return Array.isArray(capabilities)
        ? capabilities.map((entry) => String(entry ?? '').trim()).filter(Boolean)
        : [];
}

export function serializeJob(row) {
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

export function serializeJobEvent(row) {
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

export function serializePlatformOperation(row) {
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

export function serializePlatformOperationEvent(row) {
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

export function serializeMarketOperationRunner(row) {
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

export function serializeAuditEvent(row) {
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

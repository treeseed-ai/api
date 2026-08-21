import { randomUUID } from 'node:crypto';
import { isoNow,ControlPlaneStore,serializePlatformOperation } from "../../../persistence/store.ts";
export async function createPlatformOperationMethod(this: ControlPlaneStore, input) {
    await this.ensureInitialized();
    if (input.idempotencyKey) {
        const existing = await this.first(`SELECT * FROM platform_operations
				 WHERE namespace = ? AND operation = ? AND idempotency_key = ?
				 ORDER BY created_at DESC LIMIT 1`, [input.namespace, input.operation, input.idempotencyKey]);
        if (existing) {
            return serializePlatformOperation(existing);
        }
    }
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    const status = typeof input.status === 'string' && input.status.trim() ? input.status.trim() : 'queued';
    await this.run(`INSERT INTO platform_operations (
				id, namespace, operation, status, target, idempotency_key, input_json, output_json, error_json,
				requested_by_type, requested_by_id, assigned_runner_id, lease_expires_at,
				created_at, updated_at, started_at, finished_at, cancelled_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, ?, ?, NULL, NULL, NULL)`, [
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
    ]);
    await this.appendPlatformOperationEvent(id, 'created', {
        namespace: input.namespace,
        operation: input.operation,
        target: input.target ?? 'market_operations_runner',
        status,
    });
    return this.findPlatformOperationById(id);
}

import { randomUUID } from 'node:crypto';
import { isoNow,MarketControlPlaneStore,serializeJob } from "../../../persistence/store.ts";
export async function createJobMethod(this: MarketControlPlaneStore, input) {
    await this.ensureInitialized();
    if (input.idempotencyKey) {
        const existing = await this.first(`SELECT * FROM remote_jobs WHERE project_id = ? AND idempotency_key = ? ORDER BY created_at DESC LIMIT 1`, [input.projectId, input.idempotencyKey]);
        if (existing) {
            return serializeJob(existing);
        }
    }
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    const initialStatus = typeof input.status === 'string' && input.status.trim() ? input.status.trim() : 'pending';
    await this.run(`INSERT INTO remote_jobs (
				id, project_id, namespace, operation, status, preferred_mode, selected_target, capability_json,
				input_json, output_json, error_json, requested_by_type, requested_by_id, assigned_runner_id,
				idempotency_key, created_at, updated_at, started_at, finished_at, cancelled_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL)`, [
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
    ]);
    await this.appendJobEvent(id, 'created', {
        namespace: input.namespace,
        operation: input.operation,
        selectedTarget: input.selectedTarget,
        status: initialStatus,
    });
    return this.findJobById(id);
}

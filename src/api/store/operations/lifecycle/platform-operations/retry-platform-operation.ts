import { isoNow,ControlPlaneStore } from "../../../../persistence/store.ts";
export async function retryPlatformOperationMethod(this: ControlPlaneStore, operationId, input: any = {}) {
    await this.ensureInitialized();
    const existing = await this.findPlatformOperationById(operationId);
    if (!existing)
        return null;
    const timestamp = isoNow();
    const nextInput = {
        ...(existing.input ?? {}),
        ...(input.inputPatch && typeof input.inputPatch === 'object' ? input.inputPatch : {}),
    };
    await this.run(`UPDATE platform_operations
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
			 WHERE id = ?`, [JSON.stringify(nextInput), timestamp, operationId]);
    await this.appendPlatformOperationEvent(operationId, 'retry_queued', {
        status: 'queued',
    });
    return this.findPlatformOperationById(operationId);
}

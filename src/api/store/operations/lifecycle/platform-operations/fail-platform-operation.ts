import { isoNow,ControlPlaneStore } from "../../../../persistence/store.ts";
export async function failPlatformOperationMethod(this: ControlPlaneStore, operationId, input: any = {}) {
    await this.ensureInitialized();
    await this.assertPlatformOperationRunnerUpdate(operationId, input.runnerId);
    const timestamp = isoNow();
    await this.run(`UPDATE platform_operations
			 SET status = 'failed',
			     error_json = ?,
			     lease_expires_at = NULL,
			     updated_at = ?,
			     finished_at = ?
			 WHERE id = ?`, [JSON.stringify(input.error ?? { message: 'Platform operation failed.' }), timestamp, timestamp, operationId]);
    await this.appendPlatformOperationEvent(operationId, input.event?.kind ?? 'failed', input.event?.data ?? {});
    return this.findPlatformOperationById(operationId);
}

import { isoNow,ControlPlaneStore } from "../../../../persistence/store.ts";
export async function completePlatformOperationMethod(this: ControlPlaneStore, operationId, input: any = {}) {
    await this.ensureInitialized();
    await this.assertPlatformOperationRunnerUpdate(operationId, input.runnerId);
    const timestamp = isoNow();
    await this.run(`UPDATE platform_operations
			 SET status = 'succeeded',
			     output_json = ?,
			     error_json = NULL,
			     lease_expires_at = NULL,
			     updated_at = ?,
			     finished_at = ?
			 WHERE id = ?`, [JSON.stringify(input.output ?? null), timestamp, timestamp, operationId]);
    await this.appendPlatformOperationEvent(operationId, input.event?.kind ?? 'completed', input.event?.data ?? {});
    return this.findPlatformOperationById(operationId);
}

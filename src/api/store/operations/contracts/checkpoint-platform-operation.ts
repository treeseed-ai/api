import { isoNow,ControlPlaneStore } from "../../../persistence/store.ts";
export async function checkpointPlatformOperationMethod(this: ControlPlaneStore, operationId, input: any = {}) {
    await this.ensureInitialized();
    await this.assertPlatformOperationRunnerUpdate(operationId, input.runnerId);
    const timestamp = isoNow();
    await this.run(`UPDATE platform_operations
			 SET status = 'running',
			     output_json = ?,
			     updated_at = ?
			 WHERE id = ?`, [JSON.stringify(input.output ?? null), timestamp, operationId]);
    if (input.event) {
        await this.appendPlatformOperationEvent(operationId, input.event.kind ?? 'checkpoint', input.event.data ?? {});
    }
    else {
        await this.appendPlatformOperationEvent(operationId, 'checkpoint', { runnerId: input.runnerId ?? null });
    }
    return this.findPlatformOperationById(operationId);
}

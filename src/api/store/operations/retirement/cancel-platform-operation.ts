import { isoNow,MarketControlPlaneStore } from "../../../persistence/store.ts";
export async function cancelPlatformOperationMethod(this: MarketControlPlaneStore, operationId) {
    await this.ensureInitialized();
    const timestamp = isoNow();
    await this.run(`UPDATE platform_operations
			 SET status = CASE
			 	WHEN status IN ('succeeded', 'failed', 'cancelled') THEN status
			 	ELSE 'cancelled'
			 END,
			     cancelled_at = CASE
			     	WHEN status IN ('succeeded', 'failed', 'cancelled') THEN cancelled_at
			     	ELSE ?
			     END,
			     updated_at = ?
			 WHERE id = ?`, [timestamp, timestamp, operationId]);
    await this.appendPlatformOperationEvent(operationId, 'cancelled', {});
    return this.findPlatformOperationById(operationId);
}

import { isoNow,MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function renewPlatformOperationLeaseMethod(this: MarketControlPlaneStore, operationId, input: any = {}) {
    await this.ensureInitialized();
    await this.assertPlatformOperationRunnerUpdate(operationId, input.runnerId);
    const leaseSeconds = Math.max(30, Math.min(Number(input.leaseSeconds ?? 300), 3600));
    const timestamp = isoNow();
    const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    await this.run(`UPDATE platform_operations
			 SET lease_expires_at = ?,
			     updated_at = ?
			 WHERE id = ?`, [leaseExpiresAt, timestamp, operationId]);
    await this.appendPlatformOperationEvent(operationId, input.event?.kind ?? 'runner.lease_renewed', input.event?.data ?? { runnerId: input.runnerId, leaseExpiresAt });
    return this.findPlatformOperationById(operationId);
}

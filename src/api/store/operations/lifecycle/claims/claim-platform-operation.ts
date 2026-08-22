import { isoNow,ControlPlaneStore,normalizeOperationCapabilities } from "../../../../persistence/store.ts";
export async function claimPlatformOperationMethod(this: ControlPlaneStore, input: any = {}) {
    await this.ensureInitialized();
    const runnerId = input.runnerId;
    const limit = Math.max(1, Math.min(Number(input.limit ?? 1), 1));
    const leaseSeconds = Math.max(30, Math.min(Number(input.leaseSeconds ?? 300), 3600));
    const now = isoNow();
    const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    const capabilities = normalizeOperationCapabilities(input.capabilities);
    const capabilityWhere = capabilities.length > 0
        ? ` AND (${capabilities.map(() => `(namespace || ':' || operation) = ?`).join(' OR ')})`
        : '';
    const rows = input.operationId
        ? await this.all(`SELECT * FROM platform_operations
				 WHERE id = ? AND (
				    status = 'queued'
				    OR (status IN ('leased', 'running') AND lease_expires_at IS NOT NULL AND lease_expires_at < ?)
				 )
				 ${capabilityWhere}
				 ORDER BY created_at ASC LIMIT ?`, [input.operationId, now, ...capabilities, limit])
        : await this.all(`SELECT * FROM platform_operations
				 WHERE (
				    status = 'queued'
				    OR (status IN ('leased', 'running') AND lease_expires_at IS NOT NULL AND lease_expires_at < ?)
				 )
				 ${capabilityWhere}
				 ORDER BY created_at ASC LIMIT ?`, [now, ...capabilities, limit]);
    const row = rows[0];
    if (!row)
        return null;
    await this.run(`UPDATE platform_operations
			 SET status = 'leased',
			     assigned_runner_id = ?,
			     lease_expires_at = ?,
			     started_at = COALESCE(started_at, ?),
			     updated_at = ?
			 WHERE id = ?`, [runnerId, leaseExpiresAt, now, now, row.id]);
	const reclaimed = ['leased', 'running'].includes(String(row.status));
	await this.appendPlatformOperationEvent(row.id, reclaimed ? 'runner.lease_reclaimed' : 'claimed', {
		runnerId,
		leaseExpiresAt,
		...(reclaimed ? { previousRunnerId: row.assigned_runner_id ?? null, previousStatus: row.status } : {}),
	});
    return this.findPlatformOperationById(row.id);
}

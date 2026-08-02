import { isoNow,MarketControlPlaneStore,serializePlatformRepositoryClaim } from "../../../../persistence/store.ts";
export async function renewPlatformRepositoryClaimsForRunnerMethod(this: MarketControlPlaneStore, runnerId, leaseSeconds = 300) {
    await this.ensureInitialized();
    if (!runnerId)
        return [];
    const timestamp = isoNow();
    const boundedLeaseSeconds = Math.max(30, Math.min(Number(leaseSeconds ?? 300), 3600));
    const leaseExpiresAt = new Date(Date.now() + boundedLeaseSeconds * 1000).toISOString();
    await this.run(`UPDATE platform_repository_claims
			 SET lease_expires_at = ?,
			     updated_at = ?
			 WHERE runner_id = ? AND claim_state = 'active'`, [leaseExpiresAt, timestamp, runnerId]);
    const rows = await this.all(`SELECT * FROM platform_repository_claims WHERE runner_id = ? AND claim_state = 'active' ORDER BY updated_at DESC`, [runnerId]);
    return rows.map(serializePlatformRepositoryClaim);
}

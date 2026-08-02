import { isoNow,MarketControlPlaneStore,parseJson,serializePlatformRepositoryClaim } from "../../../../persistence/store.ts";
export async function releasePlatformRepositoryClaimsForRunnerMethod(this: MarketControlPlaneStore, runnerId, input: any = {}) {
    await this.ensureInitialized();
    if (!runnerId)
        return [];
    const timestamp = isoNow();
    const metadataPatch = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
    const rows = await this.all(`SELECT * FROM platform_repository_claims WHERE runner_id = ? AND claim_state = 'active'`, [runnerId]);
    for (const row of rows) {
        await this.run(`UPDATE platform_repository_claims
				 SET claim_state = ?,
				     branch = COALESCE(?, branch),
				     commit_sha = COALESCE(?, commit_sha),
				     lease_expires_at = NULL,
				     metadata_json = ?,
				     updated_at = ?
				 WHERE id = ?`, [
            input.claimState ?? 'released',
            input.branch ?? null,
            input.commitSha ?? null,
            JSON.stringify({ ...parseJson(row.metadata_json, {}), ...metadataPatch }),
            timestamp,
            row.id,
        ]);
    }
    return rows.map((row) => serializePlatformRepositoryClaim({ ...row, claim_state: input.claimState ?? 'released', updated_at: timestamp }));
}

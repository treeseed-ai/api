import { randomUUID } from 'node:crypto';
import { isoNow,MarketControlPlaneStore,parseJson,platformRepositoryKey,platformRepositoryWorkspacePath,serializePlatformRepositoryClaim } from "../../../persistence/store.ts";
export async function upsertPlatformRepositoryClaimMethod(this: MarketControlPlaneStore, input: any = {}) {
    await this.ensureInitialized();
    const repository = input.repository && typeof input.repository === 'object' ? input.repository : {};
    const repositoryKey = input.repositoryKey ?? platformRepositoryKey(repository);
    const runnerId = input.runnerId;
    if (!runnerId) {
        const error: Error & Record<string, any> = new Error('runnerId is required for platform repository claims.');
        error.status = 400;
        throw error;
    }
    const timestamp = isoNow();
    const leaseSeconds = Math.max(30, Math.min(Number(input.leaseSeconds ?? 300), 3600));
    const leaseExpiresAt = input.leaseExpiresAt ?? new Date(Date.now() + leaseSeconds * 1000).toISOString();
    await this.run(`UPDATE platform_repository_claims
             SET claim_state = 'released', updated_at = ?
             WHERE repository_key = ?
               AND claim_state = 'active'
               AND lease_expires_at IS NOT NULL
               AND lease_expires_at <= ?`, [timestamp, repositoryKey, timestamp]);
    const existing = input.id
		? await this.first(`SELECT * FROM platform_repository_claims WHERE id = ? AND claim_state = 'active' LIMIT 1`, [input.id])
		: await this.first(`SELECT * FROM platform_repository_claims
			 WHERE repository_key = ? AND runner_id = ? AND claim_state = 'active'
			 LIMIT 1`, [repositoryKey, runnerId]);
    if (existing) {
        await this.run(`UPDATE platform_repository_claims
				 SET workspace_path = ?,
				     branch = ?,
				     commit_sha = ?,
				     lease_expires_at = ?,
				     metadata_json = ?,
				     updated_at = ?
				 WHERE id = ?`, [
            input.workspacePath ?? existing.workspace_path,
            input.branch ?? existing.branch,
            input.commitSha ?? existing.commit_sha,
            leaseExpiresAt,
            JSON.stringify(input.metadata ?? parseJson(existing.metadata_json, {})),
            timestamp,
            existing.id,
        ]);
        return serializePlatformRepositoryClaim(await this.first(`SELECT * FROM platform_repository_claims WHERE id = ?`, [existing.id]));
    }
    const id = input.id ?? randomUUID();
    await this.run(`INSERT INTO platform_repository_claims (
				id, repository_key, runner_id, workspace_path, branch, commit_sha,
				claim_state, lease_expires_at, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`, [
        id,
        repositoryKey,
        runnerId,
        input.workspacePath ?? platformRepositoryWorkspacePath(input.workspaceRoot ?? '/data', repository, input.operationId),
        input.branch ?? repository.defaultBranch ?? null,
        input.commitSha ?? null,
        leaseExpiresAt,
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        timestamp,
    ]);
    return serializePlatformRepositoryClaim(await this.first(`SELECT * FROM platform_repository_claims WHERE id = ?`, [id]));
}

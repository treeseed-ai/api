import { randomUUID } from 'node:crypto';
import { isoNow,ControlPlaneStore,stableHash,tokenPrefix } from "../../../persistence/store.ts";
export async function createTeamApiKeyMethod(this: ControlPlaneStore, teamId, input) {
    await this.ensureInitialized();
    const token = `tsk_${randomUUID().replaceAll('-', '')}`;
    const timestamp = isoNow();
    const id = randomUUID();
    await this.run(`INSERT INTO team_api_keys (
				id, team_id, name, key_prefix, key_hash, permissions_json, expires_at, last_used_at, revoked_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`, [
        id,
        teamId,
        input.name,
        tokenPrefix(token),
        stableHash(token, String(this.config.authSecret)),
        JSON.stringify(input.permissions ?? []),
        input.expiresAt ?? null,
        timestamp,
        timestamp,
    ]);
    return {
        id,
        token,
        prefix: tokenPrefix(token),
        name: input.name,
        expiresAt: input.expiresAt ?? null,
    };
}

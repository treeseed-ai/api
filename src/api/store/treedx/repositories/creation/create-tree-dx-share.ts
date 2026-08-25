import { randomUUID } from 'node:crypto';
import { isoNow,ControlPlaneStore,objectValue,serializeTreeDxInstance,serializeTreeDxShare } from "../../../../persistence/store.ts";
export async function createTreeDxShareMethod(this: ControlPlaneStore, teamId, input: any = {}) {
    await this.ensureInitialized();
    const timestamp = isoNow();
    const instance = input.instanceId
        ? serializeTreeDxInstance(await this.first(`SELECT * FROM treedx_instances WHERE id = ? LIMIT 1`, [input.instanceId]))
        : await this.getPrimaryTreeDxInstance(teamId);
    if (instance && instance.teamId !== teamId)
        return null;
    const id = input.id ?? randomUUID();
    await this.run(`INSERT INTO treedx_shares (
				id, team_id, instance_id, project_id, library_id, scope, target_team_id, trust_grant_json,
				public_read, status, expires_at, metadata_json, created_at, updated_at, revoked_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        teamId,
        input.instanceId ?? instance?.id ?? null,
        input.projectId ?? null,
        input.libraryId ?? null,
        String(input.scope ?? (input.publicRead ? 'public_federation' : 'team')),
        input.targetTeamId ?? null,
        JSON.stringify(objectValue(input.trustGrant, {})),
        Number(Boolean(input.publicRead)),
        String(input.status ?? 'active'),
        input.expiresAt ?? null,
        JSON.stringify(objectValue(input.metadata, {})),
        timestamp,
        timestamp,
        null,
    ]);
    return serializeTreeDxShare(await this.first(`SELECT * FROM treedx_shares WHERE id = ? LIMIT 1`, [id]));
}

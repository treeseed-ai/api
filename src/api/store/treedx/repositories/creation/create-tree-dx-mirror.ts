import { randomUUID } from 'node:crypto';
import { isoNow,ControlPlaneStore,objectValue,serializeTreeDxInstance,serializeTreeDxMirror } from "../../../../persistence/store.ts";
export async function createTreeDxMirrorMethod(this: ControlPlaneStore, teamId, input: any = {}) {
    await this.ensureInitialized();
    const instance = input.instanceId
        ? serializeTreeDxInstance(await this.first(`SELECT * FROM treedx_instances WHERE id = ? LIMIT 1`, [input.instanceId]))
        : await this.getPrimaryTreeDxInstance(teamId);
    if (!instance || instance.teamId !== teamId)
        return null;
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    await this.run(`INSERT INTO treedx_mirrors (
				id, team_id, instance_id, name, direction, target_kind, target_url, status, instructions,
				last_sync_at, last_sync_status, last_sync_metadata_json, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        teamId,
        instance.id,
        String(input.name ?? 'TreeDX mirror'),
        String(input.direction ?? 'bidirectional'),
        String(input.targetKind ?? 'git'),
        input.targetUrl ?? null,
        String(input.status ?? 'pending'),
        input.instructions ?? `Connect this mirror to ${instance.baseUrl ?? 'the team TreeDX'} and sync the selected libraries. Store credentials in the target secret manager, not in seed exports.`,
        null,
        null,
        JSON.stringify({}),
        JSON.stringify(objectValue(input.metadata, {})),
        timestamp,
        timestamp,
    ]);
    return serializeTreeDxMirror(await this.first(`SELECT * FROM treedx_mirrors WHERE id = ? LIMIT 1`, [id]));
}

import { isoNow,MarketControlPlaneStore,objectValue,serializeTreeDxMirror } from "../../../../persistence/store.ts";
export async function syncTreeDxMirrorMethod(this: MarketControlPlaneStore, teamId, mirrorId, input: any = {}) {
    await this.ensureInitialized();
    const existing = serializeTreeDxMirror(await this.first(`SELECT * FROM treedx_mirrors WHERE team_id = ? AND id = ? LIMIT 1`, [teamId, mirrorId]));
    if (!existing)
        return null;
    const timestamp = isoNow();
    await this.run(`UPDATE treedx_mirrors
			 SET status = ?, last_sync_at = ?, last_sync_status = ?, last_sync_metadata_json = ?, updated_at = ?
			 WHERE team_id = ? AND id = ?`, [
        String(input.status ?? 'syncing'),
        timestamp,
        String(input.lastSyncStatus ?? 'queued'),
        JSON.stringify(objectValue(input.metadata, {})),
        timestamp,
        teamId,
        mirrorId,
    ]);
    return serializeTreeDxMirror(await this.first(`SELECT * FROM treedx_mirrors WHERE team_id = ? AND id = ? LIMIT 1`, [teamId, mirrorId]));
}

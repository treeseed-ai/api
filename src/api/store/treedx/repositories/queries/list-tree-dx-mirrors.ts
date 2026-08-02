import { MarketControlPlaneStore,serializeTreeDxMirror } from "../../../../persistence/store.ts";
export async function listTreeDxMirrorsMethod(this: MarketControlPlaneStore, teamId, instanceId = null) {
    await this.ensureInitialized();
    let rows = instanceId
        ? await this.all(`SELECT * FROM treedx_mirrors WHERE team_id = ? AND instance_id = ? ORDER BY created_at ASC`, [teamId, instanceId])
        : await this.all(`SELECT * FROM treedx_mirrors WHERE team_id = ? ORDER BY created_at ASC`, [teamId]);
    if (rows.length === 0) {
        rows = (await this.all(`SELECT * FROM treedx_mirrors ORDER BY created_at ASC`))
            .filter((row) => row.team_id === teamId && (!instanceId || row.instance_id === instanceId));
    }
    return rows.map(serializeTreeDxMirror).filter(Boolean);
}

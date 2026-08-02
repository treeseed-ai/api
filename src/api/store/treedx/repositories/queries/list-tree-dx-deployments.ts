import { MarketControlPlaneStore,serializeTreeDxDeployment } from "../../../../persistence/store.ts";
export async function listTreeDxDeploymentsMethod(this: MarketControlPlaneStore, teamId, instanceId = null) {
    await this.ensureInitialized();
    let rows = instanceId
        ? await this.all(`SELECT * FROM treedx_deployments WHERE team_id = ? AND instance_id = ? ORDER BY created_at DESC`, [teamId, instanceId])
        : await this.all(`SELECT * FROM treedx_deployments WHERE team_id = ? ORDER BY created_at DESC`, [teamId]);
    if (rows.length === 0) {
        rows = (await this.all(`SELECT * FROM treedx_deployments ORDER BY created_at DESC`))
            .filter((row) => row.team_id === teamId && (!instanceId || row.instance_id === instanceId));
    }
    return rows.map(serializeTreeDxDeployment).filter(Boolean);
}

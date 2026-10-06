import { ControlPlaneStore,serializeTreeDxShare } from "../../../../persistence/store.ts";
import type { TreeDxShareRow } from "../../../../persistence/store.ts";
export async function listTreeDxSharesMethod(this: ControlPlaneStore, teamId: string) {
    await this.ensureInitialized();
    let rows = await this.all<TreeDxShareRow>(`SELECT * FROM treedx_shares WHERE team_id = ? ORDER BY created_at ASC`, [teamId]);
    if (rows.length === 0) {
        rows = (await this.all<TreeDxShareRow>(`SELECT * FROM treedx_shares ORDER BY created_at ASC`))
            .filter((row) => row.team_id === teamId);
    }
    return rows
        .map(serializeTreeDxShare)
        .filter(Boolean);
}

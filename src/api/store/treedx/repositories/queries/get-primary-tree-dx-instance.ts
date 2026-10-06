import { ControlPlaneStore,serializeTreeDxInstance } from "../../../../persistence/store.ts";
import type { TreeDxInstanceRow } from "../../../../persistence/store.ts";
export async function getPrimaryTreeDxInstanceMethod(this: ControlPlaneStore, teamId: string) {
    await this.ensureInitialized();
    const primary = serializeTreeDxInstance(await this.first<TreeDxInstanceRow>(`SELECT * FROM treedx_instances WHERE team_id = ? AND COALESCE("primary", 1) != 0 AND status != 'disabled' ORDER BY updated_at DESC LIMIT 1`, [teamId]));
    if (primary)
        return primary;
    const rows = await this.all<TreeDxInstanceRow>(`SELECT * FROM treedx_instances ORDER BY updated_at DESC`);
    return rows
        .map(serializeTreeDxInstance)
        .find((instance) => instance && instance.teamId === teamId && instance.primary && instance.status !== 'disabled') ?? null;
}

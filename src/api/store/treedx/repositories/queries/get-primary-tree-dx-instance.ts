import { MarketControlPlaneStore,serializeTreeDxInstance } from "../../../../persistence/store.ts";
export async function getPrimaryTreeDxInstanceMethod(this: MarketControlPlaneStore, teamId) {
    await this.ensureInitialized();
    const primary = serializeTreeDxInstance(await this.first(`SELECT * FROM treedx_instances WHERE team_id = ? AND COALESCE("primary", 1) != 0 AND status != 'disabled' ORDER BY updated_at DESC LIMIT 1`, [teamId]));
    if (primary)
        return primary;
    const rows = await this.all(`SELECT * FROM treedx_instances ORDER BY updated_at DESC`);
    return rows
        .map(serializeTreeDxInstance)
        .find((instance) => instance?.teamId === teamId && instance.primary && instance.status !== 'disabled') ?? null;
}

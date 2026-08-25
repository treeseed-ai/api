import { ControlPlaneStore,serializeTeamInboxItem } from "../../../../persistence/store.ts";
export async function listPersistedTeamInboxItemsMethod(this: ControlPlaneStore, teamId) {
    await this.ensureInitialized();
    const rows = await this.all(`SELECT * FROM team_inbox_items WHERE team_id = ? ORDER BY created_at DESC`, [teamId]);
    return rows.map(serializeTeamInboxItem);
}

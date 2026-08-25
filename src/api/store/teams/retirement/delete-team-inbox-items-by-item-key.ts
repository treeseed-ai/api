import { ControlPlaneStore } from "../../../persistence/store.ts";
export async function deleteTeamInboxItemsByItemKeyMethod(this: ControlPlaneStore, teamId, itemKey) {
    await this.ensureInitialized();
    await this.run(`DELETE FROM team_inbox_items WHERE team_id = ? AND item_key = ?`, [teamId, itemKey]);
}

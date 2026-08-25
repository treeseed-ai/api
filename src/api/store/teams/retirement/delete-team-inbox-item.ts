import { ControlPlaneStore } from "../../../persistence/store.ts";
export async function deleteTeamInboxItemMethod(this: ControlPlaneStore, id) {
    await this.ensureInitialized();
    await this.run(`DELETE FROM team_inbox_items WHERE id = ?`, [id]);
}

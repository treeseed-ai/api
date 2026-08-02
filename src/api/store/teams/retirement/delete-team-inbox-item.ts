import { MarketControlPlaneStore } from "../../../persistence/store.ts";
export async function deleteTeamInboxItemMethod(this: MarketControlPlaneStore, id) {
    await this.ensureInitialized();
    await this.run(`DELETE FROM team_inbox_items WHERE id = ?`, [id]);
}

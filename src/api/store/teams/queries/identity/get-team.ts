import { ControlPlaneStore,serializeTeam } from "../../../../persistence/store.ts";
export async function getTeamMethod(this: ControlPlaneStore, teamId) {
    await this.ensureInitialized();
    return serializeTeam(await this.first(`SELECT * FROM teams WHERE id = ?`, [teamId]));
}

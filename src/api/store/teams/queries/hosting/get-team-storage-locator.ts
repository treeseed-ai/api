import { ControlPlaneStore,serializeTeamStorageLocator } from "../../../../persistence/store.ts";
export async function getTeamStorageLocatorMethod(this: ControlPlaneStore, teamId) {
    await this.ensureInitialized();
    return serializeTeamStorageLocator(await this.first(`SELECT * FROM team_storage_locators WHERE team_id = ?`, [teamId]));
}

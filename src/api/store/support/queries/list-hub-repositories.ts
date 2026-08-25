import { ControlPlaneStore,serializeHubRepository } from "../../../persistence/store.ts";
export async function listHubRepositoriesMethod(this: ControlPlaneStore, hubId) {
    await this.ensureInitialized();
    const rows = await this.all(`SELECT * FROM hub_repositories WHERE hub_id = ? ORDER BY role ASC`, [hubId]);
    return rows.map(serializeHubRepository);
}

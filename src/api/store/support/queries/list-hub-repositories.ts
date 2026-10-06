import { ControlPlaneStore,serializeHubRepository, type HubRepositoryRow } from "../../../persistence/store.ts";
export async function listHubRepositoriesMethod(this: ControlPlaneStore, hubId: string) {
    await this.ensureInitialized();
    const rows = await this.all<HubRepositoryRow>(`SELECT * FROM hub_repositories WHERE hub_id = ? ORDER BY role ASC`, [hubId]);
    return rows.map(row => serializeHubRepository(row));
}

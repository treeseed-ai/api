import { MarketControlPlaneStore,serializeProject } from "../../../../persistence/store.ts";
export async function getProjectMethod(this: MarketControlPlaneStore, projectId) {
    await this.ensureInitialized();
    return serializeProject(await this.first(`SELECT * FROM projects WHERE id = ?`, [projectId]));
}

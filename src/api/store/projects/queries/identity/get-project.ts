import { ControlPlaneStore,serializeProject, type ProjectRow } from "../../../../persistence/store.ts";
export async function getProjectMethod(this: ControlPlaneStore, projectId: string) {
    await this.ensureInitialized();
    return serializeProject(await this.first<ProjectRow>(`SELECT * FROM projects WHERE id = ?`, [projectId]));
}

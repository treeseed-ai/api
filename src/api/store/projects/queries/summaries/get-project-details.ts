import { ControlPlaneStore,serializeEntitlement } from "../../../../persistence/store.ts";
export async function getProjectDetailsMethod(this: ControlPlaneStore, projectId) {
    await this.ensureInitialized();
    const project = await this.getProject(projectId);
    if (!project) {
        return null;
    }
    const [entitlement, repositories, contentSource, architecture] = await Promise.all([
        (async () => serializeEntitlement(await this.first(`SELECT * FROM entitlements WHERE project_id = ? LIMIT 1`, [projectId])))(),
        this.listHubRepositories(projectId),
        this.getHubContentSource(projectId),
        this.getProjectArchitecture(projectId),
    ]);
    return {
        project,
        entitlement,
        repositories,
        contentSource,
        architecture,
    };
}

import { ControlPlaneStore,normalizeProjectArchitecture } from "../../../../persistence/store.ts";
export async function getProjectArchitectureMethod(this: ControlPlaneStore, projectId) {
    await this.ensureInitialized();
    const project = await this.getProject(projectId);
    if (!project)
        return null;
    const architecture = project.metadata?.architecture;
    if (architecture && typeof architecture === 'object' && !Array.isArray(architecture)) {
        return normalizeProjectArchitecture(architecture);
    }
    return null;
}

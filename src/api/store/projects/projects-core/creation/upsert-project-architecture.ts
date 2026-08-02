import { MarketControlPlaneStore,normalizeProjectArchitecture } from "../../../../persistence/store.ts";
export async function upsertProjectArchitectureMethod(this: MarketControlPlaneStore, projectId, input: any = {}) {
    await this.ensureInitialized();
    const project = await this.getProject(projectId);
    if (!project)
        return null;
    const architecture = normalizeProjectArchitecture(input);
    const nextMetadata = {
        ...(project.metadata ?? {}),
        architecture,
    };
    await this.updateProject(projectId, { metadata: nextMetadata });
    await this.projectArchitectureContentBindings(projectId, architecture).catch(() => null);
    return architecture;
}

import { ControlPlaneStore,projectArchitectureContentSource } from "../../../../persistence/store.ts";
export async function projectArchitectureContentBindingsMethod(this: ControlPlaneStore, projectId, architecture) {
    const project = await this.getProject(projectId);
    if (!project || !architecture)
        return null;
    const repositories = await this.listHubRepositories(projectId);
    const contentRepository = repositories.find((entry) => entry.role === 'content') ?? null;
    const publishTarget = architecture.contentPublishTarget ?? {};
    await this.upsertHubContentSource(projectId, {
        teamId: project.teamId,
        contentRepositoryId: contentRepository?.id ?? null,
        productionSource: projectArchitectureContentSource(architecture),
        overlayPolicy: architecture.contentRuntimeSource,
        r2BucketName: publishTarget.kind === 'cloudflare_r2' ? publishTarget.bucket ?? null : null,
        r2ManifestKey: publishTarget.kind === 'cloudflare_r2' ? publishTarget.manifestPath ?? publishTarget.prefix ?? null : null,
        metadata: {
            projectArchitecture: architecture,
            contentPath: architecture.contentPath ?? null,
            localContentMaterialization: architecture.localContentMaterialization,
        },
    });
    const binding = await this.getProjectTreeDxLibrary(projectId);
    if (binding) {
        await this.upsertProjectTreeDxLibrary(projectId, {
            contentPath: architecture.contentPath ?? binding.contentPath,
            r2BucketName: publishTarget.kind === 'cloudflare_r2' ? publishTarget.bucket ?? binding.r2BucketName ?? null : binding.r2BucketName ?? null,
            r2ManifestKey: publishTarget.kind === 'cloudflare_r2' ? publishTarget.manifestPath ?? publishTarget.prefix ?? binding.r2ManifestKey ?? null : binding.r2ManifestKey ?? null,
            metadata: {
                projectArchitecture: architecture,
            },
        });
    }
    return this.getHubContentSource(projectId);
}

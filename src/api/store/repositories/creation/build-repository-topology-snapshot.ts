import { MarketControlPlaneStore } from "../../../persistence/store.ts";
interface RepositoryTopologyMetadata {
    siteRepository?: Record<string, unknown>;
    projectRepository?: Record<string, unknown>;
}

export function buildRepositoryTopologySnapshotMethod(this: MarketControlPlaneStore, { project, instance, binding, softwareRepository, workspaceLink, metadata = {} as RepositoryTopologyMetadata }) {
    const siteCheckoutBase = `/data/projects/${project.slug}/site`;
    const projectCheckoutBase = workspaceLink?.parentName ? `/data/projects/${project.slug}/project` : null;
    return {
        contentRepository: {
            accessMode: 'treedx',
            githubUrl: binding.contentRepositoryUrl ?? null,
            defaultBranch: binding.contentRepositoryDefaultBranch ?? null,
            ref: binding.contentRepositoryRef ?? null,
            contentPath: binding.contentPath,
            treeDx: {
                instanceId: instance.id,
                libraryId: binding.libraryId,
                repositoryId: binding.repositoryId ?? null,
                baseUrl: instance.baseUrl ?? null,
            },
            r2: {
                bucketName: binding.r2BucketName ?? null,
                manifestKey: binding.r2ManifestKey ?? null,
            },
        },
        siteRepository: {
            accessMode: 'filesystem',
            provider: softwareRepository?.provider ?? 'github',
            owner: softwareRepository?.owner ?? null,
            name: softwareRepository?.name ?? project.slug,
            url: softwareRepository?.url ?? null,
            defaultBranch: softwareRepository?.defaultBranch ?? 'staging',
            ref: softwareRepository?.currentBranch ?? null,
            checkoutPath: metadata.siteRepository?.checkoutPath ?? siteCheckoutBase,
            volumePath: metadata.siteRepository?.volumePath ?? siteCheckoutBase,
            submoduleMountPath: softwareRepository?.submodulePath ?? workspaceLink?.softwareSubmodulePath ?? null,
        },
        projectRepository: workspaceLink?.parentUrl || metadata.projectRepository
            ? {
                accessMode: 'filesystem',
                provider: metadata.projectRepository?.provider ?? 'github',
                owner: workspaceLink?.parentOwner ?? metadata.projectRepository?.owner ?? null,
                name: workspaceLink?.parentName ?? metadata.projectRepository?.name ?? null,
                url: workspaceLink?.parentUrl ?? metadata.projectRepository?.url ?? null,
                defaultBranch: workspaceLink?.parentBranch ?? metadata.projectRepository?.defaultBranch ?? 'staging',
                ref: metadata.projectRepository?.ref ?? null,
                checkoutPath: metadata.projectRepository?.checkoutPath ?? projectCheckoutBase,
                volumePath: metadata.projectRepository?.volumePath ?? projectCheckoutBase,
                siteSubmodulePath: workspaceLink?.softwareSubmodulePath ?? metadata.projectRepository?.siteSubmodulePath ?? null,
            }
            : null,
    };
}

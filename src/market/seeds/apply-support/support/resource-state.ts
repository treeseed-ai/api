import { emptyObjectAsNull } from '../index.js';

export function teamCurrentPayload(action, team) {
    if (!team)
        return null;
    return {
        slug: action.payload.slug,
        name: action.payload.name,
        displayName: team.displayName ?? action.payload.displayName,
        logoUrl: team.logoUrl ?? null,
        profileSummary: team.profileSummary ?? null,
        metadata: action.payload.metadata,
    };
}

export function repositoryHostCurrentPayload(action, host) {
    if (!host)
        return null;
    return {
        teamKey: action.payload.teamKey,
        provider: host.provider,
        name: host.name,
        ownership: host.ownership,
        accountLabel: host.accountLabel ?? null,
        organizationOrOwner: host.organizationOrOwner,
        defaultVisibility: host.defaultVisibility ?? 'private',
        softwareRepositoryNameTemplate: host.softwareRepositoryNameTemplate ?? null,
        contentRepositoryNameTemplate: host.contentRepositoryNameTemplate ?? null,
        branchPolicy: emptyObjectAsNull(host.branchPolicy),
        workflowPolicy: emptyObjectAsNull(host.workflowPolicy),
        allowedProjectKinds: host.allowedProjectKinds?.length ? host.allowedProjectKinds : null,
        status: host.status ?? 'active',
        credentialRef: host.metadata?.credentialRef ?? action.payload.credentialRef ?? null,
        metadata: action.payload.metadata,
    };
}

export async function projectCurrentPayload(store, action, project) {
    if (!project)
        return null;
    const repository = action.payload.repository;
    const hubRepository = (await store.listHubRepositories(project.id)).find((entry) => entry.role === repository.role) ?? null;
    return {
        teamKey: action.payload.teamKey,
        slug: project.slug,
        name: project.name,
        description: project.description ?? null,
        kind: action.payload.kind ?? null,
        repository: hubRepository
            ? {
                role: hubRepository.role,
                provider: hubRepository.provider,
                owner: hubRepository.owner,
                name: hubRepository.name,
                gitUrl: hubRepository.url,
                defaultBranch: hubRepository.defaultBranch ?? undefined,
                checkoutPath: repository.checkoutPath,
                submodulePath: hubRepository.submodulePath ?? undefined,
                webUrl: repository.webUrl,
            }
            : null,
        architecture: project.metadata?.architecture,
        metadata: action.payload.metadata,
    };
}

export function hubRepositoryCurrentPayload(action, repository) {
    if (!repository)
        return null;
    return {
        projectKey: action.payload.projectKey,
        repositoryHostKey: action.payload.repositoryHostKey ?? null,
        role: repository.role,
        provider: repository.provider,
        owner: repository.owner,
        name: repository.name,
        gitUrl: repository.url,
        defaultBranch: repository.defaultBranch ?? null,
        currentBranch: repository.currentBranch ?? repository.defaultBranch ?? null,
        submodulePath: repository.submodulePath ?? null,
        status: repository.status ?? 'active',
        accessPolicy: emptyObjectAsNull(repository.accessPolicy),
        releasePolicy: emptyObjectAsNull(repository.releasePolicy),
        publishPolicy: emptyObjectAsNull(repository.publishPolicy),
        metadata: action.payload.metadata,
    };
}

export function productCurrentPayload(action, product) {
    if (!product)
        return null;
    return {
        teamKey: action.payload.teamKey,
        kind: product.kind,
        slug: product.slug,
        title: product.title,
        summary: product.summary ?? null,
        visibility: product.visibility ?? 'private',
        listingEnabled: product.listingEnabled === true,
        offerMode: product.offerMode ?? 'private',
        manifestKey: product.manifestKey ?? null,
        artifactKey: product.artifactKey ?? null,
        searchText: product.searchText ?? null,
        metadata: action.payload.metadata,
    };
}

export function catalogArtifactCurrentPayload(action, artifact) {
    if (!artifact)
        return null;
    return {
        productKey: action.payload.productKey,
        version: artifact.version,
        kind: artifact.kind,
        contentKey: artifact.contentKey,
        manifestKey: artifact.manifestKey ?? null,
        publishedAt: action.payload.publishedAt ?? null,
        metadata: action.payload.metadata,
    };
}

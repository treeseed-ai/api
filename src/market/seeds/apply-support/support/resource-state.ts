import { emptyObjectAsNull,projectSeedMetadata } from '../index.js';

function managedMetadata(desired, actual) {
    const desiredRecord = desired && typeof desired === 'object' && !Array.isArray(desired) ? desired : {};
    const actualRecord = actual && typeof actual === 'object' && !Array.isArray(actual) ? actual : {};
    return Object.fromEntries(Object.entries(desiredRecord).map(([key, desiredValue]) => [
        key,
        desiredValue && typeof desiredValue === 'object' && !Array.isArray(desiredValue)
            ? managedMetadata(desiredValue, actualRecord[key])
            : actualRecord[key],
    ]));
}

export function teamCurrentPayload(action, team) {
    if (!team)
        return null;
    return {
        slug: action.payload.slug,
        name: action.payload.name,
        displayName: team.displayName ?? action.payload.displayName,
        logoUrl: team.logoUrl ?? null,
        profileSummary: team.profileSummary ?? null,
        metadata: managedMetadata(action.payload.metadata, team.metadata),
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
                repositoryPolicy: repository.repositoryPolicy,
            }
            : null,
        architecture: project.metadata?.architecture,
		metadata: managedMetadata(action.payload.metadata, projectSeedMetadata(project.metadata)),
    };
}

export function hubRepositoryCurrentPayload(action, repository) {
    if (!repository)
        return null;
    return {
        projectKey: action.payload.projectKey,
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
        repositoryPolicy: action.payload.repositoryPolicy,
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

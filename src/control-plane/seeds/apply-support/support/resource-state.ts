import { projectSeedMetadata } from '../index.js';

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
	const library = action.payload.library;
    const configuredRepository = project.metadata?.repository ?? {};
	const hubRepository = repository
		? (await store.listHubRepositories(project.id)).find((entry) => entry.role === repository.role) ?? null
		: null;
	const libraryRepository = library
		? (await store.listHubRepositories(project.id)).find((entry) => entry.role === 'library') ?? null
		: null;
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
                checkoutPath: configuredRepository.checkoutPath,
                submodulePath: hubRepository.submodulePath ?? undefined,
                webUrl: configuredRepository.webUrl,
                repositoryPolicy: configuredRepository.repositoryPolicy,
            }
            : null,
		library: libraryRepository ? {
			role: libraryRepository.role,
			provider: libraryRepository.provider,
			owner: libraryRepository.owner,
			name: libraryRepository.name,
			gitUrl: libraryRepository.url,
			defaultBranch: libraryRepository.defaultBranch ?? undefined,
			repositoryPolicy: project.metadata?.library?.repositoryPolicy ?? library.repositoryPolicy,
		} : null,
		architecture: project.metadata?.architecture ?? {},
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
        submodulePath: repository.submodulePath ?? null,
        status: repository.status ?? 'active',
		accessPolicy: repository.accessPolicy ?? {},
		releasePolicy: repository.releasePolicy ?? {},
		publishPolicy: repository.publishPolicy ?? {},
        repositoryPolicy: action.payload.repositoryPolicy,
        metadata: action.payload.metadata,
    };
}

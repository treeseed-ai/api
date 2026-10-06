import { projectSeedMetadata } from '../index.js';
import type { ControlPlaneStore } from '../../../../api/persistence/store.ts';

type ResourceAction = { payload: Record<string, unknown> & {
    repository?: { role?: unknown } | null; library?: { repositoryPolicy?: unknown } | null;
} };

function managedMetadata(desired: unknown, actual: unknown): Record<string, unknown> {
    const desiredRecord = desired && typeof desired === 'object' && !Array.isArray(desired) ? desired as Record<string, unknown> : {};
    const actualRecord = actual && typeof actual === 'object' && !Array.isArray(actual) ? actual as Record<string, unknown> : {};
    return Object.fromEntries(Object.entries(desiredRecord).map(([key, desiredValue]) => [
        key,
        desiredValue && typeof desiredValue === 'object' && !Array.isArray(desiredValue)
            ? managedMetadata(desiredValue, actualRecord[key])
            : actualRecord[key],
    ]));
}

export function teamCurrentPayload(action: ResourceAction, team: Awaited<ReturnType<ControlPlaneStore['getTeamBySlug']>>) {
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

export async function projectCurrentPayload(store: Pick<ControlPlaneStore, 'listHubRepositories'>, action: ResourceAction, project: Awaited<ReturnType<ControlPlaneStore['getProjectByTeamAndSlug']>>) {
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
                submodulePath: hubRepository.submodulePath ?? null,
                webUrl: configuredRepository.webUrl,
                repositoryPolicy: configuredRepository.repositoryPolicy,
            }
            : null,
		library: libraryRepository && library ? {
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

export function hubRepositoryCurrentPayload(action: ResourceAction, repository: Awaited<ReturnType<ControlPlaneStore['listHubRepositories']>>[number] | null | undefined) {
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

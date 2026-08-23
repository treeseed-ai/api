import { FetchTransport, TreeDxClient } from '@treeseed/treedx/treedx/client';
import { treeDxDelegationAuthority } from '../../../../../api/control-plane/treedx/delegation-authority.ts';

function text(...values: unknown[]): string {
	for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
	return '';
}

function projectRepositoryName(projectSlug: string) {
	const normalized = `treeseed-${projectSlug}`.trim().toLowerCase().replace(/[^a-z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '');
	return normalized || 'project';
}

interface TreeDxRepositorySummary {
	repoId: string;
	repositoryName?: string;
	name?: string;
	defaultRef?: string;
}

function repositoryCatalog(response: unknown): TreeDxRepositorySummary[] {
	if (!response || typeof response !== 'object' || !Array.isArray((response as { repos?: unknown }).repos)) {
		throw new Error('TreeDX repository catalog response is invalid.');
	}
	return (response as { repos: unknown[] }).repos.map((repository) => {
		if (!repository || typeof repository !== 'object' || typeof (repository as { repoId?: unknown }).repoId !== 'string') {
			throw new Error('TreeDX repository catalog contains an invalid repository.');
		}
		return repository as TreeDxRepositorySummary;
	});
}

function createdRepository(response: unknown): TreeDxRepositorySummary {
	const repository = response && typeof response === 'object'
		? (response as { repo?: unknown }).repo
		: undefined;
	if (!repository || typeof repository !== 'object' || typeof (repository as { repoId?: unknown }).repoId !== 'string') {
		throw new Error('TreeDX repository creation response is invalid.');
	}
	return repository as TreeDxRepositorySummary;
}

export async function ensureProjectKnowledgeBinding(input: {
	store: any;
	projectId: string;
	teamId: string;
	projectSlug: string;
	contentPath?: string;
	contentRepositoryRef?: string;
	contentRepositoryUrl?: string | null;
	contentRepositoryDefaultBranch?: string;
	env?: NodeJS.ProcessEnv;
	dependencyState?: { repositoryCatalog?: Promise<unknown> };
}) {
	const env = input.env ?? process.env;
	const baseUrl = text(env.TREESEED_TREEDX_URL, env.TREESEED_TREEDX_BASE_URL, 'http://127.0.0.1:4000');
	const token = treeDxDelegationAuthority().mint({
		actorId: 'treeseed-api',
		tenantId: 'treeseed-control-plane',
		projectId: input.projectId,
		connectionId: 'treedx-local-seed',
		scope: { capabilities: ['repos:read', 'repos:write'], repositoryIds: ['*'], refs: ['*'], paths: ['**'] },
	}).token;
	const normalizedBaseUrl = baseUrl.replace(/\/+$/u, '');
	const transport = new FetchTransport({ baseUrl: normalizedBaseUrl, token, timeoutMs: 15_000, fetchImpl: input.store.config?.fetchImpl });
	const client = new TreeDxClient({
		baseUrl: normalizedBaseUrl,
		transport,
	});
	const repositoryName = projectRepositoryName(input.projectSlug);
	const catalogResponse = input.dependencyState
		? await (input.dependencyState.repositoryCatalog ??= client.repositories.list())
		: await client.repositories.list();
	const repositories = repositoryCatalog(catalogResponse);
	let repository = repositories.find((candidate) =>
		candidate.name === repositoryName || candidate.repositoryName === repositoryName);
	if (!repository) {
		repository = createdRepository(await client.repositories.create({ repositoryName, defaultRef: 'refs/heads/main' }));
		repositories.push(repository);
	}
	const existing = await input.store.getProjectTreeDxLibrary(input.projectId);
	await input.store.upsertTeamTreeDx(input.teamId, {
		kind: 'managed_public_federation', provider: 'local', name: 'Local TreeDX knowledge plane',
		baseUrl, registryUrl: baseUrl, publicRead: true, status: 'active',
		metadata: { reconciledLocalRuntime: true },
	});
	await input.store.upsertProjectTreeDxLibrary(input.projectId, {
		repositoryId: repository.repoId,
		contentPath: input.contentPath ?? 'src/content',
		contentRepositoryUrl: input.contentRepositoryUrl === undefined
			? existing?.contentRepositoryUrl ?? null
			: input.contentRepositoryUrl,
		contentRepositoryDefaultBranch: input.contentRepositoryDefaultBranch
			?? existing?.contentRepositoryDefaultBranch ?? 'main',
		contentRepositoryRef: input.contentRepositoryRef
			?? existing?.contentRepositoryRef ?? repository.defaultRef ?? 'refs/heads/main',
		metadata: { repositoryName, reconciledLocalRuntime: true },
	});
	return { kind: 'projectKnowledgeBinding', projectId: input.projectId, repositoryId: repository.repoId };
}

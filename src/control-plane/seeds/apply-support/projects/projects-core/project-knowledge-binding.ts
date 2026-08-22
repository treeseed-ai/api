import { mintTreeDxHs256Token } from '@treeseed/sdk/treedx/auth';
import { TreeDxClient } from '@treeseed/sdk/treedx/client';

function text(...values: unknown[]): string {
	for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
	return '';
}

function projectRepositoryName(projectSlug: string) {
	const normalized = `treeseed-${projectSlug}`.trim().toLowerCase().replace(/[^a-z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '');
	return normalized || 'project';
}

export async function ensureProjectKnowledgeBinding(input: {
	store: any;
	projectId: string;
	teamId: string;
	projectSlug: string;
	contentPath?: string;
	contentRepositoryRef?: string;
	contentRepositoryUrl?: string;
	contentRepositoryDefaultBranch?: string;
	env?: NodeJS.ProcessEnv;
	dependencyState?: { repositoryCatalog?: Promise<any[]> };
}) {
	const env = input.env ?? process.env;
	const baseUrl = text(env.TREESEED_TREEDX_URL, env.TREESEED_TREEDX_BASE_URL, 'http://127.0.0.1:4000');
	const secret = text(env.TREESEED_TREEDX_JWT_HS256_SECRET, 'treeseed-local-treedx-jwt-secret');
	const token = mintTreeDxHs256Token({
		secret,
		issuer: text(env.TREESEED_TREEDX_JWT_ISSUER, 'https://api.treeseed.local/treedx'),
		audience: text(env.TREESEED_TREEDX_JWT_AUDIENCE, 'treedx-local'),
		actorId: 'treeseed-api',
		tenantId: 'treeseed-control-plane',
		capabilities: ['repos:read'],
		repoIds: ['*'],
		refs: ['*'],
		paths: ['**'],
		ttlSeconds: 300,
	});
	const client = new TreeDxClient({
		baseUrl: baseUrl.replace(/\/+$/u, ''),
		token,
		timeoutMs: 15_000,
		fetch: input.store.config?.fetchImpl,
	});
	const repositoryName = projectRepositoryName(input.projectSlug);
	const repositories = input.dependencyState
		? await (input.dependencyState.repositoryCatalog ??= client.listRepositories())
		: await client.listRepositories();
	const repository = repositories.find((candidate) =>
		candidate.name === repositoryName || candidate.repositoryName === repositoryName);
	if (!repository) throw new Error(`TreeDX repository ${repositoryName} is not reconciled.`);
	const existing = await input.store.getProjectTreeDxLibrary(input.projectId);
	await input.store.upsertTeamTreeDx(input.teamId, {
		kind: 'managed_public_federation', provider: 'local', name: 'Local TreeDX knowledge plane',
		baseUrl, registryUrl: baseUrl, publicRead: true, status: 'active',
		metadata: { reconciledLocalRuntime: true },
	});
	await input.store.upsertProjectTreeDxLibrary(input.projectId, {
		repositoryId: repository.repoId,
		contentPath: input.contentPath ?? 'src/content',
		contentRepositoryUrl: input.contentRepositoryUrl ?? existing?.contentRepositoryUrl,
		contentRepositoryDefaultBranch: input.contentRepositoryDefaultBranch
			?? existing?.contentRepositoryDefaultBranch ?? 'main',
		contentRepositoryRef: input.contentRepositoryRef
			?? existing?.contentRepositoryRef ?? repository.defaultRef ?? 'refs/heads/main',
		metadata: { repositoryName, reconciledLocalRuntime: true },
	});
	return { kind: 'projectKnowledgeBinding', projectId: input.projectId, repositoryId: repository.repoId };
}

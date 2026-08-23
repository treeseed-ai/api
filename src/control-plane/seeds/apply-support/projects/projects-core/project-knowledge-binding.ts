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
	const token = treeDxDelegationAuthority().mint({
		actorId: 'treeseed-api',
		tenantId: 'treeseed-control-plane',
		projectId: input.projectId,
		connectionId: 'treedx-local-seed',
		scope: { capabilities: ['repos:read'], repositoryIds: ['*'], refs: ['*'], paths: ['**'] },
	}).token;
	const normalizedBaseUrl = baseUrl.replace(/\/+$/u, '');
	const transport = new FetchTransport({ baseUrl: normalizedBaseUrl, token, timeoutMs: 15_000, fetchImpl: input.store.config?.fetchImpl });
	const client = new TreeDxClient({
		baseUrl: normalizedBaseUrl,
		transport,
	});
	const repositoryName = projectRepositoryName(input.projectSlug);
	const repositories = input.dependencyState
		? await (input.dependencyState.repositoryCatalog ??= client.repositories.list() as Promise<any[]>)
		: await client.repositories.list() as any[];
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

import { TreeDxClient } from '@treeseed/sdk/treedx';
import { mintTreeDxHs256Token } from '@treeseed/sdk/treedx/auth';

type RecordValue = Record<string, unknown>;

const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value)
	? value as RecordValue : {};

function text(...values: unknown[]): string {
	for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
	return '';
}

function localAddress(value: string): boolean {
	try { return ['localhost', '127.0.0.1', '::1'].includes(new URL(value).hostname); } catch { return false; }
}

function normalizedContentPath(value: unknown): string {
	const path = text(value, 'src/content').replace(/^\/+|\/+$/gu, '');
	if (!path || path.split('/').some((part) => !part || part === '.' || part === '..')) {
		throw new Error('The project content path is unsafe.');
	}
	return path;
}

export interface KnowledgeGatewayConnection {
	client: TreeDxClient;
	repositoryId: string;
	baseRef: string;
	contentPath: string;
	allowedPaths: string[];
	nodeId: string;
}

export async function resolveKnowledgeGatewayConnection(store: any, input: {
	projectId: string;
	write: boolean;
	publishRefs?: string[];
	maintenanceRefs?: string[];
	readRefs?: string[];
	workspaceRefs?: string[];
	relationPaths?: boolean;
}): Promise<KnowledgeGatewayConnection | null> {
	const library = await store.getProjectTreeDxLibrary(input.projectId);
	if (!library) return null;
	const topology = record(library.topology);
	const contentRepository = record(topology.contentRepository);
	const treeDx = record(contentRepository.treeDx);
	const baseUrl = text(treeDx.baseUrl, treeDx.registryUrl, store.config.TREESEED_TREEDX_URL,
		store.config.TREESEED_TREEDX_BASE_URL, store.config.treedxBaseUrl,
		process.env.TREESEED_TREEDX_URL, process.env.TREESEED_TREEDX_BASE_URL) || 'http://127.0.0.1:4000';
	const repositoryId = text(library.repositoryId, treeDx.repositoryId);
	if (!repositoryId) return null;
	const local = process.env.TREESEED_ENVIRONMENT === 'local' || process.env.LOCAL_DEV_MODE === '1'
		|| localAddress(baseUrl) || localAddress(text(store.config.baseUrl, process.env.TREESEED_API_BASE_URL));
	const secret = text(store.config.TREESEED_TREEDX_JWT_HS256_SECRET, store.config.treedxJwtHs256Secret,
		process.env.TREESEED_TREEDX_JWT_HS256_SECRET) || (local ? 'treeseed-local-treedx-jwt-secret' : '');
	if (!secret) return null;
	const contentPath = normalizedContentPath(library.contentPath);
	const allowedPaths = [`${contentPath}/books/**`, `${contentPath}/knowledge/**`, `${contentPath}/assets/**`,
		...(input.relationPaths ? ['notes', 'questions', 'objectives', 'proposals', 'decisions', 'agents', 'people']
			.map((collection) => `${contentPath}/${collection}/**`) : [])];
	const token = mintTreeDxHs256Token({
		secret,
		issuer: text(store.config.TREESEED_TREEDX_JWT_ISSUER, process.env.TREESEED_TREEDX_JWT_ISSUER) || 'https://api.treeseed.local/treedx',
		audience: text(store.config.TREESEED_TREEDX_JWT_AUDIENCE, process.env.TREESEED_TREEDX_JWT_AUDIENCE) || 'treedx-local',
		actorId: text(store.config.TREESEED_TREEDX_PROXY_ACTOR_ID, process.env.TREESEED_TREEDX_PROXY_ACTOR_ID) || 'treeseed-api',
		tenantId: text(store.config.TREESEED_TREEDX_PROXY_TENANT_ID, process.env.TREESEED_TREEDX_PROXY_TENANT_ID) || 'treeseed-control-plane',
		repoIds: [repositoryId],
		capabilities: input.maintenanceRefs?.length
			? ['repos:read', 'files:read', 'git:read', 'git:diff', 'git:push', 'policy:write']
			: input.publishRefs?.length
			? ['repos:read', 'files:read', 'files:search', 'git:read', 'git:push', 'graph:query', 'graph:refresh']
			: input.write
			? ['repos:read', 'repos:write', 'workspace:create', 'files:read', 'files:write', 'files:delete', 'git:read', 'git:diff', 'git:commit']
			: ['repos:read', 'files:read', 'files:search', 'git:read', 'git:diff', 'graph:query'],
		refs: [...new Set([text(library.contentRepositoryRef, library.contentRepositoryDefaultBranch, 'main'),
			...(input.readRefs ?? []), ...(input.publishRefs ?? []), ...(input.maintenanceRefs ?? []),
			...(input.workspaceRefs ?? [])])],
		paths: allowedPaths,
		projectId: input.projectId,
		ttlSeconds: 300,
	});
	return {
		client: new TreeDxClient({ baseUrl: baseUrl.replace(/\/+$/u, ''), token, repoId: repositoryId, timeoutMs: 15_000, fetch: store.config.fetchImpl }),
		repositoryId,
		baseRef: text(library.contentRepositoryRef, library.contentRepositoryDefaultBranch, 'main'),
		contentPath,
		allowedPaths,
		nodeId: text(library.instanceId, treeDx.instanceId),
	};
}

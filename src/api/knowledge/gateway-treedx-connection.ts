import { FetchTransport, TreeDxClient } from '@treeseed/treedx/treedx/client';
import { AGENT_OPERATIONAL_CONTENT_COLLECTIONS } from '@treeseed/sdk/content-validation';
import { treeDxDelegationAuthority } from '../control-plane/treedx/delegation-authority.ts';
import { TreeDxInfrastructureClient } from '../control-plane/treedx/infrastructure-client.ts';
import { resolveTreeDxServiceUrl } from '../control-plane/treedx/connection-url.ts';

type RecordValue = Record<string, unknown>;

const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value)
	? value as RecordValue : {};

function text(...values: unknown[]): string {
	for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
	return '';
}

function normalizedContentPath(value: unknown): string {
	const path = text(value).replace(/^\/+|\/+$/gu, '');
	if (!path || (path !== '.' && path.split('/').some((part) => !part || part === '.' || part === '..'))) {
		throw new Error('The project content path is missing or unsafe.');
	}
	return path;
}

export function projectLibraryPath(root: string, ...parts: string[]): string {
	const normalizedRoot = normalizedContentPath(root);
	const normalizedParts = parts.flatMap((part) => part.split('/'))
		.map((part) => part.trim()).filter(Boolean);
	if (normalizedParts.some((part) => part === '.' || part === '..')) throw new Error('The project library path is unsafe.');
	return [normalizedRoot === '.' ? '' : normalizedRoot, ...normalizedParts].filter(Boolean).join('/');
}

export function canonicalTreeDxBranchRef(value: unknown): string {
	const branch = text(value, 'staging')
		.replace(/^refs\/heads\//u, '')
		.replace(/^refs\/remotes\/origin\//u, '');
	return `refs/heads/${branch}`;
}

export interface KnowledgeGatewayConnection {
	client: TreeDxInfrastructureClient;
	baseUrl: string;
	accessToken: string;
	repositoryId: string;
	baseRef: string;
	contentPath: string;
	allowedPaths: string[];
	nodeId: string;
	authoringBranch: string;
	publicationRef: string;
}

export async function resolveKnowledgeGatewayConnection(store: any, input: {
	projectId: string;
	write: boolean;
	publishRefs?: string[];
	maintenanceRefs?: string[];
	replicationRefs?: string[];
	readRefs?: string[];
	workspaceRefs?: string[];
	relationPaths?: boolean;
	communicationPaths?: boolean;
	authoringPaths?: boolean;
}): Promise<KnowledgeGatewayConnection | null> {
	const library = await store.getProjectTreeDxLibrary(input.projectId);
	if (!library) return null;
	const topology = record(library.topology);
	const contentRepository = record(topology.contentRepository);
	const treeDx = record(contentRepository.treeDx);
	const configuredBaseUrl = text(process.env.TREESEED_TREEDX_URL, process.env.TREESEED_TREEDX_BASE_URL,
		store.config.TREESEED_TREEDX_URL, store.config.TREESEED_TREEDX_BASE_URL, store.config.treedxBaseUrl,
		treeDx.baseUrl, treeDx.registryUrl) || 'http://127.0.0.1:4000';
	const runtimeEnvironment = { ...process.env, ...store.config };
	const baseUrl = resolveTreeDxServiceUrl(configuredBaseUrl, runtimeEnvironment);
	const repositoryId = text(library.repositoryId, treeDx.repositoryId);
	if (!repositoryId) return null;
	const contentPath = normalizedContentPath(library.contentPath);
	const allowedPaths = input.replicationRefs?.length ? ['**'] : [projectLibraryPath(contentPath, 'books/**'), projectLibraryPath(contentPath, 'knowledge/**'), projectLibraryPath(contentPath, 'assets/**'),
		...(input.relationPaths ? ['notes', 'questions', 'objectives', 'proposals', 'decisions', 'agents', 'people', 'groups', 'group-edges']
			.map((collection) => projectLibraryPath(contentPath, collection, '**')) : []),
		...(input.communicationPaths ? ['discussions', 'discussion-messages', 'discussion-events']
			.map((collection) => projectLibraryPath(contentPath, collection, '**')) : []),
		...(input.authoringPaths ? [
			projectLibraryPath(contentPath, 'agents/**'),projectLibraryPath(contentPath, 'agent-tests/**'),projectLibraryPath(contentPath, 'groups/**'),projectLibraryPath(contentPath, 'group-edges/**'),
			...Object.values(AGENT_OPERATIONAL_CONTENT_COLLECTIONS).map((collection) => projectLibraryPath(contentPath, collection, '**')),
			'.treeseed/agents/**','.treeseed/governance/proposal-types/**','.treeseed/seeds/**','seeds/**','scenes/**',
		] : [])];
	const authoringBranch = text(contentRepository.authoringBranch, topology.authoringBranch, 'staging');
	const canonicalAuthoringRef = canonicalTreeDxBranchRef(authoringBranch);
	const integrationRefs = (input.publishRefs ?? []).flatMap((ref) => {
		const match = /^refs\/treedx\/commits\/([a-f0-9]{40})$/iu.exec(ref);
		return match ? [`refs/heads/treedx/incoming/${match[1]}`] : [];
	});
	const token = treeDxDelegationAuthority().mint({
		actorId: text(store.config.TREESEED_TREEDX_PROXY_ACTOR_ID, process.env.TREESEED_TREEDX_PROXY_ACTOR_ID) || 'treeseed-api',
		tenantId: text(store.config.TREESEED_TREEDX_PROXY_TENANT_ID, process.env.TREESEED_TREEDX_PROXY_TENANT_ID) || 'treeseed-control-plane',
		projectId: input.projectId,
		connectionId: text(library.instanceId, treeDx.connectionId, treeDx.instanceId, 'treedx-project-binding'),
		scope: { repositoryIds: [repositoryId], capabilities: input.replicationRefs?.length
			? ['repos:read', 'files:read', 'git:read', 'git:fetch', 'git:push', 'registry:read', 'snapshot:build', 'artifact:export']
			: input.maintenanceRefs?.length
			? ['repos:read', 'files:read', 'files:search', 'git:read', 'git:diff', 'git:fetch', 'git:push',
				'registry:read', 'graph:query', 'graph:refresh', 'policy:write']
			: input.publishRefs?.length
			? ['repos:read', 'files:read', 'files:search', 'git:read', 'git:fetch', 'git:push', 'registry:read', 'graph:query', 'graph:refresh']
			: input.write
			? ['repos:read', 'repos:write', 'workspace:create', 'files:read', 'files:search', 'files:write', 'files:delete', 'git:read', 'git:diff', 'git:commit', 'graph:query', 'graph:refresh']
			: ['repos:read', 'files:read', 'files:search', 'git:read', 'git:diff', 'graph:query'],
		refs: [...new Set([text(library.contentRepositoryRef, library.contentRepositoryDefaultBranch, 'main'),
			canonicalTreeDxBranchRef(library.contentRepositoryDefaultBranch ?? 'main'),
			...(input.write || input.communicationPaths || input.authoringPaths ? [canonicalAuthoringRef] : []),
			...(input.readRefs ?? []), ...(input.publishRefs ?? []), ...integrationRefs,
			...(input.maintenanceRefs ?? []), ...(input.replicationRefs ?? []),
			...(input.workspaceRefs ?? [])])],
		paths: allowedPaths },
	}).token;
	const transport = new FetchTransport({ baseUrl: baseUrl.replace(/\/+$/u, ''), token, timeoutMs: 15_000, fetchImpl: store.config.fetchImpl });
	return {
		client: new TreeDxInfrastructureClient(new TreeDxClient({ baseUrl: baseUrl.replace(/\/+$/u, ''), transport }), repositoryId),
		baseUrl: baseUrl.replace(/\/+$/u, ''),
		accessToken: token,
		repositoryId,
		baseRef: text(library.contentRepositoryRef, library.contentRepositoryDefaultBranch, 'main'),
		contentPath,
		allowedPaths,
		nodeId: text(library.instanceId, treeDx.instanceId),
		authoringBranch,
		publicationRef: canonicalAuthoringRef,
	};
}

import { mintTreeDxHs256Token } from '@treeseed/sdk/treedx/auth';

export interface WorkdayTreeDxConnectionStore {
	config: Record<string, unknown> & { fetchImpl?: typeof fetch };
	getProjectTreeDxLibrary(projectId: string): Promise<Record<string, unknown> | null>;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(...values: unknown[]): string {
	for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
	return '';
}

function loopback(value: string): boolean {
	try { return ['localhost', '127.0.0.1', '::1'].includes(new URL(value).hostname); } catch { return false; }
}

export async function resolveWorkdayTreeDxConnection(
	store: WorkdayTreeDxConnectionStore,
	input: { projectId: string; repositoryId?: string; runId: string; capabilities: string[] },
) {
	const library = await store.getProjectTreeDxLibrary(input.projectId);
	const treeDx = record(record(record(library?.topology).contentRepository).treeDx);
	const baseUrl = text(treeDx.baseUrl, treeDx.registryUrl, store.config.TREESEED_TREEDX_URL, store.config.TREESEED_TREEDX_BASE_URL,
		store.config.treedxBaseUrl, process.env.TREESEED_TREEDX_URL, process.env.TREESEED_TREEDX_BASE_URL) || 'http://127.0.0.1:4000';
	const repositoryId = text(input.repositoryId, library?.repositoryId, treeDx.repositoryId);
	if (!repositoryId) return null;
	const apiBaseUrl = text(store.config.baseUrl, process.env.TREESEED_API_BASE_URL);
	const local = process.env.TREESEED_API_ENVIRONMENT === 'local' || process.env.TREESEED_ENVIRONMENT === 'local'
		|| process.env.LOCAL_DEV_MODE === '1' || loopback(apiBaseUrl) || loopback(baseUrl);
	const secret = text(store.config.TREESEED_TREEDX_JWT_HS256_SECRET, store.config.treedxJwtHs256Secret,
		process.env.TREESEED_TREEDX_JWT_HS256_SECRET) || (local ? 'treeseed-local-treedx-jwt-secret' : '');
	if (!secret) return null;
	const token = mintTreeDxHs256Token({
		secret,
		issuer: text(store.config.TREESEED_TREEDX_JWT_ISSUER, store.config.treedxJwtIssuer,
			process.env.TREESEED_TREEDX_JWT_ISSUER, process.env.TREEDX_JWT_ISSUER) || 'https://api.treeseed.local/treedx',
		audience: text(store.config.TREESEED_TREEDX_JWT_AUDIENCE, store.config.treedxJwtAudience,
			process.env.TREESEED_TREEDX_JWT_AUDIENCE, process.env.TREEDX_JWT_AUDIENCE) || 'treedx-local',
		actorId: text(store.config.TREESEED_TREEDX_PROXY_ACTOR_ID, store.config.treedxProxyActorId,
			process.env.TREESEED_TREEDX_PROXY_ACTOR_ID) || 'treeseed-api',
		tenantId: text(store.config.TREESEED_TREEDX_PROXY_TENANT_ID, store.config.treedxProxyTenantId,
			process.env.TREESEED_TREEDX_PROXY_TENANT_ID) || 'treeseed-control-plane',
		repoIds: [repositoryId], capabilities: input.capabilities, refs: ['*'], paths: ['**'],
		projectId: input.projectId, capacityWorkdayRunId: input.runId, ttlSeconds: 300,
	});
	return { baseUrl: baseUrl.replace(/\/+$/u, ''), repositoryId, token, fetchImpl: store.config.fetchImpl };
}

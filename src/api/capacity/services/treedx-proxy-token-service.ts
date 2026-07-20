import { mintTreeDxHs256Token } from '@treeseed/sdk/treedx/auth';
import { CapacityGovernanceError } from '../database.ts';
import { readBoundedTreeDxJson } from './treedx-response.ts';

export interface TreeDxProxyScope {
	repoIds: string[];
	capabilities: string[];
	refs: string[];
	paths: string[];
}

export interface TreeDxProxyRuntime {
	env?: Record<string, unknown>;
}

const tokenCache = new Map<string, { accessToken: string; expiresAtEpoch: number }>();

function text(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

export function treeDxRuntimeEnv(runtime: TreeDxProxyRuntime): Record<string, string | undefined> {
	return { ...process.env, ...(runtime.env && typeof runtime.env === 'object' ? runtime.env : {}) } as Record<string, string | undefined>;
}

export function treeDxProxyActorId(env: Record<string, string | undefined>): string {
	return text(env.TREESEED_TREEDX_PROXY_ACTOR_ID) || text(env.TREESEED_TREEDX_ACTOR_ID) || 'treeseed-api';
}

export function treeDxProxyTenantId(env: Record<string, string | undefined>): string {
	return text(env.TREESEED_TREEDX_PROXY_TENANT_ID) || text(env.TREESEED_TREEDX_TENANT_ID) || 'treeseed-control-plane';
}

export function treeDxTokenScope(input: Partial<TreeDxProxyScope> & { repoId?: string | null } = {}): TreeDxProxyScope {
	const repoIds = input.repoIds?.map(String).map((value) => value.trim()).filter(Boolean);
	return {
		repoIds: repoIds?.length ? [...new Set(repoIds)] : input.repoId ? [input.repoId] : ['*'],
		capabilities: [...new Set((input.capabilities ?? []).map(String).map((value) => value.trim()).filter(Boolean))],
		refs: input.refs ?? ['*'],
		paths: input.paths ?? [],
	};
}

export function treeDxRepoScopedContextBody(value: unknown, repoId: string): Record<string, unknown> {
	const body = value && typeof value === 'object' && !Array.isArray(value) ? { ...value as Record<string, unknown> } : {};
	delete body.repoIds;
	delete body.refs;
	if (body.paths && !Array.isArray(body.paths)) delete body.paths;
	return { ...body, repoId };
}

export function treeDxPathScope(filePath: unknown): string[] {
	const normalized = String(filePath ?? '').replace(/^\/+/, '');
	return normalized ? [normalized] : [];
}

export function resolveTreeDxProxyBaseUrl(runtime: TreeDxProxyRuntime, library: Record<string, unknown> | null): string {
	const env = treeDxRuntimeEnv(runtime);
	const value = text(library?.topology?.contentRepository?.treeDx?.baseUrl)
		|| text(env.TREESEED_TREEDX_URL)
		|| text(env.TREESEED_TREEDX_BASE_URL)
		|| text(env.TREESEED_PUBLIC_TREEDX_BASE_URL)
		|| 'http://127.0.0.1:4000';
	return value.replace(/\/+$/u, '');
}

export function isLoopbackTreeDxBaseUrl(baseUrl: string): boolean {
	try { return ['localhost', '127.0.0.1', '::1'].includes(new URL(baseUrl).hostname); } catch { return false; }
}

export function resolveTreeDxProxyToken(runtime: TreeDxProxyRuntime, baseUrl: string, projectId: string, requestedScope: TreeDxProxyScope): string | null {
	const env = treeDxRuntimeEnv(runtime);
	const secret = text(env.TREESEED_TREEDX_JWT_HS256_SECRET);
	const issuer = text(env.TREESEED_TREEDX_JWT_ISSUER) || text(env.TREEDX_JWT_ISSUER) || (secret ? 'https://api.treeseed.local/treedx' : '');
	const audience = text(env.TREESEED_TREEDX_JWT_AUDIENCE) || text(env.TREEDX_JWT_AUDIENCE) || (secret ? 'treedx-local' : '');
	if (!secret || !issuer || !audience) return null;
	const scope = treeDxTokenScope(requestedScope);
	const actorId = treeDxProxyActorId(env);
	const tenantId = treeDxProxyTenantId(env);
	const cacheKey = JSON.stringify({ baseUrl, issuer, audience, actorId, tenantId, scope });
	const now = Math.floor(Date.now() / 1000);
	const cached = tokenCache.get(cacheKey);
	if (cached && cached.expiresAtEpoch - 30 > now) return cached.accessToken;
	const accessToken = mintTreeDxHs256Token({ secret, issuer, audience, actorId, tenantId, ...scope, projectId, ttlSeconds: 300, nowEpochSeconds: now });
	tokenCache.set(cacheKey, { accessToken, expiresAtEpoch: now + 300 });
	return accessToken;
}

export async function verifyTreeDxWorkspace(input: {
	runtime: TreeDxProxyRuntime;
	projectId: string;
	library: Record<string, unknown> | null;
	workspaceId: string;
	fetchImpl?: typeof fetch;
}): Promise<void> {
	const repositoryId = input.library?.repositoryId ?? input.library?.topology?.contentRepository?.treeDx?.repositoryId ?? null;
	if (!repositoryId) throw new CapacityGovernanceError('treedx_repository_not_bound', 'TreeDX repository is not bound to this project.', 404, { projectId: input.projectId });
	const baseUrl = resolveTreeDxProxyBaseUrl(input.runtime, input.library);
	const token = resolveTreeDxProxyToken(input.runtime, baseUrl, input.projectId, treeDxTokenScope({ repoId: repositoryId, capabilities: ['files:read'], paths: ['**'] }));
	if (!token) throw new CapacityGovernanceError('treedx_proxy_token_unavailable', 'TreeDX proxy token is not configured for this project.', 503, { projectId: input.projectId });
	const response = await (input.fetchImpl ?? fetch)(`${baseUrl}/api/v1/workspaces/${encodeURIComponent(input.workspaceId)}`, { headers: { accept: 'application/json', authorization: `Bearer ${token}` } });
	const payload = await readBoundedTreeDxJson(response, {
		invalidCode: 'treedx_workspace_invalid_json',
		tooLargeCode: 'treedx_workspace_response_too_large',
		owner: 'TreeDX workspace response',
	});
	if (!response.ok) throw new CapacityGovernanceError('treedx_workspace_verification_failed', 'TreeDX workspace could not be verified for this project.', response.status, { projectId: input.projectId, workspaceId: input.workspaceId, details: payload?.error ?? payload });
	const workspace = payload?.workspace ?? payload?.payload?.workspace ?? payload?.payload ?? payload;
	const actualRepositoryId = workspace?.repoId ?? workspace?.repositoryId ?? null;
	if (actualRepositoryId !== repositoryId) throw new CapacityGovernanceError('treedx_workspace_project_mismatch', 'TreeDX workspace is not bound to this project repository.', 403, { projectId: input.projectId, workspaceId: input.workspaceId, repositoryId: actualRepositoryId, expectedRepositoryId: repositoryId });
}

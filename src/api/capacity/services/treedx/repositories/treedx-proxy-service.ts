import type { Context } from 'hono';
import type { CapacityGovernanceDatabase } from '../../../database.ts';
import { CapacityGovernanceError } from '../../../database.ts';
import { authorizeTreeDxProxy } from './treedx-proxy-access-service.ts';
import {
resolveTreeDxProxyBaseUrl,
resolveTreeDxProxyToken,
type TreeDxProxyRuntime,
type TreeDxProxyScope,
} from './treedx-proxy-token-service.ts';
import {
	grantCreatedLoopbackRepository,
	projectTreeDxProxyCommit,
	recordTreeDxProxySuccess,
	requestTreeDxJson,
	type TreeDxProxyStore,
} from './treedx-proxy-effects.ts';

export async function proxyTreeDxJson(input: {
	c: Context;
	runtime: TreeDxProxyRuntime;
	store: CapacityGovernanceDatabase;
	projectId: string;
	permission: 'projects:read:team' | 'projects:manage:team';
	method: 'GET' | 'POST' | 'PUT';
	path: string;
	body?: unknown;
	tokenScope: TreeDxProxyScope;
	requireProjectAccess: Parameters<typeof authorizeTreeDxProxy>[0]['requireProjectAccess'];
	fetchImpl?: typeof fetch;
}) {
	const store = input.store as TreeDxProxyStore;
	const access = await authorizeTreeDxProxy({ c: input.c, store: input.store, projectId: input.projectId, permission: input.permission, scope: input.tokenScope, requireProjectAccess: input.requireProjectAccess });
	if ('response' in access) return access.response;
	const library = await store.getProjectTreeDxLibrary(input.projectId);
	const baseUrl = resolveTreeDxProxyBaseUrl(input.runtime, library);
	const token = resolveTreeDxProxyToken(input.runtime, baseUrl, input.projectId, input.tokenScope);
	if (!token) throw new CapacityGovernanceError('treedx_proxy_token_unavailable', 'TreeDX proxy token is not configured for this project.', 503, { projectId: input.projectId });
	const fetchImpl = input.fetchImpl ?? fetch;
	const payload = await requestTreeDxJson({ baseUrl, token, projectId: input.projectId, method: input.method, path: input.path, body: input.body, fetchImpl });
	await grantCreatedLoopbackRepository({ runtime: input.runtime, baseUrl, token, projectId: input.projectId, method: input.method, path: input.path, payload, fetchImpl });
	const assignmentId = input.c.req.header('x-treeseed-assignment-id') ?? input.c.req.query('assignmentId') ?? null;
	await recordTreeDxProxySuccess({ store, access, projectId: input.projectId, method: input.method, path: input.path, tokenScope: input.tokenScope, assignmentId });
	await projectTreeDxProxyCommit({ store, access, projectId: input.projectId, method: input.method, path: input.path, body: input.body, payload });
	return input.c.json({ ok: true, payload, proxy: { projectId: input.projectId, actorType: access.actorType, treeDxBaseUrl: baseUrl } });
}

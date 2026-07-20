import type { Context } from 'hono';
import type { CapacityGovernanceDatabase } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';
import { authorizeTreeDxProxy } from './treedx-proxy-access-service.ts';
import {
	isLoopbackTreeDxBaseUrl,
	resolveTreeDxProxyBaseUrl,
	resolveTreeDxProxyToken,
	treeDxProxyActorId,
	treeDxProxyTenantId,
	treeDxRuntimeEnv,
	treeDxTokenScope,
	type TreeDxProxyRuntime,
	type TreeDxProxyScope,
} from './treedx-proxy-token-service.ts';
import { readBoundedTreeDxJson } from './treedx-response.ts';

interface ProxyStore extends CapacityGovernanceDatabase {
	getProjectTreeDxLibrary(projectId: string): Promise<Record<string, unknown> | null>;
	getProject(projectId: string): Promise<{ teamId: string } | null>;
	recordTreeDxProxyAudit(input: Record<string, unknown>): Promise<unknown>;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

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
	const store = input.store as ProxyStore;
	const access = await authorizeTreeDxProxy({ c: input.c, store: input.store, projectId: input.projectId, permission: input.permission, scope: input.tokenScope, requireProjectAccess: input.requireProjectAccess });
	if ('response' in access) return access.response;
	const library = await store.getProjectTreeDxLibrary(input.projectId);
	const baseUrl = resolveTreeDxProxyBaseUrl(input.runtime, library);
	const token = resolveTreeDxProxyToken(input.runtime, baseUrl, input.projectId, input.tokenScope);
	if (!token) throw new CapacityGovernanceError('treedx_proxy_token_unavailable', 'TreeDX proxy token is not configured for this project.', 503, { projectId: input.projectId });
	let response: Response;
	try {
		response = await (input.fetchImpl ?? fetch)(`${baseUrl}${input.path}`, {
			method: input.method,
			headers: { accept: 'application/json', authorization: `Bearer ${token}`, ...(input.body === undefined ? {} : { 'content-type': 'application/json' }) },
			body: input.body === undefined ? undefined : JSON.stringify(input.body),
		});
	} catch (error) {
		throw new CapacityGovernanceError('treedx_runtime_unavailable', 'TreeDX runtime is unavailable for this project.', 503, { projectId: input.projectId, details: error instanceof Error ? error.message : String(error) });
	}
	const payload = await readBoundedTreeDxJson(response);
	if (!response.ok) throw new CapacityGovernanceError('treedx_proxy_request_failed', `TreeDX ${input.method} ${input.path} failed.`, response.status, { status: response.status, details: record(payload).error ?? payload });

	if (input.method === 'POST' && input.path === '/api/v1/repos') {
		const payloadRecord = record(payload);
		const repo = record(payloadRecord.repo ?? payloadRecord.repository ?? payload);
		const repoId = repo.repoId ?? repo.id ?? null;
		if (repoId && isLoopbackTreeDxBaseUrl(baseUrl)) {
			const env = treeDxRuntimeEnv(input.runtime);
			const grantToken = resolveTreeDxProxyToken(input.runtime, baseUrl, input.projectId, treeDxTokenScope({ repoId, capabilities: ['policy:write'], paths: ['**'] }));
			const grantResponse = await (input.fetchImpl ?? fetch)(`${baseUrl}/api/v1/policy/grants`, {
				method: 'POST',
				headers: { accept: 'application/json', authorization: `Bearer ${grantToken ?? token}`, 'content-type': 'application/json' },
				body: JSON.stringify({ actorId: treeDxProxyActorId(env), tenantId: treeDxProxyTenantId(env), repoIds: [repoId], capabilities: ['repos:read', 'repos:write', 'files:read', 'files:write', 'files:search', 'graph:query', 'graph:refresh', 'workspace:create', 'git:read', 'git:diff', 'git:commit'], refs: ['*'], paths: ['**'] }),
			});
			const grantPayload = await readBoundedTreeDxJson(grantResponse);
			if (!grantResponse.ok) throw new CapacityGovernanceError('treedx_repository_grant_failed', 'TreeDX repository was created but proxy capability grant failed.', grantResponse.status, { repositoryId: repoId, details: record(grantPayload).error ?? grantPayload });
		}
	}

	const project = await store.getProject(input.projectId);
	if (!project) throw new CapacityGovernanceError('project_not_found', `Unknown project "${input.projectId}".`, 404);
	await store.recordTreeDxProxyAudit({
		teamId: project.teamId,
		projectId: input.projectId,
		assignmentId: access.assignment?.id ?? input.c.req.header('x-treeseed-assignment-id') ?? input.c.req.query('assignmentId') ?? null,
		actorType: access.actorType,
		actorId: access.actorType === 'capacity_provider' ? access.principal.capacityProviderId : access.principal.id ?? null,
		method: input.method,
		path: input.path,
		handle: { ...(access.handle ?? {}), projectId: input.projectId, assignmentId: access.assignment?.id ?? null, scopes: input.tokenScope.capabilities },
		resultStatus: 'proxied',
		metadata: { tokenScope: input.tokenScope, providerAssignmentScoped: access.actorType === 'capacity_provider' },
	});
	return input.c.json({ ok: true, payload, proxy: { projectId: input.projectId, actorType: access.actorType, treeDxBaseUrl: baseUrl } });
}

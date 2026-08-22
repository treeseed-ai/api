import { createHash } from 'node:crypto';
import { evaluateTreeDxProxyHandleAccess } from '../../../capacity/policy/treedx-proxy-access.ts';
import type { CapacityGovernanceDatabase } from '../../../capacity/database.ts';
import { CapacityGovernanceError } from '../../../capacity/database.ts';
import { ensureTreeDxContextGraphReady } from '../../../capacity/services/treedx/repositories/treedx-context-readiness.ts';
import { grantCreatedLoopbackRepository, projectTreeDxProxyCommit, recordTreeDxProxySuccess, requestTreeDxJson, type TreeDxProxyStore } from '../../../capacity/services/treedx/repositories/treedx-proxy-effects.ts';
import { resolveTreeDxProxyBaseUrl, resolveTreeDxProxyToken, treeDxChangesetPaths, treeDxPathScope, treeDxRepoScopedContextBody,
	treeDxTokenScope, verifyTreeDxWorkspace, type TreeDxProxyRuntime, type TreeDxProxyScope } from '../../../capacity/services/treedx/repositories/treedx-proxy-token-service.ts';
import { providerPrincipal, type ProviderPrincipal } from '../providers/provider-runtime-service.ts';
import type { OperationInvocationContext } from '../../catalog/operation-registry.ts';

interface Store extends TreeDxProxyStore {
	getProjectTreeDxLibrary(projectId: string): Promise<Record<string, unknown> | null>;
	upsertProjectTreeDxLibrary(projectId: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	getProjectDetails(projectId: string): Promise<{ project: { id: string; teamId: string } } | null>;
	principalCanAccessTeam(principal: unknown, teamId: string): Promise<boolean>;
	principalCanManageTeam(principal: unknown, teamId: string): Promise<boolean>;
	getProviderAssignment(teamId: string, assignmentId: string): Promise<Record<string, unknown> | null>;
	getTreeDxProxyHandle(teamId: string, projectId: string, handleId: string): Promise<Record<string, unknown> | null>;
}

type Permission = 'projects:read:team' | 'projects:manage:team';
type Access = { actorType: 'user' | 'capacity_provider'; principal: Record<string, unknown> | ProviderPrincipal;
	details: { project: { id: string; teamId: string } }; assignment: Record<string, unknown> | null; handle: Record<string, unknown> | null };

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

function repositoryId(library: Record<string, unknown> | null): string | null {
	const treeDx = record(record(record(library?.topology).contentRepository).treeDx);
	const value = library?.repositoryId ?? treeDx.repositoryId;
	return typeof value === 'string' ? value : null;
}

function assertRepository(library: Record<string, unknown> | null, requested: string) {
	const expected = repositoryId(library);
	if (expected && expected !== requested) throw new CapacityGovernanceError('treedx_repository_project_mismatch', 'TreeDX repository is not bound to this project.', 403, { repositoryId: requested, expectedRepositoryId: expected });
}

function administrator(principal: NonNullable<OperationInvocationContext['principal']>) {
	return principal.roles?.some((role) => role === 'admin' || role === 'platform_admin') || principal.permissions?.includes('*:*:*') || false;
}

function requestIdentity(context: OperationInvocationContext, query: Record<string, unknown>) {
	return {
		assignmentId: context.requestHeaders?.['x-treeseed-assignment-id'] || (typeof query.assignmentId === 'string' ? query.assignmentId : null),
		handleId: context.requestHeaders?.['x-treeseed-treedx-proxy-handle-id'] || (typeof query.treeDxProxyHandleId === 'string' ? query.treeDxProxyHandleId : null),
		token: context.requestHeaders?.['x-treeseed-treedx-proxy-handle'] || (typeof query.treeDxProxyToken === 'string' ? query.treeDxProxyToken : null),
	};
}

function requiredHandleScopes(scope: TreeDxProxyScope) {
	const write = scope.capabilities.some((capability) => /write|commit|create|delete|refresh/u.test(capability));
	return write ? ['project:write', 'workspace:write', 'git:commit'] : ['project:read', 'workspace:read', 'files:read'];
}

async function deny(store: Store, principal: ProviderPrincipal, input: { projectId: string; assignmentId: string | null; handleId: string | null;
	method: string; path: string; code: string; message: string; details?: Record<string, unknown> }): Promise<never> {
	await store.recordTreeDxProxyAudit({ teamId: principal.teamId, projectId: input.projectId, assignmentId: input.assignmentId,
		actorType: 'capacity_provider', actorId: principal.capacityProviderId, method: input.method, path: input.path,
		handle: { id: input.handleId }, resultStatus: 'denied', reasonCode: input.code, reason: input.message, metadata: { details: input.details ?? {} } });
	throw new CapacityGovernanceError(input.code, input.message, 403, input.details);
}

async function authorize(store: Store, projectId: string, permission: Permission, scope: TreeDxProxyScope,
	method: string, path: string, query: Record<string, unknown>, context: OperationInvocationContext): Promise<Access> {
	const details = await store.getProjectDetails(projectId);
	if (!details) throw new CapacityGovernanceError('project_not_found', `Unknown project "${projectId}".`, 404);
	if (!context.providerAuth) {
		const principal = context.principal;
		if (!principal) throw new CapacityGovernanceError('authentication_required', 'Authentication is required.', 401);
		if (!administrator(principal) && !await store.principalCanAccessTeam(principal, details.project.teamId)) throw new CapacityGovernanceError('treedx_access_denied', 'The principal cannot access this project.', 403);
		if (permission === 'projects:manage:team' && !administrator(principal) && !await store.principalCanManageTeam(principal, details.project.teamId)) throw new CapacityGovernanceError('treedx_management_denied', 'Team management authority is required.', 403);
		return { actorType: 'user', principal, details, assignment: null, handle: null };
	}
	const principal = providerPrincipal(context.providerAuth, [permission === 'projects:manage:team' ? 'provider:assignments:write' : 'provider:assignments:read']);
	const identity = requestIdentity(context, query);
	const reject = (code: string, message: string, metadata: Record<string, unknown> = {}) => deny(store, principal, { projectId,
		assignmentId: identity.assignmentId, handleId: identity.handleId, method, path, code, message, details: { projectId, ...metadata } });
	if (principal.teamId !== details.project.teamId) return reject('treedx_proxy_team_mismatch', 'Capacity provider cannot access this project.');
	if (!identity.assignmentId || !identity.handleId) return reject('treedx_proxy_handle_missing', 'Capacity provider TreeDX proxy access requires an assignment-scoped proxy handle.');
	const assignment = await store.getProviderAssignment(principal.teamId, identity.assignmentId);
	if (!assignment || assignment.projectId !== projectId || assignment.capacityProviderId !== principal.capacityProviderId) return reject('treedx_proxy_assignment_mismatch', 'TreeDX proxy handle is not bound to this provider assignment.');
	if (assignment.leaseState !== 'leased' || !assignment.leaseExpiresAt || Date.parse(String(assignment.leaseExpiresAt)) <= Date.now()) return reject('treedx_proxy_assignment_not_leased', 'TreeDX proxy handle requires an active assignment lease.');
	const handle = await store.getTreeDxProxyHandle(principal.teamId, projectId, identity.handleId);
	if (!handle || handle.assignmentId && handle.assignmentId !== identity.assignmentId) return reject('treedx_proxy_scope_mismatch', 'TreeDX proxy handle scope does not match the active assignment.');
	if (handle.tokenHash && (!identity.token || createHash('sha256').update(identity.token).digest('hex') !== handle.tokenHash)) return reject('treedx_proxy_token_mismatch', 'TreeDX proxy handle token does not match.');
	const acceptable = requiredHandleScopes(scope);
	if (!acceptable.some((value) => (handle.scopes as unknown[] ?? []).map(String).includes(value))) return reject('treedx_proxy_scope_denied', 'TreeDX proxy handle does not allow this operation.', { requiredAny: acceptable });
	const workspaceMatch = path.match(/\/workspaces\/([^/]+)/u);
	const evaluated = evaluateTreeDxProxyHandleAccess(handle, { teamId: principal.teamId, projectId, assignmentId: identity.assignmentId,
		repositoryId: scope.repoIds.find((value) => value !== '*') ?? null, workspaceId: workspaceMatch?.[1] ? decodeURIComponent(workspaceMatch[1]) : null,
		operation: scope.capabilities[0] ?? null, path: scope.paths.find((value) => value !== '**') ?? null, token: identity.token });
	if (!evaluated.ok) return reject(evaluated.code ?? 'treedx_proxy_request_denied', evaluated.reason ?? 'TreeDX proxy handle does not allow this request.', evaluated.metadata ?? {});
	return { actorType: 'capacity_provider', principal, details, assignment, handle };
}

export function createTreeDxProxyOperationService(storeValue: CapacityGovernanceDatabase, runtime: TreeDxProxyRuntime) {
	const store = storeValue as Store;
	const execute = async (input: { projectId: string; permission: Permission; method: 'GET' | 'POST' | 'PUT'; path: string;
		body?: unknown; query: Record<string, unknown>; scope: TreeDxProxyScope; context: OperationInvocationContext }) => {
		const access = await authorize(store, input.projectId, input.permission, input.scope, input.method, input.path, input.query, input.context);
		const library = await store.getProjectTreeDxLibrary(input.projectId); const baseUrl = resolveTreeDxProxyBaseUrl(runtime, library);
		const token = resolveTreeDxProxyToken(runtime, baseUrl, input.projectId, input.scope);
		if (!token) throw new CapacityGovernanceError('treedx_proxy_token_unavailable', 'TreeDX proxy token is not configured for this project.', 503, { projectId: input.projectId });
		if (input.path.endsWith('/context/build')) await ensureTreeDxContextGraphReady({ repoId: input.path.split('/')[4] ?? '', body: record(input.body),
			request: (method, path, body) => requestTreeDxJson({ baseUrl, token, projectId: input.projectId, method, path, body, fetchImpl: fetch }) });
		const payload = await requestTreeDxJson({ baseUrl, token, projectId: input.projectId, method: input.method, path: input.path, body: input.body, fetchImpl: fetch });
		await grantCreatedLoopbackRepository({ runtime, baseUrl, token, projectId: input.projectId, method: input.method, path: input.path, payload, fetchImpl: fetch });
		const identity = requestIdentity(input.context, input.query);
		await recordTreeDxProxySuccess({ store, access: access as never, projectId: input.projectId, method: input.method, path: input.path, tokenScope: input.scope, assignmentId: identity.assignmentId });
		await projectTreeDxProxyCommit({ store, access: access as never, projectId: input.projectId, method: input.method, path: input.path, body: input.body, payload });
		return { payload, proxy: { projectId: input.projectId, actorType: access.actorType, treeDxBaseUrl: baseUrl } };
	};
	return {
		async library(principal: OperationInvocationContext['principal'], projectId: string) { await authorize(store, projectId, 'projects:read:team', treeDxTokenScope(), 'GET', `/v1/projects/${projectId}/treedx-library`, {}, { interface: 'internal', requestId: '', principal }); return store.getProjectTreeDxLibrary(projectId); },
		async bindLibrary(principal: OperationInvocationContext['principal'], projectId: string, body: Record<string, unknown>) { await authorize(store, projectId, 'projects:manage:team', treeDxTokenScope(), 'POST', `/v1/projects/${projectId}/treedx-library`, {}, { interface: 'internal', requestId: '', principal }); const value = await store.upsertProjectTreeDxLibrary(projectId, body); if (!value) throw new CapacityGovernanceError('treedx_team_binding_required', 'Create a team TreeDX binding before binding a project library.', 404); return value; },
		createRepository: (projectId: string, body: Record<string, unknown>, query: Record<string, unknown>, context: OperationInvocationContext) => execute({ projectId, permission: 'projects:manage:team', method: 'POST', path: '/api/v1/repos', body, query, scope: treeDxTokenScope({ capabilities: ['repos:write'] }), context }),
		async createWorkspace(projectId: string, repoId: string, body: Record<string, unknown>, query: Record<string, unknown>, context: OperationInvocationContext) { assertRepository(await store.getProjectTreeDxLibrary(projectId), repoId); return execute({ projectId, permission: 'projects:manage:team', method: 'POST', path: `/api/v1/repos/${encodeURIComponent(repoId)}/workspaces`, body, query, scope: treeDxTokenScope({ repoId, capabilities: ['repos:write', 'workspace:create', 'files:read', 'files:write', 'git:read', 'git:diff', 'git:commit'], paths: ['**'] }), context }); },
		async workspace(projectId: string, workspaceId: string, operation: 'files' | 'changesets' | 'search' | 'commit' | 'close', body: Record<string, unknown> | undefined, query: Record<string, unknown>, context: OperationInvocationContext) {
			const library = await store.getProjectTreeDxLibrary(projectId); await verifyTreeDxWorkspace({ runtime, projectId, library, workspaceId }); const repoId = repositoryId(library);
			const filePath = operation === 'files' ? query.path : null; if (operation === 'files' && typeof filePath !== 'string') throw new CapacityGovernanceError('treedx_file_path_required', 'TreeDX file path is required.', 400);
			const method = operation === 'files' ? 'GET' as const : 'POST' as const; const path = operation === 'files' ? `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/files?path=${encodeURIComponent(String(filePath))}` : `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/${operation}`;
			const capabilities = operation === 'files' ? ['files:read'] : operation === 'changesets' ? ['files:write'] : operation === 'search' ? ['files:search'] : operation === 'close' ? ['workspace:write', 'files:read'] : ['git:commit'];
			const paths = operation === 'files' ? treeDxPathScope(filePath) : operation === 'changesets' ? treeDxChangesetPaths(body) : operation === 'search' && Array.isArray(body?.paths) ? body.paths.map(String) : ['**'];
			return execute({ projectId, permission: operation === 'files' || operation === 'search' ? 'projects:read:team' : 'projects:manage:team', method, path, body, query, scope: treeDxTokenScope({ repoId, capabilities, paths }), context });
		},
		async repositoryRead(projectId: string, repoId: string, operation: 'files/read' | 'paths/list' | 'context/build', body: Record<string, unknown>, query: Record<string, unknown>, context: OperationInvocationContext) {
			assertRepository(await store.getProjectTreeDxLibrary(projectId), repoId); const declared = Array.isArray(body.scopePaths) && body.scopePaths.length ? body.scopePaths : body.paths;
			const paths = Array.isArray(declared) && declared.length ? declared.flatMap(treeDxPathScope) : typeof body.path === 'string' ? treeDxPathScope(body.path) : ['**'];
			const capabilities = operation === 'context/build' ? ['files:read', 'files:search', 'git:read', 'graph:query', 'graph:refresh'] : ['files:read'];
			return execute({ projectId, permission: 'projects:read:team', method: 'POST', path: `/api/v1/repos/${encodeURIComponent(repoId)}/${operation}`,
				body: operation === 'context/build' ? treeDxRepoScopedContextBody(body, repoId) : body, query, scope: treeDxTokenScope({ repoId, capabilities, paths }), context });
		},
	};
}

export type TreeDxProxyOperationService = ReturnType<typeof createTreeDxProxyOperationService>;

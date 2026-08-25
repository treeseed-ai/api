import { createHash } from 'node:crypto';
import { TreeDxApiError } from '@treeseed/treedx/treedx/client';
import { TREEDX_OPENAPI_CONTRACT } from '@treeseed/treedx/openapi';
import type { ControlPlaneOperationDescriptor } from '@treeseed/sdk/operator-contracts';
import { treeDxProxyOperationMapping } from '@treeseed/sdk/treedx';
import { evaluateTreeDxProxyHandleAccess } from '../../../capacity/policy/treedx-proxy-access.ts';
import type { CapacityGovernanceDatabase } from '../../../capacity/database.ts';
import { CapacityGovernanceError } from '../../../capacity/database.ts';
import { projectTreeDxProxyCommit, recordTreeDxProxySuccess, type TreeDxProxyStore } from '../../../capacity/services/treedx/repositories/treedx-proxy-effects.ts';
import { resolveTreeDxProxyBaseUrl, resolveTreeDxProxyToken, treeDxTokenScope, verifyTreeDxWorkspace,
	type TreeDxProxyRuntime, type TreeDxProxyScope } from '../../../capacity/services/treedx/repositories/treedx-proxy-token-service.ts';
import { providerPrincipal, type ProviderPrincipal } from '../providers/provider-runtime-service.ts';
import type { OperationInvocationContext } from '../../catalog/operation-registry.ts';
import { TreeDxUpstreamAdmission, TreeDxUpstreamAdmissionError } from '../../treedx/upstream-admission.ts';
import { createOfficialTreeDxClient, invokeOfficialTreeDxOperation, requireTreeDxOperation, treeDxOperationScope } from '../../treedx/upstream-operation.ts';

interface Store extends TreeDxProxyStore {
	getProjectTreeDxLibrary(projectId: string): Promise<Record<string, unknown> | null>;
	upsertProjectTreeDxLibrary(projectId: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	getProjectDetails(projectId: string): Promise<{ project: { id: string; teamId: string } } | null>;
	principalCanAccessTeam(principal: unknown, teamId: string): Promise<boolean>;
	principalCanManageTeam(principal: unknown, teamId: string): Promise<boolean>;
	getProviderAssignment(teamId: string, assignmentId: string): Promise<Record<string, unknown> | null>;
	getTreeDxProxyHandle(teamId: string, projectId: string, handleId: string): Promise<Record<string, unknown> | null>;
	getTeamServiceConnection(teamId: string, connectionId: string): Promise<Record<string, unknown> | null>;
	upsertTeamTreeDx(teamId: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	run(sql: string, parameters?: unknown[]): Promise<unknown>;
	first(sql: string, parameters?: unknown[]): Promise<any>;
	all(sql: string, parameters?: unknown[]): Promise<any[]>;
}

type Permission = 'projects:read:team' | 'projects:manage:team';
type Access = { actorType: 'user' | 'capacity_provider'; principal: Record<string, unknown> | ProviderPrincipal;
	details: { project: { id: string; teamId: string } }; assignment: Record<string, unknown> | null; handle: Record<string, unknown> | null };

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

function repositoryId(library: Record<string, unknown> | null): string | null {
	const treeDx = record(record(record(library?.topology).contentRepository).treeDx);
	const value = library?.repositoryId ?? treeDx.repositoryId;
	return typeof value === 'string' && value.trim() ? value : null;
}

function connectionId(library: Record<string, unknown> | null, baseUrl: string) {
	const treeDx = record(record(record(library?.topology).contentRepository).treeDx);
	const value = library?.instanceId ?? treeDx.connectionId ?? treeDx.instanceId;
	return typeof value === 'string' && value.trim() ? value : `treedx-${createHash('sha256').update(baseUrl).digest('hex').slice(0, 16)}`;
}

function publicLibrary(library: Record<string, unknown> | null) {
	if (!library) return null;
	const { instanceId, ...value } = library;
	return { ...value, connectionId: instanceId ?? null };
}

const treeDxCapabilityGroups = ['repositories', 'workspaces', 'files', 'blobs', 'search', 'graph', 'context', 'artifacts', 'capabilities', 'health'];

async function acceptServiceContract(store: Store, acceptedConnectionId: string) {
	const now = new Date().toISOString();
	const id = `treedx-contract-${createHash('sha256').update(`${acceptedConnectionId}:${TREEDX_OPENAPI_CONTRACT.openapiSha256}`).digest('hex').slice(0, 24)}`;
	await store.run(`INSERT INTO treedx_service_contracts (id, connection_id, package_version, openapi_version,
		openapi_digest, operation_inventory_digest, generated_types_digest, compatibility_status, status,
		capability_groups_json, accepted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'compatible', 'accepted', ?, ?, ?)
		ON CONFLICT(connection_id, openapi_digest) DO UPDATE SET package_version = excluded.package_version,
		openapi_version = excluded.openapi_version, operation_inventory_digest = excluded.operation_inventory_digest,
		generated_types_digest = excluded.generated_types_digest, compatibility_status = excluded.compatibility_status,
		capability_groups_json = excluded.capability_groups_json, updated_at = excluded.updated_at`, [id, acceptedConnectionId,
		TREEDX_OPENAPI_CONTRACT.packageVersion, TREEDX_OPENAPI_CONTRACT.openapiVersion, TREEDX_OPENAPI_CONTRACT.openapiSha256,
		TREEDX_OPENAPI_CONTRACT.operationInventorySha256, TREEDX_OPENAPI_CONTRACT.generatedTypesSha256,
		JSON.stringify(treeDxCapabilityGroups), now, now]);
}

function assertRepository(library: Record<string, unknown> | null, requested: unknown) {
	if (typeof requested !== 'string') return;
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
	const write = scope.capabilities.some((capability) => /write|commit|create|delete|refresh|push|promote|retire/u.test(capability));
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
	method: string, path: string, query: Record<string, unknown>, context: OperationInvocationContext,
	resources: Record<string, unknown> = {}): Promise<Access> {
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
	if (!requiredHandleScopes(scope).some((value) => (handle.scopes as unknown[] ?? []).map(String).includes(value))) return reject('treedx_proxy_scope_denied', 'TreeDX proxy handle does not allow this operation.');
	const evaluated = evaluateTreeDxProxyHandleAccess(handle, { teamId: principal.teamId, projectId, assignmentId: identity.assignmentId,
		repositoryId: String(resources.repoId ?? scope.repoIds.find((value) => value !== '*') ?? '') || null,
		workspaceId: typeof resources.workspaceId === 'string' ? resources.workspaceId : null, operation: scope.capabilities[0] ?? null,
		path: scope.paths.find((value) => value !== '**') ?? null, token: identity.token });
	if (!evaluated.ok) return reject(evaluated.code ?? 'treedx_proxy_request_denied', evaluated.reason ?? 'TreeDX proxy handle does not allow this request.', evaluated.metadata ?? {});
	return { actorType: 'capacity_provider', principal, details, assignment, handle };
}

function actorId(access: Access) {
	return access.actorType === 'capacity_provider' ? String((access.principal as ProviderPrincipal).capacityProviderId) : String(access.principal.id);
}

function normalizedError(error: unknown): never {
	if (error instanceof TreeDxUpstreamAdmissionError) {
		const status = error.code === 'treedx_upstream_busy' ? 429 : error.code === 'treedx_upstream_cancelled' ? 409 : 503;
		throw new CapacityGovernanceError(error.code, error.message, status, { retryable: error.code !== 'treedx_upstream_cancelled' });
	}
	if (!(error instanceof TreeDxApiError)) throw error;
	const status = [400, 401, 403, 404, 409, 412, 413, 422, 429, 500, 503].includes(error.status) ? error.status : 503;
	const message = status === 404 ? 'The requested TreeDX resource was not found.'
		: status === 401 || status === 403 ? 'TreeDX rejected the scoped delegation.'
			: status === 409 || status === 412 ? 'The TreeDX resource changed or conflicts with this request.'
				: status === 429 ? 'TreeDX is temporarily busy.'
					: status >= 500 ? 'TreeDX is temporarily unavailable.' : 'TreeDX rejected the proxied request.';
	throw new CapacityGovernanceError(`treedx_${error.code}`, message, status as 503);
}

export function createTreeDxProxyOperationService(storeValue: CapacityGovernanceDatabase, runtime: TreeDxProxyRuntime) {
	const store = storeValue as Store;
	const admission = new TreeDxUpstreamAdmission();
	return {
		async library(principal: OperationInvocationContext['principal'], projectId: string) {
			await authorize(store, projectId, 'projects:read:team', treeDxTokenScope(), 'GET', 'treedx.library.show', {}, { interface: 'internal', requestId: '', principal });
			return publicLibrary(await store.getProjectTreeDxLibrary(projectId));
		},
		async bindLibrary(principal: OperationInvocationContext['principal'], projectId: string, body: Record<string, unknown>) {
			const access = await authorize(store, projectId, 'projects:manage:team', treeDxTokenScope(), 'POST', 'treedx.library.bind', {}, { interface: 'internal', requestId: '', principal });
			const requestedConnectionId = typeof body.connectionId === 'string' ? body.connectionId.trim() : '';
			if (!requestedConnectionId) throw new CapacityGovernanceError('treedx_connection_required', 'A trusted TreeDX connection is required.', 400);
			const connection = await store.getTeamServiceConnection(access.details.project.teamId, requestedConnectionId);
			if (!connection || connection.status === 'disconnected') throw new CapacityGovernanceError('treedx_connection_not_found', 'The selected TreeDX connection is unavailable.', 404);
			const config = record(connection.nonSecretConfig); const baseUrl = String(config.baseUrl ?? config.url ?? '').trim();
			if (!baseUrl) throw new CapacityGovernanceError('treedx_connection_invalid', 'The selected TreeDX connection has no trusted service URL.', 409);
			await store.upsertTeamTreeDx(access.details.project.teamId, { id: requestedConnectionId, kind: 'external_service', provider: 'service_connection',
				name: connection.displayName ?? 'TreeDX service', baseUrl, registryUrl: baseUrl, status: 'active', metadata: { serviceConnectionId: requestedConnectionId } });
			const { connectionId: _connectionId, ...binding } = body;
			const value = await store.upsertProjectTreeDxLibrary(projectId, { ...binding, instanceId: requestedConnectionId });
			if (!value) throw new CapacityGovernanceError('treedx_connection_required', 'Create a trusted TreeDX connection before binding a project library.', 404);
			await acceptServiceContract(store, requestedConnectionId);
			return publicLibrary(value);
		},
		async serviceContract(principal: OperationInvocationContext['principal'], projectId: string) {
			await authorize(store, projectId, 'projects:read:team', treeDxTokenScope(), 'GET', 'treedx.service.contract', {}, { interface: 'internal', requestId: '', principal });
			const library = await store.getProjectTreeDxLibrary(projectId);
			const accepted = library?.instanceId ? await store.first(`SELECT status, compatibility_status, accepted_at, observed_at
				FROM treedx_service_contracts WHERE connection_id = ? AND openapi_digest = ? LIMIT 1`,
				[library.instanceId, TREEDX_OPENAPI_CONTRACT.openapiSha256]) : null;
			return { service: 'treedx', packageVersion: TREEDX_OPENAPI_CONTRACT.packageVersion, openapiVersion: TREEDX_OPENAPI_CONTRACT.openapiVersion,
				openapiDigest: TREEDX_OPENAPI_CONTRACT.openapiSha256, operationInventoryDigest: TREEDX_OPENAPI_CONTRACT.operationInventorySha256,
				generatedTypesDigest: TREEDX_OPENAPI_CONTRACT.generatedTypesSha256, operationMapping: treeDxProxyOperationMapping(),
				capabilityGroups: treeDxCapabilityGroups, acceptance: accepted ? { status: accepted.status,
					compatibilityStatus: accepted.compatibility_status, acceptedAt: accepted.accepted_at, observedAt: accepted.observed_at } : null };
		},
		async listWorkspaces(projectId: string, query: Record<string, unknown>, context: OperationInvocationContext) {
			await authorize(store, projectId, 'projects:read:team', treeDxTokenScope({ capabilities: ['workspace:read'] }), 'GET', 'treedx.workspaces.list', query, context);
			const rows = await store.all(`SELECT upstream_request_id, metadata_json, created_at FROM treedx_project_proxy_audit
				WHERE project_id = ? AND path LIKE '%/workspaces' AND result_status = 'success' ORDER BY created_at DESC LIMIT 100`, [projectId]);
			return { items: rows.map((row) => { let metadata: unknown = {}; try { metadata = JSON.parse(row.metadata_json ?? '{}'); } catch { metadata = {}; }
				return { upstreamRequestId: row.upstream_request_id, createdAt: row.created_at, metadata: record(metadata) }; }) };
		},
		async invoke(descriptor: ControlPlaneOperationDescriptor, input: { path: Record<string, unknown>; query: Record<string, unknown>; body: unknown }, context: OperationInvocationContext) {
			if (descriptor.upstream?.service !== 'treedx') throw new CapacityGovernanceError('treedx_mapping_missing', 'The TreeDX proxy operation has no authoritative upstream mapping.', 500);
			const projectId = String(input.path.projectId ?? ''); const library = await store.getProjectTreeDxLibrary(projectId);
			if (!library) throw new CapacityGovernanceError('treedx_binding_unavailable', 'The project has no accepted TreeDX binding.', 503);
			assertRepository(library, input.path.repoId);
			const operation = requireTreeDxOperation(descriptor.upstream.operationId);
			const scope = treeDxOperationScope(operation, input, repositoryId(library) ? [repositoryId(library)!] : []);
			const permission: Permission = descriptor.kind === 'read' ? 'projects:read:team' : 'projects:manage:team';
			const access = await authorize(store, projectId, permission, scope, operation.method, operation.path, input.query, context, input.path);
			if (input.path.workspaceId) await verifyTreeDxWorkspace({ runtime, projectId, library, workspaceId: String(input.path.workspaceId) });
			const baseUrl = resolveTreeDxProxyBaseUrl(runtime, library);
			// TreeDX grants upstream authority to the control-plane service identity. The
			// end user or capacity provider remains the audited actor below, but must not
			// replace the service principal in the bounded delegation token.
			const token = resolveTreeDxProxyToken(runtime, baseUrl, projectId, scope, { connectionId: connectionId(library, baseUrl) });
			try {
				const payload = await admission.run({ connectionId: connectionId(library, baseUrl), projectId, actorId: actorId(access),
					retryable: descriptor.kind === 'read' || Boolean(context.idempotencyKey), signal: context.signal,
					transient: (error) => error instanceof TypeError || error instanceof TreeDxApiError && (error.status === 429 || error.status >= 500),
					invoke: async () => invokeOfficialTreeDxOperation({
						client: createOfficialTreeDxClient({ baseUrl, token, fetchImpl: runtime.fetchImpl, timeoutMs: 15_000 }), operation,
						path: input.path, query: input.query, body: input.body, requestId: context.requestId,
						traceparent: context.traceparent, idempotencyKey: context.idempotencyKey, signal: context.signal,
					}),
				});
				const identity = requestIdentity(context, input.query);
				await projectTreeDxProxyCommit({ store, access: access as never, projectId, method: operation.method,
					path: operation.path, body: input.body, payload });
				await recordTreeDxProxySuccess({ store, access: access as never, projectId, method: operation.method, path: operation.path,
					tokenScope: scope, assignmentId: identity.assignmentId });
				return { result: payload, receipt: { projectId, connectionId: connectionId(library, baseUrl), upstreamOperationId: operation.operationId,
					requestId: context.requestId, idempotencyKey: context.idempotencyKey ?? null } };
			} catch (error) { return normalizedError(error); }
		},
	};
}

export type TreeDxProxyOperationService = ReturnType<typeof createTreeDxProxyOperationService>;

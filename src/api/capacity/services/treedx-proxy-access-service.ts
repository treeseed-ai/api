import { createHash } from 'node:crypto';
import { evaluateTreeDxProxyHandleAccess } from '@treeseed/sdk/agent-capacity';
import type { Context } from 'hono';
import type { CapacityGovernanceDatabase } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';
import { requireProviderPrincipal, type CapacityProviderAccessPrincipal } from '../routes/provider-auth.ts';
import type { TreeDxProxyScope } from './treedx-proxy-token-service.ts';

interface TreeDxAccessStore extends CapacityGovernanceDatabase {
	getProjectDetails(projectId: string): Promise<{ project: { id: string; teamId: string } } | null>;
	getProviderAssignment(teamId: string, assignmentId: string): Promise<Record<string, unknown> | null>;
	getTreeDxProxyHandle(teamId: string, projectId: string, handleId: string): Promise<Record<string, unknown> | null>;
	recordTreeDxProxyAudit(input: Record<string, unknown>): Promise<unknown>;
}

export interface TreeDxProxyAccess {
	actorType: 'user' | 'capacity_provider';
	principal: Record<string, unknown> | CapacityProviderAccessPrincipal;
	details: { project: { id: string; teamId: string } };
	assignment: Record<string, unknown> | null;
	handle: Record<string, unknown> | null;
}

function requiredHandleScopes(scope: TreeDxProxyScope): string[] {
	const write = scope.capabilities.some((capability) => /write|commit|create|delete|refresh/u.test(capability));
	return write ? ['project:write', 'workspace:write', 'git:commit'] : ['project:read', 'workspace:read', 'files:read'];
}

async function recordDenial(store: TreeDxAccessStore, c: Context, input: {
	principal: CapacityProviderAccessPrincipal;
	projectId: string;
	assignmentId: string | null;
	handleId: string | null;
	code: string;
	message: string;
	details: Record<string, unknown>;
}) {
	await store.recordTreeDxProxyAudit({
		teamId: input.principal.teamId,
		projectId: input.projectId,
		assignmentId: input.assignmentId,
		actorType: 'capacity_provider',
		actorId: input.principal.capacityProviderId,
		method: c.req.method,
		path: new URL(c.req.url).pathname,
		handle: { id: input.handleId },
		resultStatus: 'denied',
		reasonCode: input.code,
		reason: input.message,
		metadata: { details: input.details },
	});
	throw new CapacityGovernanceError(input.code, input.message, 403, input.details);
}

export async function authorizeTreeDxProxy(input: {
	c: Context;
	store: CapacityGovernanceDatabase;
	projectId: string;
	permission: 'projects:read:team' | 'projects:manage:team';
	scope: TreeDxProxyScope;
	requireProjectAccess(c: Context, store: CapacityGovernanceDatabase, projectId: string, permission: string): Promise<{ response?: Response | null; principal?: Record<string, unknown>; details?: { project: { id: string; teamId: string } } }>;
}): Promise<TreeDxProxyAccess | { response: Response }> {
	const store = input.store as TreeDxAccessStore;
	const details = await store.getProjectDetails(input.projectId);
	if (!details) throw new CapacityGovernanceError('project_not_found', `Unknown project "${input.projectId}".`, 404);
	if (input.c.get('principal')) {
		const access = await input.requireProjectAccess(input.c, input.store, input.projectId, input.permission);
		if (access.response) return { response: access.response };
		return { actorType: 'user', principal: access.principal ?? {}, details: access.details ?? details, assignment: null, handle: null };
	}

	const requiredScopes = input.permission === 'projects:manage:team' ? ['provider:assignments:write'] : ['provider:assignments:read'];
	const principal = requireProviderPrincipal(input.c, requiredScopes);
	if (principal.teamId !== details.project.teamId) {
		await recordDenial(store, input.c, { principal, projectId: input.projectId, assignmentId: null, handleId: null, code: 'treedx_proxy_team_mismatch', message: 'Capacity provider cannot access this project.', details: { projectId: input.projectId, teamId: details.project.teamId } });
	}
	const assignmentId = input.c.req.header('x-treeseed-assignment-id') ?? input.c.req.query('assignmentId') ?? null;
	const handleId = input.c.req.header('x-treeseed-treedx-proxy-handle-id') ?? input.c.req.query('treeDxProxyHandleId') ?? null;
	const deny = (code: string, message: string, metadata: Record<string, unknown> = {}) => recordDenial(store, input.c, { principal, projectId: input.projectId, assignmentId, handleId, code, message, details: { projectId: input.projectId, assignmentId, handleId, ...metadata } });
	if (!assignmentId || !handleId) return deny('treedx_proxy_handle_missing', 'Capacity provider TreeDX proxy access requires an assignment-scoped proxy handle.');
	const assignment = await store.getProviderAssignment(principal.teamId, assignmentId);
	if (!assignment || assignment.projectId !== input.projectId || assignment.capacityProviderId !== principal.capacityProviderId) return deny('treedx_proxy_assignment_mismatch', 'TreeDX proxy handle is not bound to this provider assignment.');
	if (assignment.leaseState !== 'leased' || !assignment.leaseExpiresAt || Date.parse(assignment.leaseExpiresAt) <= Date.now()) return deny('treedx_proxy_assignment_not_leased', 'TreeDX proxy handle requires an active assignment lease.', { leaseState: assignment.leaseState });
	const handle = await store.getTreeDxProxyHandle(principal.teamId, input.projectId, handleId);
	if (!handle || handle.id !== handleId || handle.projectId !== input.projectId || handle.teamId !== principal.teamId || (handle.assignmentId && handle.assignmentId !== assignmentId)) return deny('treedx_proxy_scope_mismatch', 'TreeDX proxy handle scope does not match the active assignment.');
	const presentedToken = input.c.req.header('x-treeseed-treedx-proxy-handle') ?? input.c.req.query('treeDxProxyToken') ?? null;
	if (handle.tokenHash && (!presentedToken || createHash('sha256').update(presentedToken).digest('hex') !== handle.tokenHash)) return deny('treedx_proxy_token_mismatch', 'TreeDX proxy handle token does not match.');
	const acceptableScopes = requiredHandleScopes(input.scope);
	if (!acceptableScopes.some((scope) => (handle.scopes ?? []).map(String).includes(scope))) return deny('treedx_proxy_scope_denied', 'TreeDX proxy handle does not allow this operation.', { requiredAny: acceptableScopes });
	const repositoryIds = input.scope.repoIds.filter((value) => value !== '*');
	const paths = input.scope.paths.filter((value) => value !== '**');
	const workspaceMatch = new URL(input.c.req.url).pathname.match(/\/workspaces\/([^/]+)/u);
	const evaluated = evaluateTreeDxProxyHandleAccess(handle, {
		teamId: principal.teamId,
		projectId: input.projectId,
		assignmentId,
		repositoryId: repositoryIds[0] ?? null,
		workspaceId: workspaceMatch?.[1] ? decodeURIComponent(workspaceMatch[1]) : null,
		operation: input.scope.capabilities.find(Boolean) ?? null,
		path: paths.length === 1 ? paths[0] : null,
		token: presentedToken,
	});
	if (!evaluated.ok) return deny(evaluated.code ?? 'treedx_proxy_request_denied', evaluated.reason ?? 'TreeDX proxy handle does not allow this request.', evaluated.metadata ?? {});
	return { actorType: 'capacity_provider', principal, details, assignment, handle };
}

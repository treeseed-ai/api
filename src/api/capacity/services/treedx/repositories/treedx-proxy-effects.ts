import { gzipSync } from 'node:zlib';
import type { CapacityGovernanceDatabase } from '../../../database.ts';
import { CapacityGovernanceError } from '../../../database.ts';
import type { TreeDxProxyAccess } from './treedx-proxy-access-service.ts';
import {
	isLoopbackTreeDxBaseUrl,
	resolveTreeDxProxyToken,
	treeDxProxyActorId,
	treeDxProxyTenantId,
	treeDxRuntimeEnv,
	treeDxTokenScope,
	type TreeDxProxyRuntime,
	type TreeDxProxyScope,
} from './treedx-proxy-token-service.ts';
import { readBoundedTreeDxJson } from './treedx-response.ts';
import { projectTreeDxCommitSignals } from './treedx-change-projector.ts';

export interface TreeDxProxyStore extends CapacityGovernanceDatabase {
	getProjectTreeDxLibrary(projectId: string): Promise<Record<string, unknown> | null>;
	getProject(projectId: string): Promise<{ teamId: string } | null>;
	recordTreeDxProxyAudit(input: Record<string, unknown>): Promise<unknown>;
}

interface ProxyRequest {
	baseUrl: string;
	token: string;
	projectId: string;
	method: 'GET' | 'POST' | 'PUT';
	path: string;
	body?: unknown;
	fetchImpl: typeof fetch;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function requestTreeDxJson(input: ProxyRequest) {
	let response: Response;
	try {
		const serialized = input.body === undefined ? undefined : JSON.stringify(input.body);
		const gzip = input.path.endsWith('/changesets') && serialized !== undefined
			&& Buffer.byteLength(serialized, 'utf8') >= 1_024;
		response = await input.fetchImpl(`${input.baseUrl}${input.path}`, {
			method: input.method,
			headers: {
				accept: 'application/json',
				authorization: `Bearer ${input.token}`,
				...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
				...(gzip ? { 'content-encoding': 'gzip' } : {}),
			},
			body: serialized === undefined ? undefined : gzip ? gzipSync(serialized) : serialized,
		});
	} catch (error) {
		throw new CapacityGovernanceError('treedx_runtime_unavailable', 'TreeDX runtime is unavailable for this project.', 503, {
			projectId: input.projectId,
			details: error instanceof Error ? error.message : String(error),
		});
	}
	const payload = await readBoundedTreeDxJson(response);
	if (!response.ok) {
		throw new CapacityGovernanceError('treedx_proxy_request_failed', `TreeDX ${input.method} ${input.path} failed.`, response.status, {
			status: response.status,
			details: record(payload).error ?? payload,
		});
	}
	return payload;
}

export async function grantCreatedLoopbackRepository(input: {
	runtime: TreeDxProxyRuntime;
	baseUrl: string;
	token: string;
	projectId: string;
	method: ProxyRequest['method'];
	path: string;
	payload: unknown;
	fetchImpl: typeof fetch;
}) {
	if (input.method !== 'POST' || input.path !== '/api/v1/repos' || !isLoopbackTreeDxBaseUrl(input.baseUrl)) return;
	const payload = record(input.payload);
	const repository = record(payload.repo ?? payload.repository ?? input.payload);
	const rawRepositoryId = repository.repoId ?? repository.id ?? null;
	if (typeof rawRepositoryId !== 'string') return;
	const environment = treeDxRuntimeEnv(input.runtime);
	const grantToken = resolveTreeDxProxyToken(input.runtime, input.baseUrl, input.projectId, treeDxTokenScope({
		repoId: rawRepositoryId,
		capabilities: ['policy:write'],
		paths: ['**'],
	}));
	const response = await input.fetchImpl(`${input.baseUrl}/api/v1/policy/grants`, {
		method: 'POST',
		headers: { accept: 'application/json', authorization: `Bearer ${grantToken ?? input.token}`, 'content-type': 'application/json' },
		body: JSON.stringify({
			actorId: treeDxProxyActorId(environment),
			tenantId: treeDxProxyTenantId(environment),
			repoIds: [rawRepositoryId],
			capabilities: ['repos:read', 'repos:write', 'files:read', 'files:write', 'files:search', 'graph:query', 'graph:refresh', 'workspace:create', 'git:read', 'git:diff', 'git:commit', 'git:fetch'],
			refs: ['*'],
			paths: ['**'],
		}),
	});
	const grant = await readBoundedTreeDxJson(response);
	if (!response.ok) {
		throw new CapacityGovernanceError('treedx_repository_grant_failed', 'TreeDX repository was created but proxy capability grant failed.', response.status, {
			repositoryId: rawRepositoryId,
			details: record(grant).error ?? grant,
		});
	}
}

function actorId(access: TreeDxProxyAccess): string | null {
	return access.actorType === 'capacity_provider'
		? (access.principal as { capacityProviderId: string }).capacityProviderId
		: String((access.principal as Record<string, unknown>).id ?? '') || null;
}

export async function recordTreeDxProxySuccess(input: {
	store: TreeDxProxyStore;
	access: TreeDxProxyAccess;
	projectId: string;
	method: ProxyRequest['method'];
	path: string;
	tokenScope: TreeDxProxyScope;
	assignmentId: string | null;
}) {
	const project = await input.store.getProject(input.projectId);
	if (!project) throw new CapacityGovernanceError('project_not_found', `Unknown project "${input.projectId}".`, 404);
	await input.store.recordTreeDxProxyAudit({
		teamId: project.teamId,
		projectId: input.projectId,
		assignmentId: input.access.assignment?.id ?? input.assignmentId,
		actorType: input.access.actorType,
		actorId: actorId(input.access),
		method: input.method,
		path: input.path,
		handle: { ...(input.access.handle ?? {}), projectId: input.projectId, assignmentId: input.access.assignment?.id ?? null, scopes: input.tokenScope.capabilities },
		resultStatus: 'proxied',
		metadata: { tokenScope: input.tokenScope, providerAssignmentScoped: input.access.actorType === 'capacity_provider' },
	});
}

export async function projectTreeDxProxyCommit(input: {
	store: TreeDxProxyStore;
	access: TreeDxProxyAccess;
	projectId: string;
	method: ProxyRequest['method'];
	path: string;
	body?: unknown;
	payload: unknown;
}) {
	if (input.method !== 'POST' || !input.path.endsWith('/commit')) return;
	const commit = record(record(input.payload).commit ?? input.payload);
	const commitSha = String(commit.commitSha ?? commit.commit_sha ?? '');
	const rawChangedPaths = commit.changedPaths ?? commit.changed_paths;
	const changedPaths = Array.isArray(rawChangedPaths) ? rawChangedPaths as string[] : [];
	if (!commitSha || changedPaths.length === 0) return;
	const assignment = input.access.assignment;
	const decision = record(assignment?.decisionInput);
	const assignmentMetadata = record(assignment?.metadata);
	const activityType = assignment ? String(
		decision.activityType
			?? record(decision.metadata).activityType
			?? record(decision.input).activityType
			?? assignmentMetadata.activityType
			?? '',
	) || null : null;
	await projectTreeDxCommitSignals(input.store, {
		projectId: input.projectId,
		commitSha,
		immutableRef: String(commit.branchName ?? commit.branch_name ?? commitSha),
		changedPaths,
		changeSummary: typeof record(input.body).message === 'string' ? String(record(input.body).message) : 'Committed TreeDX content changes.',
		assignmentId: assignment?.id ?? null,
		workdayRunId: assignment ? String(assignmentMetadata.workdayRunId ?? '') || null : null,
		agentId: assignment ? String(assignment.agentId ?? '') || null : null,
		activityType,
		capacityProviderId: input.access.actorType === 'capacity_provider' ? actorId(input.access) : null,
		actorType: input.access.actorType === 'capacity_provider' ? 'capacity_provider' : 'user',
		actorId: actorId(input.access),
	});
}

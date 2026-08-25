import type { CapacityGovernanceDatabase } from '../../../database.ts';
import { CapacityGovernanceError } from '../../../database.ts';
import type { TreeDxProxyScope } from './treedx-proxy-token-service.ts';
import { projectTreeDxCommitSignals } from './treedx-change-projector.ts';
import { recordTreeDxAuthoringState } from './treedx-authoring-journal.ts';

export interface TreeDxProxyStore extends CapacityGovernanceDatabase {
	getProjectTreeDxLibrary(projectId: string): Promise<Record<string, unknown> | null>;
	getProject(projectId: string): Promise<{ teamId: string } | null>;
	recordTreeDxProxyAudit(input: Record<string, unknown>): Promise<unknown>;
}

interface TreeDxProxyAccess {
	actorType: 'user' | 'capacity_provider';
	principal: Record<string, unknown>;
	assignment: Record<string, unknown> | null;
	handle: Record<string, unknown> | null;
}

type ProxyMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
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
	method: ProxyMethod;
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
	method: ProxyMethod;
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
	const library = await input.store.getProjectTreeDxLibrary(input.projectId);
	const repositoryId = String(input.access.handle?.repositoryId ?? record(library).repositoryId ?? '');
	if (!repositoryId) throw new CapacityGovernanceError('treedx_authoring_repository_missing','TreeDX commit journaling requires the durable repository identity.',500,{ projectId:input.projectId });
	const decision = record(assignment?.decisionInput);
	const assignmentMetadata = record(assignment?.metadata);
	const activityType = assignment ? String(
		decision.activityType
			?? record(decision.metadata).activityType
			?? record(decision.input).activityType
			?? assignmentMetadata.activityType
			?? '',
	) || null : null;
	await recordTreeDxAuthoringState(input.store,'unpublished',{
		projectId:input.projectId,
		repositoryId,
		commitSha,
		ref:String(commit.branchName ?? commit.branch_name ?? commitSha),
		changedPaths,
		assignmentId:assignment?.id ?? null,
		actorType:input.access.actorType === 'capacity_provider' ? 'capacity_provider' : 'user',
		actorId:actorId(input.access),
	});
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

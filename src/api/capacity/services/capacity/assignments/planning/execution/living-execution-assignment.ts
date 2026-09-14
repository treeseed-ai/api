import { appliedWorkdaySchema, assignmentAttemptSchema, assignmentResultSchema, selectFairReadyNode,
} from '@treeseed/sdk/agent-capacity';
import type { DurableProviderAssignment } from '../../../../../repositories/capacity/assignments/assignment.ts';
import { CapacityWorkdayRunRepository } from '../../../../../repositories/capacity/workdays/workday-run.ts';
import { CapacityGovernanceError } from '../../../../../database.ts';
import type { ProviderLeasePrincipal } from '../../../../accounts/lease-authority-service.ts';
import type { ProviderSynthesisExecutionProvider } from '../../../providers/provider-synthesis-context-service.ts';
import { listReadyExecutionNodes } from '../../../../build/ready-execution-node.ts';
import { capacityWorkdayRequestedProjectSlugs, resolveCapacityWorkdayProjects } from '../../../workdays/policy/workday-project-policy.ts';
import { admitLivingExecutionAssignment } from '../../admission/living-execution-admission.ts';
import { buildAssignmentAttempt } from './assignment-attempt-builder.ts';
import type { AssignmentFunctionStore } from '../support/assignment-function-store.ts';

const record = (value: unknown): Record<string, unknown> => {
	if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
	if (typeof value === 'string') try { return record(JSON.parse(value)); } catch { return {}; }
	return {};
};

const unique = (values: Array<string | undefined>) => [...new Set(values.filter((value): value is string => Boolean(value)))];

async function issueLivingTreeDxAuthority(store: AssignmentFunctionStore, run: Parameters<typeof buildAssignmentAttempt>[0]['run'],
	assignment: ReturnType<typeof buildAssignmentAttempt>['assignment'], now: string) {
	const currentRepositoryId = assignment.workspace.mode === 'treedx'
		? assignment.workspace.repository
		: assignment.sourceRef.repository;
	const readPaths = unique(assignment.grant.contentRead.filter((reference) => reference.repository === currentRepositoryId)
		.map((reference) => reference.path));
	const writePaths = unique(assignment.grant.contentWrite.map((reference) => reference.path));
	const allowedPaths = unique([...readPaths, ...writePaths]);
	const repositoryId = assignment.workspace.mode === 'treedx'
		? assignment.workspace.repository
		: assignment.grant.contentRead.find((reference) => reference.repository)?.repository;
	const teamLibraryProject = await store.getProjectByTeamAndSlug(assignment.teamId, 'team');
	const projects = await store.listTeamProjects(assignment.teamId);
	const projectBindings = await Promise.all(projects.map(async (project) => ({
		project,
		binding: await store.getProjectTreeDxLibrary(String(project.id)),
	})));
	const boundRepositoryId = ({ binding }: (typeof projectBindings)[number]) => String(binding?.repositoryId
		?? record(record(record(binding?.topology).contentRepository).treeDx).repositoryId ?? '');
	const repositoryProjectId = String(projectBindings.find((entry) => boundRepositoryId(entry) === repositoryId)?.project.id ?? '');
	const readRepositories = projectBindings.flatMap(({ project, binding }) => {
		const candidateRepositoryId = String(binding?.repositoryId
			?? record(record(record(binding?.topology).contentRepository).treeDx).repositoryId ?? '');
		if (!candidateRepositoryId) return [];
		const references = assignment.grant.contentRead.filter((reference) => reference.repository === candidateRepositoryId);
		if (!references.length) return [];
		return [{
			projectId: String(project.id), projectSlug: String(project.slug ?? ''), repositoryId: candidateRepositoryId,
			baseRef: String(references[0]!.commit), allowedPaths: unique(references.map((reference) => reference.path)),
			allowedModels: unique(references.map((reference) => reference.model)),
			source: String(project.id) === String(teamLibraryProject?.id) ? 'team-library' as const : 'same-team' as const,
		}];
	});
	let workspace: Record<string, unknown> = {};
	if (assignment.workspace.mode === 'treedx') {
		workspace = await store.createCapacityWorkdayTreeDxWorkspace({ id: assignment.projectId }, run, {
			workspaceId: assignment.workspace.workspaceId,
			repositoryId: assignment.workspace.repository,
			assignmentId: assignment.id,
			baseRef: assignment.workspace.baseCommit,
			branchName: `refs/heads/${assignment.id}`,
			mode: 'writable',
			allowedPaths,
			ttlSeconds: Math.max(1, Math.ceil((Date.parse(assignment.deadline) - Date.parse(now)) / 1_000)),
		});
		if (String(workspace.baseCommitSha ?? '') !== assignment.workspace.baseCommit) throw new CapacityGovernanceError(
			'assignment_workspace_base_mismatch', 'TreeDX issued a workspace from a different base commit.', 502,
			{ assignmentId: assignment.id },
		);
	}
	const write = assignment.workspace.mode === 'treedx';
	return {
		id: `tdx_${assignment.id}`, teamId: assignment.teamId, projectId: assignment.projectId,
		assignmentId: assignment.id, repositoryId: repositoryId ?? null, repositoryProjectId: repositoryProjectId || null,
		workspaceId: write ? assignment.workspace.workspaceId : null,
		baseRef: write ? assignment.workspace.baseCommit : assignment.sourceRef.commit ?? null,
		baseCommitSha: write ? assignment.workspace.baseCommit : assignment.sourceRef.commit ?? null,
		...(write ? { branchName: String(workspace.branchName ?? `refs/heads/${assignment.id}`) } : {}),
		status: 'issued',
		scopes: write
			? ['project:read','project:write','workspace:read','workspace:write','files:read','files:search','graph:query','files:write','git:commit']
			: ['project:read','files:read','files:search','graph:query'],
		allowedOperations: write
			? ['files:read','files:search','graph:query','files:write','git:commit','workspace:write']
			: ['files:read','files:search','graph:query'],
		allowedPaths, allowedReadPaths: readPaths, allowedWritePaths: writePaths, readRepositories,
		expiresAt: assignment.deadline,
		metadata: { source: 'living_execution_graph', nodeId: assignment.nodeId, nodeRevision: assignment.nodeRevision,
			graphRevision: assignment.graphRevision, baseRef: write ? assignment.workspace.baseCommit : assignment.sourceRef.commit ?? null,
			baseCommitSha: write ? assignment.workspace.baseCommit : assignment.sourceRef.commit ?? null, repositoryProjectId: repositoryProjectId || null,
			branchName: workspace.branchName ?? null, readRepositories },
	};
}

export async function executionNodeAssignmentGeneration(
	store: Pick<AssignmentFunctionStore, 'first'>,
	teamId: string,
	nodeId: string,
	nodeRevision: number,
): Promise<number> {
	const row = await store.first(`SELECT COUNT(*) AS assignment_count FROM capacity_provider_assignments
		WHERE team_id=? AND execution_node_id=? AND execution_node_revision=?`, [teamId, nodeId, nodeRevision]);
	return Math.max(0, Number(row?.assignment_count ?? 0));
}

/** Claim one ready graph node without creating a demand or capacity-plan record. */
export async function assignNextReadyExecutionNode(
	store: AssignmentFunctionStore,
	principal: ProviderLeasePrincipal,
	providerSessionId: string,
	executionProviders: ProviderSynthesisExecutionProvider[],
	now = new Date().toISOString(),
): Promise<DurableProviderAssignment | null> {
	const runs = await new CapacityWorkdayRunRepository(store).listActiveForSupply(principal.teamId, principal.capacityProviderId);
	for (const run of runs) {
		const parsedPlan = appliedWorkdaySchema.safeParse(run.parameters.appliedPlan);
		if (!parsedPlan.success) continue;
		const appliedPlan = parsedPlan.data;
		if (appliedPlan.state === 'planned' || appliedPlan.state === 'ended') continue;
		const activeRow = await store.first(`SELECT COUNT(*) AS active_count FROM capacity_provider_assignments
			WHERE team_id=? AND work_day_id=? AND status IN ('pending','leased','running')`, [run.teamId,run.id]);
		if (Number(activeRow?.active_count ?? 0) >= appliedPlan.policySnapshot.maximumConcurrency) continue;
		const projects = resolveCapacityWorkdayProjects(
			capacityWorkdayRequestedProjectSlugs(run.parameters),
			await store.listTeamProjects(run.teamId),
		);
		const candidates = (await Promise.all(projects.map((project) => listReadyExecutionNodes(store, run, project)))).flat()
			.filter((candidate) => appliedPlan.state === 'closing' ? candidate.node.kind === 'reporting' : candidate.node.kind !== 'reporting')
			.filter((candidate) => appliedPlan.state === 'closing'
				|| Date.parse(appliedPlan.endsAt) - Date.parse(now) >= (candidate.node.estimate?.minimumSeconds ?? 1) * 1_000);
		const prior = await store.all(`SELECT assignment_attempt_json,assignment_result_json FROM capacity_provider_assignments
			WHERE team_id=? AND work_day_id=? AND assignment_result_json IS NOT NULL`, [run.teamId,run.id]);
		const usage = prior.flatMap((row) => {
			const attempt = assignmentAttemptSchema.safeParse(record(row.assignment_attempt_json));
			const result = assignmentResultSchema.safeParse(record(row.assignment_result_json));
			return attempt.success && result.success ? [{ projectId: attempt.data.projectId,
				agentClass: attempt.data.effectiveProfile.profileRef.id.split('/').at(-1) ?? attempt.data.effectiveProfile.profileRef.id,
				seconds: result.data.usage.elapsedSeconds }] : [];
		});
		const policy = appliedPlan.policySnapshot;
		const remaining = [...candidates];
		while (remaining.length) {
			const selectedNode = selectFairReadyNode(remaining.map((candidate) => ({ id: candidate.node.id,
				projectId: candidate.node.projectId, agentClass: candidate.node.agentClass!, graphPriority: 0,
				readyAt: candidate.readyAt || now })), usage, policy);
			const candidate = remaining.find((item) => item.node.id === selectedNode?.id);
			if (!candidate) break;
			remaining.splice(remaining.indexOf(candidate), 1);
				const priorAttempts = await executionNodeAssignmentGeneration(
					store, candidate.node.teamId, candidate.node.id, candidate.node.nodeRevision,
				);
				const selected = buildAssignmentAttempt({
					candidate, run, principal, providerSessionId, providers: executionProviders,
					attempt: priorAttempts + 1, now,
				});
				const attempt = selected.assignment;
				try {
					const treedxProxyHandle = await issueLivingTreeDxAuthority(store, run, attempt, now);
					return await admitLivingExecutionAssignment(store, { principal, assignment: attempt,
						projectAgentClassId: candidate.projectAgentClassId, providerSessionId,
						executionProviderId: selected.executionProviderId, laneId: selected.laneId,
						lanePurpose: selected.lanePurpose,
						executionKind: candidate.node.kind === 'communication' ? 'conversation' : 'workday',
						invocationId: candidate.node.kind === 'communication'
							? String(record(run.parameters.discussion).invocationId ?? '') || null : null,
						predecessorResults: candidate.predecessorResults, treedxProxyHandle, now });
				} catch (error) {
					if (error instanceof CapacityGovernanceError && [
						'execution_node_claim_lost', 'execution_node_claim_stale',
						'capacity_execution_provider_unavailable',
					].includes(error.code)) continue;
					throw error;
				}
		}
	}
	return null;
}

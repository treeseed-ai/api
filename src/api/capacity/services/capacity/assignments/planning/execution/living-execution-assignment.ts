import { appliedWorkdaySchema, selectFairReadyNode, workdayPhase,
} from '@treeseed/sdk/agent-capacity';
import type { DurableProviderAssignment } from '../../../../../repositories/capacity/assignments/assignment.ts';
import { CapacityWorkdayRunRepository } from '../../../../../repositories/capacity/workdays/workday-run.ts';
import { CapacityGovernanceError } from '../../../../../database.ts';
import type { ProviderLeasePrincipal } from '../../../../accounts/lease-authority-service.ts';
import type { ProviderSynthesisExecutionProvider } from '../../../providers/provider-synthesis-context-service.ts';
import { isProposalGovernanceReview, listReadyExecutionNodes } from '../../../../build/ready-execution-node.ts';
import { capacityWorkdayRequestedProjectReferences, resolveCapacityWorkdayProjects } from '../../../workdays/policy/workday-project-policy.ts';
import { admitLivingExecutionAssignment } from '../../admission/living-execution-admission.ts';
import { buildAssignmentAttempt } from './assignment-attempt-builder.ts';
import type { LivingExecutionStore } from '../support/living-execution-store.ts';
import { livingAllocationInputs } from '../../admission/living-allocation-inputs.ts';

const record = (value: unknown): Record<string, unknown> => {
	if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
	if (typeof value === 'string') try { return record(JSON.parse(value)); } catch { return {}; }
	return {};
};

const unique = (values: Array<string | undefined>) => [...new Set(values.filter((value): value is string => Boolean(value)))];

export function workdayConcurrencyAvailable(kind: string, active: Record<string, number>, policy: {
	maximumConcurrency: number; communicationConcurrency: number;
}): boolean {
	return kind === 'communication'
		? (active.conversation ?? 0) < policy.communicationConcurrency
		: (active.workday ?? 0) < policy.maximumConcurrency;
}

export function prioritizeCommunicationCandidates<T extends { node: { kind: string } }>(candidates: T[]): T[] {
	const communication = candidates.filter((candidate) => candidate.node.kind === 'communication');
	return communication.length ? communication : candidates;
}

export function isNodeEligibleInWorkdayPhase(
	node: Parameters<typeof isProposalGovernanceReview>[0], phase: 'planning' | 'acting', closing: boolean,
): boolean {
	if (closing) return node.kind === 'reporting';
	if (node.kind === 'reporting') return false;
	if (node.kind === 'communication') return true;
	const planningWork = node.kind === 'planning' || node.kind === 'estimating' || isProposalGovernanceReview(node);
	return phase === 'planning' ? planningWork : !planningWork;
}

export function reservationFairUsage(rows: Record<string, unknown>[]) {
	return rows.map((row) => ({ projectId: String(row.project_id), agentClass: String(row.agent_class),
		seconds: ['reserved', 'consuming'].includes(String(row.state))
			? Math.max(Number(row.active_seconds ?? 0), Number(row.reserved_seconds ?? 0)) : Number(row.active_seconds ?? 0) }));
}
export const treeDxAuthorizedPaths = (values: Array<string | undefined>) => unique(values).flatMap((path) => {
	const leaf = path.split('/').at(-1) ?? path;
	return leaf.includes('.') || /[*?\[\]]/u.test(path)
		? [path]
		: [path, `${path}.md`, `${path}.mdx`, `${path}.yaml`, `${path}.yml`, `${path}.json`];
});

async function issueLivingTreeDxAuthority(store: LivingExecutionStore, run: Parameters<typeof buildAssignmentAttempt>[0]['run'],
	assignment: ReturnType<typeof buildAssignmentAttempt>['assignment'], now: string) {
	const currentRepositoryId = assignment.workspace.mode === 'treedx'
		? assignment.workspace.repository
		: assignment.sourceRef.repository;
	const readPaths = treeDxAuthorizedPaths(assignment.grant.contentRead.filter((reference) => reference.repository === currentRepositoryId)
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
		return unique(references.map((reference) => reference.commit)).map((baseRef) => {
			const exact = references.filter((reference) => reference.commit === baseRef);
			return {
				projectId: String(project.id), projectSlug: String(project.slug ?? ''), repositoryId: candidateRepositoryId,
				baseRef, allowedPaths: treeDxAuthorizedPaths(exact.map((reference) => reference.path)),
				allowedModels: unique(exact.map((reference) => reference.model)),
				source: String(project.id) === String(teamLibraryProject?.id) ? 'team-library' as const : 'same-team' as const,
			};
		});
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
	store: Pick<LivingExecutionStore, 'first'>,
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
	store: LivingExecutionStore,
	principal: ProviderLeasePrincipal,
	providerSessionId: string,
	executionProviders: ProviderSynthesisExecutionProvider[],
	now = new Date().toISOString(),
): Promise<DurableProviderAssignment | null> {
	const runs = await new CapacityWorkdayRunRepository(store).listActiveForSupply(principal.teamId, principal.capacityProviderId);
	const deferred: Array<{ runId: string; nodeId: string; code: string; details: unknown }> = [];
	const selection = { activeRuns: runs.length, readyNodes: 0, phaseEligible: 0, concurrencyEligible: 0,
		windowEligible: 0, attemptedNodes: 0, claimLost: 0, claimStale: 0, providerUnavailable: 0, allocationDeferred: 0,
		claimLoss: null as unknown };
	for (const run of runs) {
		const parsedPlan = appliedWorkdaySchema.safeParse(run.parameters.appliedPlan);
		if (!parsedPlan.success) continue;
		const appliedPlan = parsedPlan.data;
		if (appliedPlan.state === 'planned' || appliedPlan.state === 'ended') continue;
		const activeRows = await store.all(`SELECT execution_kind,COUNT(*) AS active_count FROM capacity_provider_assignments
			WHERE team_id=? AND work_day_id=? AND status IN ('pending','leased','running') GROUP BY execution_kind`, [run.teamId,run.id]);
		const activeByKind = Object.fromEntries(activeRows.map((row) => [String(row.execution_kind), Number(row.active_count)]));
		const projects = resolveCapacityWorkdayProjects(
			capacityWorkdayRequestedProjectReferences(run.parameters),
			await store.listTeamProjects(run.teamId),
		);
		const phase = workdayPhase(appliedPlan, now);
		const ready = (await Promise.all(projects.map((project) => listReadyExecutionNodes(store, run, project)))).flat();
		selection.readyNodes += ready.length;
		const inPhase = ready.filter((candidate) => isNodeEligibleInWorkdayPhase(candidate.node, phase, appliedPlan.state === 'closing'));
		selection.phaseEligible += inPhase.length;
		const concurrent = inPhase.filter((candidate) => workdayConcurrencyAvailable(candidate.node.kind, activeByKind, appliedPlan.policySnapshot));
		selection.concurrencyEligible += concurrent.length;
		const withinWindow = concurrent.filter((candidate) => appliedPlan.state === 'closing'
			|| Date.parse(appliedPlan.endsAt) - Date.parse(now) >= (candidate.node.estimate?.minimumSeconds ?? 1) * 1_000);
		selection.windowEligible += withinWindow.length;
		const candidates = prioritizeCommunicationCandidates(withinWindow);
		const prior = await store.all(`SELECT node.project_id,node.agent_class,reservation.active_seconds,
			reservation.reserved_seconds,reservation.state FROM capacity_reservations reservation
			JOIN capacity_provider_assignments assignment ON assignment.reservation_id=reservation.id
			JOIN execution_nodes node ON node.team_id=assignment.team_id AND node.id=assignment.execution_node_id
			WHERE reservation.team_id=? AND reservation.work_day_id=?`, [run.teamId,run.id]);
		const usage = reservationFairUsage(prior);
		const policy = appliedPlan.policySnapshot;
		const remaining = [...candidates];
		while (remaining.length) {
			const selectedNode = selectFairReadyNode(remaining.map((candidate) => ({ id: candidate.node.id,
				projectId: candidate.node.projectId, agentClass: candidate.node.agentClass!,
				readyAt: candidate.readyAt || now })), usage, policy);
			const candidate = remaining.find((item) => item.node.id === selectedNode?.id);
			if (!candidate) break;
			remaining.splice(remaining.indexOf(candidate), 1);
			selection.attemptedNodes += 1;
				const priorAttempts = await executionNodeAssignmentGeneration(
					store, candidate.node.teamId, candidate.node.id, candidate.node.nodeRevision,
				);
				try {
				const allocationInputs = await livingAllocationInputs(store, { run, runs, providers: executionProviders,
					capacityProviderId: principal.capacityProviderId, capabilityId: candidate.node.requiredCapabilities?.[0] ?? '',
					agentClass: candidate.node.agentClass!, activity: candidate.effectiveProfile.activity, now });
				const selected = buildAssignmentAttempt({
					candidate, run, principal, providerSessionId, providers: executionProviders, allocationInputs,
					attempt: priorAttempts + 1, now,
				});
				const attempt = selected.assignment;
					const treedxProxyHandle = await issueLivingTreeDxAuthority(store, run, attempt, now);
					const admitted = await admitLivingExecutionAssignment(store, { principal, assignment: attempt, allocation: { ...selected.allocation, selection: selectedNode },
						workdayConcurrencyLimit: candidate.node.kind === 'communication'
							? appliedPlan.policySnapshot.communicationConcurrency : appliedPlan.policySnapshot.maximumConcurrency,
						accountingLimits: selected.accountingLimits,
						projectAgentClassId: candidate.projectAgentClassId, providerSessionId,
						executionProviderId: selected.executionProviderId, laneId: selected.laneId,
						lanePurpose: selected.lanePurpose, providerConcurrencyLimit: selected.providerConcurrencyLimit,
						executionKind: candidate.node.kind === 'communication' ? 'conversation' : 'workday',
						invocationId: candidate.node.kind === 'communication'
							? candidate.node.sourceRef.id : null,
						predecessorResults: candidate.predecessorResults, treedxProxyHandle, now });
					return { assignment: admitted, selection };
				} catch (error) {
					if (error instanceof CapacityGovernanceError && [
						'execution_node_claim_lost', 'execution_node_claim_stale',
						'capacity_execution_provider_unavailable',
						'capacity_assignment_allocation_deferred',
					].includes(error.code)) {
					if (error.code === 'execution_node_claim_lost') { selection.claimLost += 1; selection.claimLoss = error.details; }
					if (error.code === 'execution_node_claim_stale') selection.claimStale += 1;
					if (error.code === 'capacity_execution_provider_unavailable') selection.providerUnavailable += 1;
					if (error.code === 'capacity_assignment_allocation_deferred') selection.allocationDeferred += 1;
						if (error.code.startsWith('capacity_')) deferred.push({
							runId: run.id, nodeId: candidate.node.id, code: error.code, details: error.details,
						});
						continue;
					}
					throw error;
				}
		}
	}
	if (deferred.length) throw new CapacityGovernanceError(
		'capacity_assignment_synthesis_deferred',
		'Ready execution nodes could not fit the currently available provider allocation.',
		409,
		{ candidates: deferred },
	);
	return { assignment: null, selection };
}

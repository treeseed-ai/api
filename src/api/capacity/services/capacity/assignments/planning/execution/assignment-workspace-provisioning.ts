import { CapacityGovernanceError } from '../../../../../database.ts';
import { CapacityWorkdayRunRepository } from '../../../../../repositories/capacity/workdays/workday-run.ts';
import type { CapacityWorkdayDemandRepository } from '../../../../../repositories/capacity/workdays/workday-demand.ts';
import type { ExecutionNodeAssignmentInput } from '../../../../build/execution-node-demand-compiler.ts';
import type { assignmentInput } from '../assignment-function.ts';
import type { AssignmentFunctionStore } from '../support/assignment-function-store.ts';
import { persistIssuedWorkspaceAuthority } from '../workspace-authority-persistence.ts';

export async function provisionAssignmentWorkspace(store: AssignmentFunctionStore,
	demand: NonNullable<Awaited<ReturnType<CapacityWorkdayDemandRepository['claimNext']>>> | ExecutionNodeAssignmentInput,
	input: ReturnType<typeof assignmentInput>, now: string) {
	const run = await new CapacityWorkdayRunRepository(store).get(demand.teamId, demand.workdayRunId);
	if (!run) throw new CapacityGovernanceError('capacity_workday_run_missing', 'Demand-owned workday run no longer exists.', 500, { demandId: demand.id });
	const workspace = await store.createCapacityWorkdayTreeDxWorkspace({ id: demand.projectId }, run, {
		repositoryId: input.workspace.repositoryId, assignmentId: input.assignmentId, baseRef: input.workspace.baseRef,
		branchName: `refs/heads/${input.assignmentId}`, mode: 'writable', allowedPaths: input.workspace.allowedPaths,
		ttlSeconds: Math.max(1800, Number(run.parameters.durationSeconds ?? 600) + 1800),
	});
	await persistIssuedWorkspaceAuthority({ store, assignmentId: input.assignmentId, proxyHandle: input.treedxProxyHandle,
		workspaceContext: input.workspaceContext, workspace, now });
}

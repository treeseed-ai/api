import { assignmentPathAllowed, assignmentResultSchema, type AssignmentResult } from '@treeseed/sdk/agent-capacity';
import { CapacityGovernanceError } from '../../../../database.ts';
import type { DurableProviderAssignment } from '../../../../repositories/capacity/assignments/assignment.ts';

const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Validate the one general result contract returned by AgentKernel. */
export function validateAssignmentResultCompletion(
	assignment: DurableProviderAssignment,
	input: Record<string, unknown>,
): AssignmentResult {
	if (!assignment.assignmentAttempt || !assignment.executionNodeId) {
		throw new CapacityGovernanceError('assignment_attempt_required', 'Living execution completion requires its immutable assignment attempt.', 409, { assignmentId: assignment.id });
	}
	const output = record(input.output);
	const parsed = assignmentResultSchema.safeParse(output.assignmentResult ?? input.assignmentResult);
	if (!parsed.success) throw new CapacityGovernanceError(
		'assignment_result_invalid', 'AgentKernel completion requires the canonical assignment result.', 409,
		{ assignmentId: assignment.id, diagnostics: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) },
	);
	if (parsed.data.assignmentId !== assignment.id) throw new CapacityGovernanceError(
		'assignment_result_identity_mismatch', 'Assignment result does not belong to this assignment.', 409, { assignmentId: assignment.id },
	);
	const workspace = assignment.assignmentAttempt.workspace;
	const matching = parsed.data.references.filter((reference) => {
		if (workspace.mode === 'git') return reference.kind === 'git'
			&& reference.repository === workspace.repository && reference.branch === workspace.branch;
		if (workspace.mode === 'treedx') return reference.kind === 'treedx'
			&& reference.repository === workspace.repository && reference.workspaceId === workspace.workspaceId
			&& assignmentPathAllowed(reference.path, workspace.writablePaths);
		return false;
	});
	if (workspace.mode !== 'read-only' && matching.length === 0) throw new CapacityGovernanceError(
		'assignment_result_workspace_reference_required',
		`Completed ${workspace.mode} work must return its exact committed workspace reference.`, 409,
		{ assignmentId: assignment.id, workspace: workspace.mode },
	);
	if (parsed.data.references.some((reference) => reference.kind === 'git' && workspace.mode !== 'git'
		|| reference.kind === 'treedx' && workspace.mode !== 'treedx')) throw new CapacityGovernanceError(
		'assignment_result_reference_denied', 'Assignment result references a mutable store outside its selected workspace.', 409,
		{ assignmentId: assignment.id, workspace: workspace.mode },
	);
	return parsed.data;
}

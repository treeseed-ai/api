import { assignmentPathAllowed, assignmentResultSchema, type AssignmentResult } from '@treeseed/sdk/agent-capacity';
import { CapacityGovernanceError } from '../../../../database.ts';
import type { DurableProviderAssignment } from '../../../../repositories/capacity/assignments/assignment.ts';

const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Validate the one general result contract returned by AgentKernel. */
export function validateAssignmentResultCompletion(
	assignment: DurableProviderAssignment,
	input: Record<string, unknown>,
	now = new Date().toISOString(),
): AssignmentResult {
	if (!assignment.assignmentAttempt || !assignment.executionNodeId) {
		throw new CapacityGovernanceError('assignment_attempt_required', 'Living execution completion requires its immutable assignment attempt.', 409, { assignmentId: assignment.id });
	}
	const output = record(input.output);
	const supplied = output.assignmentResult ?? input.assignmentResult;
	const raw = record(supplied);
	if (['id', 'assignmentId'].some(field => typeof raw[field] === 'string' && raw[field] !== raw[field].trim())) throw new CapacityGovernanceError(
		'assignment_result_invalid', 'Canonical result identities must retain their exact untrimmed input bytes.', 409);
	const parsed = assignmentResultSchema.safeParse(supplied);
	if (!parsed.success) throw new CapacityGovernanceError(
		'assignment_result_invalid', 'AgentKernel completion requires the canonical assignment result.', 409,
		{ assignmentId: assignment.id, diagnostics: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) },
	);
	if (parsed.data.assignmentId !== assignment.id) throw new CapacityGovernanceError(
		'assignment_result_identity_mismatch', 'Assignment result does not belong to this assignment.', 409, { assignmentId: assignment.id },
	);
	const time = record(record(record(assignment.capacityEnvelope).budget).time);
	const started = Date.parse(String(time.executionStartedAt ?? assignment.assignmentAttempt.createdAt));
	const completed = Date.parse(parsed.data.completedAt), deadline = Date.parse(assignment.assignmentAttempt.deadline), reported = Date.parse(now);
	if (![started, completed, deadline, reported].every(Number.isFinite) || completed < started || completed > deadline || completed > reported) throw new CapacityGovernanceError(
		'assignment_result_clock_invalid', 'Completion must be inside its original productive interval and no later than the actual report.', 409);
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

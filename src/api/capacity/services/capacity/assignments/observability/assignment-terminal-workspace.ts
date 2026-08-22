import { TreeDxClient } from '@treeseed/sdk/treedx/client';
import { CapacityGovernanceError } from '../../../../database.ts';
import type { DurableProviderAssignment } from '../../../../repositories/capacity/assignments/assignment.ts';
import { resolveWorkdayTreeDxConnection,type WorkdayTreeDxConnectionStore } from '../../workdays/treedx/workday-treedx-connection.ts';

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(...values: unknown[]) {
	for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
	return '';
}

export function terminalWorkspaceAlreadyAbsent(error: unknown) {
	return error instanceof Error && 'status' in error && error.status === 404;
}

export async function closeTerminalAssignmentWorkspace(
	store: WorkdayTreeDxConnectionStore,
	assignment: DurableProviderAssignment,
) {
	const workspace = record(assignment.workspaceContext);
	const proxy = record(assignment.treedxProxyHandle ?? workspace.treedxProxyHandle);
	const workspaceId = text(proxy.workspaceId, workspace.workspaceId);
	if (!workspaceId) return { required: false, closed: true, workspaceId: null };
	const runId = text(record(assignment.metadata).workdayRunId, assignment.workDayId, assignment.id);
	const connection = await resolveWorkdayTreeDxConnection(store, {
		projectId: assignment.projectId,
		repositoryId: text(proxy.repositoryId, workspace.repositoryId),
		runId,
		capabilities: ['repos:read', 'files:read'],
	});
	if (!connection) throw new CapacityGovernanceError(
		'assignment_terminal_workspace_cleanup_unavailable',
		'TreeDX authentication is required to close the terminal assignment workspace.',
		503,
		{ assignmentId: assignment.id, workspaceId },
	);
	const client = new TreeDxClient({ ...connection, repoId: connection.repositoryId, timeoutMs: 15_000, fetch: connection.fetchImpl });
	try {
		await client.closeWorkspace(workspaceId);
	} catch (error) {
		if (!terminalWorkspaceAlreadyAbsent(error)) throw error;
	}
	return { required: true, closed: true, workspaceId };
}

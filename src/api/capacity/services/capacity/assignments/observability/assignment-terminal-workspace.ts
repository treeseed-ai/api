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
	return error instanceof Error && 'status' in error && error.status === 404 && 'code' in error && error.code === 'not_found';
}

export async function closeTerminalAssignmentWorkspace(
	store: Partial<WorkdayTreeDxConnectionStore>,
	assignment: DurableProviderAssignment,
) {
	const workspace = record(assignment.workspaceContext);
	const proxy = record(assignment.treedxProxyHandle ?? workspace.treedxProxyHandle);
	const workspaceId = text(proxy.workspaceId, workspace.workspaceId);
	if (!workspaceId) return { required: false, closed: true, workspaceId: null };
	if (!store.config || !store.getProjectTreeDxLibrary) throw new CapacityGovernanceError(
		'assignment_terminal_workspace_cleanup_unavailable', 'Owned workspace closure requires its authoritative library binding.', 503);
	const runId = text(record(assignment.metadata).workdayRunId, assignment.workDayId, assignment.id);
	const connection = await resolveWorkdayTreeDxConnection({ config: store.config, getProjectTreeDxLibrary: store.getProjectTreeDxLibrary.bind(store) }, {
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
	const client = connection.client;
	try {
		const current = record(await client.getWorkspace(workspaceId));
		if (current.workspaceId !== workspaceId || (current.repoId !== undefined && current.repoId !== connection.repositoryId)) throw new CapacityGovernanceError(
			'assignment_terminal_workspace_readback_invalid', 'Workspace closure requires the exact owned resource.', 502);
		if (current.status === 'closed') return { required: true, closed: true, workspaceId };
		const closed = record(await client.closeWorkspace(workspaceId));
		if (closed.workspaceId !== workspaceId || closed.status !== 'closed') throw new CapacityGovernanceError(
			'assignment_terminal_workspace_close_invalid', 'Workspace close must return this exact closed resource.', 502);
		const readback = record(await client.getWorkspace(workspaceId));
		if (readback.workspaceId !== workspaceId || readback.status !== 'closed'
			|| (readback.repoId !== undefined && readback.repoId !== connection.repositoryId)) throw new CapacityGovernanceError(
			'assignment_terminal_workspace_readback_invalid', 'Workspace closure requires exact independent resource read-back.', 502);
	} catch (error) {
		if (!terminalWorkspaceAlreadyAbsent(error)) throw error;
	}
	return { required: true, closed: true, workspaceId };
}

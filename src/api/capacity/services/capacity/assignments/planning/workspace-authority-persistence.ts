import { CapacityGovernanceError } from '../../../../database.ts';
import { decodeDurableJsonObject } from '../../../../durable-json.ts';

type JsonRecord = Record<string, unknown>;

interface WorkspaceAuthorityStore {
	first(query: string, params?: unknown[]): Promise<JsonRecord | null>;
	run(query: string, params?: unknown[]): Promise<unknown>;
}

function record(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function text(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

export async function persistIssuedWorkspaceAuthority(input: {
	store: WorkspaceAuthorityStore;
	assignmentId: string;
	proxyHandle: JsonRecord;
	workspaceContext: JsonRecord;
	workspace: JsonRecord;
	now: string;
}) {
	const baseCommitSha = text(input.workspace.baseCommitSha);
	const baseRef = text(input.workspace.baseRef);
	const branchName = text(input.workspace.branchName);
	if (!baseCommitSha || !baseRef) {
		throw new CapacityGovernanceError(
			'capacity_workday_workspace_authority_missing',
			'TreeDX workspace creation must return its immutable base commit and base ref.',
			502,
			{ assignmentId: input.assignmentId },
		);
	}
	const authority = { baseCommitSha, baseRef, ...(branchName ? { branchName } : {}) };
	const assignment = await input.store.first(
		`SELECT treedx_proxy_handle_json, workspace_context_json
		 FROM capacity_provider_assignments WHERE id = ? LIMIT 1`,
		[input.assignmentId],
	);
	if (!assignment) {
		throw new CapacityGovernanceError(
			'capacity_workday_assignment_missing',
			'Workspace authority cannot be persisted because its assignment is missing.',
			409,
			{ assignmentId: input.assignmentId },
		);
	}
	const durableHandle = decodeDurableJsonObject(assignment.treedx_proxy_handle_json, {
		owner: 'capacity provider assignment', ownerId: input.assignmentId, column: 'treedx_proxy_handle_json',
	});
	const durableContext = decodeDurableJsonObject(assignment.workspace_context_json, {
		owner: 'capacity provider assignment', ownerId: input.assignmentId, column: 'workspace_context_json',
	});
	const issuedHandle = { ...input.proxyHandle, ...durableHandle, ...authority, status: 'issued' };
	const workspaceContext = { ...input.workspaceContext, ...durableContext, treedxProxyHandle: issuedHandle };
	const handleMetadata = { ...record(input.proxyHandle.metadata), ...authority };
	// Persist the assignment snapshot first. If execution is interrupted before the
	// handle transition, the still-provisioning handle causes the normal recovery
	// poll to replay this complete operation.
	await input.store.run(
		`UPDATE capacity_provider_assignments
		 SET treedx_proxy_handle_json = ?, workspace_context_json = ?, updated_at = ?
		 WHERE id = ?`,
		[JSON.stringify(issuedHandle), JSON.stringify(workspaceContext), input.now, input.assignmentId],
	);
	await input.store.run(
		`UPDATE treedx_proxy_handles
		 SET status = 'issued', metadata_json = ?, updated_at = ?
		 WHERE assignment_id = ? AND status = 'provisioning'`,
		[JSON.stringify(handleMetadata), input.now, input.assignmentId],
	);
	return issuedHandle;
}

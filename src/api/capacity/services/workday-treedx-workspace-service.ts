import { createHash } from 'node:crypto';
import { CapacityGovernanceError } from '../database.ts';
import { readBoundedTreeDxJson } from './treedx-response.ts';
import { resolveWorkdayTreeDxConnection, type WorkdayTreeDxConnectionStore } from './workday-treedx-connection.ts';

interface CreateWorkdayTreeDxWorkspaceInput {
	baseUrl: string;
	token: string;
	repositoryId: string;
	assignmentId: string;
	baseRef: string;
	branchName: string;
	mode: 'read_only' | 'writable';
	allowedPaths: string[];
	ttlSeconds: number;
	fetchImpl?: typeof fetch;
}

type ConfiguredWorkspaceStore = WorkdayTreeDxConnectionStore;

interface ConfiguredWorkspaceInput {
	repositoryId?: string;
	assignmentId: string;
	baseRef?: string;
	branchName: string;
	mode?: 'read_only' | 'writable';
	allowedPaths: string[];
	ttlSeconds: number;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requireText(value: string, owner: string): string {
	const normalized = value.trim();
	if (!normalized) {
		throw new CapacityGovernanceError('capacity_workday_workspace_input_invalid', `${owner} is required.`, 500, { owner });
	}
	return normalized;
}

export function workdayTreeDxWorkspaceId(assignmentId: string) {
	const normalized = requireText(assignmentId, 'assignmentId');
	const digest = createHash('sha256').update(normalized).digest('base64url').slice(0, 32);
	return `ws_${digest}`;
}

export async function createWorkdayTreeDxWorkspace(input: CreateWorkdayTreeDxWorkspaceInput) {
	const workspaceId = workdayTreeDxWorkspaceId(input.assignmentId);
	const baseUrl = requireText(input.baseUrl, 'baseUrl').replace(/\/+$/u, '');
	const repositoryId = requireText(input.repositoryId, 'repositoryId');
	const token = requireText(input.token, 'token');
	if (!Number.isFinite(input.ttlSeconds) || input.ttlSeconds <= 0) {
		throw new CapacityGovernanceError(
			'capacity_workday_workspace_input_invalid',
			'ttlSeconds must be positive and finite.',
			500,
			{ owner: 'ttlSeconds' },
		);
	}
	const response = await (input.fetchImpl ?? fetch)(
		`${baseUrl}/api/v1/repos/${encodeURIComponent(repositoryId)}/workspaces`,
		{
			method: 'POST',
			headers: {
				accept: 'application/json',
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				workspaceId,
				baseRef: input.baseRef,
				branchName: input.branchName,
				mode: input.mode,
				allowedPaths: input.allowedPaths,
				ttlSeconds: input.ttlSeconds,
			}),
		},
	);
	const decoded = await readBoundedTreeDxJson(response, {
		tooLargeCode: 'capacity_workday_workspace_response_too_large',
		invalidCode: 'capacity_workday_workspace_response_invalid',
		owner: 'TreeDX workspace response',
	});
	if (!response.ok) {
		throw new CapacityGovernanceError(
			'capacity_workday_workspace_create_failed',
			`TreeDX workspace creation failed (${response.status}).`,
			502,
			{ status: response.status },
		);
	}
	const envelope = record(decoded);
	const workspace = record(envelope.payload ?? envelope.workspace ?? envelope);
	const returnedId = String(workspace.workspaceId ?? workspace.id ?? '');
	if (returnedId !== workspaceId) {
		throw new CapacityGovernanceError(
			'capacity_workday_workspace_identity_mismatch',
			`TreeDX workspace creation returned an unexpected workspace id for ${input.assignmentId}.`,
			502,
		);
	}
	return workspace;
}

export async function createConfiguredWorkdayTreeDxWorkspace(
	store: ConfiguredWorkspaceStore,
	project: { id: string },
	run: { id: string },
	input: ConfiguredWorkspaceInput,
) {
	const connection = await resolveWorkdayTreeDxConnection(store, {
		projectId: project.id, repositoryId: input.repositoryId, runId: run.id,
		capabilities: ['repos:read', 'repos:write', 'workspace:create', 'workspaces:create', 'files:read', 'files:write', 'git:commit'],
	});
	if (!connection) throw new CapacityGovernanceError('capacity_workday_workspace_auth_unavailable', 'TreeDX connected authentication and a repository binding are required for local and hosted workdays.', 503);
	return createWorkdayTreeDxWorkspace({
		baseUrl: connection.baseUrl,
		token: connection.token,
		repositoryId: connection.repositoryId,
		assignmentId: input.assignmentId,
		baseRef: input.baseRef ?? 'refs/heads/main',
		branchName: input.branchName,
		mode: input.mode ?? 'writable',
		allowedPaths: input.allowedPaths,
		ttlSeconds: input.ttlSeconds,
		fetchImpl: connection.fetchImpl,
	});
}

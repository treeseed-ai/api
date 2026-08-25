import { createHash } from 'node:crypto';
import { CapacityGovernanceError } from '../../../../database.ts';
import { resolveWorkdayTreeDxConnection,type WorkdayTreeDxConnectionStore } from './workday-treedx-connection.ts';
import type { TreeDxInfrastructureClient } from '../../../../../control-plane/treedx/infrastructure-client.ts';

interface CreateWorkdayTreeDxWorkspaceInput {
	client: TreeDxInfrastructureClient;
	repositoryId: string;
	assignmentId: string;
	baseRef: string;
	branchName: string;
	mode: 'read_only' | 'writable';
	allowedPaths: string[];
	ttlSeconds: number;
}

type ConfiguredWorkspaceStore = WorkdayTreeDxConnectionStore;

export interface ConfiguredWorkspaceInput {
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
	const repositoryId = requireText(input.repositoryId, 'repositoryId');
	if (!Number.isFinite(input.ttlSeconds) || input.ttlSeconds <= 0) {
		throw new CapacityGovernanceError(
			'capacity_workday_workspace_input_invalid',
			'ttlSeconds must be positive and finite.',
			500,
			{ owner: 'ttlSeconds' },
		);
	}
	let decoded: unknown;
	try {
		decoded = await input.client.createWorkspace({ repoId: repositoryId, workspaceId, baseRef: input.baseRef, branchName: input.branchName,
			mode: input.mode, allowedPaths: input.allowedPaths, ttlSeconds: input.ttlSeconds });
	} catch (error) {
		throw new CapacityGovernanceError('capacity_workday_workspace_create_failed', 'TreeDX workspace creation failed.', 502, {
			details: 'The TreeDX workspace operation failed.',
		});
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
		client: connection.client,
		repositoryId: connection.repositoryId,
		assignmentId: input.assignmentId,
		baseRef: input.baseRef ?? 'refs/heads/main',
		branchName: input.branchName,
		mode: input.mode ?? 'writable',
		allowedPaths: input.allowedPaths,
		ttlSeconds: input.ttlSeconds,
	});
}

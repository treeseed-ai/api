import { createHash } from 'node:crypto';
import { CapacityGovernanceError } from '../../../../database.ts';
import { resolveWorkdayTreeDxConnection,type WorkdayTreeDxConnectionStore } from './workday-treedx-connection.ts';
import type { TreeDxInfrastructureClient } from '../../../../../control-plane/treedx/infrastructure-client.ts';

interface CreateWorkdayTreeDxWorkspaceInput {
	client: TreeDxInfrastructureClient;
	workspaceId?: string;
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
	workspaceId?: string;
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

function safeTreeDxError(error: unknown): Record<string, unknown> {
	if (!(error instanceof Error)) return { message: String(error) };
	const source = record(error);
	const result: Record<string, unknown> = { message: error.message };
	if (typeof source.code === 'string') result.code = source.code;
	if (typeof source.status === 'number') result.status = source.status;
	const upstream = record(source.details);
	const blocked = /token|secret|password|credential|authorization/i;
	const details = Object.fromEntries(Object.entries(upstream).filter(([key, value]) =>
		!blocked.test(key) && ['string', 'number', 'boolean'].includes(typeof value)));
	if (Object.keys(details).length > 0) result.details = details;
	return result;
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
	const workspaceId = input.workspaceId?.trim() || workdayTreeDxWorkspaceId(input.assignmentId);
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
			upstream: safeTreeDxError(error),
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
		workspaceId: input.workspaceId,
		repositoryId: connection.repositoryId,
		assignmentId: input.assignmentId,
		baseRef: input.baseRef ?? 'refs/heads/main',
		branchName: input.branchName,
		mode: input.mode ?? 'writable',
		allowedPaths: input.allowedPaths,
		ttlSeconds: input.ttlSeconds,
	});
}

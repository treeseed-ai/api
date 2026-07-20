import {
	providerAssignmentCapabilityHandlesContainSecretMaterial,
	redactedProviderAssignmentCapabilityHandles,
	validateProviderAssignmentCapabilityHandles,
} from '@treeseed/sdk/agent-capacity';
import { CapacityGovernanceError } from '../database.ts';

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}

function array(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function exactBaseRef(input: AssignmentCapabilityInput) {
	return text(record(record(input.decisionInput).input).exactBaseRef);
}

function workspaceAccessMode(input: RecordValue) {
	const explicit = text(input.workspaceAccessMode ?? input.workspace_access_mode);
	if (['context_only', 'workspace_write', 'brokered_workspace', 'full_workspace_no_credentials', 'trusted_direct'].includes(explicit)) return explicit;
	return input.mode === 'acting' ? 'brokered_workspace' : 'context_only';
}

export interface AssignmentCapabilityInput extends RecordValue {
	id: string;
	teamId: string;
	projectId: string;
	mode: 'planning' | 'acting';
	workspaceContext?: RecordValue;
	capabilityHandles?: RecordValue;
	treedxProxyHandle?: RecordValue;
	decisionInput?: RecordValue;
	capacityEnvelope?: RecordValue;
	metadata?: RecordValue;
	synthesizedFrom?: string | null;
}

export function compileAssignmentCapabilityContext(input: AssignmentCapabilityInput) {
	const context = record(input.workspaceContext);
	const supplied = record(input.capabilityHandles ?? context.capabilityHandles);
	if (providerAssignmentCapabilityHandlesContainSecretMaterial(supplied)) {
		throw new CapacityGovernanceError(
			'assignment_capability_handle_secret_material',
			'Provider assignment capability handles must not contain secret material.',
			400,
		);
	}
	const accessMode = workspaceAccessMode({ ...input, workspaceAccessMode: supplied.workspaceAccessMode ?? context.workspaceAccessMode });
	const handles = redactedProviderAssignmentCapabilityHandles({
		workspaceAccessMode: accessMode,
		repository: array(supplied.repository),
		treeDx: array(supplied.treeDx),
		workflowOperations: array(supplied.workflowOperations ?? input.workflowOperationHandles),
		secrets: array(supplied.secrets),
		metadata: record(supplied.metadata),
	});
	const treeDx = record(input.treedxProxyHandle ?? context.treedxProxyHandle);
	const governedBaseRef = exactBaseRef(input);
	if (treeDx.id) {
		const proxyHandleId = text(treeDx.id);
		const repositoryId = text(treeDx.repositoryId);
		const workspaceId = text(treeDx.workspaceId);
		if (!handles.treeDx.some((handle) => handle.proxyHandleId === proxyHandleId || handle.id === `tdx-workspace-${proxyHandleId}`)) {
			handles.treeDx.push({
				id: `tdx-workspace-${proxyHandleId}`,
				kind: 'treedx_workspace',
				teamId: input.teamId,
				projectId: input.projectId,
				assignmentId: input.id,
				status: 'active',
				workspaceAccessMode: accessMode,
				proxyHandleId,
				repositoryId: repositoryId || null,
				workspaceId: workspaceId || null,
				operations: array(treeDx.allowedOperations).map(String),
				allowedOperations: array(treeDx.allowedOperations).map(String),
				allowedPaths: array(treeDx.allowedPaths).map(String),
				expiresAt: text(treeDx.expiresAt) || null,
				metadata: { source: 'treedx_proxy_handle' },
			});
		}
		if (repositoryId && !handles.repository.some((handle) => handle.repositoryId === repositoryId)) {
			handles.repository.push({
				id: `repo-access-${proxyHandleId}`,
				kind: 'repository_access',
				teamId: input.teamId,
				projectId: input.projectId,
				assignmentId: input.id,
				status: 'active',
				workspaceAccessMode: accessMode,
				provider: 'treedx_proxy',
				repositoryId,
				operations: accessMode === 'context_only' ? ['read'] : ['read', 'write', 'commit', 'test'],
				allowedRefs: governedBaseRef ? [governedBaseRef] : [],
				allowedPaths: array(treeDx.allowedPaths).map(String),
				credentialMode: 'brokered',
				expiresAt: text(treeDx.expiresAt) || null,
				metadata: { source: 'treedx_proxy_handle' },
			});
		}
	}
	const fallback = validateProviderAssignmentCapabilityHandles({ assignment: { ...input, capabilityHandles: handles }, capabilityHandles: handles });
	if (fallback) {
		throw new CapacityGovernanceError(
			fallback.code ?? 'assignment_capability_handle_invalid',
			fallback.reason ?? 'Invalid provider assignment capability handles.',
			400,
			fallback.metadata ?? {},
		);
	}
	return { ...context, workspaceAccessMode: accessMode, capabilityHandles: handles };
}

import type { ProviderAssignmentSynthesisSource } from '@treeseed/sdk/agent-capacity';
import { CapacityGovernanceError } from '../../../../database.ts';

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

function secretLikeKey(key: string) { return /(^|[_-])(plaintext|token|passphrase|password|private[_-]?key|deploy[_-]?key|raw[_-]?secret|unencrypted|credential)([_-]|$)/iu.test(key) || ['secretValue', 'rawSecret', 'githubInstallationToken', 'deployKey', 'privateKey'].includes(key); }
function secretLikePath(value: unknown, path = '$'): string | null {
	if (Array.isArray(value)) { for (let index = 0; index < value.length; index += 1) { const found = secretLikePath(value[index], `${path}[${index}]`); if (found) return found; } return null; }
	if (!value || typeof value !== 'object') return null;
	for (const [key, entry] of Object.entries(value as RecordValue)) { if (secretLikeKey(key)) return `${path}.${key}`; const found = secretLikePath(entry, `${path}.${key}`); if (found) return found; }
	return null;
}
function providerAssignmentCapabilityHandlesContainSecretMaterial(value: unknown) { return Boolean(secretLikePath(value)); }
function redactedProviderAssignmentCapabilityHandles(value: unknown) {
	const source = record(value); const redact = (entry: unknown) => Object.fromEntries(Object.entries(record(entry)).filter(([key]) => !secretLikeKey(key)));
	return { workspaceAccessMode: workspaceAccessMode(source), repository: array(source.repository).map(redact), treeDx: array(source.treeDx).map(redact), workflowOperations: array(source.workflowOperations).map(redact), secrets: array(source.secrets).map(redact), metadata: record(source.metadata) };
}
function validateProviderAssignmentCapabilityHandles(input: { assignment: AssignmentCapabilityInput & { capabilityHandles?: RecordValue }; capabilityHandles?: RecordValue; now?: Date }) {
	const handles = input.capabilityHandles ?? input.assignment.capabilityHandles; const leakedPath = secretLikePath(handles); if (leakedPath) return { code: 'assignment_capability_handle_secret_material', reason: `Assignment capability handles include secret-like material at ${leakedPath}.`, metadata: { path: leakedPath } };
	for (const handle of [...array(handles?.repository), ...array(handles?.treeDx), ...array(handles?.workflowOperations), ...array(handles?.secrets)].map(record)) {
		if (!text(handle.id) || !text(handle.kind)) return { code: 'assignment_capability_handle_invalid', reason: 'An assignment capability handle is missing its identity or kind.', metadata: {} };
		if ((handle.teamId && handle.teamId !== input.assignment.teamId) || (handle.projectId && handle.projectId !== input.assignment.projectId) || (handle.assignmentId && handle.assignmentId !== input.assignment.id)) return { code: 'assignment_capability_handle_invalid', reason: `Capability handle ${text(handle.id)} is scoped to a different assignment.`, metadata: { handleId: handle.id } };
		if (handle.expiresAt && Date.parse(String(handle.expiresAt)) <= (input.now ?? new Date()).getTime()) return { code: 'assignment_capability_handle_invalid', reason: `Capability handle ${text(handle.id)} has expired.`, metadata: { handleId: handle.id } };
		const operations = array(handle.operations).map(String); const writeCapable = operations.some((operation) => ['write', 'commit', 'push', 'release', 'dispatch_workflow', 'files:write', 'git:commit'].includes(operation));
		if (writeCapable && input.assignment.mode !== 'acting' && record(input.assignment.metadata).allowPlanningContentArtifacts !== true) return { code: 'assignment_capability_handle_write_not_ready', reason: 'Write-capable handles require acting mode or explicit planning-artifact authority.', metadata: { handleId: handle.id } };
	}
	return null;
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
	const synthesizedFrom = ['approved_decision', 'planning_input_request', 'capacity_plan', 'workday_demand', 'verification_failure', 'fallback_queue']
		.includes(String(input.synthesizedFrom ?? ''))
		? input.synthesizedFrom as ProviderAssignmentSynthesisSource
		: null;
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
	const fallback = validateProviderAssignmentCapabilityHandles({
		assignment: {
			...input,
			metadata: input.metadata ?? {},
			decisionInput: input.decisionInput ?? {},
			capacityEnvelope: {
				...(input.capacityEnvelope ?? {}),
				mode: input.mode,
				teamId: input.teamId,
				projectId: input.projectId,
			},
			synthesizedFrom,
			capabilityHandles: handles,
		},
		capabilityHandles: handles,
	});
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

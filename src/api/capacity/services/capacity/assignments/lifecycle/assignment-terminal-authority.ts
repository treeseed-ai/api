import type { DurableProviderAssignment } from '../../../../repositories/capacity/assignments/assignment.ts';

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function revokedHandle(value:unknown,now:string):JsonRecord {
 const original=record(value);return original.status==='revoked'?{...original}:{...original,status:'revoked',revokedAt:now};
}

export function revokeAssignmentCapabilityHandles(value: unknown, now: string): JsonRecord {
	const handles = record(value);
	const revoke = (entries: unknown) => Array.isArray(entries)
		? entries.map((entry) => revokedHandle(entry,now))
		: [];
	return {
		...handles,
		repository: revoke(handles.repository),
		treeDx: revoke(handles.treeDx),
		workflowOperations: revoke(handles.workflowOperations),
		secrets: revoke(handles.secrets),
	};
}

export function terminalAssignmentAuthority(assignment: DurableProviderAssignment, now: string) {
	const proxyHandle = revokedHandle(assignment.treedxProxyHandle,now);
	const workspaceContext = record(assignment.workspaceContext);
	const capabilityHandles = revokeAssignmentCapabilityHandles(
		assignment.capabilityHandles ?? workspaceContext.capabilityHandles,
		now,
	);
	return {
		proxyHandle,
		capabilityHandles,
		workspaceContext: {
			...workspaceContext,
			treedxProxyHandle: proxyHandle,
			capabilityHandles,
		},
	};
}

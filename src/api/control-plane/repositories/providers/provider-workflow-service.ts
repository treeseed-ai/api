import { CapacityGovernanceError } from '../../../capacity/database.ts';
import { observeWorkflowRun, queueRun, serializeWorkflowOperation, serializeWorkflowOperationRun } from '../workflow-service.ts';
import { providerPrincipal, type ProviderPrincipal } from './provider-runtime-service.ts';
import { assignmentRecord as record, assertProviderOwnsAssignment, type ProviderAssignmentStore } from './provider-assignment-support.ts';

function workflowHandles(assignment: Record<string, unknown>) {
	const value = record(assignment.capabilityHandles).workflowOperations;
	return Array.isArray(value) ? value.map(record) : [];
}

function authorizedHandle(assignment: Record<string, unknown>, principal: ProviderPrincipal, body: Record<string, unknown>, operationId: string) {
	const now = Date.now();
	if (assignment.membershipId !== principal.membershipId || assignment.status !== 'leased' || assignment.leaseState !== 'leased'
		|| assignment.leaseToken !== body.leaseToken || !assignment.leaseExpiresAt || Date.parse(String(assignment.leaseExpiresAt)) <= now) {
		throw new CapacityGovernanceError('assignment_workflow_lease_invalid', 'Workflow dispatch requires the active assignment lease.', 409);
	}
	if (assignment.mode !== 'acting' || !assignment.decisionId || !assignment.allocationSetId) throw new CapacityGovernanceError('assignment_workflow_acting_readiness_required', 'Workflow dispatch requires acting mode, an approved decision, and accepted capacity provenance.', 403);
	const handleId = typeof body.handleId === 'string' ? body.handleId : '';
	const handle = workflowHandles(assignment).find((entry) => entry.id === handleId && entry.operationId === operationId);
	if (!handle || handle.kind !== 'workflow_operation' || handle.status !== 'active' || (handle.expiresAt && Date.parse(String(handle.expiresAt)) <= now)
		|| !Array.isArray(handle.operations) || !handle.operations.includes('dispatch_workflow') || handle.assignmentId !== assignment.id
		|| handle.teamId !== assignment.teamId || handle.projectId !== assignment.projectId) {
		throw new CapacityGovernanceError('assignment_workflow_handle_denied', 'The assignment workflow handle is missing, expired, or outside this assignment.', 403);
	}
	return handle;
}

export function createProviderWorkflowService(store: ProviderAssignmentStore) {
	return {
		async dispatch(auth: unknown, assignmentId: string, operationId: string, body: Record<string, unknown>) {
			const principal = providerPrincipal(auth, ['provider:assignments:write']);
			const assignment = assertProviderOwnsAssignment(await store.getProviderAssignment(principal.teamId, assignmentId), principal, 'dispatch workflow operations for');
			const handle = authorizedHandle(assignment, principal, body, operationId);
			const definition = serializeWorkflowOperation(await store.first('SELECT * FROM project_workflow_operations WHERE id = ? AND project_id = ?', [operationId, assignment.projectId]));
			if (!definition) throw new CapacityGovernanceError('assignment_workflow_operation_missing', 'The authorized workflow operation no longer exists.', 404);
			if (!definition.actorPolicy.includes('capacity_provider') || definition.repositoryBindingId !== handle.repositoryId || definition.workflowId !== handle.workflowFile) {
				throw new CapacityGovernanceError('assignment_workflow_definition_mismatch', 'The workflow handle no longer matches the canonical workflow definition.', 409);
			}
			const binding = await store.first('SELECT * FROM project_remote_repository_bindings WHERE id = ? AND project_id = ?', [definition.repositoryBindingId, assignment.projectId]);
			if (!binding || `${binding.owner}/${binding.name}` !== handle.repository) throw new CapacityGovernanceError('assignment_workflow_repository_mismatch', 'The workflow handle no longer matches the repository binding.', 409);
			const sourceSha = typeof body.sourceSha === 'string' && body.sourceSha.trim() ? body.sourceSha.trim() : String(binding.observed_head ?? '');
			return queueRun({ store }, { definition, actorType: 'capacity_provider', actorId: principal.capacityProviderId, mode: 'acting',
				ref: String(handle.ref ?? ''), sourceSha, inputs: body.inputs, idempotencyKey: `${assignment.id}:${operationId}:${String(body.idempotencyKey ?? sourceSha)}`,
				assignmentId: assignment.id as string, handleId: handle.id as string });
		},
		async show(auth: unknown, assignmentId: string, runId: string) {
			const principal = providerPrincipal(auth, ['provider:assignments:read']);
			const assignment = assertProviderOwnsAssignment(await store.getProviderAssignment(principal.teamId, assignmentId), principal, 'observe workflow runs for');
			const row = await store.first("SELECT * FROM workflow_operation_runs WHERE id = ? AND assignment_id = ? AND actor_type = 'capacity_provider' AND actor_id = ?", [runId, assignment.id, principal.capacityProviderId]);
			if (!row) throw new CapacityGovernanceError('assignment_workflow_run_not_found', 'Unknown assignment workflow run.', 404);
			try { return serializeWorkflowOperationRun(await observeWorkflowRun(store, row)); }
			catch (error) { throw new CapacityGovernanceError('assignment_workflow_provider_unavailable', error instanceof Error ? error.message : 'Workflow provider observation failed.', 503); }
		},
	};
}

export type ProviderWorkflowService = ReturnType<typeof createProviderWorkflowService>;

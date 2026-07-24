import type { Context, Hono } from 'hono';
import type { CapacityGovernanceDatabase } from '../../../database.ts';
import { CapacityGovernanceError } from '../../../database.ts';
import { createGitHubActionsSecretEnclave } from '../../../../configuration/github-actions-secret-enclave.ts';
import { readCapacityRequestObject } from '../../support/request-json.ts';
import { requireProviderPrincipal } from './provider-auth.ts';

interface ProviderWorkflowStore extends CapacityGovernanceDatabase {
	getProviderAssignment(teamId: string, assignmentId: string): Promise<ProviderWorkflowAssignment | null>;
	recordSecretCapabilityAudit(eventType: string, record: Record<string, unknown>): Promise<unknown>;
}

interface ProviderWorkflowAssignment extends Record<string, unknown> {
	capacityProviderId: string;
	leaseState: string;
	leaseToken?: string | null;
	leaseExpiresAt?: string | null;
	capabilityHandles?: { workflowOperations?: unknown[] };
}

function routeError(c: Context, error: unknown) {
	const candidate = error && typeof error === 'object' ? error as { status?: unknown; code?: unknown; message?: unknown } : {};
	const status = Number(candidate.status);
	if (Number.isInteger(status) && status >= 400 && status <= 599) {
		return new Response(JSON.stringify({ ok: false, error: typeof candidate.message === 'string' ? candidate.message : 'Workflow dispatch failed.', code: typeof candidate.code === 'string' ? candidate.code : 'provider_workflow_dispatch_failed' }), { status, headers: { 'content-type': 'application/json' } });
	}
	throw error;
}

function deny(code: string, message: string, status: 400 | 403 | 404 | 409) {
	throw new CapacityGovernanceError(code, message, status);
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function installProviderWorkflowDispatchRoutes(app: Hono, options: { store: CapacityGovernanceDatabase; config: Record<string, unknown> }) {
	const store = options.store as ProviderWorkflowStore;
	app.post('/v1/provider/assignments/:assignmentId/workflow-operations/:operationId/dispatch', async (c) => {
		try {
			const principal = requireProviderPrincipal(c, ['provider:assignments:write']);
			const assignment = await store.getProviderAssignment(principal.teamId, c.req.param('assignmentId'));
			if (!assignment) deny('provider_assignment_not_found', 'Unknown assignment.', 404);
			if (assignment!.capacityProviderId !== principal.capacityProviderId) deny('provider_assignment_forbidden', 'Provider cannot update this assignment.', 403);
			const body = await readCapacityRequestObject(c, { optional: true });
			if (assignment!.leaseState === 'leased' && assignment!.leaseToken !== body.leaseToken) deny('assignment_lease_token_required', 'Assignment lease token is required for workflow operation dispatch.', 409);
			if (assignment!.leaseExpiresAt && Date.parse(assignment!.leaseExpiresAt) <= Date.now()) deny('assignment_lease_expired', 'Assignment lease has expired.', 409);

			const capabilityHandles = assignment!.capabilityHandles ?? {};
			const workflowHandles = Array.isArray(capabilityHandles.workflowOperations) ? capabilityHandles.workflowOperations : [];
			const requestedHandleId = typeof body.handleId === 'string' ? body.handleId : null;
			const operationId = c.req.param('operationId');
			const handle = workflowHandles.map(record).find((entry) => entry.operationId === operationId
				&& (!requestedHandleId || entry.id === requestedHandleId));
			if (!handle || (handle.status && !['active', 'issued'].includes(String(handle.status))) || (typeof handle.expiresAt === 'string' && Date.parse(handle.expiresAt) <= Date.now())) {
				deny('assignment_workflow_operation_denied', 'Assignment does not include an active workflow operation handle for this operation.', 403);
			}
			if (!Array.isArray(handle.operations) || !handle.operations.map(String).includes('dispatch_workflow')) {
				deny('assignment_workflow_operation_denied', 'Assignment workflow operation handle is not dispatch-capable.', 403);
			}
			const forbiddenFields = ['workflow', 'workflowFile', 'workflow_file', 'repository', 'ref', 'branch', 'command', 'commands', 'providerCommands']
				.filter((field) => Object.prototype.hasOwnProperty.call(body, field));
			if (forbiddenFields.length > 0) {
				throw new CapacityGovernanceError('arbitrary_secret_workflow_dispatch', 'Provider workflow operation dispatch accepts only assignment handle inputs, not arbitrary workflow scope.', 400, { fields: forbiddenFields });
			}

			const payload = await createGitHubActionsSecretEnclave({ store, config: options.config }).dispatchWorkflowOperation({
				inputs: body.inputs && typeof body.inputs === 'object' && !Array.isArray(body.inputs) ? body.inputs : {},
				wait: body.wait === true,
				teamId: assignment!.teamId,
				projectId: assignment!.projectId,
				operationId,
				requester: { type: 'capacity_provider', id: principal.capacityProviderId, assignmentId: assignment!.id, handleId: handle.id },
				metadata: { providerAssignmentId: assignment!.id, capacityProviderId: principal.capacityProviderId, workflowOperationHandleId: handle.id },
			});
			await store.recordSecretCapabilityAudit('provider_assignment.workflow_operation_dispatched', {
				teamId: assignment!.teamId,
				projectId: assignment!.projectId,
				assignmentId: assignment!.id,
				capacityProviderId: principal.capacityProviderId,
				workflowOperationId: operationId,
				handleId: handle.id,
				dispatchId: payload?.dispatch?.id ?? null,
			}).catch(() => null);
			return c.json({ ok: true, payload }, { status: 202 });
		} catch (error) { return routeError(c, error); }
	});
}

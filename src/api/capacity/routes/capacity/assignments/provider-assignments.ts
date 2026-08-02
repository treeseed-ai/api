import type { Context,Hono } from 'hono';
import type { CapacityGovernanceDatabase } from '../../../database.ts';
import { CapacityGovernanceError } from '../../../database.ts';
import { readCapacityRequestObject } from '../../support/request-json.ts';
import { requireProviderPrincipal,type CapacityProviderAccessPrincipal } from '../providers/provider-auth.ts';
import { observeWorkflowRun, queueRun, serializeWorkflowOperation,
	serializeWorkflowOperationRun } from '../../../../routes/projects/operations/workflow-operations.ts';
import { modeRunActivityEvent } from '../../../services/capacity/workdays/content/mode-run-activity-event.ts';

interface ProviderAssignmentStore extends CapacityGovernanceDatabase {
	leaseNextProviderAssignment(principal: CapacityProviderAccessPrincipal, input: Record<string, unknown>): Promise<Record<string, unknown>>;
	getProviderAssignment(teamId: string, assignmentId: string): Promise<Record<string, unknown> | null>;
	renewProviderAssignmentLease(principal: CapacityProviderAccessPrincipal, assignmentId: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	returnProviderAssignment(principal: CapacityProviderAccessPrincipal, assignmentId: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	completeProviderAssignment(principal: CapacityProviderAccessPrincipal, assignmentId: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	failProviderAssignment(principal: CapacityProviderAccessPrincipal, assignmentId: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	createAgentModeRun(input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	createCapacityWorkdayEvent?(teamId: string, runId: string, input: Record<string, unknown>): Promise<unknown>;
}

function errorResponse(c: Context, error: unknown) {
	if (error instanceof CapacityGovernanceError) {
		return new Response(JSON.stringify({ ok: false, error: error.message, code: error.code, details: error.details }), { status: error.status, headers: { 'content-type': 'application/json' } });
	}
	throw error;
}

function assertProviderOwnsAssignment(assignment: Record<string, unknown> | null, principal: CapacityProviderAccessPrincipal, action: string) {
	if (!assignment) throw new CapacityGovernanceError('provider_assignment_not_found', 'Unknown assignment.', 404);
	if (assignment.capacityProviderId !== principal.capacityProviderId) {
		throw new CapacityGovernanceError('provider_assignment_forbidden', `Provider cannot ${action} this assignment.`, 403);
	}
	return assignment;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function workflowHandles(assignment: Record<string, unknown>) {
	const value = record(assignment.capabilityHandles).workflowOperations;
	return Array.isArray(value) ? value.map(record) : [];
}

function assertAssignmentWorkflowDispatch(assignment: Record<string, unknown>, principal: CapacityProviderAccessPrincipal, body: Record<string, unknown>, operationId: string) {
	const now = Date.now();
	if (assignment.membershipId !== principal.membershipId || assignment.status !== 'leased' || assignment.leaseState !== 'leased'
		|| assignment.leaseToken !== body.leaseToken || !assignment.leaseExpiresAt || Date.parse(String(assignment.leaseExpiresAt)) <= now) {
		throw new CapacityGovernanceError('assignment_workflow_lease_invalid', 'Workflow dispatch requires the active assignment lease.', 409);
	}
	if (assignment.mode !== 'acting' || !assignment.decisionId || !assignment.allocationSetId) {
		throw new CapacityGovernanceError('assignment_workflow_acting_readiness_required', 'Workflow dispatch requires acting mode, an approved decision, and accepted capacity provenance.', 403);
	}
	const handleId = typeof body.handleId === 'string' ? body.handleId : '';
	const handle = workflowHandles(assignment).find((entry) => entry.id === handleId && entry.operationId === operationId);
	if (!handle || handle.kind !== 'workflow_operation' || handle.status !== 'active'
		|| (handle.expiresAt && Date.parse(String(handle.expiresAt)) <= now)
		|| !Array.isArray(handle.operations) || !handle.operations.includes('dispatch_workflow')
		|| handle.assignmentId !== assignment.id || handle.teamId !== assignment.teamId || handle.projectId !== assignment.projectId) {
		throw new CapacityGovernanceError('assignment_workflow_handle_denied', 'The assignment workflow handle is missing, expired, or outside this assignment.', 403);
	}
	return handle;
}

export function installProviderAssignmentRoutes(app: Hono, options: { store: CapacityGovernanceDatabase }) {
	const store = options.store as ProviderAssignmentStore;

	app.post('/v1/provider/assignments/next', async (c) => {
		try {
			const principal = requireProviderPrincipal(c, ['provider:assignments:read']);
			const body = await readCapacityRequestObject(c, { optional: true });
			const result = await store.leaseNextProviderAssignment(principal, body);
			return c.json({ ok: true, payload: result.assignment, assignment: result.assignment, leaseToken: result.leaseToken, leaseSeconds: result.leaseSeconds, diagnostics: result.diagnostics ?? null, leaseDiagnostics: result.diagnostics ?? null });
		} catch (error) { return errorResponse(c, error); }
	});

	app.get('/v1/provider/assignments/:assignmentId', async (c) => {
		try {
			const principal = requireProviderPrincipal(c, ['provider:assignments:read']);
			const assignment = assertProviderOwnsAssignment(await store.getProviderAssignment(principal.teamId, c.req.param('assignmentId')), principal, 'access');
			return c.json({ ok: true, payload: assignment });
		} catch (error) { return errorResponse(c, error); }
	});

	app.get('/v1/provider/assignments/:assignmentId/explanation', async (c) => {
		try {
			const principal = requireProviderPrincipal(c, ['provider:assignments:read']);
			const assignment = assertProviderOwnsAssignment(await store.getProviderAssignment(principal.teamId, c.req.param('assignmentId')), principal, 'access');
			return c.json({ ok: true, payload: assignment.explanation ?? {} });
		} catch (error) { return errorResponse(c, error); }
	});

	const lifecycle = (scope: string, method: 'renewProviderAssignmentLease' | 'returnProviderAssignment' | 'completeProviderAssignment') => async (c: Context) => {
		try {
			const principal = requireProviderPrincipal(c, [scope]);
			const body = await readCapacityRequestObject(c, { optional: true });
			const result = await store[method](principal, c.req.param('assignmentId'), body);
			if (!result) throw new CapacityGovernanceError('provider_assignment_conflict', 'Assignment lease transition was rejected.', 409);
			return c.json({ ok: true, payload: result.assignment, assignment: result.assignment, ...(method === 'renewProviderAssignmentLease' ? { leaseToken: result.leaseToken, leaseSeconds: result.leaseSeconds } : {}) });
		} catch (error) { return errorResponse(c, error); }
	};
	app.post('/v1/provider/assignments/:assignmentId/renew', lifecycle('provider:assignments:read', 'renewProviderAssignmentLease'));
	app.post('/v1/provider/assignments/:assignmentId/return', lifecycle('provider:assignments:write', 'returnProviderAssignment'));
	app.post('/v1/provider/assignments/:assignmentId/complete', lifecycle('provider:assignments:write', 'completeProviderAssignment'));

	app.post('/v1/provider/assignments/:assignmentId/fail', async (c) => {
		try {
			const body = await readCapacityRequestObject(c, { optional: true });
			const scopes = ['provider:assignments:write'];
			if (body.usageActualId || body.modeRunId || body.usageActual || body.usage) scopes.push('provider:usage:write');
			const principal = requireProviderPrincipal(c, scopes);
			const result = await store.failProviderAssignment(principal, c.req.param('assignmentId'), body);
			if (!result) throw new CapacityGovernanceError('provider_assignment_conflict', 'Assignment lease transition was rejected.', 409);
			return c.json({ ok: true, payload: result.assignment, assignment: result.assignment });
		} catch (error) { return errorResponse(c, error); }
	});

	app.post('/v1/provider/assignments/:assignmentId/mode-runs', async (c) => {
		try {
			const principal = requireProviderPrincipal(c, ['provider:assignments:write', 'provider:usage:write']);
			const assignment = assertProviderOwnsAssignment(await store.getProviderAssignment(principal.teamId, c.req.param('assignmentId')), principal, 'update');
			const body = await readCapacityRequestObject(c, { optional: true });
			const modeRun = await store.createAgentModeRun({ ...body, teamId: principal.teamId, providerAssignmentId: assignment.id });
			if (!modeRun) throw new CapacityGovernanceError('provider_assignment_not_found', 'Unknown assignment.', 404);
			const workdayRunId = record(assignment.metadata).workdayRunId;
			if (typeof workdayRunId === 'string' && workdayRunId && store.createCapacityWorkdayEvent) {
				await store.createCapacityWorkdayEvent(principal.teamId, workdayRunId, modeRunActivityEvent({ assignment, modeRun }));
			}
			return c.json({ ok: true, payload: modeRun }, { status: 201 });
		} catch (error) { return errorResponse(c, error); }
	});

	app.post('/v1/provider/assignments/:assignmentId/workflow-operations/:operationId/dispatch', async (c) => {
		try {
			const principal = requireProviderPrincipal(c, ['provider:assignments:write']);
			const assignment = assertProviderOwnsAssignment(await store.getProviderAssignment(principal.teamId, c.req.param('assignmentId')), principal, 'dispatch workflow operations for');
			const body = await readCapacityRequestObject(c);
			const operationId = c.req.param('operationId');
			const handle = assertAssignmentWorkflowDispatch(assignment, principal, body, operationId);
			const definition = serializeWorkflowOperation(await store.first('SELECT * FROM project_workflow_operations WHERE id = ? AND project_id = ?', [operationId, assignment.projectId]));
			if (!definition) throw new CapacityGovernanceError('assignment_workflow_operation_missing', 'The authorized workflow operation no longer exists.', 404);
			if (!definition.actorPolicy.includes('capacity_provider') || definition.repositoryBindingId !== handle.repositoryId
				|| definition.workflowId !== handle.workflowFile) {
				throw new CapacityGovernanceError('assignment_workflow_definition_mismatch', 'The workflow handle no longer matches the canonical workflow definition.', 409);
			}
			const binding = await store.first('SELECT * FROM project_remote_repository_bindings WHERE id = ? AND project_id = ?', [definition.repositoryBindingId, assignment.projectId]);
			if (!binding || `${binding.owner}/${binding.name}` !== handle.repository) {
				throw new CapacityGovernanceError('assignment_workflow_repository_mismatch', 'The workflow handle no longer matches the repository binding.', 409);
			}
			const sourceSha = typeof body.sourceSha === 'string' && body.sourceSha.trim() ? body.sourceSha.trim() : String(binding.observed_head ?? '');
			const result = await queueRun({ store }, { definition, actorType: 'capacity_provider', actorId: principal.capacityProviderId,
				mode: 'acting', ref: String(handle.ref ?? ''), sourceSha, inputs: body.inputs,
				idempotencyKey: `${assignment.id}:${operationId}:${String(body.idempotencyKey ?? sourceSha)}`,
				assignmentId: assignment.id as string, handleId: handle.id as string });
			return c.json({ ok: true, payload: result }, 202);
		} catch (error) { return errorResponse(c, error); }
	});

	app.get('/v1/provider/assignments/:assignmentId/workflow-runs/:runId', async (c) => {
		try {
			const principal = requireProviderPrincipal(c, ['provider:assignments:read']);
			const assignment = assertProviderOwnsAssignment(
				await store.getProviderAssignment(principal.teamId, c.req.param('assignmentId')), principal, 'observe workflow runs for');
			const row = await store.first(`SELECT * FROM workflow_operation_runs
				WHERE id = ? AND assignment_id = ? AND actor_type = 'capacity_provider' AND actor_id = ?`,
				[c.req.param('runId'), assignment.id, principal.capacityProviderId]);
			if (!row) throw new CapacityGovernanceError('assignment_workflow_run_not_found', 'Unknown assignment workflow run.', 404);
			let observed;
			try { observed = await observeWorkflowRun(store, row); }
			catch (error) { throw new CapacityGovernanceError('assignment_workflow_provider_unavailable',
				error instanceof Error ? error.message : 'Workflow provider observation failed.', 503); }
			return c.json({ ok: true, payload: serializeWorkflowOperationRun(observed) }, 200,
				{ 'Cache-Control': 'private, no-store' });
		} catch (error) { return errorResponse(c, error); }
	});
}

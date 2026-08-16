import type { Context,Hono } from 'hono';
import type { CapacityGovernanceDatabase } from '../../../database.ts';
import { CapacityGovernanceError } from '../../../database.ts';
import { readCapacityRequestObject } from '../../support/request-json.ts';
import { requireProviderPrincipal,type CapacityProviderAccessPrincipal } from '../providers/provider-auth.ts';
import { observeWorkflowRun, queueRun, serializeWorkflowOperation,
	serializeWorkflowOperationRun } from '../../../../routes/projects/operations/workflow-operations.ts';
import { modeRunActivityEvent } from '../../../services/capacity/workdays/content/mode-run-activity-event.ts';
import { redactTranscriptValue } from '../../support/workday-activity.ts';
import { filterWorkdayActivity } from '../../support/workday-activity.ts';
import { agentActivityPageSchema,agentActivityQuerySchema } from '@treeseed/sdk/agent-capacity';
import { assertProviderOwnsAssignment,assignmentActivityType,assignmentRecord as record,providerAssignmentErrorResponse as errorResponse,type ProviderAssignmentStore } from './provider-assignment-route-support.ts';
import { installProviderAssignmentSignalRoutes } from './provider-assignment-signals.ts';
import { installProviderAssignmentDiscussionRoutes } from './provider-assignment-discussions.ts';
import { startAssignmentCloseoutWindow,startAssignmentExecutionWindow } from '../../../services/capacity/assignments/lifecycle/assignment-execution-window-service.ts';
import { reconcileBlockedDiscussionInvocations } from '../../../services/capacity/invocations/discussion-invocation-service.ts';

function providerEventInput(assignment: Record<string, unknown>, body: Record<string, unknown>) {
	const id = typeof body.id === 'string' ? body.id.trim() : '';
	const eventType = typeof body.eventType === 'string' ? body.eventType.trim() : '';
	const component = typeof body.component === 'string' ? body.component.trim() : '';
	const message = typeof body.message === 'string' ? body.message.trim() : '';
	const status = typeof body.status === 'string' ? body.status : 'recorded';
	if (!/^[a-z0-9][a-z0-9_.:-]{0,159}$/u.test(id)) throw new CapacityGovernanceError('provider_runtime_event_id_invalid', 'Provider runtime event id is invalid.', 400);
	if (!/^provider\.[a-z0-9_.-]{1,120}$/u.test(eventType)) throw new CapacityGovernanceError('provider_runtime_event_type_invalid', 'Provider runtime event type is invalid.', 400);
	if (!['provider-manager', 'provider-runner', 'lease', 'execution-provider', 'recovery'].includes(component)) throw new CapacityGovernanceError('provider_runtime_event_component_invalid', 'Provider runtime event component is invalid.', 400);
	if (!['recorded', 'active', 'completed', 'warning', 'error', 'failed'].includes(status)) throw new CapacityGovernanceError('provider_runtime_event_status_invalid', 'Provider runtime event status is invalid.', 400);
	if (!message || message.length > 4_000) throw new CapacityGovernanceError('provider_runtime_event_message_invalid', 'Provider runtime event message must contain at most 4,000 characters.', 400);
	const sanitized = redactTranscriptValue({ context: body.context, refs: body.refs, metrics: body.metrics }) as Record<string, unknown>;
	if (JSON.stringify(sanitized).length > 262_144) throw new CapacityGovernanceError('provider_runtime_event_payload_too_large', 'Provider runtime event evidence exceeds 256 KiB.', 413);
	return {
		id: `provider-runtime:${String(assignment.id)}:${id}`, eventType, status,
		title: eventType, message, assignmentId: assignment.id, projectId: assignment.projectId,
		workdayId: assignment.workDayId, createdAt: body.createdAt,
		context: { ...record(sanitized.context), component, agentId: assignment.agentId, agentClassId: assignment.projectAgentClassId,
			handlerId: assignment.handlerId, capacityProviderId: assignment.capacityProviderId, runnerId: assignment.runnerId,
			executionProviderId: assignment.executionProviderId, activityType: assignmentActivityType(assignment) },
		refs: record(sanitized.refs), metadata: { severity: status === 'failed' || status === 'error' ? 'error' : status === 'warning' ? 'warning' : 'info', metrics: record(sanitized.metrics), redactionStatus: 'sanitized' },
	};
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

async function leaseNextAssignment(c: Context,store: ProviderAssignmentStore,sessionEvents?: { subscribe(teamId:string,listener:(event:{eventType:string;payload:Record<string,unknown>})=>void):Promise<()=>void> }) {
	try {
		const principal = requireProviderPrincipal(c, ['provider:assignments:read']);
		const body = await readCapacityRequestObject(c, { optional: true });
		await reconcileBlockedDiscussionInvocations(store,principal.teamId);
		const waitMs=Math.max(0,Math.min(30,Number(body.waitSeconds)||0))*1000; const deadline=Date.now()+waitMs;
		let wake: (()=>void)|null=null; let unsubscribe:(()=>void)|null=null;
		let result=await store.leaseNextProviderAssignment(principal,body);
		try{
			if(!result.assignment&&waitMs>0&&sessionEvents)unsubscribe=await sessionEvents.subscribe(principal.teamId,(event)=>{
				if(event.eventType!=='capacity.assignment.available')return;
				const requestedPurpose=typeof body.lanePurpose==='string'?body.lanePurpose:null;
				if(requestedPurpose&&event.payload.lanePurpose&&event.payload.lanePurpose!==requestedPurpose)return;
				wake?.();
			});
			if(!result.assignment&&unsubscribe)result=await store.leaseNextProviderAssignment(principal,body);
			while(!result.assignment&&Date.now()<deadline&&!c.req.raw.signal.aborted){
				await new Promise<void>((resolve)=>{wake=resolve;setTimeout(resolve,Math.min(250,Math.max(1,deadline-Date.now())));});wake=null;
				result=await store.leaseNextProviderAssignment(principal,body);
			}
		}finally{unsubscribe?.();}
		return c.json({ ok: true, payload: result.assignment, assignment: result.assignment, leaseToken: result.leaseToken, leaseSeconds: result.leaseSeconds, diagnostics: result.diagnostics ?? null, leaseDiagnostics: result.diagnostics ?? null });
	} catch (error) { return errorResponse(c, error); }
}

export function installProviderAssignmentRoutes(app: Hono, options: { store: CapacityGovernanceDatabase; sessionEvents?: { subscribe(teamId:string,listener:(event:{eventType:string;payload:Record<string,unknown>})=>void):Promise<()=>void> } }) {
	const store = options.store as ProviderAssignmentStore;

	app.post('/v1/provider/assignments/next', (c) => leaseNextAssignment(c,store,options.sessionEvents));

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

	app.get('/v1/provider/assignments/:assignmentId/activity', async (c) => {
		try {
			const principal = requireProviderPrincipal(c, ['provider:assignments:read']);
			const assignment = assertProviderOwnsAssignment(await store.getProviderAssignment(principal.teamId, c.req.param('assignmentId')), principal, 'inspect activity for');
			const workdayRunId = record(assignment.metadata).workdayRunId;
			if (typeof workdayRunId !== 'string' || !workdayRunId) throw new CapacityGovernanceError('provider_assignment_workday_required', 'Assignment activity requires a durable workday.', 409);
			const query = agentActivityQuerySchema.safeParse({ after: c.req.query('after') ?? undefined, limit: c.req.query('limit') ?? undefined, type: c.req.query('type') ?? undefined, severity: c.req.query('severity') ?? undefined });
			if (!query.success) throw new CapacityGovernanceError('provider_assignment_activity_query_invalid', 'Assignment activity query is invalid.', 400, { diagnostics: query.error.issues });
			const events = await store.listCapacityWorkdayEventsPage(principal.teamId, workdayRunId, { limit: 200, cursor: null, afterEventIndex: query.data.after });
			const items = filterWorkdayActivity(events.items as never[], query.data).filter((event) => event.assignmentId === assignment.id).slice(0, query.data.limit);
			return c.json({ ok: true, payload: agentActivityPageSchema.parse({ items, cursor: items.at(-1)?.sequence ?? query.data.after }) });
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
	app.post('/v1/provider/assignments/:assignmentId/execution-start',async(c)=>{
		try { const principal=requireProviderPrincipal(c,['provider:assignments:write']); const body=await readCapacityRequestObject(c); const assignment=await startAssignmentExecutionWindow(store,principal,c.req.param('assignmentId'),body); return c.json({ok:true,payload:assignment}); }
		catch(error){ return errorResponse(c,error); }
	});
	app.post('/v1/provider/assignments/:assignmentId/closeout-start',async(c)=>{
		try { const principal=requireProviderPrincipal(c,['provider:assignments:write']); const body=await readCapacityRequestObject(c); const assignment=await startAssignmentCloseoutWindow(store,principal,c.req.param('assignmentId'),body); return c.json({ok:true,payload:assignment}); }
		catch(error){ return errorResponse(c,error); }
	});
	app.post('/v1/provider/assignments/:assignmentId/return', lifecycle('provider:assignments:write', 'returnProviderAssignment'));
	app.post('/v1/provider/assignments/:assignmentId/completion-preflight',async(c)=>{
		try{const principal=requireProviderPrincipal(c,['provider:assignments:write']);const body=await readCapacityRequestObject(c);const result=await store.preflightProviderAssignmentCompletion(principal,c.req.param('assignmentId'),body);return c.json({ok:true,payload:result});}
		catch(error){return errorResponse(c,error);}
	});
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

	app.post('/v1/provider/assignments/:assignmentId/events', async (c) => {
		try {
			const principal = requireProviderPrincipal(c, ['provider:assignments:write']);
			const assignment = assertProviderOwnsAssignment(await store.getProviderAssignment(principal.teamId, c.req.param('assignmentId')), principal, 'report runtime events for');
			const workdayRunId = record(assignment.metadata).workdayRunId;
			if (typeof workdayRunId !== 'string' || !workdayRunId || !store.createCapacityWorkdayEvent) {
				throw new CapacityGovernanceError('provider_runtime_event_workday_required', 'Provider runtime events require a durable workday assignment.', 409);
			}
			const event = await store.createCapacityWorkdayEvent(principal.teamId, workdayRunId, providerEventInput(assignment, await readCapacityRequestObject(c)));
			return c.json({ ok: true, payload: event }, { status: 201 });
		} catch (error) { return errorResponse(c, error); }
	});

	installProviderAssignmentSignalRoutes(app, store);
	installProviderAssignmentDiscussionRoutes(app, store);

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

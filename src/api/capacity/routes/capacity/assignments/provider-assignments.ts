import type { Context,Hono } from 'hono';
import type { CapacityGovernanceDatabase } from '../../../database.ts';
import { CapacityGovernanceError } from '../../../database.ts';
import { readCapacityRequestObject } from '../../support/request-json.ts';
import { requireProviderPrincipal,type CapacityProviderAccessPrincipal } from '../providers/provider-auth.ts';
import { observeWorkflowRun, queueRun, serializeWorkflowOperation,
	serializeWorkflowOperationRun } from '../../../../routes/projects/operations/workflow-operations.ts';
import { modeRunActivityEvent } from '../../../services/capacity/workdays/content/mode-run-activity-event.ts';
import { redactTranscriptValue } from '../../support/workday-activity.ts';
import { decodeWorkdayPlanningGraphSnapshot } from '../../../services/capacity/workdays/policy/workday-planning-graph-policy.ts';
import { enforceProviderSignalContract } from './provider-signal-policy.ts';
import { recordPlanningParticipantRequest,validatePlanningParticipantRequest } from '../../../services/capacity/workdays/scheduling/planning-participant-request-service.ts';

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

function assignmentActivityType(assignment: Record<string, unknown>): unknown {
	const decision = record(assignment.decisionInput);
	return decision.activityType
		?? record(decision.metadata).activityType
		?? record(decision.input).activityType
		?? record(assignment.metadata).activityType;
}

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

function providerSignalInput(assignment: Record<string, unknown>, body: Record<string, unknown>, contract: import('@treeseed/sdk/agent-capacity').AgentSignalContract) {
	const contractId = typeof body.contractId === 'string' ? body.contractId.trim().replace(/_/gu, '-') : '';
	const subjectKind = typeof body.subjectKind === 'string' ? body.subjectKind.trim() : '';
	const subjectId = typeof body.subjectId === 'string' ? body.subjectId.trim() : '';
	const causationId = typeof body.causationId === 'string' ? body.causationId.trim() : '';
	const correlationId = typeof body.correlationId === 'string' ? body.correlationId.trim() : causationId;
	const declared = Array.isArray(record(assignment.allowedOutputs).publishedSignals)
		? record(assignment.allowedOutputs).publishedSignals as unknown[] : [];
	if (!declared.some((entry) => String(entry).replace(/_/gu, '-') === contractId)) throw new CapacityGovernanceError('assignment_signal_not_declared', 'Assignment cannot publish this signal contract.', 403, { contractId });
	if (!/^[a-z0-9][a-z0-9-]{1,119}$/u.test(contractId)) throw new CapacityGovernanceError('assignment_signal_contract_invalid', 'Signal contract ID is invalid.', 400);
	if (!subjectKind || !subjectId || !causationId || !correlationId) throw new CapacityGovernanceError('assignment_signal_identity_required', 'Signal subject, causation, and correlation identities are required.', 400);
	const evidence = record(body.evidence);
	const commitSha = typeof evidence.commitSha === 'string' ? evidence.commitSha.trim() : '';
	const evidenceRef = typeof evidence.controlPlaneRef === 'string' ? evidence.controlPlaneRef.trim() : '';
	if (!commitSha && !evidenceRef) throw new CapacityGovernanceError('assignment_signal_evidence_required', 'A signal requires immutable commit evidence or a durable control-plane evidence reference.', 400);
	const changeSummary = typeof body.changeSummary === 'string' ? body.changeSummary.trim() : '';
	if (!changeSummary || changeSummary.length > 4_000) throw new CapacityGovernanceError('assignment_signal_summary_invalid', 'Signal change summary must contain at most 4,000 characters.', 400);
	const sanitized = redactTranscriptValue({ payload: body.payload, evidence, metadata: body.metadata }) as Record<string, unknown>;
	if (JSON.stringify(sanitized).length > 262_144) throw new CapacityGovernanceError('assignment_signal_payload_too_large', 'Signal evidence exceeds 256 KiB.', 413);
	const metadata = record(assignment.metadata);
	const idempotencyKey = enforceProviderSignalContract(assignment, body, contract);
	return {
		id: `signal:${String(assignment.id)}:${contractId}:${idempotencyKey}`,
		contractId, subjectKind, subjectId, causationId, correlationId, changeSummary,
		commitSha: commitSha || null, immutableRef: typeof evidence.immutableRef === 'string' ? evidence.immutableRef : null,
		digest: typeof evidence.digest === 'string' ? evidence.digest : null,
		changedPaths: Array.isArray(evidence.changedPaths) ? evidence.changedPaths.filter((entry) => typeof entry === 'string') : [],
		evidenceRef: evidenceRef || null, payload: record(sanitized.payload),
		metadata: { ...record(sanitized.metadata), producerClass: assignment.signalProducerClass ?? assignment.projectAgentClassId ?? null },
		workdayRunId: typeof metadata.workdayRunId === 'string' ? metadata.workdayRunId : null,
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

	app.post('/v1/provider/assignments/:assignmentId/signals', async (c) => {
		try {
			const principal = requireProviderPrincipal(c, ['provider:assignments:write']);
			const assignment = assertProviderOwnsAssignment(await store.getProviderAssignment(principal.teamId, c.req.param('assignmentId')), principal, 'publish signals for');
			if (!['leased', 'running'].includes(String(assignment.status))) throw new CapacityGovernanceError('assignment_signal_execution_required', 'Signals may only be published while an assignment is executing.', 409);
			const body = await readCapacityRequestObject(c);
			const workdayRunId = record(assignment.metadata).workdayRunId;
			const run = typeof workdayRunId === 'string' ? await store.first('SELECT parameters_json FROM capacity_workday_runs WHERE id = ? AND team_id = ?', [workdayRunId, principal.teamId]) : null;
			if (!run) throw new CapacityGovernanceError('assignment_signal_workday_snapshot_required', 'Signal publication requires its frozen workday graph snapshot.', 409);
			let parameters: Record<string, unknown> = {};
			try { parameters = record(JSON.parse(String(run.parameters_json ?? '{}'))); } catch { throw new CapacityGovernanceError('assignment_signal_workday_snapshot_invalid', 'The frozen workday parameters are corrupt.', 500); }
			const snapshot = decodeWorkdayPlanningGraphSnapshot(record(parameters.planningGraphByProjectId)[String(assignment.projectId)], String(assignment.projectId));
			const contractId = String(body.contractId ?? '').trim().replace(/_/gu, '-');
			const contract = snapshot.signalContracts[contractId];
			if (!contract) throw new CapacityGovernanceError('assignment_signal_contract_not_frozen', 'Signal contract is not part of this workday graph revision.', 403, { contractId });
			const decisionInput = record(assignment.decisionInput);
			const activityType = String(
				decisionInput.activityType
				?? record(decisionInput.metadata).activityType
				?? record(decisionInput.input).activityType
				?? record(assignment.metadata).activityType
				?? '',
			).trim();
			const selectedAgent = snapshot.agents.find((agent) => agent.slug === assignment.agentId && agent.activityType === activityType)
				?? snapshot.agents.find((agent) => agent.slug === assignment.agentId);
			const signal = providerSignalInput({ ...assignment, signalProducerClass: selectedAgent?.projectAgentClassSlug }, body, contract);
			let participantRequest: Awaited<ReturnType<typeof validatePlanningParticipantRequest>> | null = null;
			if (contractId === 'proposal-participant-requested') {
				try { participantRequest = await validatePlanningParticipantRequest({ database: store, assignment, snapshot, payload: record(body.payload) }); }
				catch (error) {
					if (typeof workdayRunId === 'string' && store.createCapacityWorkdayEvent) await store.createCapacityWorkdayEvent(principal.teamId,workdayRunId,{
						eventType:'planning.participant_request_rejected',status:'warning',assignmentId:assignment.id,projectId:assignment.projectId,
						title:'Planning participant request rejected',context:{ contractId,target:record(body.payload),code:error instanceof CapacityGovernanceError ? error.code : 'planning_participant_request_failed',message:error instanceof Error ? error.message : String(error) },
					}).catch(() => null);
					throw error;
				}
			}
			const now = new Date().toISOString();
			await store.run(`INSERT INTO agent_signals
				(id,contract_id,subject_kind,subject_id,team_id,project_id,workday_run_id,assignment_id,agent_id,activity_type,capacity_provider_id,causation_id,correlation_id,origin,commit_sha,immutable_ref,digest,changed_paths_json,change_summary,evidence_ref,payload_json,metadata_json,created_at)
				VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'agent-tool',?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`, [
				signal.id, signal.contractId, signal.subjectKind, signal.subjectId, principal.teamId, assignment.projectId,
				signal.workdayRunId, assignment.id, assignment.agentId ?? null, activityType || null,
				principal.capacityProviderId, signal.causationId, signal.correlationId, signal.commitSha, signal.immutableRef,
				signal.digest, JSON.stringify(signal.changedPaths), signal.changeSummary, signal.evidenceRef,
				JSON.stringify(signal.payload), JSON.stringify(signal.metadata), now,
			]);
			if (participantRequest) await recordPlanningParticipantRequest(store, participantRequest, signal.id, now);
			const persisted = await store.first('SELECT * FROM agent_signals WHERE id = ? AND assignment_id = ?', [signal.id, assignment.id]);
			return c.json({ ok: true, payload: persisted }, { status: 201 });
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

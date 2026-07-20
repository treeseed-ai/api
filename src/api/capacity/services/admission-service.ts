import { createHash, randomUUID } from 'node:crypto';
import {
	evaluateCapacityAdmission,
	type CapacityAdmissionDecision,
	type CapacityAdmissionInput,
} from '@treeseed/sdk/agent-capacity/allocation';
import type { CapacityGovernanceDatabase, CapacityDatabaseOperation } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';
import { decodeDurableJsonArray, decodeDurableJsonObject } from '../durable-json.ts';
import { compileAssignmentCapabilityContext } from './assignment-capability-service.ts';

export interface CapacityAssignmentDraft {
	id?: string;
	projectAgentClassId: string;
	providerSessionId?: string | null;
	executionProviderId?: string | null;
	laneId?: string | null;
	workDayId?: string | null;
	taskId?: string | null;
	agentId?: string | null;
	handlerId?: string | null;
	capacityEnvelope?: Record<string, unknown>;
	decisionInput?: Record<string, unknown>;
	workspaceContext?: Record<string, unknown>;
	capabilityHandles?: Record<string, unknown>;
	allowedOutputs?: Record<string, unknown>;
	explanation?: Record<string, unknown>;
	synthesizedFrom?: string | null;
	synthesisKey?: string | null;
	decisionId?: string | null;
	proposalId?: string | null;
	fallbackOutputId?: string | null;
	treedxProxyHandle?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
}

export interface CapacityAdmissionCommitRequest {
	idempotencyKey: string;
	admission: CapacityAdmissionInput;
	assignment: CapacityAssignmentDraft;
	reservationId?: string;
	assignmentId?: string;
	expiresAt?: string | null;
}

export interface CapacityAdmissionCommitResult {
	replayed: boolean;
	reservation: Record<string, unknown>;
	assignment: Record<string, unknown>;
	decision: CapacityAdmissionDecision;
}

function required(value: string, name: string) {
	if (!value.trim()) throw new CapacityGovernanceError(`${name}_required`, `${name} is required.`, 400);
	return value.trim();
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function optionalString(value: unknown): string | null {
	return typeof value === 'string' && value ? value : null;
}

function assertProxyHandleScope(handle: Record<string, unknown>, input: CapacityAdmissionCommitRequest, assignmentId: string) {
	for (const [field, expected] of [
		['teamId', input.admission.request.teamId],
		['projectId', input.admission.request.projectId],
		['assignmentId', assignmentId],
	] as const) {
		const actual = optionalString(handle[field]);
		if (actual && actual !== expected) {
			throw new CapacityGovernanceError(
				'capacity_admission_treedx_proxy_scope_mismatch',
				`TreeDX proxy handle ${field} does not match the admitted assignment.`,
				400,
				{ field, expected, actual },
			);
		}
	}
}

function proxyHandleOperation(
	input: CapacityAdmissionCommitRequest,
	assignmentId: string,
	reservationId: string,
	now: string,
): CapacityDatabaseOperation | null {
	const handle = record(input.assignment.treedxProxyHandle);
	const handleId = optionalString(handle.id);
	if (!handleId) return null;
	assertProxyHandleScope(handle, input, assignmentId);
	const token = optionalString(handle.token);
	const tokenHash = token
		? createHash('sha256').update(token).digest('hex')
		: optionalString(handle.tokenHash);
	return {
		query: `INSERT INTO treedx_proxy_handles (
			id, team_id, project_id, assignment_id, repository_id, workspace_id, status, scopes_json,
			allowed_operations_json, allowed_paths_json, allowed_read_paths_json, allowed_write_paths_json,
			token_hash, expires_at, issued_at, revoked_at, metadata_json, created_at, updated_at
		) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
		  WHERE EXISTS (
			SELECT 1 FROM capacity_provider_assignments
			 WHERE id = ? AND reservation_id = ? AND team_id = ? AND project_id = ?
		  )`,
		params: [
			handleId,
			input.admission.request.teamId,
			input.admission.request.projectId,
			assignmentId,
			optionalString(handle.repositoryId),
			optionalString(handle.workspaceId),
			optionalString(handle.status) ?? 'issued',
			JSON.stringify(strings(handle.scopes)),
			JSON.stringify(strings(handle.allowedOperations)),
			JSON.stringify(strings(handle.allowedPaths)),
			JSON.stringify(strings(handle.allowedReadPaths)),
			JSON.stringify(strings(handle.allowedWritePaths)),
			tokenHash,
			optionalString(handle.expiresAt),
			optionalString(handle.issuedAt) ?? now,
			optionalString(handle.revokedAt),
			JSON.stringify(record(handle.metadata)),
			now,
			now,
			assignmentId,
			reservationId,
			input.admission.request.teamId,
			input.admission.request.projectId,
		],
	};
}

function serialized(row: Record<string, unknown>, owner: string) {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(row)) {
		if (key.endsWith('_json')) continue;
		result[key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())] = value;
	}
	for (const [column, key] of [
		['policy_snapshot_json', 'policySnapshot'],
		['capacity_envelope_json', 'capacityEnvelope'],
		['decision_input_json', 'decisionInput'],
		['explanation_json', 'explanation'],
		['workspace_context_json', 'workspaceContext'],
		['allowed_outputs_json', 'allowedOutputs'],
		['treedx_proxy_handle_json', 'treedxProxyHandle'],
		['metadata_json', 'metadata'],
		['allocation_slice_ids_json', 'allocationSliceIds'],
	] as const) {
		if (!(column in row)) continue;
		const context = { owner, ownerId: String(row.id ?? ''), column };
		result[key] = column === 'allocation_slice_ids_json'
			? decodeDurableJsonArray(row[column], context)
			: decodeDurableJsonObject(row[column], context);
	}
	return result;
}

async function committedResult(database: CapacityGovernanceDatabase, teamId: string, idempotencyKey: string, decision: CapacityAdmissionDecision, allowPartial = false) {
	const reservation = await database.first(`SELECT * FROM capacity_reservations WHERE team_id = ? AND idempotency_key = ? LIMIT 1`, [teamId, idempotencyKey]);
	if (!reservation) return null;
	const assignment = await database.first(`SELECT * FROM capacity_provider_assignments WHERE reservation_id = ? AND team_id = ? LIMIT 1`, [reservation.id, teamId]);
	if (!assignment) {
		if (allowPartial) return null;
		throw new CapacityGovernanceError('capacity_admission_partial_commit', 'Capacity admission contains a reservation without its assignment.', 500, { reservationId: reservation.id });
	}
	return { replayed: true, reservation: serialized(reservation, 'capacity reservation'), assignment: serialized(assignment, 'provider assignment'), decision };
}

async function awaitConcurrentCommit(database: CapacityGovernanceDatabase, teamId: string, idempotencyKey: string, decision: CapacityAdmissionDecision) {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const committed = await committedResult(database, teamId, idempotencyKey, decision, true);
		if (committed) return committed;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	return committedResult(database, teamId, idempotencyKey, decision);
}

function assertReplayMatchesRequest(
	committed: Awaited<ReturnType<typeof committedResult>>,
	input: CapacityAdmissionCommitRequest,
) {
	if (!committed) return;
	const reservation = committed.reservation;
	const request = input.admission.request;
	const mismatches = [
		['membershipId', reservation.membershipId, request.membershipId],
		['providerId', reservation.capacityProviderId, request.providerId],
		['laneId', reservation.laneId, request.laneId ?? null],
		['projectId', reservation.projectId, request.projectId],
		['mode', reservation.mode, request.mode],
		['workDayId', reservation.workDayId, input.assignment.workDayId ?? input.admission.workday.id],
		['projectAgentClassId', reservation.projectAgentClassId, input.assignment.projectAgentClassId],
		['requestedCredits', Number(reservation.reservedCredits), Number(request.requestedCredits)],
	].filter(([, committedValue, requestedValue]) => committedValue !== requestedValue);
	if (mismatches.length > 0) {
		throw new CapacityGovernanceError(
			'capacity_admission_idempotency_conflict',
			'Capacity admission idempotency key was already committed with a different request.',
			409,
			{ mismatches: mismatches.map(([field]) => field), reservationId: reservation.id },
		);
	}
}

function counterInitializationOperations(input: CapacityAdmissionCommitRequest, decision: CapacityAdmissionDecision, now: string): CapacityDatabaseOperation[] {
	const teamId = input.admission.request.teamId;
	return decision.counterClaims.map((claim) => ({
			query: `INSERT OR IGNORE INTO capacity_admission_counters (id, team_id, scope, scope_id, period_key, hard_limit, committed_amount, state_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
			params: [claim.id, teamId, claim.scope, claim.scopeId, claim.periodKey, claim.hardLimit, now, now],
		}));
}

function counterClaimOperations(input: CapacityAdmissionCommitRequest, decision: CapacityAdmissionDecision, reservationId: string, admissionToken: string, now: string): CapacityDatabaseOperation[] {
	const teamId = input.admission.request.teamId;
	return decision.counterClaims.flatMap((claim) => [
		{
			query: `UPDATE capacity_admission_counters
			 SET committed_amount = committed_amount + ?, state_version = state_version + 1, updated_at = ?
			 WHERE id = ? AND team_id = ?
			   AND EXISTS (
				 SELECT 1 FROM capacity_reservations
				 WHERE id = ? AND team_id = ? AND idempotency_key = ? AND admission_token = ?
			   )`,
			params: [claim.amount, now, claim.id, teamId, reservationId, teamId, input.idempotencyKey, admissionToken],
		},
		{
			query: `INSERT INTO capacity_reservation_counter_claims (reservation_id, counter_id, admission_token, reserved_amount, released_amount, release_policy, created_at, updated_at) SELECT ?, ?, ?, CAST(? AS REAL), 0, ?, ?, ? WHERE EXISTS (SELECT 1 FROM capacity_reservations WHERE id = ? AND team_id = ? AND idempotency_key = ? AND admission_token = ?) ON CONFLICT (reservation_id, counter_id) DO NOTHING`,
			params: [reservationId, claim.id, admissionToken, claim.amount, claim.release, now, now, reservationId, teamId, input.idempotencyKey, admissionToken],
		},
	]);
}

export async function commitCapacityAdmission(database: CapacityGovernanceDatabase, input: CapacityAdmissionCommitRequest): Promise<CapacityAdmissionCommitResult> {
	await database.ensureInitialized();
	const idempotencyKey = required(input.idempotencyKey, 'capacity_admission_idempotency_key');
	const decision = evaluateCapacityAdmission(input.admission);
	const replay = await committedResult(database, input.admission.request.teamId, idempotencyKey, decision);
	if (replay) {
		assertReplayMatchesRequest(replay, input);
		return replay;
	}
	if (!decision.allowed) throw new CapacityGovernanceError('capacity_admission_denied', 'Capacity admission was denied by policy.', 409, { decision });
	const reservationId = input.reservationId ?? randomUUID();
	const assignmentId = input.assignmentId ?? input.assignment.id ?? randomUUID();
	const admissionToken = randomUUID();
	const now = input.admission.now;
	const request = input.admission.request;
	const workspaceContext = compileAssignmentCapabilityContext({
		id: assignmentId,
		teamId: request.teamId,
		projectId: request.projectId,
		mode: request.mode,
		workspaceContext: input.assignment.workspaceContext,
		capabilityHandles: input.assignment.capabilityHandles,
		treedxProxyHandle: input.assignment.treedxProxyHandle,
		decisionInput: input.assignment.decisionInput,
		capacityEnvelope: input.assignment.capacityEnvelope,
		metadata: input.assignment.metadata,
		synthesizedFrom: input.assignment.synthesizedFrom,
	});
	const grantId = decision.grantId;
	const allocationSetId = decision.allocationSetId;
	if (!grantId || !allocationSetId || decision.allocationVersion == null) throw new CapacityGovernanceError('capacity_admission_policy_snapshot_incomplete', 'Admission decision is missing its grant or allocation provenance.', 500);
	const workDayId = input.assignment.workDayId ?? input.admission.workday.id;
	const taskId = input.assignment.taskId ?? null;
	const capacityEnvelope = {
		...record(input.assignment.capacityEnvelope),
		teamId: request.teamId,
		projectId: request.projectId,
		workDayId,
		allocationSetId,
		mode: request.mode,
		projectAgentClassId: input.assignment.projectAgentClassId,
		capacityProviderId: request.providerId,
		executionProviderId: request.executionProviderId ?? null,
		reservationId,
		reservedCredits: request.requestedCredits,
	};
	const suppliedDecisionInput = record(input.assignment.decisionInput);
	const decisionInput = {
		...suppliedDecisionInput,
		teamId: request.teamId,
		projectId: request.projectId,
		projectAgentClassId: input.assignment.projectAgentClassId,
		mode: request.mode,
		taskId,
		workDayId,
		agentId: input.assignment.agentId ?? null,
		handlerId: input.assignment.handlerId ?? null,
		capacity: capacityEnvelope,
		input: record(suppliedDecisionInput.input),
	};
	const operations = counterInitializationOperations(input, decision, now);
	operations.push({
		query: `INSERT OR IGNORE INTO capacity_reservations (id, idempotency_key, admission_token, membership_id, grant_id, capacity_provider_id, execution_provider_id, lane_id, allocation_set_id, allocation_version, allocation_slice_ids_json, policy_snapshot_json, project_agent_class_id, assignment_id, mode, team_id, project_id, work_day_id, task_id, state, reserved_credits, consumed_credits, expires_at, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, 0, ?, '{}', ?, ?)`,
		params: [reservationId, idempotencyKey, admissionToken, request.membershipId, grantId, request.providerId, request.executionProviderId ?? null, request.laneId ?? null, allocationSetId, decision.allocationVersion, JSON.stringify(input.admission.allocationSliceIds), JSON.stringify(decision.policySnapshot), input.assignment.projectAgentClassId, assignmentId, request.mode, request.teamId, request.projectId, workDayId, taskId, request.requestedCredits, input.expiresAt ?? null, now, now],
	});
	operations.push(...counterClaimOperations(input, decision, reservationId, admissionToken, now));
	operations.push({
		query: `INSERT INTO capacity_provider_assignments (id, membership_id, team_id, project_id, capacity_provider_id, provider_session_id, execution_provider_id, lane_id, allocation_set_id, project_agent_class_id, reservation_id, work_day_id, task_id, mode, status, lease_state, state_version, agent_id, handler_id, capacity_envelope_json, decision_input_json, workspace_context_json, allowed_outputs_json, explanation_json, attempt_count, assigned_at, lifecycle_output_json, synthesized_from, synthesis_key, decision_id, proposal_id, fallback_output_id, treedx_proxy_handle_json, metadata_json, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'unleased', 1, ?, ?, ?, ?, ?, ?, ?, 0, ?, '{}', ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM capacity_reservations WHERE id = ? AND team_id = ? AND idempotency_key = ?) ON CONFLICT (id) DO NOTHING`,
		params: [assignmentId, request.membershipId, request.teamId, request.projectId, request.providerId, input.assignment.providerSessionId ?? null, request.executionProviderId ?? null, request.laneId ?? null, allocationSetId, input.assignment.projectAgentClassId, reservationId, workDayId, taskId, request.mode, input.assignment.agentId ?? null, input.assignment.handlerId ?? null, JSON.stringify(capacityEnvelope), JSON.stringify(decisionInput), JSON.stringify(workspaceContext), JSON.stringify(input.assignment.allowedOutputs ?? {}), JSON.stringify({ ...(input.assignment.explanation ?? {}), admission: decision }), now, input.assignment.synthesizedFrom ?? null, input.assignment.synthesisKey ?? null, input.assignment.decisionId ?? null, input.assignment.proposalId ?? null, input.assignment.fallbackOutputId ?? null, JSON.stringify(input.assignment.treedxProxyHandle ?? {}), JSON.stringify(input.assignment.metadata ?? {}), now, now, reservationId, request.teamId, idempotencyKey],
	});
	const handleOperation = proxyHandleOperation(input, assignmentId, reservationId, now);
	if (handleOperation) operations.push(handleOperation);
	try {
		await database.batch(operations);
	} catch (error) {
		if (error instanceof Error && /duplicate key|unique constraint/iu.test(error.message)) {
			const concurrentReplay = await awaitConcurrentCommit(database, request.teamId, idempotencyKey, decision);
			if (concurrentReplay) {
				assertReplayMatchesRequest(concurrentReplay, input);
				return concurrentReplay;
			}
		}
		if (error instanceof Error && !/check constraint|committed_amount|hard_limit/iu.test(error.message)) throw error;
		throw new CapacityGovernanceError('capacity_admission_concurrent_limit_exhausted', 'Capacity changed concurrently and no longer satisfies a hard limit.', 409, { decision });
	}
	const committed = await committedResult(database, request.teamId, idempotencyKey, decision);
	if (!committed) throw new CapacityGovernanceError('capacity_admission_not_committed', 'Capacity admission did not create a reservation and assignment.', 409, { decision });
	assertReplayMatchesRequest(committed, input);
	return { ...committed, replayed: committed.reservation.id !== reservationId };
}

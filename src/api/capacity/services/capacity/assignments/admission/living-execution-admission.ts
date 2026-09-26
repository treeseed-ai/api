import type { AssignmentAttempt, CapabilityAccountingLimits, calculateAssignmentAllocation, allocateWorkdayCapacity, selectFairReadyNode } from '@treeseed/sdk/agent-capacity';
import { randomUUID } from 'node:crypto';
import { capabilityCounterClaims, initializeCapabilityCounters, commitCapabilityCounters } from './capability-counter-claims.ts';
import type { CapacityGovernanceDatabase } from '../../../../database.ts';
import { CapacityGovernanceError } from '../../../../database.ts';
import type { DurableProviderAssignment } from '../../../../repositories/capacity/assignments/assignment.ts';
import type { ProviderLeasePrincipal } from '../../../accounts/lease-authority-service.ts';
import { compileAssignmentTimeBudget } from '../planning/assignment-time-budget.ts';
import { workdayReportContext } from './workday-report-context.ts';

interface Store extends CapacityGovernanceDatabase {
	getProviderAssignment(teamId: string, assignmentId: string): Promise<DurableProviderAssignment | null>;
}

type JsonRecord = Record<string, unknown>;

// Graph reconciliation is a projection and may briefly observe adjacent
// lifecycle commits in different snapshots. Admission is the final authority:
// never claim an Actor once its exact paired Reviewer has exhausted the
// configured request-changes cycle, even if a stale projection says `ready`.
const reviewCycleAdmissionFence = `NOT EXISTS (
	SELECT 1 FROM execution_edges review_pair
	JOIN execution_nodes reviewer ON reviewer.team_id=review_pair.team_id AND reviewer.id=review_pair.to_node_id
	WHERE review_pair.team_id=node.team_id AND review_pair.from_node_id=node.id
	AND review_pair.provenance='review-pair' AND review_pair.graph_revision_removed IS NULL
	AND reviewer.pair_role='reviewer'
	AND (SELECT COUNT(*) FROM capacity_provider_assignments review_history
		WHERE review_history.team_id=node.team_id AND review_history.execution_node_id=reviewer.id
		AND (node.workday_id IS NULL OR review_history.work_day_id=node.workday_id)
		AND review_history.status='completed' AND review_history.assignment_result_json IS NOT NULL
		AND review_history.lifecycle_output_json::jsonb #>> '{activityCompletion,reviewDisposition}'='request-changes'
	)>=COALESCE(reviewer.maximum_review_cycles,1)
)`;

export function assignmentAccountingMode(assignment: Pick<AssignmentAttempt, 'effectiveProfile' | 'sourceRef' | 'workItemId'>): 'planning' | 'acting' {
	return assignment.effectiveProfile.activity === 'planning' || assignment.effectiveProfile.activity === 'estimating'
		|| (assignment.effectiveProfile.activity === 'reviewing' && assignment.sourceRef.model === 'proposal'
			&& assignment.workItemId === 'proposal-review') ? 'planning' : 'acting';
}

/** Atomically claim one normalized node and create its one reservation/attempt. */
export async function admitLivingExecutionAssignment(store: Store, input: {
	principal: ProviderLeasePrincipal;
	assignment: AssignmentAttempt;
	allocation: ReturnType<typeof calculateAssignmentAllocation> & {
		opportunity: ReturnType<typeof allocateWorkdayCapacity>[string]; selection: ReturnType<typeof selectFairReadyNode> };
	accountingLimits: CapabilityAccountingLimits;
	projectAgentClassId: string;
	providerSessionId: string;
	executionProviderId: string;
	laneId: string;
	lanePurpose: 'workday' | 'communication';
	executionKind: 'workday' | 'conversation';
	workdayConcurrencyLimit: number;
	providerConcurrencyLimit?: number;
	invocationId?: string | null;
	predecessorResults: unknown[];
	treedxProxyHandle: JsonRecord;
	now: string;
}): Promise<DurableProviderAssignment> {
	const { assignment, principal } = input;
	const replay = await store.getProviderAssignment(assignment.teamId, assignment.id);
	if (replay) {
		if (replay.executionNodeId !== assignment.nodeId || replay.executionNodeRevision !== assignment.nodeRevision) {
			throw new CapacityGovernanceError('execution_assignment_idempotency_conflict',
				'Assignment identity is already bound to another execution-node revision.', 409);
		}
		return replay;
	}
	if (!input.allocation.admitted || input.allocation.allocatedSeconds !== assignment.limits.maximumSeconds) {
		throw new CapacityGovernanceError('assignment_allocation_mismatch', 'Assignment limits must match the allocator-issued duration.', 409);
	}
	if (!Number.isInteger(input.workdayConcurrencyLimit) || input.workdayConcurrencyLimit < 1) {
		throw new CapacityGovernanceError('workday_concurrency_limit_invalid', 'A positive workday concurrency limit is required.', 409);
	}
	const providerConcurrencyLimit = input.providerConcurrencyLimit ?? 1;
	if (!Number.isInteger(providerConcurrencyLimit) || providerConcurrencyLimit < 1) throw new CapacityGovernanceError(
		'provider_concurrency_limit_invalid', 'A positive provider concurrency limit is required.', 409);
	const mode = assignmentAccountingMode(assignment);
	const decisionId = assignment.authorityRefs.find((reference) => reference.model === 'decision')?.id ?? null;
	const proposalId = assignment.sourceRef.model === 'proposal' ? assignment.sourceRef.id : null;
	const timing = compileAssignmentTimeBudget({ now: input.now, requestedSeconds: assignment.limits.maximumSeconds, configuredBudget: { deadline: assignment.deadline } });
	const capacityEnvelope = {
		teamId: assignment.teamId, projectId: assignment.projectId, workDayId: assignment.workdayId, mode,
		projectAgentClassId: input.projectAgentClassId, capacityProviderId: principal.capacityProviderId,
		executionProviderId: input.executionProviderId, reservationId: assignment.reservationId,
		requestedSeconds: assignment.limits.maximumSeconds, reservedSeconds: assignment.limits.maximumSeconds,
		limits: assignment.limits, budget: timing.capacityBudget,
	};
	const common = [assignment.teamId,assignment.nodeId,assignment.nodeRevision];
	const authorizedContext = await workdayReportContext(store, assignment);
	const claims = capabilityCounterClaims(assignment, input.accountingLimits, input.now);
	const admissionToken = randomUUID();
	await store.batch([
		// Serializes admissions for this workday before checking its per-kind
		// concurrency. The count in the reservation INSERT is therefore atomic.
		{ query: `SELECT id FROM capacity_workday_runs WHERE team_id=? AND id=? AND status='running' FOR UPDATE`,
			params: [assignment.teamId, assignment.workdayId] },
		...initializeCapabilityCounters(assignment, claims, input.now),
		{ query: `SELECT node.id FROM execution_nodes node
			WHERE node.team_id=? AND node.id=? AND node.node_revision=? AND node.status='ready'
			AND ${reviewCycleAdmissionFence}
			AND NOT EXISTS (
				SELECT 1 FROM capacity_provider_assignments prior
				WHERE prior.team_id=node.team_id
				AND prior.execution_node_id=node.id
				AND prior.execution_node_revision=node.node_revision
				AND (prior.status<>'returned' OR (
					prior.execution_kind='conversation'
					AND prior.lifecycle_code='discussion_response_required'
				))
			)
			FOR UPDATE`, params: common },
		{ query: `INSERT INTO capacity_reservations
			(id,idempotency_key,membership_id,capacity_provider_id,execution_provider_id,lane_id,lane_purpose,
			 project_agent_class_id,assignment_id,mode,team_id,project_id,work_day_id,state,requested_seconds,
			 reserved_seconds,active_seconds,elapsed_seconds,released_seconds,overrun_seconds,expires_at,metadata_json,created_at,updated_at,admission_token)
			SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,'reserved',?,?,0,0,0,0,?,?::jsonb,?,?,?
			WHERE EXISTS (
				SELECT 1 FROM execution_nodes node
				WHERE node.team_id=? AND node.id=? AND node.node_revision=? AND node.status='ready'
				AND ${reviewCycleAdmissionFence}
				AND NOT EXISTS (
					SELECT 1 FROM capacity_provider_assignments prior
					WHERE prior.team_id=node.team_id
					AND prior.execution_node_id=node.id
					AND prior.execution_node_revision=node.node_revision
					AND (prior.status<>'returned' OR (
						prior.execution_kind='conversation'
						AND prior.lifecycle_code='discussion_response_required'
					))
				)
			)
			AND ${claims.map(() => `EXISTS (SELECT 1 FROM capacity_admission_counters WHERE id=? AND committed_amount+?<=LEAST(hard_limit,?))`).join(' AND ')}
			AND EXISTS (SELECT 1 FROM capacity_workday_runs run
				WHERE run.team_id=? AND run.id=? AND run.status='running')
			AND (SELECT COUNT(*) FROM capacity_provider_assignments active
				WHERE active.team_id=? AND active.work_day_id=? AND active.execution_kind=?
				AND active.status IN ('pending','leased','running')) < ?
			AND (SELECT COUNT(*) FROM capacity_provider_assignments active
				WHERE active.team_id=? AND active.capacity_provider_id=? AND active.lane_id=?
				AND active.status IN ('pending','leased','running')) < ?
			ON CONFLICT (id) DO NOTHING`, params: [assignment.reservationId,assignment.idempotencyKey,principal.membershipId,
				principal.capacityProviderId,input.executionProviderId,input.laneId,input.lanePurpose,input.projectAgentClassId,assignment.id,mode,
				assignment.teamId,assignment.projectId,assignment.workdayId,assignment.limits.maximumSeconds,
				assignment.limits.maximumSeconds,assignment.deadline,JSON.stringify({ nodeId: assignment.nodeId,
					nodeRevision: assignment.nodeRevision, graphRevision: assignment.graphRevision }),input.now,input.now,admissionToken,...common,
			...claims.flatMap(claim => [claim.id, assignment.limits.maximumSeconds, claim.hardLimit]),
			assignment.teamId, assignment.workdayId,
			assignment.teamId, assignment.workdayId, input.executionKind, input.workdayConcurrencyLimit,
			assignment.teamId, principal.capacityProviderId, input.laneId, providerConcurrencyLimit] },
		...commitCapabilityCounters(assignment, claims, admissionToken, input.now),
		{ query: `INSERT INTO capacity_provider_assignments
			(id,membership_id,team_id,project_id,capacity_provider_id,provider_session_id,execution_provider_id,lane_id,lane_purpose,
			 project_agent_class_id,reservation_id,work_day_id,mode,execution_kind,invocation_id,status,lease_state,state_version,agent_id,handler_id,
			 capacity_envelope_json,workspace_context_json,allowed_outputs_json,explanation_json,
			 attempt_count,assigned_at,lifecycle_output_json,synthesized_from,synthesis_key,decision_id,proposal_id,metadata_json,created_at,updated_at)
			SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending','unleased',1,?,?,?::jsonb,?::jsonb,'{}','{}',0,?,'{}',
				 'living_execution_graph',?,?,?,?::jsonb,?,?
			WHERE EXISTS (SELECT 1 FROM capacity_reservations WHERE id=? AND team_id=? AND assignment_id=?)
			AND NOT EXISTS (
				SELECT 1 FROM capacity_provider_assignments prior
				WHERE prior.team_id=? AND prior.execution_node_id=? AND prior.execution_node_revision=?
				AND (prior.status<>'returned' OR (
					prior.execution_kind='conversation'
					AND prior.lifecycle_code='discussion_response_required'
				))
			)
			ON CONFLICT (id) DO NOTHING`, params: [assignment.id,principal.membershipId,assignment.teamId,assignment.projectId,
				principal.capacityProviderId,input.providerSessionId,input.executionProviderId,input.laneId,input.lanePurpose,input.projectAgentClassId,
				assignment.reservationId,assignment.workdayId,mode,input.executionKind,input.invocationId ?? null,
				assignment.effectiveProfile.profileRef.id,assignment.effectiveProfile.handler,
			JSON.stringify(capacityEnvelope),
				JSON.stringify({ assignmentAttempt: assignment, predecessorResults: input.predecessorResults, authorizedContext }),input.now,
				assignment.idempotencyKey,decisionId,proposalId,JSON.stringify({ requiredCapabilities: assignment.requiredCapabilities }),input.now,input.now,
				assignment.reservationId,assignment.teamId,assignment.id,
				assignment.teamId,assignment.nodeId,assignment.nodeRevision] },
		{ query: `UPDATE capacity_provider_assignments SET explanation_json=?::jsonb,graph_revision=?,execution_node_id=?,execution_node_revision=?,
			assignment_attempt_json=?::jsonb,treedx_proxy_handle_json=?::jsonb,workspace_context_json=?::jsonb,updated_at=?
			WHERE id=? AND team_id=? AND reservation_id=?`,
			params: [JSON.stringify({ metadata: { allocation: input.allocation } }),assignment.graphRevision,assignment.nodeId,assignment.nodeRevision,JSON.stringify(assignment),
				JSON.stringify(input.treedxProxyHandle),JSON.stringify({ assignmentAttempt: assignment,
					predecessorResults: input.predecessorResults, authorizedContext, treedxProxyHandle: input.treedxProxyHandle }),input.now,
				assignment.id,assignment.teamId,assignment.reservationId] },
		...(input.invocationId ? [{ query: `UPDATE agent_invocation_requests SET assignment_id=?, status='running', updated_at=?
			WHERE id=? AND team_id=? AND status IN ('admitted','running') AND (assignment_id IS NULL OR assignment_id=?)`,
			params: [assignment.id,input.now,input.invocationId,assignment.teamId,assignment.id] }] : []),
		{ query: `INSERT INTO treedx_proxy_handles (
			id,team_id,project_id,assignment_id,repository_id,workspace_id,status,scopes_json,
			allowed_operations_json,allowed_paths_json,allowed_read_paths_json,allowed_write_paths_json,
			token_hash,expires_at,issued_at,revoked_at,metadata_json,created_at,updated_at)
			SELECT ?,?,?,?,?,?,'issued',?::jsonb,?::jsonb,?::jsonb,?::jsonb,?::jsonb,NULL,?,?,NULL,?::jsonb,?,?
			WHERE EXISTS (SELECT 1 FROM capacity_provider_assignments WHERE id=? AND team_id=? AND reservation_id=?)
			ON CONFLICT (id) DO NOTHING`, params: [input.treedxProxyHandle.id,assignment.teamId,assignment.projectId,
				assignment.id,input.treedxProxyHandle.repositoryId ?? null,input.treedxProxyHandle.workspaceId ?? null,
				JSON.stringify(input.treedxProxyHandle.scopes ?? []),JSON.stringify(input.treedxProxyHandle.allowedOperations ?? []),
				JSON.stringify(input.treedxProxyHandle.allowedPaths ?? []),JSON.stringify(input.treedxProxyHandle.allowedReadPaths ?? []),
				JSON.stringify(input.treedxProxyHandle.allowedWritePaths ?? []),input.treedxProxyHandle.expiresAt ?? assignment.deadline,
				input.now,JSON.stringify(input.treedxProxyHandle.metadata ?? {}),input.now,input.now,assignment.id,assignment.teamId,
				assignment.reservationId] },
		{ query: `UPDATE execution_nodes SET status='assigned',updated_at=?
			WHERE team_id=? AND id=? AND node_revision=? AND status='ready'
			AND EXISTS (SELECT 1 FROM capacity_provider_assignments WHERE id=? AND team_id=?
				AND execution_node_id=? AND execution_node_revision=? AND status='pending')`,
			params: [input.now,assignment.teamId,assignment.nodeId,assignment.nodeRevision,assignment.id,assignment.teamId,
				assignment.nodeId,assignment.nodeRevision] },
	]);
	const committed = await store.getProviderAssignment(assignment.teamId, assignment.id);
	if (!committed) {
		const active = await store.first(`SELECT COUNT(*) AS active_count FROM capacity_provider_assignments
			WHERE team_id=? AND work_day_id=? AND execution_kind=? AND status IN ('pending','leased','running')`,
			[assignment.teamId, assignment.workdayId, input.executionKind]);
		if (Number(active?.active_count ?? 0) >= input.workdayConcurrencyLimit) {
			throw new CapacityGovernanceError('capacity_assignment_allocation_deferred',
				'The workday execution lane has reached its independent concurrency limit.', 409,
				{ reason: 'workday_concurrency_exhausted', executionKind: input.executionKind,
					limit: input.workdayConcurrencyLimit });
		}
		const providerActive = await store.first(`SELECT COUNT(*) AS active_count FROM capacity_provider_assignments
			WHERE team_id=? AND capacity_provider_id=? AND lane_id=? AND status IN ('pending','leased','running')`,
			[assignment.teamId, principal.capacityProviderId, input.laneId]);
		if (Number(providerActive?.active_count ?? 0) >= providerConcurrencyLimit) throw new CapacityGovernanceError(
			'capacity_assignment_allocation_deferred', 'The provider execution lane has reached its advertised concurrency limit.', 409,
			{ reason: 'provider_concurrency_exhausted', providerId: principal.capacityProviderId,
				laneId: input.laneId, limit: providerConcurrencyLimit });
		const counters = await store.all(`SELECT scope,committed_amount,hard_limit FROM capacity_admission_counters
			WHERE id IN (${claims.map(() => '?').join(',')}) ORDER BY scope`, claims.map(claim => claim.id));
		const node = await store.first(`SELECT status,node_revision FROM execution_nodes WHERE team_id=? AND id=?`,
			[assignment.teamId, assignment.nodeId]);
		throw new CapacityGovernanceError('execution_node_claim_lost',
			'The execution node or an atomic admission guard changed before assignment admission.', 409,
			{ nodeId: assignment.nodeId, nodeRevision: assignment.nodeRevision,
				observedNode: { status: node?.status, revision: node?.node_revision },
				counters: counters.map(counter => ({ scope: counter.scope, committed: Number(counter.committed_amount),
					hardLimit: Number(counter.hard_limit) })),
				requestedSeconds: assignment.limits.maximumSeconds });
	}
	return committed;
}

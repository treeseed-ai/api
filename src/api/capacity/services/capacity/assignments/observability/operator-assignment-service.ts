import type { CapacityGovernanceDatabase } from '../../../../database.ts';
import { CapacityGovernanceError } from '../../../../database.ts';
import { ProviderAssignmentRepository, advanceAssignmentAttemptLifecycle } from '../../../../repositories/capacity/assignments/assignment.ts';
import type { DurableProviderAssignment } from '../../../../repositories/capacity/assignments/assignment.ts';
import { releaseCapacityReservationsExactlyOnce } from '../../accounting/settlement-service.ts';
import { terminalAssignmentAuthority } from '../lifecycle/assignment-terminal-authority.ts';
import { planningBoundaryCancellation } from '../lifecycle/assignment-failure-policy.ts';
import { composeAssignmentLifecycleOutput } from '../lifecycle/assignment-lifecycle-output.ts';
import { record, terminalPerformance } from '../lifecycle/completion/assignment-terminal-performance.ts';
import { capacityTransaction } from '../../../../transaction.ts';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';

function idempotencyKey(value: string) {
	if (!value.trim()) throw new CapacityGovernanceError('capacity_idempotency_key_required', 'An idempotency key is required.', 400);
	return value.trim();
}

export class OperatorAssignmentService {
	private readonly assignments: ProviderAssignmentRepository;
	constructor(
		private readonly database: CapacityGovernanceDatabase,
		private readonly closeWorkspace?: (assignment: DurableProviderAssignment) => Promise<unknown>,
	) {
		this.assignments = new ProviderAssignmentRepository(database);
	}

	/** Release an operator-held terminal slot, NOT an actual usage settlement.
	 * Audit is the sole unresolved-usage fact. Period claims stay held until actual
	 * measurements exist; neither zero charges nor budget refunds are inferred. */
	async recover(teamId: string, assignmentId: string, input: Record<string, unknown>) {
		const parsed = CONTROL_PLANE_OPERATIONS.assignments.recover.schema.body.safeParse({
			expectedStateVersion: input.expectedStateVersion, reason: input.reason });
		if (!parsed.success || typeof input.actorId !== 'string' || !input.actorId.trim()
			|| typeof input.idempotencyKey !== 'string') throw new CapacityGovernanceError(
			'capacity_recovery_input_invalid', 'Recovery requires authenticated actor, exact version, reason and operation identity.', 400);
		const accepted = record(parsed.data), expectedStateVersion = accepted.expectedStateVersion, reason = accepted.reason;
		if (typeof expectedStateVersion !== 'number' || typeof reason !== 'string') throw new CapacityGovernanceError(
			'capacity_recovery_input_invalid', 'Validated recovery identity is unavailable.', 400);
		const key = idempotencyKey(input.idempotencyKey), actorId = input.actorId;
		await this.database.ensureInitialized();
		return capacityTransaction(this.database, async database => {
			const row = await database.first('SELECT * FROM capacity_provider_assignments WHERE team_id=? AND id=? FOR UPDATE', [teamId, assignmentId]);
			if (!row) throw new CapacityGovernanceError('capacity_assignment_not_found', 'Assignment does not exist.', 404);
			const audit = await database.first("SELECT * FROM capacity_audit_events WHERE team_id=? AND resource_id=? AND action='assignment.usage.unresolved'", [teamId, assignmentId]);
			if (audit) {
				const retained: unknown = JSON.parse(String(audit.metadata_json));
				const value = record(retained);
				if (audit.idempotency_key !== key || value.actorId !== actorId || value.reason !== reason
					|| value.expectedStateVersion !== expectedStateVersion) throw new CapacityGovernanceError(
					'capacity_recovery_idempotency_conflict', 'Original unresolved recovery evidence must be replayed unchanged.', 409);
				return value;
			}
			const metadata = record(JSON.parse(String(row.metadata_json ?? '{}')));
			if (!['expired', 'failed', 'cancelled'].includes(String(row.status)) || row.lease_state === 'leased'
				|| row.lease_token || row.lease_expires_at || record(metadata.leaseRecovery).disposition !== 'operator-action')
				throw new CapacityGovernanceError('capacity_recovery_authority_conflict', 'Only a terminal assignment held for operator action can release unresolved capacity.', 409);
			if (row.state_version !== expectedStateVersion) throw new CapacityGovernanceError(
				'capacity_recovery_version_conflict', 'Assignment state version moved.', 409);
			const reservation = await database.first('SELECT * FROM capacity_reservations WHERE id=? AND team_id=? FOR UPDATE', [row.reservation_id, teamId]);
			if (!reservation || reservation.assignment_id !== assignmentId || reservation.membership_id !== row.membership_id
				|| reservation.capacity_provider_id !== row.capacity_provider_id || reservation.project_id !== row.project_id
				|| reservation.execution_provider_id !== row.execution_provider_id
				|| reservation.work_day_id !== row.work_day_id || !['reserved', 'consuming'].includes(String(reservation.state))
				|| reservation.settlement_token || reservation.usage_report_token) throw new CapacityGovernanceError(
				'capacity_recovery_reservation_conflict', 'Original held reservation authority is required.', 409);
			if (await database.first(`SELECT id FROM capacity_usage_actuals WHERE assignment_id=? AND accounting_mode='aggregate'
				UNION ALL SELECT id FROM capacity_ledger_entries WHERE reservation_id=? LIMIT 1`, [assignmentId, reservation.id]))
				throw new CapacityGovernanceError('capacity_recovery_measured_usage_conflict', 'Measured or settled usage must use the existing settlement path.', 409);
			const assignment = await new ProviderAssignmentRepository(database).getForCancellation(teamId, assignmentId);
			if (!assignment) throw new CapacityGovernanceError('capacity_assignment_not_found', 'Assignment disappeared.', 500);
			if (this.closeWorkspace) {
				const closed = record(await this.closeWorkspace(assignment));
				if (closed.closed !== true) throw new CapacityGovernanceError('capacity_recovery_workspace_open', 'Exact native workspace closure is required.', 409);
			} else if (assignment.workspaceContext?.workspaceId || assignment.treedxProxyHandle?.workspaceId)
				throw new CapacityGovernanceError('capacity_recovery_workspace_unavailable', 'Workspace closure authority is missing.', 503);
			const claims = await database.all(`SELECT claim.*,counter.team_id,counter.committed_amount FROM capacity_reservation_counter_claims claim
				JOIN capacity_admission_counters counter ON counter.id=claim.counter_id WHERE claim.reservation_id=? FOR UPDATE OF claim,counter`, [reservation.id]);
			const retainedClaims = await database.all('SELECT counter_id FROM capacity_reservation_counter_claims WHERE reservation_id=?', [reservation.id]);
			if (retainedClaims.length !== claims.length) throw new CapacityGovernanceError(
				'capacity_recovery_counter_conflict', 'Every original reservation claim must retain its owning counter.', 409);
			const now = new Date().toISOString();
			for (const claim of claims) {
				if (claim.team_id !== teamId) throw new CapacityGovernanceError('capacity_recovery_counter_conflict', 'Counter authority differs from the reservation.', 409);
				if (claim.release_policy !== 'assignment-terminal') continue;
				const amount = Number(claim.reserved_amount) - Number(claim.released_amount);
				if (!Number.isFinite(amount) || amount < 0 || Number(claim.committed_amount) < amount) throw new CapacityGovernanceError(
					'capacity_recovery_counter_conflict', 'Terminal counter release is inconsistent.', 409);
				await database.run(`UPDATE capacity_admission_counters SET committed_amount=committed_amount-?,state_version=state_version+1,updated_at=? WHERE id=? AND team_id=?`, [amount, now, claim.counter_id, teamId]);
				await database.run('UPDATE capacity_reservation_counter_claims SET released_amount=reserved_amount,updated_at=? WHERE reservation_id=? AND counter_id=?', [now, reservation.id, claim.counter_id]);
			}
			await database.run("UPDATE capacity_reservations SET state='released',updated_at=? WHERE id=? AND team_id=?", [now, reservation.id, teamId]);
			const result = { assignmentId, reservationId: String(reservation.id), usageStatus: 'unresolved', settled: false,
				expectedStateVersion, actorId, reason, recoveredAt: now };
			await database.run(`INSERT INTO capacity_audit_events (id,team_id,capacity_provider_id,membership_id,actor_type,actor_id,action,resource_type,resource_id,idempotency_key,metadata_json,created_at)
				VALUES (?,?,?,?,?,?,'assignment.usage.unresolved','capacity_provider_assignment',?,?,?,?)`,
				[`operator-recovery:${teamId}:${assignmentId}`, teamId, row.capacity_provider_id, row.membership_id, 'user', actorId, assignmentId, key, JSON.stringify(result), now]);
			return result;
		});
	}

	async cancel(teamId: string, assignmentId: string, input: { idempotencyKey: string; actorId?: string | null; reason?: string | null }) {
		await this.database.ensureInitialized();
		const operationKey = idempotencyKey(input.idempotencyKey);
		let assignment = await this.assignments.getForCancellation(teamId, assignmentId);
		if (!assignment) throw new CapacityGovernanceError('capacity_assignment_not_found', 'Assignment does not exist.', 404, { assignmentId });
		if (assignment.status === 'leased' && assignment.leaseState === 'leased') {
			const now = new Date().toISOString(), metadata = { ...(assignment.metadata ?? {}), cancellationRequested: true,
				cancellationReason: 'operator_cancelled', cancellationRequestedAt: now, cancellationRequestedBy: input.actorId ?? null };
			const requested = await this.database.first(
				`UPDATE capacity_provider_assignments SET metadata_json = ?, lifecycle_code = 'operator_cancellation_requested', lifecycle_reason = ?, state_version = state_version + 1, updated_at = ? WHERE id = ? AND team_id = ? AND state_version = ? AND status = 'leased' AND lease_state = 'leased' RETURNING id`,
				[JSON.stringify(metadata), input.reason ?? 'Assignment cancellation requested by a team operator.', now, assignmentId, teamId, assignment.stateVersion],
			);
			if (!requested) throw new CapacityGovernanceError('capacity_assignment_cancel_conflict', 'Assignment changed during cancellation.', 409, { assignmentId });
			const cancelling = await this.assignments.getForCancellation(teamId, assignmentId);
			if (!cancelling) throw new CapacityGovernanceError('capacity_assignment_not_found', 'Assignment disappeared during cancellation.', 500, { assignmentId });
			return cancelling;
		}
		const failedCleanup = assignment.status === 'failed' && assignment.leaseState === 'released';
		if (assignment.status !== 'cancelled' && !failedCleanup && (!['pending', 'returned', 'expired'].includes(assignment.status) || !['unleased', 'released', 'expired'].includes(assignment.leaseState))) throw new CapacityGovernanceError(
			'capacity_assignment_active_lease_conflict', 'An active or terminal assignment cannot be safely cancelled.', 409,
			{ assignmentId, status: assignment.status, leaseState: assignment.leaseState },
		);
		if (!assignment.reservationId || !assignment.membershipId) throw new CapacityGovernanceError('capacity_assignment_admission_provenance_missing', 'Assignment lacks reservation provenance.', 500, { assignmentId });
		const reservationId = assignment.reservationId;
		const now = new Date().toISOString();
		// Reuse the owning terminal measurement contract before any cancellation
		// mutation. A released lease does not prove that execution never started.
		const settledUsage = await this.database.first(
			`SELECT active_seconds, elapsed_seconds, input_tokens, cached_input_tokens, reasoning_tokens, output_tokens, actual_usd FROM capacity_usage_actuals WHERE id = ? AND assignment_id = ? AND accounting_mode = 'aggregate' LIMIT 1`,
			[`usage:${assignment.id}:${assignment.attemptCount}:aggregate`, assignment.id]);
		terminalPerformance(assignment, { completion: { disposition: 'cancelled' } }, 'failed', now, record(settledUsage));
		if (assignment.status !== 'cancelled' && !failedCleanup) {
			const phaseCancelled = await planningBoundaryCancellation(this.database, assignment, { code: 'operator_cancelled' }, now);
			const code = phaseCancelled ? 'planning_boundary_cancelled' : 'operator_cancelled';
			const reason = phaseCancelled ? 'Unfinished planning turn cancelled at its authoritative phase boundary.'
				: input.reason ?? 'Assignment cancelled by a team operator.';
			const priorOutput = record(assignment.lifecycleOutput);
			const terminalInput = { code, reason, completion: { disposition: 'cancelled' as const }, output: priorOutput };
			const output = phaseCancelled ? composeAssignmentLifecycleOutput(terminalInput,
				terminalPerformance(assignment, terminalInput, 'failed', now, record(settledUsage))) : priorOutput;
			// Diagnostic cancellation must retain malformed snapshot bytes rather
			// than manufacturing executable authority for cleanup.
			const attempt = assignment.assignmentAttempt
				? JSON.stringify(advanceAssignmentAttemptLifecycle(assignment.assignmentAttempt, 'cancelled', now)) : null;
			const fenced = await this.database.first(
				`UPDATE capacity_provider_assignments SET status = 'cancelled', assignment_attempt_json = COALESCE(?, assignment_attempt_json), lease_state = 'released', lifecycle_code = ?, lifecycle_reason = ?, failed_at = COALESCE(failed_at, ?), lifecycle_output_json = ?, state_version = state_version + 1, updated_at = ? WHERE id = ? AND team_id = ? AND state_version = ? AND status IN ('pending','returned','expired') AND lease_state IN ('unleased','released','expired') RETURNING id`,
				[attempt, code, reason, now, JSON.stringify(output), now, assignmentId, teamId, assignment.stateVersion],
			);
			if (!fenced) throw new CapacityGovernanceError('capacity_assignment_cancel_conflict', 'Assignment changed during cancellation.', 409, { assignmentId });
			assignment = await this.assignments.getForCancellation(teamId, assignmentId);
			if (!assignment) throw new CapacityGovernanceError('capacity_assignment_not_found', 'Assignment disappeared during cancellation.', 500, { assignmentId });
		}
		const terminalAuthority = terminalAssignmentAuthority(assignment, now);
		await this.database.batch([
			{ query: `UPDATE capacity_provider_assignments SET treedx_proxy_handle_json = ?, workspace_context_json = ?, updated_at = ? WHERE id = ? AND team_id = ? AND status IN ('cancelled','failed')`, params: [JSON.stringify(terminalAuthority.proxyHandle), JSON.stringify(terminalAuthority.workspaceContext), now, assignmentId, teamId] },
			{ query: `UPDATE treedx_proxy_handles SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE assignment_id = ? AND team_id = ?`, params: [now, now, assignmentId, teamId] },
		]);
		if (this.closeWorkspace) await this.closeWorkspace(assignment);
		await releaseCapacityReservationsExactlyOnce(this.database, [{
			settlementKey: `operator-cancel:${teamId}:${operationKey}`, teamId, membershipId: assignment.membershipId,
			reservationId, assignmentId, activeSeconds: 0, elapsedSeconds: 0, source: 'operator_assignment_cancel',
			existingSettlementPolicy: 'replay', metadata: { actorId: input.actorId ?? null, reason: input.reason ?? null },
		}]);
		await this.database.batch([
			...(assignment.executionNodeId ? [{ query: `UPDATE execution_nodes SET status='cancelled',updated_at=?
				WHERE team_id=? AND id=? AND node_revision=?
				AND EXISTS (SELECT 1 FROM capacity_provider_assignments WHERE id=? AND team_id=?)`,
				params: [now, teamId, assignment.executionNodeId, assignment.executionNodeRevision, assignmentId, teamId] }] : []),
		]);
		const cancelled = await this.assignments.getForCancellation(teamId, assignmentId);
		const expectedStatus = failedCleanup ? 'failed' : 'cancelled';
		if (!cancelled || cancelled.status !== expectedStatus) throw new CapacityGovernanceError('capacity_assignment_cancel_conflict', 'Assignment changed during cancellation.', 409, { assignmentId });
		return cancelled;
	}

	async requeue(teamId: string, assignmentId: string, input: { idempotencyKey: string; actorId?: string | null; reason?: string | null }) {
		await this.database.ensureInitialized();
		idempotencyKey(input.idempotencyKey);
		const assignment = await this.assignments.get(teamId, assignmentId);
		if (!assignment) throw new CapacityGovernanceError('capacity_assignment_not_found', 'Assignment does not exist.', 404, { assignmentId });
		if (!['returned', 'failed', 'expired', 'cancelled'].includes(assignment.status) || assignment.leaseState === 'leased') throw new CapacityGovernanceError(
			'capacity_assignment_requeue_unsafe', 'Only a released returned, failed, expired, or cancelled assignment can be requeued.', 409,
			{ assignmentId, status: assignment.status, leaseState: assignment.leaseState },
		);
		if (assignment.executionNodeId) {
			const now = new Date().toISOString();
			const retryMetadata = { ...(assignment.metadata ?? {}), operatorRetry: {
				requestedAt: now, requestedBy: input.actorId ?? null, reason: input.reason ?? null,
			} };
			const reopened = await this.database.first(`WITH target AS (
				SELECT team_id,id,project_id,work_item_id,pair_role,source_ref_json,authority_refs_json,node_revision,status
				FROM execution_nodes WHERE team_id=? AND id=? AND node_revision>=? FOR UPDATE
			), marked_assignment AS (
				UPDATE capacity_provider_assignments terminal SET metadata_json=?,state_version=state_version+1,updated_at=?
				FROM target WHERE terminal.id=? AND terminal.team_id=? AND terminal.state_version=?
				AND terminal.status IN ('returned','failed','expired','cancelled') AND terminal.lease_state<>'leased'
				AND (target.status IN ('failed','cancelled') OR (target.status='ready' AND EXISTS (
					SELECT 1 FROM capacity_provider_assignments prior WHERE prior.team_id=target.team_id
					AND prior.execution_node_id=target.id AND prior.execution_node_revision=target.node_revision
					AND prior.status IN ('completed','failed','cancelled','expired')
				)))
				AND NOT EXISTS (SELECT 1 FROM capacity_provider_assignments active WHERE active.team_id=target.team_id
					AND active.execution_node_id=target.id AND active.execution_node_revision=target.node_revision
					AND active.status IN ('pending','leased','running'))
				RETURNING terminal.id
			), reopened AS (
				UPDATE execution_nodes node SET status='ready',node_revision=node.node_revision+1,updated_at=?
				FROM target,marked_assignment WHERE node.team_id=target.team_id AND node.id=target.id
				RETURNING node.team_id,node.project_id,node.work_item_id,node.pair_role,node.source_ref_json,node.authority_refs_json,node.node_revision,node.status
			), paired_reviewer AS (
				UPDATE execution_nodes reviewer SET status='blocked',node_revision=GREATEST(reviewer.node_revision,reopened.node_revision),updated_at=?
				FROM reopened WHERE reopened.pair_role='actor'
				AND reviewer.team_id=reopened.team_id AND reviewer.project_id=reopened.project_id
				AND reviewer.work_item_id=reopened.work_item_id AND reviewer.pair_role='reviewer'
				AND reviewer.source_ref_json=reopened.source_ref_json AND reviewer.authority_refs_json=reopened.authority_refs_json
				RETURNING reviewer.id
			) SELECT node_revision,status FROM reopened`,
				[teamId, assignment.executionNodeId, assignment.executionNodeRevision,
					JSON.stringify(retryMetadata), now, assignment.id, teamId, assignment.stateVersion, now, now]);
			if (!reopened) {
				const current = await this.database.first('SELECT node_revision,status FROM execution_nodes WHERE team_id=? AND id=? LIMIT 1',
					[teamId, assignment.executionNodeId]);
				if (String(current?.status ?? '') !== 'ready') throw new CapacityGovernanceError(
					'capacity_assignment_requeue_conflict',
					`The execution node could not be reopened for a bounded retry; current state is ${String(current?.status ?? 'missing')} at revision ${String(current?.node_revision ?? 'unknown')}.`, 409,
					{ assignmentId, executionNodeId: assignment.executionNodeId,
						nodeRevision: current?.node_revision ?? null, nodeStatus: current?.status ?? null },
				);
			}
			return { assignment, demand: null, alreadyLeasable: false };
		}
		throw new CapacityGovernanceError('capacity_assignment_graph_provenance_required',
			'Only a living-graph assignment can be requeued; this assignment has no execution node.', 409, { assignmentId });
	}
}

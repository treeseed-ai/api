import { createHash } from 'node:crypto';
import type { CapacityGovernanceDatabase } from '../../../../database.ts';
import { CapacityGovernanceError } from '../../../../database.ts';
import { ProviderAssignmentRepository } from '../../../../repositories/capacity/assignments/assignment.ts';
import { CapacityWorkdayDemandRepository, serializeCapacityWorkdayDemandRow } from '../../../../repositories/capacity/workdays/workday-demand.ts';
import { releaseCapacityReservationsExactlyOnce } from '../../accounting/settlement-service.ts';

function id(value: string) { return `demand_${createHash('sha256').update(value).digest('base64url').slice(0, 32)}`; }
function idempotencyKey(value: string) {
	if (!value.trim()) throw new CapacityGovernanceError('capacity_idempotency_key_required', 'An idempotency key is required.', 400);
	return value.trim();
}

export class OperatorAssignmentService {
	private readonly assignments: ProviderAssignmentRepository;
	private readonly demands: CapacityWorkdayDemandRepository;
	constructor(private readonly database: CapacityGovernanceDatabase) {
		this.assignments = new ProviderAssignmentRepository(database);
		this.demands = new CapacityWorkdayDemandRepository(database);
	}

	async cancel(teamId: string, assignmentId: string, input: { idempotencyKey: string; actorId?: string | null; reason?: string | null }) {
		await this.database.ensureInitialized();
		const operationKey = idempotencyKey(input.idempotencyKey);
		let assignment = await this.assignments.get(teamId, assignmentId);
		if (!assignment) throw new CapacityGovernanceError('capacity_assignment_not_found', 'Assignment does not exist.', 404, { assignmentId });
		if (assignment.status !== 'cancelled' && (!['pending', 'returned', 'expired'].includes(assignment.status) || !['unleased', 'released', 'expired'].includes(assignment.leaseState))) throw new CapacityGovernanceError(
			'capacity_assignment_active_lease_conflict', 'An active or terminal assignment cannot be safely cancelled.', 409,
			{ assignmentId, status: assignment.status, leaseState: assignment.leaseState },
		);
		if (!assignment.reservationId || !assignment.membershipId) throw new CapacityGovernanceError('capacity_assignment_admission_provenance_missing', 'Assignment lacks reservation provenance.', 500, { assignmentId });
		const now = new Date().toISOString();
		if (assignment.status !== 'cancelled') {
			const fenced = await this.database.first(
				`UPDATE capacity_provider_assignments SET status = 'cancelled', lease_state = 'released', lifecycle_code = 'operator_cancelled', lifecycle_reason = ?, state_version = state_version + 1, updated_at = ? WHERE id = ? AND team_id = ? AND state_version = ? AND status IN ('pending','returned','expired') AND lease_state IN ('unleased','released','expired') RETURNING id`,
				[input.reason ?? 'Assignment cancelled by a team operator.', now, assignmentId, teamId, assignment.stateVersion],
			);
			if (!fenced) throw new CapacityGovernanceError('capacity_assignment_cancel_conflict', 'Assignment changed during cancellation.', 409, { assignmentId });
			assignment = await this.assignments.get(teamId, assignmentId);
			if (!assignment) throw new CapacityGovernanceError('capacity_assignment_not_found', 'Assignment disappeared during cancellation.', 500, { assignmentId });
		}
		await releaseCapacityReservationsExactlyOnce(this.database, [{
			settlementKey: `operator-cancel:${teamId}:${operationKey}`, teamId, membershipId: assignment.membershipId,
			reservationId: assignment.reservationId, assignmentId, actualCredits: 0, source: 'operator_assignment_cancel',
			existingSettlementPolicy: 'replay', metadata: { actorId: input.actorId ?? null, reason: input.reason ?? null },
		}]);
		await this.database.batch([
			{ query: `UPDATE capacity_workday_demands SET status = 'cancelled', completed_at = ?, updated_at = ? WHERE assignment_id = ? AND status = 'admitted'`, params: [now, now, assignmentId] },
			{ query: `UPDATE capacity_workday_participation_entries SET status = 'blocked', reason_code = 'operator_cancelled', covered_at = ?, updated_at = ? WHERE assignment_id = ? AND status = 'assigned'`, params: [now, now, assignmentId] },
		]);
		const cancelled = await this.assignments.get(teamId, assignmentId);
		if (!cancelled || cancelled.status !== 'cancelled') throw new CapacityGovernanceError('capacity_assignment_cancel_conflict', 'Assignment changed during cancellation.', 409, { assignmentId });
		return cancelled;
	}

	async requeue(teamId: string, assignmentId: string, input: { idempotencyKey: string; actorId?: string | null; reason?: string | null }) {
		await this.database.ensureInitialized();
		const operationKey = idempotencyKey(input.idempotencyKey);
		const assignment = await this.assignments.get(teamId, assignmentId);
		if (!assignment) throw new CapacityGovernanceError('capacity_assignment_not_found', 'Assignment does not exist.', 404, { assignmentId });
		if (assignment.status === 'returned' && assignment.leaseState === 'released') return { assignment, demand: null, alreadyLeasable: true };
		if (!['failed', 'expired', 'cancelled'].includes(assignment.status) || assignment.leaseState === 'leased') throw new CapacityGovernanceError(
			'capacity_assignment_requeue_unsafe', 'Only a released failed, expired, or cancelled assignment can be requeued.', 409,
			{ assignmentId, status: assignment.status, leaseState: assignment.leaseState },
		);
		if (assignment.reservationId) {
			const reservation = await this.database.first(`SELECT state FROM capacity_reservations WHERE id = ? AND team_id = ? LIMIT 1`, [assignment.reservationId, teamId]);
			if (!reservation || !['consumed', 'released'].includes(String(reservation.state ?? ''))) throw new CapacityGovernanceError(
				'capacity_assignment_recovery_decision_required',
				'Assignment recovery must resolve its original reservation before creating replacement demand.',
				409,
				{ assignmentId, reservationId: assignment.reservationId, reservationState: reservation?.state ?? null },
			);
		}
		const original = serializeCapacityWorkdayDemandRow(await this.database.first(
			`SELECT * FROM capacity_workday_demands WHERE team_id = ? AND assignment_id = ? LIMIT 1`, [teamId, assignmentId],
		));
		if (!original) throw new CapacityGovernanceError('capacity_assignment_demand_missing', 'Assignment has no canonical demand provenance.', 409, { assignmentId });
		const now = new Date().toISOString();
		const retryKey = `requeue:${original.id}:${operationKey}`;
		const demand = await this.demands.create({
			id: id(retryKey), teamId, projectId: original.projectId, workdayRunId: original.workdayRunId,
			workdayId: original.workdayId, sourceType: original.sourceType, sourceId: original.sourceId,
			mode: original.mode, projectAgentClassId: original.projectAgentClassId, agentId: original.agentId,
			handlerId: original.handlerId, activityType: original.activityType, decisionId: original.decisionId,
			capacityPlanId: original.capacityPlanId, priority: original.priority, requestedCredits: original.requestedCredits,
			idempotencyKey: retryKey, payload: original.payload,
			metadata: { ...original.metadata, requeuedFromAssignmentId: assignmentId, actorId: input.actorId ?? null, reason: input.reason ?? null },
			availableAt: now, now,
		});
		return { assignment, demand, alreadyLeasable: false };
	}
}

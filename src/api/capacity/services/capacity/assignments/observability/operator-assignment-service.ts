import type { CapacityGovernanceDatabase } from '../../../../database.ts';
import { CapacityGovernanceError } from '../../../../database.ts';
import { ProviderAssignmentRepository } from '../../../../repositories/capacity/assignments/assignment.ts';
import type { DurableProviderAssignment } from '../../../../repositories/capacity/assignments/assignment.ts';
import { releaseCapacityReservationsExactlyOnce } from '../../accounting/settlement-service.ts';
import { terminalAssignmentAuthority } from '../lifecycle/assignment-terminal-authority.ts';

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
		const now = new Date().toISOString();
		if (assignment.status !== 'cancelled' && !failedCleanup) {
			const fenced = await this.database.first(
				`UPDATE capacity_provider_assignments SET status = 'cancelled', lease_state = 'released', lifecycle_code = 'operator_cancelled', lifecycle_reason = ?, state_version = state_version + 1, updated_at = ? WHERE id = ? AND team_id = ? AND state_version = ? AND status IN ('pending','returned','expired') AND lease_state IN ('unleased','released','expired') RETURNING id`,
				[input.reason ?? 'Assignment cancelled by a team operator.', now, assignmentId, teamId, assignment.stateVersion],
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
			reservationId: assignment.reservationId, assignmentId, activeSeconds: 0, elapsedSeconds: 0, source: 'operator_assignment_cancel',
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
			const reopened = await this.database.first(`UPDATE execution_nodes SET status='ready',node_revision=node_revision+1,updated_at=?
				WHERE team_id=? AND id=? AND node_revision>=? AND status IN ('failed','cancelled')
				AND NOT EXISTS (SELECT 1 FROM capacity_provider_assignments active WHERE active.team_id=?
					AND active.execution_node_id=execution_nodes.id AND active.execution_node_revision=execution_nodes.node_revision
					AND active.status IN ('pending','leased','running'))
				RETURNING node_revision,status`,
				[now, teamId, assignment.executionNodeId, assignment.executionNodeRevision,
					teamId]);
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

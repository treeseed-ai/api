import { createHash } from 'node:crypto';
import type { CapacityDatabaseOperation,CapacityGovernanceDatabase } from '../../../../database.ts';
import { ProviderAssignmentRepository,serializeProviderAssignmentRow,type DurableProviderAssignment } from '../../../../repositories/capacity/assignments/assignment.ts';
import { settleCapacityReservationExactlyOnce } from '../../accounting/settlement-service.ts';
import { teamSupplyPolicy } from '../../../../domain/supply-policy.ts';
import { terminalAssignmentAuthority } from './assignment-terminal-authority.ts';
import { recoverOperationHandoff } from '../handoffs/operation-handoff-lifecycle-service.ts';
import { capacityTransaction } from '../../../../transaction.ts';

type RecoveryDisposition = 'safe-retry' | 'terminal-failure' | 'completed' | 'operator-action';

export interface AssignmentRecoveryResult {
	assignmentId: string;
	disposition: RecoveryDisposition;
	status: 'returned' | 'failed' | 'completed' | 'expired';
	reasonCode: string;
}

export interface AssignmentRecoverySummary {
	scanned: number;
	recovered: number;
	safeRetries: number;
	terminalFailures: number;
	completed: number;
	operatorActions: number;
	results: AssignmentRecoveryResult[];
}

interface RecoveryScope {
	teamId?: string | null;
	providerId?: string | null;
	now?: string;
	limit?: number;
}

export function recoverableLeaseSql(alias = ''): string {
	const column = (name: string) => `${alias ? `${alias}.` : ''}${name}`;
	return `(${column('lease_expires_at')} IS NOT NULL AND ${column('lease_expires_at')} <= ? OR (${column('provider_session_id')} IS NOT NULL AND EXISTS (SELECT 1 FROM capacity_provider_availability_sessions recovery_session WHERE recovery_session.id = ${column('provider_session_id')} AND recovery_session.status IN ('closed','expired'))))`;
}

export interface RecoveryEvidence {
	reservation: Record<string, unknown> | null;
	settlement: Record<string, unknown> | null;
	usageCount: number;
	hasAssignmentResult: boolean;
	proxyEvents: number;
	fallbackOutputs: number;
	node: Record<string, unknown> | null;
	failoverAllowed: boolean;
	failoverCount: number;
	invocationFinalMessageRef: string | null;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function retryLimit(assignment: DurableProviderAssignment) {
	const metadata = record(assignment.metadata);
	const envelope = record(record(assignment.capacityEnvelope).metadata);
	const configured = Number(record(metadata.retryPolicy).maxAttempts ?? envelope.maxAttempts ?? 3);
	return Number.isFinite(configured) ? Math.max(1, Math.min(Math.floor(configured), 20)) : 3;
}

async function evidence(database: CapacityGovernanceDatabase, assignment: DurableProviderAssignment): Promise<RecoveryEvidence> {
	const [reservation, settlement, usage, proxy, fallback, node, attempts, run, team, invocation] = await Promise.all([
		assignment.reservationId ? database.first(`SELECT * FROM capacity_reservations WHERE id = ? AND team_id = ? LIMIT 1`, [assignment.reservationId, assignment.teamId]) : Promise.resolve(null),
		assignment.reservationId ? database.first(`SELECT * FROM capacity_ledger_entries WHERE reservation_id = ? AND phase = 'task_completed_actual_settlement' LIMIT 1`, [assignment.reservationId]) : Promise.resolve(null),
		database.first(`SELECT COUNT(*) AS total FROM capacity_usage_actuals WHERE assignment_id = ?`, [assignment.id]),
		database.first(`SELECT COUNT(*) AS total FROM treedx_project_proxy_audit WHERE assignment_id = ?`, [assignment.id]),
		database.first(`SELECT COUNT(*) AS total FROM agent_fallback_outputs WHERE assignment_id = ?`, [assignment.id]),
		assignment.executionNodeId ? database.first(`SELECT id,status,node_revision FROM execution_nodes WHERE id=? AND team_id=? LIMIT 1`, [assignment.executionNodeId, assignment.teamId]) : Promise.resolve(null),
		assignment.executionNodeId ? database.first(`SELECT COUNT(*) AS total FROM capacity_provider_assignments WHERE team_id=? AND execution_node_id=?`, [assignment.teamId, assignment.executionNodeId]) : Promise.resolve(null),
		assignment.workDayId ? database.first(`SELECT status FROM capacity_workday_runs WHERE id=? AND team_id=? LIMIT 1`, [assignment.workDayId, assignment.teamId]) : Promise.resolve(null),
		database.first(`SELECT metadata_json FROM teams WHERE id = ? LIMIT 1`, [assignment.teamId]),
		assignment.invocationId ? database.first(`SELECT final_message_ref FROM agent_invocation_requests WHERE id = ? AND team_id = ? LIMIT 1`, [assignment.invocationId,assignment.teamId]) : Promise.resolve(null),
	]);
	const failoverCount = Math.max(0, Number(attempts?.total ?? 0));
	const policy = teamSupplyPolicy(team);
	const failoverAllowed = Boolean(run?.status === 'running' && node && ['assigned','running'].includes(String(node.status))
		&& Number(node.node_revision) === assignment.executionNodeRevision && failoverCount <= policy.maxFailovers)
		&& (assignment.mode === 'acting' ? policy.allowActingFailover : policy.allowPlanningFailover);
	return {
		reservation,
		settlement,
		usageCount: Number(usage?.total ?? 0),
		hasAssignmentResult: Boolean(assignment.assignmentResult),
		proxyEvents: Number(proxy?.total ?? 0),
		fallbackOutputs: Number(fallback?.total ?? 0),
		node,
		failoverAllowed,
		failoverCount,
		invocationFinalMessageRef: typeof invocation?.final_message_ref === 'string' && invocation.final_message_ref.trim() ? invocation.final_message_ref.trim() : null,
	};
}

export function decideAssignmentRecovery(assignment: DurableProviderAssignment, observed: RecoveryEvidence): AssignmentRecoveryResult {
	if (assignment.executionKind === 'conversation' && !observed.invocationFinalMessageRef) return { assignmentId: assignment.id, disposition: 'terminal-failure', status: 'failed', reasonCode: 'expired_communication_final_response_missing' };
	if (observed.settlement) {
		const settlementSource = String(observed.settlement.source ?? '');
		if (settlementSource === 'expired_lease_recovery' || settlementSource === 'provider_assignment_fail') return { assignmentId: assignment.id, disposition: 'terminal-failure', status: 'failed', reasonCode: settlementSource === 'provider_assignment_fail' ? 'provider_failure_settlement_recovered' : 'expired_lease_terminal_settlement_recovered' };
		if (observed.hasAssignmentResult) return { assignmentId: assignment.id, disposition: 'operator-action', status: 'expired', reasonCode: 'expired_lease_completion_requires_graph_reconciliation' };
		return { assignmentId: assignment.id, disposition: 'operator-action', status: 'expired', reasonCode: 'expired_lease_settlement_without_success_evidence' };
	}
	if (observed.reservation && (observed.reservation.settlement_token || observed.reservation.usage_report_token)) return { assignmentId: assignment.id, disposition: 'operator-action', status: 'expired', reasonCode: 'expired_lease_financial_transition_uncertain' };
	if (observed.usageCount > 0 || observed.hasAssignmentResult || observed.proxyEvents > 0 || observed.fallbackOutputs > 0) return { assignmentId: assignment.id, disposition: 'operator-action', status: 'expired', reasonCode: 'expired_lease_side_effect_evidence_present' };
	// A retry admits a new immutable assignment for the same graph node. The
	// current assignment's attempt_count therefore cannot bound that sequence.
	if (observed.failoverCount >= retryLimit(assignment)) return { assignmentId: assignment.id, disposition: 'terminal-failure', status: 'failed', reasonCode: 'expired_lease_retry_exhausted' };
	if (!observed.failoverAllowed) return { assignmentId: assignment.id, disposition: 'terminal-failure', status: 'failed', reasonCode: 'expired_lease_failover_not_allowed' };
	return { assignmentId: assignment.id, disposition: 'safe-retry', status: 'failed', reasonCode: 'expired_lease_requeued' };
}

function transitionOperations(assignment: DurableProviderAssignment, result: AssignmentRecoveryResult, observed: RecoveryEvidence, now: string, recoveryTrigger: 'lease-expired' | 'provider-session-closed'): CapacityDatabaseOperation[] {
	const leaseState = result.status === 'expired' ? 'expired' : 'released';
	const metadata = { ...record(assignment.metadata), leaseRecovery: { disposition: result.disposition, reasonCode: result.reasonCode, recoveryTrigger, expiredAt: assignment.leaseExpiresAt, recoveredAt: now, priorRunnerId: assignment.runnerId ?? null, priorStateVersion: assignment.stateVersion } };
	const auditId = `audit:lease-recovery:${createHash('sha256').update(`${assignment.id}:${assignment.stateVersion}`).digest('base64url')}`;
	const idempotencyKey = `lease-recovery:${assignment.id}:${assignment.stateVersion}`;
	const terminalAuthority = terminalAssignmentAuthority(assignment, now);
	const operations: CapacityDatabaseOperation[] = [
		{ query: `UPDATE capacity_provider_assignments SET status = ?, lease_state = ?, lease_token = NULL, lease_expires_at = NULL, lease_renewed_at = NULL, runner_id = NULL, attempt_count = attempt_count + 1, state_version = state_version + 1, returned_at = CASE WHEN ? = 'returned' THEN ? ELSE returned_at END, failed_at = CASE WHEN ? IN ('failed','expired') THEN COALESCE(failed_at, ?) ELSE failed_at END, completed_at = CASE WHEN ? = 'completed' THEN COALESCE(completed_at, ?) ELSE completed_at END, lifecycle_code = ?, lifecycle_reason = ?, metadata_json = ?, treedx_proxy_handle_json = ?, workspace_context_json = ?, updated_at = ? WHERE id = ? AND team_id = ? AND state_version = ? AND status = 'leased' AND lease_state = 'leased' AND ${recoverableLeaseSql()}`, params: [result.status, leaseState, result.status, now, result.status, now, result.status, now, result.reasonCode, `Lease recovery classified the assignment as ${result.disposition} after ${recoveryTrigger}.`, JSON.stringify(metadata), JSON.stringify(terminalAuthority.proxyHandle), JSON.stringify(terminalAuthority.workspaceContext), now, assignment.id, assignment.teamId, assignment.stateVersion, now] },
		{ query: `UPDATE treedx_proxy_handles SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE assignment_id = ? AND team_id = ? AND EXISTS (SELECT 1 FROM capacity_provider_assignments WHERE id = ? AND team_id = ? AND state_version = ? AND status = ?)`, params: [now, now, assignment.id, assignment.teamId, assignment.id, assignment.teamId, assignment.stateVersion + 1, result.status] },
		{ query: `INSERT INTO capacity_audit_events (id, team_id, capacity_provider_id, membership_id, actor_type, actor_id, action, resource_type, resource_id, request_id, idempotency_key, metadata_json, created_at) SELECT ?, ?, ?, ?, 'service', 'capacity-assignment-recovery', ?, 'capacity-provider-assignment', ?, NULL, ?, ?, ? WHERE EXISTS (SELECT 1 FROM capacity_provider_assignments WHERE id = ? AND team_id = ? AND state_version = ? AND status = ? AND lifecycle_code = ?) ON CONFLICT DO NOTHING`, params: [auditId, assignment.teamId, assignment.capacityProviderId, assignment.membershipId, `capacity-assignment.recovery.${result.disposition}`, assignment.id, idempotencyKey, JSON.stringify({ reasonCode: result.reasonCode, priorLeaseExpiresAt: assignment.leaseExpiresAt, recoveredStateVersion: assignment.stateVersion + 1 }), now, assignment.id, assignment.teamId, assignment.stateVersion + 1, result.status, result.reasonCode] },
	];
	if (result.disposition === 'safe-retry' && observed.node) {
		operations.push(
			{ query: `UPDATE execution_nodes SET status='ready',node_revision=node_revision+1,updated_at=?
				WHERE team_id=? AND id=? AND node_revision=? AND status IN ('assigned','running')
				AND EXISTS (SELECT 1 FROM capacity_provider_assignments WHERE id=? AND team_id=? AND state_version=? AND status='failed')`,
				params: [now, assignment.teamId, assignment.executionNodeId, assignment.executionNodeRevision,
					assignment.id, assignment.teamId, assignment.stateVersion + 1] },
		);
	} else if (result.status !== 'returned') {
		const nodeStatus = result.status === 'completed'
			? 'completed'
			: assignment.executionKind === 'conversation' && result.disposition === 'terminal-failure'
				? 'cancelled'
				: 'failed';
		operations.push(
			...(assignment.executionNodeId ? [{ query: `UPDATE execution_nodes SET status=?,updated_at=?
				WHERE team_id=? AND id=? AND node_revision=? AND status IN ('assigned','running')
				AND EXISTS (SELECT 1 FROM capacity_provider_assignments WHERE id=? AND team_id=? AND state_version=? AND status=?)`,
				params: [nodeStatus, now, assignment.teamId, assignment.executionNodeId, assignment.executionNodeRevision,
					assignment.id, assignment.teamId, assignment.stateVersion + 1, result.status] }] : []),
		);
	}
	if (assignment.invocationId && result.disposition !== 'safe-retry') operations.push({
		query: `UPDATE agent_invocation_requests SET status=?,assignment_id=?,completed_at=COALESCE(completed_at,?),blocking_state_json=?,updated_at=? WHERE id=? AND team_id=? AND status IN ('admitted','running')`,
		params: [result.status === 'completed' ? 'completed' : 'failed',assignment.id,now,JSON.stringify({ code: result.reasonCode, assignmentStatus: result.status }),now,assignment.invocationId,assignment.teamId],
	});
	return operations;
}

async function recoverOne(database: CapacityGovernanceDatabase, assignment: DurableProviderAssignment, now: string) {
	return capacityTransaction(database, async transaction => {
		await transaction.run('SELECT id FROM capacity_provider_assignments WHERE id=? AND team_id=? FOR UPDATE', [assignment.id, assignment.teamId]);
		const current = await new ProviderAssignmentRepository(transaction).get(assignment.teamId, assignment.id);
		if (!current || current.stateVersion !== assignment.stateVersion || current.status !== 'leased' || current.leaseState !== 'leased') return null;
		return recoverLocked(transaction, current, now);
	});
}

async function recoverLocked(database: CapacityGovernanceDatabase, assignment: DurableProviderAssignment, now: string) {
	const observed = await evidence(database, assignment);
	const result = decideAssignmentRecovery(assignment, observed);
	const leaseExpiry = assignment.leaseExpiresAt ? Date.parse(assignment.leaseExpiresAt) : Number.NaN;
	const recoveryTrigger = Number.isFinite(leaseExpiry) && leaseExpiry <= Date.parse(now) ? 'lease-expired' : 'provider-session-closed';
	if (result.disposition === 'terminal-failure' && assignment.reservationId && !observed.settlement) {
		await settleCapacityReservationExactlyOnce(database, { settlementKey: `expired-lease:${assignment.id}:${assignment.stateVersion}`, teamId: assignment.teamId, membershipId: assignment.membershipId, reservationId: assignment.reservationId, assignmentId: assignment.id, assignmentAttempt: assignment.attemptCount, activeSeconds: 0, elapsedSeconds: 0, source: 'expired_lease_recovery', existingSettlementPolicy: 'replay', metadata: { recoveryReasonCode: result.reasonCode } });
	}
	if (result.disposition === 'safe-retry' && assignment.reservationId && !observed.settlement) {
		await settleCapacityReservationExactlyOnce(database, { settlementKey: `failover:${assignment.id}:${assignment.stateVersion}`, teamId: assignment.teamId, membershipId: assignment.membershipId, reservationId: assignment.reservationId, assignmentId: assignment.id, assignmentAttempt: assignment.attemptCount, activeSeconds: 0, elapsedSeconds: 0, source: 'expired_lease_recovery', existingSettlementPolicy: 'replay', metadata: { recoveryReasonCode: result.reasonCode, requeued: true } });
	}
	await database.batch(transitionOperations(assignment, result, observed, now, recoveryTrigger));
	const recovered = await new ProviderAssignmentRepository(database).get(assignment.teamId, assignment.id);
	if (!recovered || recovered.stateVersion !== assignment.stateVersion + 1 || recovered.status !== result.status) return null;
	if (assignment.operationHandoffId) await recoverOperationHandoff(database,assignment.operationHandoffId,assignment.id,{retry:result.disposition==='safe-retry',completed:result.status==='completed'},now);
	return result;
}

export async function recoverExpiredProviderAssignments(database: CapacityGovernanceDatabase, scope: RecoveryScope = {}): Promise<AssignmentRecoverySummary> {
	await database.ensureInitialized();
	const now = scope.now ?? new Date().toISOString();
	const limit = Math.max(1, Math.min(Math.floor(Number(scope.limit ?? 100)), 200));
	const clauses = [`status = 'leased'`, `lease_state = 'leased'`, recoverableLeaseSql()];
	const params: unknown[] = [now];
	if (scope.teamId) { clauses.push('team_id = ?'); params.push(scope.teamId); }
	if (scope.providerId) { clauses.push('capacity_provider_id = ?'); params.push(scope.providerId); }
	const rows = await database.all(`SELECT * FROM capacity_provider_assignments WHERE ${clauses.join(' AND ')} ORDER BY lease_expires_at ASC, id ASC LIMIT ?`, [...params, limit]);
	const results: AssignmentRecoveryResult[] = [];
	for (const row of rows) {
		const assignment = serializeProviderAssignmentRow(row);
		if (!assignment) continue;
		const result = await recoverOne(database, assignment, now);
		if (result) results.push(result);
	}
	return { scanned: rows.length, recovered: results.length, safeRetries: results.filter((item) => item.disposition === 'safe-retry').length, terminalFailures: results.filter((item) => item.disposition === 'terminal-failure').length, completed: results.filter((item) => item.disposition === 'completed').length, operatorActions: results.filter((item) => item.disposition === 'operator-action').length, results };
}

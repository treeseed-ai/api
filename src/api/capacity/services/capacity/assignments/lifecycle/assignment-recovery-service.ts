import { createHash } from 'node:crypto';
import type { CapacityDatabaseOperation,CapacityGovernanceDatabase } from '../../../../database.ts';
import { ProviderAssignmentRepository,serializeProviderAssignmentRow,type DurableProviderAssignment } from '../../../../repositories/capacity/assignments/assignment.ts';
import { settleCapacityReservationExactlyOnce } from '../../accounting/settlement-service.ts';
import { logicalModeRunSql } from '../../../../repositories/support/mode-run.ts';
import { decodeDurableJsonObject } from '../../../../durable-json.ts';
import { teamSupplyPolicy } from '../../../../domain/supply-policy.ts';

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

interface RecoveryEvidence {
	reservation: Record<string, unknown> | null;
	settlement: Record<string, unknown> | null;
	usageCount: number;
	succeededModeRuns: number;
	activeModeRuns: number;
	proxyEvents: number;
	fallbackOutputs: number;
	demand: Record<string, unknown> | null;
	failoverAllowed: boolean;
	failoverCount: number;
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
	const [reservation, settlement, usage, modeRuns, proxy, fallback, demand, team] = await Promise.all([
		assignment.reservationId ? database.first(`SELECT * FROM capacity_reservations WHERE id = ? AND team_id = ? LIMIT 1`, [assignment.reservationId, assignment.teamId]) : Promise.resolve(null),
		assignment.reservationId ? database.first(`SELECT * FROM capacity_ledger_entries WHERE reservation_id = ? AND phase = 'task_completed_actual_settlement' LIMIT 1`, [assignment.reservationId]) : Promise.resolve(null),
		database.first(`SELECT COUNT(*) AS total FROM capacity_usage_actuals WHERE assignment_id = ?`, [assignment.id]),
		database.first(`SELECT COALESCE(SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END), 0) AS succeeded, COALESCE(SUM(CASE WHEN status IN ('queued','running') THEN 1 ELSE 0 END), 0) AS active FROM agent_mode_runs WHERE provider_assignment_id = ? AND ${logicalModeRunSql()}`, [assignment.id]),
		database.first(`SELECT COUNT(*) AS total FROM treedx_project_proxy_audit WHERE assignment_id = ?`, [assignment.id]),
		database.first(`SELECT COUNT(*) AS total FROM agent_fallback_outputs WHERE assignment_id = ?`, [assignment.id]),
		database.first(`SELECT * FROM capacity_workday_demands WHERE assignment_id = ? AND team_id = ? LIMIT 1`, [assignment.id, assignment.teamId]),
		database.first(`SELECT metadata_json FROM teams WHERE id = ? LIMIT 1`, [assignment.teamId]),
	]);
	const demandMetadata = demand ? decodeDurableJsonObject(demand.metadata_json, { owner: 'capacity workday demand', ownerId: String(demand.id), column: 'metadata_json' }) : {};
	const failoverCount = Math.max(0, Number(demandMetadata.failoverCount ?? 0));
	const policy = teamSupplyPolicy(team);
	let failoverAllowed = Boolean(demand) && failoverCount < policy.maxFailovers
		&& (assignment.mode === 'acting' ? policy.allowActingFailover : policy.allowPlanningFailover);
	if (failoverAllowed && assignment.mode === 'acting') {
		const payload = decodeDurableJsonObject(demand!.payload_json, { owner: 'capacity workday demand', ownerId: String(demand!.id), column: 'payload_json' });
		const estimateId = String(payload.estimateId ?? record(payload.decisionInput).estimateId ?? record(record(payload.decisionInput).metadata).estimateId ?? '');
		const [readiness, estimate] = await Promise.all([
			database.first(`SELECT decision_id FROM decision_planning_statuses WHERE decision_id = ? AND project_id = ? AND human_approval_state = 'approved' AND execution_readiness IN ('ready','waived') AND planning_inputs_status IN ('complete','waived') LIMIT 1`, [assignment.decisionId, assignment.projectId]),
			estimateId ? database.first(`SELECT id FROM structured_agent_estimates WHERE id = ? AND team_id = ? AND project_id = ? AND decision_id = ? AND status = 'accepted' LIMIT 1`, [estimateId, assignment.teamId, assignment.projectId, assignment.decisionId]) : Promise.resolve(null),
		]);
		failoverAllowed = Boolean(readiness && estimate);
	}
	return {
		reservation,
		settlement,
		usageCount: Number(usage?.total ?? 0),
		succeededModeRuns: Number(modeRuns?.succeeded ?? 0),
		activeModeRuns: Number(modeRuns?.active ?? 0),
		proxyEvents: Number(proxy?.total ?? 0),
		fallbackOutputs: Number(fallback?.total ?? 0),
		demand,
		failoverAllowed,
		failoverCount,
	};
}

function decide(assignment: DurableProviderAssignment, observed: RecoveryEvidence): AssignmentRecoveryResult {
	if (observed.settlement) {
		const settlementSource = String(observed.settlement.source ?? '');
		if (settlementSource === 'expired_lease_recovery' || settlementSource === 'provider_assignment_fail') return { assignmentId: assignment.id, disposition: 'terminal-failure', status: 'failed', reasonCode: settlementSource === 'provider_assignment_fail' ? 'provider_failure_settlement_recovered' : 'expired_lease_terminal_settlement_recovered' };
		if (observed.succeededModeRuns > 0) return { assignmentId: assignment.id, disposition: 'completed', status: 'completed', reasonCode: 'expired_lease_completion_recovered' };
		return { assignmentId: assignment.id, disposition: 'operator-action', status: 'expired', reasonCode: 'expired_lease_settlement_without_success_evidence' };
	}
	if (observed.reservation && (observed.reservation.settlement_token || observed.reservation.usage_report_token)) return { assignmentId: assignment.id, disposition: 'operator-action', status: 'expired', reasonCode: 'expired_lease_financial_transition_uncertain' };
	if (observed.usageCount > 0 || observed.succeededModeRuns > 0 || observed.proxyEvents > 0 || observed.fallbackOutputs > 0) return { assignmentId: assignment.id, disposition: 'operator-action', status: 'expired', reasonCode: 'expired_lease_side_effect_evidence_present' };
	if (Number(assignment.attemptCount ?? 0) + 1 >= retryLimit(assignment)) return { assignmentId: assignment.id, disposition: 'terminal-failure', status: 'failed', reasonCode: 'expired_lease_retry_exhausted' };
	if (!observed.failoverAllowed) return { assignmentId: assignment.id, disposition: 'terminal-failure', status: 'failed', reasonCode: 'expired_lease_failover_not_allowed' };
	return { assignmentId: assignment.id, disposition: 'safe-retry', status: 'failed', reasonCode: 'expired_lease_requeued' };
}

function transitionOperations(assignment: DurableProviderAssignment, result: AssignmentRecoveryResult, observed: RecoveryEvidence, now: string): CapacityDatabaseOperation[] {
	const leaseState = result.status === 'expired' ? 'expired' : 'released';
	const metadata = { ...record(assignment.metadata), leaseRecovery: { disposition: result.disposition, reasonCode: result.reasonCode, expiredAt: assignment.leaseExpiresAt, recoveredAt: now, priorRunnerId: assignment.runnerId ?? null, priorStateVersion: assignment.stateVersion } };
	const auditId = `audit:lease-recovery:${createHash('sha256').update(`${assignment.id}:${assignment.stateVersion}`).digest('base64url')}`;
	const idempotencyKey = `lease-recovery:${assignment.id}:${assignment.stateVersion}`;
	const operations: CapacityDatabaseOperation[] = [
		{ query: `UPDATE agent_mode_runs SET status = 'failed', failed_at = COALESCE(failed_at, ?), fallback_reason = COALESCE(fallback_reason, ?), updated_at = ? WHERE provider_assignment_id = ? AND status IN ('queued','running') AND ${logicalModeRunSql()} AND EXISTS (SELECT 1 FROM capacity_provider_assignments WHERE id = ? AND state_version = ? AND status = 'leased' AND lease_state = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)`, params: [now, result.reasonCode, now, assignment.id, assignment.id, assignment.stateVersion, now] },
		{ query: `UPDATE capacity_provider_assignments SET status = ?, lease_state = ?, lease_token = NULL, lease_expires_at = NULL, lease_renewed_at = NULL, runner_id = NULL, attempt_count = attempt_count + 1, state_version = state_version + 1, returned_at = CASE WHEN ? = 'returned' THEN ? ELSE returned_at END, failed_at = CASE WHEN ? IN ('failed','expired') THEN COALESCE(failed_at, ?) ELSE failed_at END, completed_at = CASE WHEN ? = 'completed' THEN COALESCE(completed_at, ?) ELSE completed_at END, lifecycle_code = ?, lifecycle_reason = ?, metadata_json = ?, updated_at = ? WHERE id = ? AND team_id = ? AND state_version = ? AND status = 'leased' AND lease_state = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`, params: [result.status, leaseState, result.status, now, result.status, now, result.status, now, result.reasonCode, `Expired lease recovery classified the assignment as ${result.disposition}.`, JSON.stringify(metadata), now, assignment.id, assignment.teamId, assignment.stateVersion, now] },
		{ query: `INSERT INTO capacity_audit_events (id, team_id, capacity_provider_id, membership_id, actor_type, actor_id, action, resource_type, resource_id, request_id, idempotency_key, metadata_json, created_at) SELECT ?, ?, ?, ?, 'service', 'capacity-assignment-recovery', ?, 'capacity-provider-assignment', ?, NULL, ?, ?, ? WHERE EXISTS (SELECT 1 FROM capacity_provider_assignments WHERE id = ? AND team_id = ? AND state_version = ? AND status = ? AND lifecycle_code = ?) ON CONFLICT DO NOTHING`, params: [auditId, assignment.teamId, assignment.capacityProviderId, assignment.membershipId, `capacity-assignment.recovery.${result.disposition}`, assignment.id, idempotencyKey, JSON.stringify({ reasonCode: result.reasonCode, priorLeaseExpiresAt: assignment.leaseExpiresAt, recoveredStateVersion: assignment.stateVersion + 1 }), now, assignment.id, assignment.teamId, assignment.stateVersion + 1, result.status, result.reasonCode] },
	];
	if (result.disposition === 'safe-retry' && observed.demand) {
		const demandMetadata = decodeDurableJsonObject(observed.demand.metadata_json, { owner: 'capacity workday demand', ownerId: String(observed.demand.id), column: 'metadata_json' });
		const failoverHistory = Array.isArray(demandMetadata.failoverHistory) ? demandMetadata.failoverHistory : [];
		operations.push(
			{ query: `UPDATE capacity_workday_demands SET status = 'pending', claim_token = NULL, claimed_at = NULL, assignment_id = NULL, admitted_at = NULL, metadata_json = ?, available_at = ?, updated_at = ? WHERE id = ? AND assignment_id = ? AND status = 'admitted'`, params: [JSON.stringify({ ...demandMetadata, failoverCount: observed.failoverCount + 1, failoverHistory: [...failoverHistory, { assignmentId: assignment.id, capacityProviderId: assignment.capacityProviderId, executionProviderId: assignment.executionProviderId, reasonCode: result.reasonCode, at: now }] }), now, now, observed.demand.id, assignment.id] },
			{ query: `UPDATE capacity_workday_participation_entries SET assignment_id = NULL, reason_code = ?, updated_at = ? WHERE assignment_id = ? AND status = 'assigned'`, params: [result.reasonCode, now, assignment.id] },
		);
	} else if (result.status !== 'returned') {
		const demandStatus = result.status === 'completed' ? 'completed' : 'blocked';
		operations.push(
			{ query: `UPDATE capacity_workday_demands SET status = ?, completed_at = ?, updated_at = ? WHERE assignment_id = ? AND status = 'admitted' AND EXISTS (SELECT 1 FROM capacity_provider_assignments WHERE id = ? AND state_version = ?)`, params: [demandStatus, now, now, assignment.id, assignment.id, assignment.stateVersion + 1] },
			{ query: `UPDATE capacity_workday_participation_entries SET status = ?, reason_code = ?, covered_at = ?, updated_at = ? WHERE assignment_id = ? AND status = 'assigned' AND EXISTS (SELECT 1 FROM capacity_provider_assignments WHERE id = ? AND state_version = ?)`, params: [demandStatus, result.status === 'completed' ? null : result.reasonCode, now, now, assignment.id, assignment.id, assignment.stateVersion + 1] },
		);
	}
	return operations;
}

async function recoverOne(database: CapacityGovernanceDatabase, assignment: DurableProviderAssignment, now: string) {
	const observed = await evidence(database, assignment);
	const result = decide(assignment, observed);
	if (result.disposition === 'terminal-failure' && assignment.reservationId && !observed.settlement) {
		await settleCapacityReservationExactlyOnce(database, { settlementKey: `expired-lease:${assignment.id}:${assignment.stateVersion}`, teamId: assignment.teamId, membershipId: assignment.membershipId, reservationId: assignment.reservationId, assignmentId: assignment.id, assignmentAttempt: assignment.attemptCount, activeSeconds: 0, elapsedSeconds: 0, source: 'expired_lease_recovery', existingSettlementPolicy: 'replay', metadata: { recoveryReasonCode: result.reasonCode } });
	}
	if (result.disposition === 'safe-retry' && assignment.reservationId && !observed.settlement) {
		await settleCapacityReservationExactlyOnce(database, { settlementKey: `failover:${assignment.id}:${assignment.stateVersion}`, teamId: assignment.teamId, membershipId: assignment.membershipId, reservationId: assignment.reservationId, assignmentId: assignment.id, assignmentAttempt: assignment.attemptCount, activeSeconds: 0, elapsedSeconds: 0, source: 'expired_lease_recovery', existingSettlementPolicy: 'replay', metadata: { recoveryReasonCode: result.reasonCode, requeued: true } });
	}
	await database.batch(transitionOperations(assignment, result, observed, now));
	const recovered = await new ProviderAssignmentRepository(database).get(assignment.teamId, assignment.id);
	if (!recovered || recovered.stateVersion !== assignment.stateVersion + 1 || recovered.status !== result.status) return null;
	return result;
}

export async function recoverExpiredProviderAssignments(database: CapacityGovernanceDatabase, scope: RecoveryScope = {}): Promise<AssignmentRecoverySummary> {
	await database.ensureInitialized();
	const now = scope.now ?? new Date().toISOString();
	const limit = Math.max(1, Math.min(Math.floor(Number(scope.limit ?? 100)), 200));
	const clauses = [`status = 'leased'`, `lease_state = 'leased'`, `lease_expires_at IS NOT NULL`, `lease_expires_at <= ?`];
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

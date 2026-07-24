import { randomUUID } from 'node:crypto';
import type { CapacityDatabaseOperation, CapacityGovernanceDatabase } from '../../../database.ts';
import { CapacityGovernanceError } from '../../../database.ts';
import { isUniqueConstraintViolation } from '../../../database-errors.ts';
import type { CapacityUsageActualInput } from './usage-actual-input.ts';
import { durableRealEquals } from '../../support/durable-number.ts';

export interface CapacityUsageReportRequest {
	teamId: string;
	membershipId: string;
	reservationId: string;
	assignmentId: string;
	idempotencyKey: string;
	assignmentAttempt?: number | null;
	usageDimension: string;
	accountingMode?: 'informational' | 'incremental' | 'aggregate';
	actualCredits: number;
	providerUnits?: number | null;
	usd?: number | null;
	modeRunId?: string | null;
	source: string;
	metadata?: Record<string, unknown>;
	usageActual?: CapacityUsageActualInput;
}

export interface CapacityUsageIdentity {
	id: string;
	idempotencyKey: string;
	assignmentAttempt: number;
	usageDimension: string;
}

function positiveOrZero(value: number, name: string) {
	if (!Number.isFinite(value) || value < 0) throw new CapacityGovernanceError(`${name}_invalid`, `${name} must be a finite value greater than or equal to zero.`, 400);
	return value;
}

export function capacityUsageIdentity(input: CapacityUsageReportRequest, reservation: Record<string, unknown>): CapacityUsageIdentity {
	const durableAttempt = Number(reservation.assignment_attempt ?? 0);
	const assignmentAttempt = Number(input.assignmentAttempt ?? durableAttempt);
	if (!Number.isInteger(assignmentAttempt) || assignmentAttempt < 0) throw new CapacityGovernanceError('capacity_usage_assignment_attempt_invalid', 'Usage assignmentAttempt must be a non-negative integer.', 400);
	if (assignmentAttempt !== durableAttempt) throw new CapacityGovernanceError('capacity_usage_assignment_attempt_conflict', 'Usage assignmentAttempt does not match the durable assignment attempt.', 409, { assignmentAttempt, durableAttempt });
	const usageDimension = String(input.usageDimension).trim();
	if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(usageDimension)) throw new CapacityGovernanceError('capacity_usage_dimension_invalid', 'usageDimension must be a lowercase stable identifier of at most 64 characters.', 400);
	const idempotencyKey = String(input.idempotencyKey).trim();
	if (!idempotencyKey) throw new CapacityGovernanceError('capacity_usage_idempotency_key_required', 'Usage idempotency key is required.', 400);
	return { assignmentAttempt, usageDimension, idempotencyKey, id: `usage:${input.assignmentId}:${assignmentAttempt}:${usageDimension}` };
}

export function assertCapacityUsageMatches(row: Record<string, unknown>, input: CapacityUsageReportRequest, identity: CapacityUsageIdentity) {
	let metadata: Record<string, unknown> = {};
	try { metadata = JSON.parse(String(row.metadata_json ?? '{}')) as Record<string, unknown>; } catch { /* handled by mismatch */ }
	const matches = String(row.id ?? '') === identity.id
		&& String(row.idempotency_key ?? '') === identity.idempotencyKey
		&& String(row.assignment_id ?? '') === input.assignmentId
		&& Number(row.assignment_attempt) === identity.assignmentAttempt
		&& String(row.usage_dimension ?? '') === identity.usageDimension
		&& String(row.accounting_mode ?? '') === String(input.accountingMode ?? 'informational')
		&& durableRealEquals(row.actual_credits, input.actualCredits)
		&& durableRealEquals(metadata.providerUnits, input.providerUnits)
		&& durableRealEquals(row.actual_usd, input.usd);
	if (!matches) throw new CapacityGovernanceError('capacity_usage_idempotency_conflict', 'Usage identity is already bound to a different report.', 409, { assignmentId: input.assignmentId, usageActualId: identity.id });
}

export function capacityUsageInsertOperation(input: CapacityUsageReportRequest, reservation: Record<string, unknown>, identity: CapacityUsageIdentity, guard: { column: 'usage_report_token' | 'settlement_token'; token: string }, now: string): CapacityDatabaseOperation {
	positiveOrZero(input.actualCredits, 'capacity_actual_credits');
	const accountingMode = input.accountingMode ?? 'informational';
	if (accountingMode === 'informational' && input.actualCredits !== 0) throw new CapacityGovernanceError('capacity_usage_informational_credits_invalid', 'Informational usage dimensions cannot carry billable credits.', 400);
	const usage = input.usageActual ?? {};
	return {
		query: `INSERT INTO capacity_usage_actuals (
			id, idempotency_key, task_id, work_day_id, project_id, task_signature, execution_profile_id, assignment_id, assignment_attempt, usage_dimension, accounting_mode, mode_run_id, mode,
			capacity_provider_id, execution_provider_id, lane_id, business_model, model_name, input_tokens, output_tokens,
			cached_input_tokens, quota_minutes, wall_minutes, files_opened, files_changed, diff_lines_added,
			diff_lines_removed, test_runs, retry_count, actual_credits, actual_usd, credit_formula_version,
			actual_credit_source, native_usage_json, metadata_json, created_at
		) SELECT ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS INTEGER), ?, ?, ?, ?, ?, ?, ?, ?, ?,
			CAST(? AS INTEGER), CAST(? AS INTEGER), CAST(? AS INTEGER), CAST(? AS REAL), CAST(? AS REAL),
			CAST(? AS INTEGER), CAST(? AS INTEGER), CAST(? AS INTEGER), CAST(? AS INTEGER), CAST(? AS INTEGER),
			CAST(? AS INTEGER), CAST(? AS REAL), CAST(? AS REAL), ?, ?, ?, ?, ?
		  WHERE EXISTS (SELECT 1 FROM capacity_reservations WHERE id = ? AND team_id = ? AND ${guard.column} = ?)
		  ON CONFLICT (id) DO NOTHING`,
		params: [identity.id, identity.idempotencyKey, reservation.task_id ?? null, reservation.work_day_id ?? null, reservation.project_id,
			usage.taskSignature ?? `${reservation.project_agent_class_id ?? 'assignment'}:${reservation.mode ?? 'unknown'}`,
			usage.executionProfileId ?? 'standard-code-model', input.assignmentId, identity.assignmentAttempt, identity.usageDimension, accountingMode,
			input.modeRunId ?? null, reservation.mode ?? null, reservation.capacity_provider_id,
			usage.executionProviderId ?? reservation.execution_provider_id ?? null, reservation.lane_id ?? null,
			usage.businessModel ?? 'credit', usage.modelName ?? null, usage.inputTokens ?? null, usage.outputTokens ?? null,
			usage.cachedInputTokens ?? null, usage.quotaMinutes ?? null, usage.wallMinutes ?? null, usage.filesOpened ?? null,
			usage.filesChanged ?? null, usage.diffLinesAdded ?? null, usage.diffLinesRemoved ?? null, usage.testRuns ?? null,
			usage.retryCount ?? null, input.actualCredits, input.usd ?? null, 'treeseed.provider-usage.v1', input.source,
			JSON.stringify(usage.nativeUsage ?? {}), JSON.stringify({ ...(input.metadata ?? {}), providerUnits: input.providerUnits ?? null }), now,
			input.reservationId, input.teamId, guard.token],
	};
}

export async function reportCapacityUsage(database: CapacityGovernanceDatabase, input: CapacityUsageReportRequest) {
	await database.ensureInitialized();
	if (input.accountingMode === 'aggregate') throw new CapacityGovernanceError('capacity_usage_aggregate_terminal_only', 'Aggregate usage is accepted only by terminal settlement.', 400);
	const reservation = await database.first(`SELECT reservation.*, assignment.attempt_count AS assignment_attempt FROM capacity_reservations reservation JOIN capacity_provider_assignments assignment ON assignment.id = reservation.assignment_id WHERE reservation.id = ? AND reservation.team_id = ? LIMIT 1`, [input.reservationId, input.teamId]);
	if (!reservation) throw new CapacityGovernanceError('capacity_reservation_not_found', 'Capacity reservation does not exist.', 404);
	if (String(reservation.assignment_id ?? '') !== input.assignmentId) throw new CapacityGovernanceError('capacity_usage_assignment_mismatch', 'Usage report assignment does not own the reservation.', 409);
	if (String(reservation.membership_id ?? '') !== input.membershipId) throw new CapacityGovernanceError('capacity_usage_membership_mismatch', 'Usage report membership does not own the reservation.', 403);
	const identity = capacityUsageIdentity(input, reservation);
	const token = randomUUID();
	const now = new Date().toISOString();
	try {
		await database.batch([
			{ query: `UPDATE capacity_reservations SET usage_report_token = ?, updated_at = ? WHERE id = ? AND team_id = ? AND usage_report_token IS NULL AND settlement_token IS NULL AND state IN ('reserved', 'consuming') AND NOT EXISTS (SELECT 1 FROM capacity_ledger_entries WHERE reservation_id = ? AND phase = 'task_completed_actual_settlement')`, params: [token, now, input.reservationId, input.teamId, input.reservationId] },
			capacityUsageInsertOperation({ ...input, metadata: { ...(input.metadata ?? {}), usageReportToken: token } }, reservation, identity, { column: 'usage_report_token', token }, now),
			{ query: `UPDATE capacity_reservations SET usage_report_token = NULL, updated_at = ? WHERE id = ? AND team_id = ? AND usage_report_token = ?`, params: [now, input.reservationId, input.teamId, token] },
		]);
	} catch (error) {
		if (!isUniqueConstraintViolation(error)) throw error;
	}
	const row = await database.first(`SELECT * FROM capacity_usage_actuals WHERE id = ? OR idempotency_key = ? LIMIT 1`, [identity.id, identity.idempotencyKey]);
	if (!row) throw new CapacityGovernanceError('capacity_usage_reporting_closed', 'Usage cannot be reported after reservation settlement has started or completed.', 409, { reservationId: input.reservationId });
	assertCapacityUsageMatches(row, input, identity);
	let storedToken = '';
	try { storedToken = String(JSON.parse(String(row.metadata_json ?? '{}')).usageReportToken ?? ''); } catch { /* malformed stored metadata cannot claim this insertion */ }
	return { replayed: storedToken !== token, usageActual: row };
}

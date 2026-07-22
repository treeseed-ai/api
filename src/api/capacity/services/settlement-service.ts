import { randomUUID } from 'node:crypto';
import type { CapacityGovernanceDatabase, CapacityDatabaseOperation } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';
import { isUniqueConstraintViolation } from '../database-errors.ts';
import {
	assertCapacityUsageMatches,
	capacityUsageIdentity,
	capacityUsageInsertOperation,
	type CapacityUsageReportRequest,
} from './usage-report-service.ts';
import type { CapacityUsageActualInput } from './usage-actual-input.ts';
import { durableRealEquals } from './durable-number.ts';

export interface CapacitySettlementRequest {
	settlementKey: string;
	teamId: string;
	membershipId: string;
	reservationId: string;
	assignmentId: string;
	assignmentAttempt?: number | null;
	usageDimension?: string | null;
	usageIdempotencyKey?: string | null;
	approvedOverrun?: boolean;
	actualCredits: number;
	providerUnits?: number | null;
	usd?: number | null;
	modeRunId?: string | null;
	source: string;
	existingSettlementPolicy?: 'require-match' | 'replay';
	metadata?: Record<string, unknown>;
	usageActual?: CapacityUsageActualInput;
}

const ACTUAL_SETTLEMENT_PHASE = 'task_completed_actual_settlement';

function positiveOrZero(value: number, name: string) {
	if (!Number.isFinite(value) || value < 0) throw new CapacityGovernanceError(`${name}_invalid`, `${name} must be a finite value greater than or equal to zero.`, 400);
	return value;
}

function isEnforcedLimitViolation(error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	return /check constraint|committed_amount|hard_limit/u.test(message.toLowerCase());
}

function usageReportInput(input: CapacitySettlementRequest): CapacityUsageReportRequest {
	return {
		teamId: input.teamId,
		membershipId: input.membershipId,
		reservationId: input.reservationId,
		assignmentId: input.assignmentId,
		idempotencyKey: String(input.usageIdempotencyKey ?? `assignment:${input.assignmentId}:usage:${input.usageDimension ?? 'aggregate'}`),
		assignmentAttempt: input.assignmentAttempt,
		usageDimension: String(input.usageDimension ?? 'aggregate'),
		accountingMode: 'aggregate',
		actualCredits: input.actualCredits,
		providerUnits: input.providerUnits,
		usd: input.usd,
		modeRunId: input.modeRunId,
		source: input.source,
		metadata: { ...(input.metadata ?? {}), settlementKey: input.settlementKey },
		usageActual: input.usageActual,
	};
}

function assertSettlementMatches(entry: Record<string, unknown>, input: CapacitySettlementRequest) {
	const identityMatches = String(entry.team_id ?? '') === input.teamId
		&& String(entry.membership_id ?? '') === input.membershipId
		&& String(entry.reservation_id ?? '') === input.reservationId
		&& String(entry.assignment_id ?? '') === input.assignmentId;
	if (!identityMatches) {
		throw new CapacityGovernanceError(
			'capacity_settlement_idempotency_conflict',
			'Settlement identity is already associated with a different reservation or assignment.',
			409,
			{ settlementKey: input.settlementKey, reservationId: input.reservationId },
		);
	}
	if (input.existingSettlementPolicy === 'replay') return;
	const usageMatches = durableRealEquals(entry.credits ?? 0, input.actualCredits)
		&& durableRealEquals(entry.provider_units, input.providerUnits)
		&& durableRealEquals(entry.usd, input.usd);
	if (!usageMatches) {
		throw new CapacityGovernanceError(
			'capacity_settlement_usage_conflict',
			'Reservation was already settled with different actual usage.',
			409,
			{ settlementKey: String(entry.settlement_key ?? ''), reservationId: input.reservationId },
		);
	}
}

function replayedSettlement(entry: Record<string, unknown>, input: CapacitySettlementRequest, usageActualId: string) {
	assertSettlementMatches(entry, input);
	return { replayed: true, entry, usageActualId };
}

interface PreparedCapacitySettlement {
	input: CapacitySettlementRequest;
	reservation: Record<string, unknown>;
	claims: Record<string, unknown>[];
	settlementToken: string;
	usageActualId: string;
	entryId: string;
	actualCredits: number;
	reservedCredits: number;
	now: string;
	operations: CapacityDatabaseOperation[];
}

function prepareCapacitySettlement(
	input: CapacitySettlementRequest,
	reservation: Record<string, unknown>,
	claims: Record<string, unknown>[],
): PreparedCapacitySettlement {
	if (String(reservation.assignment_id ?? '') !== input.assignmentId) throw new CapacityGovernanceError('capacity_settlement_assignment_mismatch', 'Settlement assignment does not own the reservation.', 409);
	if (String(reservation.membership_id ?? '') !== input.membershipId) throw new CapacityGovernanceError('capacity_settlement_membership_mismatch', 'Settlement membership does not own the reservation.', 403);
	const actualCredits = positiveOrZero(input.actualCredits, 'capacity_actual_credits');
	const reservedCredits = Number(reservation.reserved_credits ?? 0);
	const settlementToken = randomUUID();
	const usageInput = usageReportInput(input);
	const usageIdentityValue = capacityUsageIdentity(usageInput, reservation);
	const usageActualId = usageIdentityValue.id;
	const now = new Date().toISOString();
	const entryId = randomUUID();
	const operations: CapacityDatabaseOperation[] = [{
		query: `UPDATE capacity_reservations
		 SET settlement_token = ?, updated_at = ?
		 WHERE id = ? AND team_id = ? AND usage_report_token IS NULL AND settlement_token IS NULL
		   AND NOT EXISTS (SELECT 1 FROM capacity_ledger_entries WHERE reservation_id = ? AND phase = ?)`,
		params: [settlementToken, now, input.reservationId, input.teamId, input.reservationId, ACTUAL_SETTLEMENT_PHASE],
	}];
	operations.push(capacityUsageInsertOperation(usageInput, reservation, usageIdentityValue, { column: 'settlement_token', token: settlementToken }, now));
	operations.push({
		query: `DELETE FROM capacity_usage_actuals WHERE id = ? AND EXISTS (SELECT 1 FROM capacity_reservations WHERE id = ? AND team_id = ? AND settlement_token = ?) AND EXISTS (SELECT 1 FROM (SELECT COALESCE(SUM(actual_credits), 0) AS credits FROM capacity_usage_actuals WHERE assignment_id = ? AND assignment_attempt = ? AND accounting_mode = 'incremental') incremental_total WHERE incremental_total.credits > CAST(? AS REAL))`,
		params: [usageActualId, input.reservationId, input.teamId, settlementToken, input.assignmentId, usageIdentityValue.assignmentAttempt, actualCredits],
	});
	operations.push({
		query: `UPDATE capacity_reservations SET settlement_token = NULL, updated_at = ? WHERE id = ? AND team_id = ? AND settlement_token = ? AND EXISTS (SELECT 1 FROM (SELECT COALESCE(SUM(actual_credits), 0) AS credits FROM capacity_usage_actuals WHERE assignment_id = ? AND assignment_attempt = ? AND accounting_mode = 'incremental') incremental_total WHERE incremental_total.credits > CAST(? AS REAL))`,
		params: [now, input.reservationId, input.teamId, settlementToken, input.assignmentId, usageIdentityValue.assignmentAttempt, actualCredits],
	});
	for (const claim of claims) {
		const reservedAmount = Number(claim.reserved_amount ?? 0);
		const isConcurrency = claim.release_policy === 'assignment-terminal';
		const desiredAmount = isConcurrency ? 0 : actualCredits;
		const adjustment = desiredAmount - reservedAmount;
		if (input.approvedOverrun === true && adjustment > 0) operations.push({
			query: `UPDATE capacity_admission_counters SET hard_limit = CASE WHEN hard_limit < committed_amount + ? THEN committed_amount + ? ELSE hard_limit END, state_version = state_version + 1, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM capacity_reservations WHERE id = ? AND team_id = ? AND settlement_token = ?) AND NOT EXISTS (SELECT 1 FROM capacity_ledger_entries WHERE reservation_id = ? AND phase = ?)`,
			params: [adjustment, adjustment, now, claim.counter_id, input.reservationId, input.teamId, settlementToken, input.reservationId, ACTUAL_SETTLEMENT_PHASE],
		});
		operations.push({
			query: `UPDATE capacity_admission_counters SET committed_amount = committed_amount + ?, state_version = state_version + 1, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM capacity_reservations WHERE id = ? AND team_id = ? AND settlement_token = ?) AND NOT EXISTS (SELECT 1 FROM capacity_ledger_entries WHERE reservation_id = ? AND phase = ?)`,
			params: [adjustment, now, claim.counter_id, input.reservationId, input.teamId, settlementToken, input.reservationId, ACTUAL_SETTLEMENT_PHASE],
		});
		operations.push({
			query: `UPDATE capacity_reservation_counter_claims SET released_amount = ?, updated_at = ? WHERE reservation_id = ? AND counter_id = ? AND EXISTS (SELECT 1 FROM capacity_reservations WHERE id = ? AND team_id = ? AND settlement_token = ?) AND NOT EXISTS (SELECT 1 FROM capacity_ledger_entries WHERE reservation_id = ? AND phase = ?)`,
			params: [Math.max(0, reservedAmount - desiredAmount), now, input.reservationId, claim.counter_id, input.reservationId, input.teamId, settlementToken, input.reservationId, ACTUAL_SETTLEMENT_PHASE],
		});
	}
	operations.push({
		query: `INSERT INTO capacity_ledger_entries (id, settlement_key, membership_id, capacity_provider_id, reservation_id, assignment_id, mode_run_id, mode, team_id, project_id, work_day_id, task_id, phase, credits, provider_units, usd, source, metadata_json, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'task_completed_actual_settlement', CAST(? AS REAL), CAST(? AS REAL), CAST(? AS REAL), ?, ?, ? WHERE EXISTS (SELECT 1 FROM capacity_reservations WHERE id = ? AND team_id = ? AND settlement_token = ?) ON CONFLICT (reservation_id, phase) DO NOTHING`,
		params: [entryId, input.settlementKey, input.membershipId, reservation.capacity_provider_id, input.reservationId, input.assignmentId, input.modeRunId ?? null, reservation.mode ?? null, input.teamId, reservation.project_id ?? null, reservation.work_day_id ?? null, reservation.task_id ?? null, actualCredits, input.providerUnits ?? null, input.usd ?? null, input.source, JSON.stringify({ ...(input.metadata ?? {}), reservedCredits, actualCredits, releasedCredits: Math.max(0, reservedCredits - actualCredits), overrunCredits: Math.max(0, actualCredits - reservedCredits) }), now, input.reservationId, input.teamId, settlementToken],
	});
	operations.push({
		query: `UPDATE capacity_reservations SET consumed_credits = ?, consumed_provider_units = ?, consumed_usd = ?, state = 'consumed', updated_at = ? WHERE id = ? AND team_id = ? AND settlement_token = ? AND EXISTS (SELECT 1 FROM capacity_ledger_entries WHERE reservation_id = ? AND phase = ? AND id = ?)`,
		params: [actualCredits, input.providerUnits ?? null, input.usd ?? null, now, input.reservationId, input.teamId, settlementToken, input.reservationId, ACTUAL_SETTLEMENT_PHASE, entryId],
	});
	return {
		input,
		reservation,
		claims,
		settlementToken,
		usageActualId,
		entryId,
		actualCredits,
		reservedCredits,
		now,
		operations,
	};
}

export async function settleCapacityReservationExactlyOnce(database: CapacityGovernanceDatabase, input: CapacitySettlementRequest) {
	await database.ensureInitialized();
	if (!input.settlementKey.trim()) throw new CapacityGovernanceError('capacity_settlement_key_required', 'settlementKey is required.', 400);
	const reservation = await database.first(`SELECT reservation.*, assignment.attempt_count AS assignment_attempt FROM capacity_reservations reservation JOIN capacity_provider_assignments assignment ON assignment.id = reservation.assignment_id WHERE reservation.id = ? AND reservation.team_id = ? LIMIT 1`, [input.reservationId, input.teamId]);
	if (!reservation) throw new CapacityGovernanceError('capacity_reservation_not_found', 'Capacity reservation does not exist.', 404);
	const usageInput = usageReportInput(input);
	const usageIdentityValue = capacityUsageIdentity(usageInput, reservation);
	const usageActualId = usageIdentityValue.id;
	const existingByKey = await database.first(
		`SELECT * FROM capacity_ledger_entries WHERE settlement_key = ? LIMIT 1`,
		[input.settlementKey],
	);
	const existingByReservation = existingByKey ?? await database.first(
		`SELECT * FROM capacity_ledger_entries WHERE reservation_id = ? AND phase = ? LIMIT 1`,
		[input.reservationId, ACTUAL_SETTLEMENT_PHASE],
	);
	if (existingByReservation) {
		assertSettlementMatches(existingByReservation, input);
		if (input.existingSettlementPolicy !== 'replay') {
			const usageRow = await database.first(
				`SELECT * FROM capacity_usage_actuals WHERE id = ? OR idempotency_key = ? LIMIT 1`,
				[usageActualId, usageIdentityValue.idempotencyKey],
			);
			if (!usageRow) throw new CapacityGovernanceError('capacity_usage_not_committed', 'Terminal usage report was not committed.', 500);
			assertCapacityUsageMatches(usageRow, usageInput, usageIdentityValue);
		}
		return { replayed: true, entry: existingByReservation, usageActualId: String(existingByReservation.assignment_id) === input.assignmentId
			? `usage:${input.assignmentId}:${usageIdentityValue.assignmentAttempt}:aggregate`
			: usageActualId };
	}
	const claims = await database.all(`SELECT claim.*, counter.scope FROM capacity_reservation_counter_claims claim JOIN capacity_admission_counters counter ON counter.id = claim.counter_id WHERE claim.reservation_id = ? ORDER BY claim.counter_id ASC`, [input.reservationId]);
	const prepared = prepareCapacitySettlement(input, reservation, claims);
	const { actualCredits, reservedCredits, now, entryId, operations } = prepared;
	try {
		await database.batch(operations);
	} catch (error) {
		if (isUniqueConstraintViolation(error)) {
			const message = error instanceof Error ? error.message : String(error);
			if (/capacity_usage_actuals|idx_capacity_usage_actuals/iu.test(message)) throw new CapacityGovernanceError(
				'capacity_usage_idempotency_conflict', 'Usage identity is already bound to a different report.', 409,
				{ assignmentId: input.assignmentId, usageActualId },
			);
			throw new CapacityGovernanceError(
				'capacity_settlement_idempotency_conflict', 'Settlement identity is already bound to a different reservation.', 409,
				{ settlementKey: input.settlementKey, reservationId: input.reservationId },
			);
		}
		if (!isEnforcedLimitViolation(error)) throw error;
		const holdKey = `${input.settlementKey}:overrun-hold`;
		await database.batch([
			{ query: `DELETE FROM capacity_usage_actuals WHERE id = ? AND assignment_id = ? AND NOT EXISTS (SELECT 1 FROM capacity_ledger_entries WHERE reservation_id = ? AND phase = ?)`, params: [usageActualId, input.assignmentId, input.reservationId, ACTUAL_SETTLEMENT_PHASE] },
			{ query: `INSERT INTO capacity_ledger_entries (id, settlement_key, membership_id, capacity_provider_id, reservation_id, assignment_id, mode_run_id, mode, team_id, project_id, work_day_id, task_id, phase, credits, provider_units, usd, source, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'overrun_hold', ?, ?, ?, ?, ?, ?) ON CONFLICT (settlement_key) DO NOTHING`, params: [randomUUID(), holdKey, input.membershipId, reservation.capacity_provider_id, input.reservationId, input.assignmentId, input.modeRunId ?? null, reservation.mode ?? null, input.teamId, reservation.project_id ?? null, reservation.work_day_id ?? null, reservation.task_id ?? null, actualCredits, input.providerUnits ?? null, input.usd ?? null, input.source, JSON.stringify({ ...(input.metadata ?? {}), reservedCredits, actualCredits, cause: error instanceof Error ? error.message : String(error) }), now] },
			{ query: `UPDATE capacity_reservations SET state = 'overran_pending_approval', settlement_token = NULL, updated_at = ? WHERE id = ? AND team_id = ?`, params: [now, input.reservationId, input.teamId] },
		]);
		throw new CapacityGovernanceError('capacity_settlement_overrun_requires_approval', 'Actual usage exceeds an enforced hard limit and is held for approval.', 409, { reservationId: input.reservationId, reservedCredits, actualCredits, holdKey });
	}
	const entry = await database.first(
		`SELECT * FROM capacity_ledger_entries WHERE reservation_id = ? AND phase = ? LIMIT 1`,
		[input.reservationId, ACTUAL_SETTLEMENT_PHASE],
	);
	if (!entry) {
		const incremental = await database.first(`SELECT COALESCE(SUM(actual_credits), 0) AS credits FROM capacity_usage_actuals WHERE assignment_id = ? AND assignment_attempt = ? AND accounting_mode = 'incremental'`, [input.assignmentId, usageIdentityValue.assignmentAttempt]);
		if (Number(incremental?.credits ?? 0) > input.actualCredits) throw new CapacityGovernanceError('capacity_usage_aggregate_underreported', 'Terminal aggregate credits cannot be less than accepted incremental usage.', 409, { assignmentId: input.assignmentId, incrementalCredits: Number(incremental?.credits ?? 0), aggregateCredits: input.actualCredits });
		throw new CapacityGovernanceError('capacity_settlement_not_committed', 'Capacity settlement was not committed.', 500);
	}
	const usageRow = await database.first(`SELECT * FROM capacity_usage_actuals WHERE id = ? OR idempotency_key = ? LIMIT 1`, [usageActualId, usageIdentityValue.idempotencyKey]);
	if (!usageRow) throw new CapacityGovernanceError('capacity_usage_not_committed', 'Terminal usage report was not committed.', 500);
	assertSettlementMatches(entry, input);
	assertCapacityUsageMatches(usageRow, usageInput, usageIdentityValue);
	return { replayed: String(entry.id) !== entryId, entry, usageActualId };
}

export async function releaseCapacityReservationsExactlyOnce(
	database: CapacityGovernanceDatabase,
	inputs: CapacitySettlementRequest[],
) {
	if (inputs.length === 0) return [];
	await database.ensureInitialized();
	const teamIds = new Set(inputs.map((input) => input.teamId));
	if (teamIds.size !== 1) throw new CapacityGovernanceError('capacity_settlement_batch_team_mismatch', 'A reservation release batch must belong to one team.', 400);
	for (const input of inputs) {
		if (!input.settlementKey.trim()) throw new CapacityGovernanceError('capacity_settlement_key_required', 'settlementKey is required.', 400);
		if (input.actualCredits !== 0 || input.providerUnits != null || input.usd != null || input.usageActual != null) {
			throw new CapacityGovernanceError('capacity_release_requires_zero_usage', 'Batched reservation release only supports terminal assignments with zero unreported usage.', 400);
		}
	}
	const results = [];
	for (const input of inputs) results.push(await settleCapacityReservationExactlyOnce(database, input));
	return results;
}

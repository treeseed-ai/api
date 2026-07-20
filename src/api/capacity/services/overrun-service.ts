import { createHash } from 'node:crypto';
import type { CapacityGovernanceDatabase } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';
import { CapacityAuditRepository } from '../repositories/audit.ts';
import { settleCapacityReservationExactlyOnce } from './settlement-service.ts';

type Decision = 'approved' | 'rejected';
type Row = Record<string, unknown>;

function metadata(row: Row): Row {
	try {
		const value = JSON.parse(String(row.metadata_json ?? '{}')) as unknown;
		if (value && typeof value === 'object' && !Array.isArray(value)) return value as Row;
	} catch { /* classified below */ }
	throw new CapacityGovernanceError('capacity_overrun_hold_corrupt', 'Overrun hold metadata is invalid.', 500, { ledgerEntryId: row.id ?? null });
}

function finite(value: unknown, field: string): number | null {
	if (value == null) return null;
	const parsed = Number(value);
	if (Number.isFinite(parsed) && parsed >= 0) return parsed;
	throw new CapacityGovernanceError('capacity_overrun_hold_corrupt', `Overrun hold ${field} is invalid.`, 500, { field });
}

export class CapacityOverrunService {
	constructor(private readonly database: CapacityGovernanceDatabase) {}

	async decide(teamId: string, reservationId: string, decision: Decision, actorId: string, idempotencyKey: string) {
		if (!idempotencyKey.trim()) throw new CapacityGovernanceError('idempotency_key_required', 'Idempotency-Key is required.', 400);
		await this.database.ensureInitialized();
		const reservation = await this.database.first(
			`SELECT reservation.*, assignment.attempt_count AS assignment_attempt FROM capacity_reservations reservation JOIN capacity_provider_assignments assignment ON assignment.id = reservation.assignment_id WHERE reservation.id = ? AND reservation.team_id = ? LIMIT 1`,
			[reservationId, teamId],
		);
		if (!reservation) throw new CapacityGovernanceError('capacity_reservation_not_found', 'Capacity reservation does not exist.', 404);
		const hold = await this.database.first(
			`SELECT * FROM capacity_ledger_entries WHERE reservation_id = ? AND team_id = ? AND phase = 'overrun_hold' LIMIT 1`,
			[reservationId, teamId],
		);
		if (!hold) throw new CapacityGovernanceError('capacity_overrun_hold_not_found', 'Reservation has no overrun hold.', 409, { reservationId });
		if (reservation.state !== 'overran_pending_approval' && reservation.state !== 'consumed') throw new CapacityGovernanceError(
			'capacity_overrun_state_conflict', `Reservation in ${String(reservation.state)} state cannot receive an overrun decision.`, 409,
		);
		const holdMetadata = metadata(hold);
		const actualCredits = decision === 'approved' ? finite(holdMetadata.actualCredits ?? hold.credits, 'actualCredits') ?? 0 : 0;
		const result = await settleCapacityReservationExactlyOnce(this.database, {
			settlementKey: `overrun-${decision}:${reservationId}:${idempotencyKey}`,
			usageIdempotencyKey: `overrun-${decision}:${reservationId}:${idempotencyKey}`,
			teamId,
			membershipId: String(reservation.membership_id),
			reservationId,
			assignmentId: String(reservation.assignment_id),
			assignmentAttempt: Number(reservation.assignment_attempt ?? 0),
			actualCredits,
			providerUnits: decision === 'approved' ? finite(hold.provider_units, 'providerUnits') : null,
			usd: decision === 'approved' ? finite(hold.usd, 'usd') : null,
			source: `team_overrun_${decision}`,
			approvedOverrun: decision === 'approved',
			existingSettlementPolicy: 'require-match',
			metadata: { overrunDecision: decision, overrunHoldId: hold.id, actorId },
		});
		const now = new Date().toISOString();
		const auditId = `audit:overrun:${createHash('sha256').update(`${teamId}:${reservationId}:${decision}:${idempotencyKey}`).digest('base64url')}`;
		await new CapacityAuditRepository(this.database).record({
			id: auditId, teamId, providerId: String(reservation.capacity_provider_id), membershipId: String(reservation.membership_id),
			actorType: 'team-principal', actorId, action: `capacity-overrun.${decision}`, resourceType: 'capacity-reservation',
			resourceId: reservationId, idempotencyKey, metadata: { actualCredits, settlementKey: result.entry.settlement_key }, now,
		});
		return { decision, reservationId, settlement: result };
	}
}

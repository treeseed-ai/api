import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CapacityGovernanceDatabase } from '../../../database.ts';
import { CapacityGovernanceError } from '../../../database.ts';
import { serializeCapacityReservationRow } from '../../../repositories/capacity/accounting/reservation.ts';
import { serializeTaskUsageActualRow } from '../../../repositories/capacity/accounting/task-usage.ts';
import { serializeCapacityLedgerEntryRow } from '../../../repositories/capacity/accounting/ledger.ts';
import { CapacityWorkdayEventRepository } from '../../../repositories/capacity/workdays/workday-event.ts';

type Row = Record<string, unknown>;
/** Called on the transaction owning the actual accounting mutation. Existing
 * canonical serializers define historical bytes; this is no second ledger. */
export async function recordCapacityAccountingObservation(database: CapacityGovernanceDatabase, input: {
 teamId: string; reservationId: string; transitionId: string; createdAt: string;
 usageRow?: Row | null; ledgerRow?: Row | null; replayed?: boolean;
}) {
 const fail = () => new CapacityGovernanceError('capacity_accounting_observation_conflict', 'Accounting requires its exact durable public observation.', 409);
 const reservation = serializeCapacityReservationRow(await database.first('SELECT * FROM capacity_reservations WHERE id=? AND team_id=?', [input.reservationId, input.teamId]));
 if (!reservation || !reservation.assignmentId || !reservation.workDayId) throw fail();
 const usageActual = serializeTaskUsageActualRow(input.usageRow ?? null), ledgerEntry = serializeCapacityLedgerEntryRow(input.ledgerRow ?? null);
 if (usageActual && (usageActual.assignmentId !== reservation.assignmentId || usageActual.projectId !== reservation.projectId || usageActual.workDayId !== reservation.workDayId)
  || ledgerEntry && (ledgerEntry.teamId !== reservation.teamId || ledgerEntry.reservationId !== reservation.id || ledgerEntry.assignmentId !== reservation.assignmentId || ledgerEntry.workDayId !== reservation.workDayId)) throw fail();
 const id = 'capacity-accounting:' + createHash('sha256').update(JSON.stringify([input.teamId, input.reservationId, input.transitionId])).digest('hex');
 const repository = new CapacityWorkdayEventRepository(database);
 if (input.replayed) {
  const observed = await repository.get(input.teamId, reservation.workDayId, id);
  // Later accounting may legitimately advance the reservation and shared
  // counters. Never rewrite that earlier snapshot during a record replay.
  if (!observed || observed.eventType !== 'capacity.accounting.updated' || observed.assignmentId !== reservation.assignmentId
   || observed.projectId !== reservation.projectId || observed.workdayId !== reservation.workDayId || observed.createdAt !== input.createdAt
   || !isDeepStrictEqual(observed.context.usageActual, usageActual) || !isDeepStrictEqual(observed.context.ledgerEntry, ledgerEntry)) throw fail();
  return observed;
 }
 const claims = await database.all(`SELECT claim.counter_id AS "id",counter.team_id AS "teamId",counter.scope,counter.scope_id AS "scopeId",
  counter.period_key AS "periodKey",counter.hard_limit AS "hardLimit",counter.committed_amount AS "committedAmount",counter.state_version AS "stateVersion",
  claim.reserved_amount AS "reservedAmount",claim.released_amount AS "releasedAmount",claim.release_policy AS "releasePolicy"
  FROM capacity_reservation_counter_claims claim LEFT JOIN capacity_admission_counters counter ON counter.id=claim.counter_id
  WHERE claim.reservation_id=? ORDER BY claim.counter_id`, [reservation.id]);
 const remainingSupply = claims.map(claim => {
  if (claim.teamId !== input.teamId || typeof claim.id !== 'string' || typeof claim.scope !== 'string' || typeof claim.scopeId !== 'string'
   || typeof claim.periodKey !== 'string' || typeof claim.releasePolicy !== 'string') throw fail();
  const numeric = Object.fromEntries(['hardLimit', 'committedAmount', 'reservedAmount', 'releasedAmount', 'stateVersion'].map(field => {
   const value = Number(claim[field]); if (claim[field] == null || !Number.isFinite(value) || value < 0) throw fail(); return [field, value];
  }));
  if (!Number.isSafeInteger(numeric.stateVersion) || numeric.stateVersion! < 1 || numeric.releasedAmount! > numeric.reservedAmount!) throw fail();
  return { ...claim, ...numeric, remainingAmount: Math.max(0, numeric.hardLimit! - numeric.committedAmount!) };
 });
 const value = { id, projectId: reservation.projectId, workdayId: reservation.workDayId, assignmentId: reservation.assignmentId,
  eventType: 'capacity.accounting.updated', status: 'recorded' as const, title: 'Capacity accounting updated', message: null,
  parameters: {}, metadata: {}, refs: {}, createdAt: input.createdAt, context: { reservation, usageActual, ledgerEntry, remainingSupply } };
 const observed = await repository.create(input.teamId, reservation.workDayId, value);
 if (!observed || observed.teamId !== input.teamId || observed.runId !== reservation.workDayId
  || Object.entries(value).some(([key, expected]) => !isDeepStrictEqual(Reflect.get(observed, key), expected))) throw fail();
 return observed;
}

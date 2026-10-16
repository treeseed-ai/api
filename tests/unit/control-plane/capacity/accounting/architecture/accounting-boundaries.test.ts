import type { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
import { initialAdmission } from '../../execution/architecture/initial/initial-admission-fixture.ts';
import { cancellationDatabase } from '../../../providers/assignments/architecture/cancellation-fixture.ts';
import { OperatorAssignmentService } from '../../../../../../src/api/capacity/services/capacity/assignments/observability/operator-assignment-service.ts';
import { serializeCapacityReservationRow } from '../../../../../../src/api/capacity/repositories/capacity/accounting/reservation.ts';
type Row = Record<string, unknown>;
type Boundary = { db: PGlite; id: string; reservationId: string; workdayId: string; call: () => Promise<unknown>;
 query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }>; snapshot: () => Promise<unknown> };
async function admittedBoundary(): Promise<Boundary> {
 const f = await initialAdmission(); return { ...f, id: f.attempt.id, reservationId: f.attempt.reservationId, workdayId: f.attempt.workdayId, call: () => f.admit() };
}
async function recoveredBoundary(): Promise<Boundary> {
 const f = await cancellationDatabase('expired');
 try {
  await f.query("UPDATE capacity_provider_assignments SET lease_state='expired',metadata_json=? WHERE id=?", [JSON.stringify({ leaseRecovery: { disposition: 'operator-action' } }), f.assignment.id]);
  const service = new OperatorAssignmentService(f.owner), input = { expectedStateVersion: 1, reason: 'Original measurement unavailable', actorId: 'operator', idempotencyKey: 'accounting-recovery' };
  return { ...f, id: f.assignment.id, reservationId: f.attempt.reservationId, workdayId: f.attempt.workdayId, call: () => service.recover('team', f.assignment.id, input) };
 } catch (error) { await f.db.close(); throw error; }
}
async function prove(make: () => Promise<Boundary>, state: string) {
 const f = await make();
 try {
  const snapshot = async () => ({ financial: await f.snapshot(), events: (await f.query('SELECT * FROM capacity_workday_events ORDER BY event_index')).rows,
   workdays: (await f.query('SELECT * FROM capacity_workday_runs ORDER BY id')).rows });
  const before = await snapshot();
  for (const mode of ['missing', 'interrupted', 'altered', 'counter-state-missing', ...(state === 'released' ? ['reservation-state-missing'] : [])]) {
   const target = mode === 'counter-state-missing' ? 'capacity_admission_counters' : mode === 'reservation-state-missing' ? 'capacity_reservations' : 'capacity_workday_events';
   const body = target === 'capacity_workday_events' ? "IF NEW.event_type='capacity.accounting.updated' THEN " +
    (mode === 'missing' ? 'RETURN NULL;' : mode === 'altered' ? "NEW.context_json='{}';" : "RAISE EXCEPTION 'retained boundary accounting interruption';") + ' END IF; RETURN NEW;' : 'RETURN NULL;';
   await f.db.exec('CREATE FUNCTION retained_boundary_accounting_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN '+body+' END $$; CREATE TRIGGER retained_boundary_accounting_fault BEFORE '+(target === 'capacity_workday_events' ? 'INSERT' : 'UPDATE')+' ON '+target+' FOR EACH ROW EXECUTE FUNCTION retained_boundary_accounting_fault();');
   let error = ''; try { await f.call(); } catch (cause) { error = String(cause); }
   expect(error, mode + ' accounting history required at the original boundary').not.toBe(''); expect(await snapshot()).toEqual(before);
   await f.db.exec('DROP TRIGGER retained_boundary_accounting_fault ON '+target+'; DROP FUNCTION retained_boundary_accounting_fault();');
  }
  await f.call();
  const rows = (await f.query("SELECT * FROM capacity_workday_events WHERE event_type='capacity.accounting.updated' ORDER BY event_index")).rows;
  expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ assignment_id: f.id, run_id: f.workdayId, workday_id: f.workdayId, team_id: 'team' });
  const context = JSON.parse(String(rows[0]!.context_json));
  expect(context.reservation).toEqual(serializeCapacityReservationRow((await f.query('SELECT * FROM capacity_reservations WHERE id=?', [f.reservationId])).rows[0]!));
  expect(context.reservation.state).toBe(state); expect(context.usageActual).toBeNull(); expect(context.ledgerEntry).toBeNull();
  expect(context.remainingSupply.length).toBeGreaterThan(0);
  const stable = await snapshot(); await f.call(); expect(await snapshot()).toEqual(stable);
 } finally { await f.db.close(); }
}
it('records original reservation admission and remaining supply on the same transaction as assignment creation before exact replay', async () => { await prove(admittedBoundary, 'reserved'); });
it('records actual unresolved operator release and retained remaining supply without inventing usage or settlement before exact replay', async () => { await prove(recoveredBoundary, 'released'); });

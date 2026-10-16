import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { createProviderAssignmentService } from '../../../../../../src/api/control-plane/repositories/providers/provider-assignment-service.ts';
import { CapacityWorkdayEventRepository } from '../../../../../../src/api/capacity/repositories/capacity/workdays/workday-event.ts';
import { serializeCapacityReservationRow } from '../../../../../../src/api/capacity/repositories/capacity/accounting/reservation.ts';
import { serializeCapacityLedgerEntryRow } from '../../../../../../src/api/capacity/repositories/capacity/accounting/ledger.ts';
import { serializeTaskUsageActualRow } from '../../../../../../src/api/capacity/repositories/capacity/accounting/task-usage.ts';
import { executePostgresBatch } from '../../../../../../src/api/support/control-plane-postgres.ts';
import { splitPostgresSqlStatements } from '../../../../../../src/api/persistence/postgres-sql-statements.ts';
import { frozenAttempt, settlementDatabase, terminalUsage } from './settlement-fixture.ts';

const auth = { principal: { teamId: 'team', membershipId: 'membership', capacityProviderId: 'provider',
 scopes: ['provider:usage:write', 'provider:assignments:write'] } };

/** Actual public service, original SQL and event serializer with controlled
 * measurements. Independent PostgreSQL concurrency is separately required. */
async function fixture() {
 const f = await settlementDatabase();
 try {
  const ddl = splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0000_control_plane.sql', 'utf8'));
  for (const prefix of ['CREATE TABLE "capacity_workday_events" (', 'CREATE UNIQUE INDEX "idx_capacity_workday_events_run_index" ']) {
   const statements = ddl.filter(sql => sql.startsWith(prefix)); expect(statements).toHaveLength(1); await f.db.exec(statements[0]!);
  }
  await f.query('UPDATE capacity_provider_assignments SET reservation_id=? WHERE id=?', ['reservation', frozenAttempt.id]);
  const owner = { ...f.owner, db: { transaction: <T>(apply: (client: Parameters<typeof executePostgresBatch>[0]) => Promise<T>) =>
   f.db.transaction(transaction => apply(transaction as unknown as Parameters<typeof executePostgresBatch>[0])) } };
  const service = createProviderAssignmentService(owner as Parameters<typeof createProviderAssignmentService>[0]);
  const events = () => new CapacityWorkdayEventRepository(owner).list('team', 'workday', { limit: 100 });
  const snapshot = async () => ({ accounting: await f.snapshot(), events: (await f.query('SELECT * FROM capacity_workday_events ORDER BY event_index')).rows,
   runs: (await f.query('SELECT * FROM capacity_workday_runs ORDER BY id')).rows });
  return { ...f, owner, service, events, snapshot };
 } catch (error) { await f.db.close(); throw error; }
}

it('retains every accepted public usage and terminal accounting change with exact canonical snapshots and unchanged replay', async () => {
 const f = await fixture();
 try {
  const body = { assignmentAttempt: 1, usageDimension: 'checkpoint', accountingMode: 'incremental', activeSeconds: 1,
   elapsedSeconds: 1, usageActual: { ...terminalUsage.usageActual, inputTokens: 3, nativeUsage: { activeSeconds: 1, tokens: 3 } } };
  const original = structuredClone({ body, terminalUsage, auth });
  await f.service.reportUsage(auth, frozenAttempt.id, body, 'checkpoint');
  const checkpoint = await f.events();
  expect(checkpoint.items.map(event => event.eventType), 'Each accounting write requires its durable public history').toEqual(['capacity.accounting.updated']);
  const usage = serializeTaskUsageActualRow((await f.query('SELECT * FROM capacity_usage_actuals')).rows[0]!);
  const reservation = serializeCapacityReservationRow((await f.query('SELECT * FROM capacity_reservations')).rows[0]!);
  expect(checkpoint.items[0]).toMatchObject({ runId: 'workday', workdayId: 'workday', teamId: 'team', projectId: frozenAttempt.projectId,
   assignmentId: frozenAttempt.id, eventIndex: 0, status: 'recorded', createdAt: usage!.createdAt,
   context: { reservation, usageActual: usage, ledgerEntry: null } });
  const stable = await f.snapshot(); expect((await f.service.reportUsage(auth, frozenAttempt.id, body, 'checkpoint')).replayed).toBe(true);
  expect(await f.snapshot()).toEqual(stable);
  await f.service.settle(auth, frozenAttempt.id, { ...terminalUsage }, terminalUsage.settlementKey);
  const settled = await f.events(); expect(settled.items.map(event => event.eventType)).toEqual(['capacity.accounting.updated', 'capacity.accounting.updated']);
  const ledger = serializeCapacityLedgerEntryRow((await f.query('SELECT * FROM capacity_ledger_entries')).rows[0]!);
  const aggregate = serializeTaskUsageActualRow((await f.query("SELECT * FROM capacity_usage_actuals WHERE accounting_mode='aggregate'")).rows[0]!);
  expect(settled.items[1]).toMatchObject({ runId: 'workday', workdayId: 'workday', teamId: 'team', projectId: frozenAttempt.projectId,
   assignmentId: frozenAttempt.id, eventIndex: 1, createdAt: ledger!.createdAt,
   context: { reservation: serializeCapacityReservationRow((await f.query('SELECT * FROM capacity_reservations')).rows[0]!), usageActual: aggregate, ledgerEntry: ledger } });
  expect(settled.items[0]).toEqual(checkpoint.items[0]); expect(settled.page).toEqual({ limit: 100, hasMore: false, nextCursor: null });
  const final = await f.snapshot(); expect((await f.service.settle(auth, frozenAttempt.id, { ...terminalUsage }, terminalUsage.settlementKey)).replayed).toBe(true);
  expect(await f.snapshot()).toEqual(final); expect({ body, terminalUsage, auth }).toEqual(original);
 } finally { await f.db.close(); }
});

it('rolls back public accounting when a required observation is silently omitted or interrupted before an unchanged retry', async () => {
 const failures: Array<{ operation: string; mode: string; error: string }> = [];
 for (const operation of ['usage', 'settlement']) {
  const f = await fixture();
  try {
   const apply = () => operation === 'usage' ? f.service.reportUsage(auth, frozenAttempt.id, { assignmentAttempt: 1, usageDimension: 'checkpoint',
    accountingMode: 'incremental', activeSeconds: 1, elapsedSeconds: 1, usageActual: terminalUsage.usageActual }, 'checkpoint')
    : f.service.settle(auth, frozenAttempt.id, { ...terminalUsage }, terminalUsage.settlementKey);
   for (const mode of ['missing', 'interrupted']) {
    const before = await f.snapshot();
    await f.db.exec("CREATE FUNCTION retained_accounting_observation_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='capacity.accounting.updated' THEN " +
     (mode === 'missing' ? 'RETURN NULL;' : "RAISE EXCEPTION 'retained accounting observation interruption';") + ' END IF; RETURN NEW; END $$; CREATE TRIGGER retained_accounting_observation_fault BEFORE INSERT ON capacity_workday_events FOR EACH ROW EXECUTE FUNCTION retained_accounting_observation_fault();');
    let error = ''; try { await apply(); } catch (cause) { error = String(cause); }
    failures.push({ operation, mode, error });
    expect.soft(error, operation + ':' + mode + ' must fail before commit').not.toBe(''); expect.soft(await f.snapshot()).toEqual(before);
    await f.db.exec('DROP TRIGGER retained_accounting_observation_fault ON capacity_workday_events; DROP FUNCTION retained_accounting_observation_fault();');
   }
   expect((await apply()).replayed).toBe(false); const stable = await f.snapshot(); expect((await apply()).replayed).toBe(true); expect(await f.snapshot()).toEqual(stable);
  } finally { await f.db.close(); }
 }
 expect(failures).toHaveLength(4); expect(failures.every(value => value.error.length > 0)).toBe(true);
});

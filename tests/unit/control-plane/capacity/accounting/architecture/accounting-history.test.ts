import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { createProviderAssignmentService } from '../../../../../../src/api/control-plane/repositories/providers/provider-assignment-service.ts';
import { CapacityWorkdayEventRepository } from '../../../../../../src/api/capacity/repositories/capacity/workdays/workday-event.ts';
import { serializeCapacityReservationRow } from '../../../../../../src/api/capacity/repositories/capacity/accounting/reservation.ts';
import { serializeCapacityLedgerEntryRow } from '../../../../../../src/api/capacity/repositories/capacity/accounting/ledger.ts';
import { serializeTaskUsageActualRow } from '../../../../../../src/api/capacity/repositories/capacity/accounting/task-usage.ts';
import { executePostgresBatch } from '../../../../../../src/api/support/control-plane-postgres.ts';
import { capacityTransaction } from '../../../../../../src/api/capacity/transaction.ts';
import { splitPostgresSqlStatements } from '../../../../../../src/api/persistence/postgres-sql-statements.ts';
import { frozenAttempt, settlementDatabase, terminalUsage } from './settlement-fixture.ts';

const auth = { principal: { teamId: 'team', membershipId: 'membership', capacityProviderId: 'provider',
 scopes: ['provider:usage:write', 'provider:assignments:write'] } };

it('retains the owning transaction connection and rolls back a caught nested accounting failure to its original savepoint', async () => {
 const f = await fixture();
 try {
  await capacityTransaction(f.owner, async outer => {
   await outer.run('UPDATE capacity_reservations SET active_seconds=2 WHERE id=?', ['reservation']);
   let error = ''; try { await capacityTransaction(outer, async inner => {
    expect((await inner.first('SELECT active_seconds FROM capacity_reservations WHERE id=?', ['reservation']))?.active_seconds).toBe(2);
    await inner.run('UPDATE capacity_reservations SET active_seconds=9 WHERE id=?', ['reservation']); throw new Error('retained nested accounting failure');
   }); } catch (cause) { error = String(cause); }
   expect(error).toContain('retained nested accounting failure');
   expect((await outer.first('SELECT active_seconds FROM capacity_reservations WHERE id=?', ['reservation']))?.active_seconds).toBe(2);
  });
  expect((await f.query('SELECT active_seconds FROM capacity_reservations WHERE id=?', ['reservation'])).rows).toEqual([{ active_seconds: 2 }]);
 } finally { await f.db.close(); }
});

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

it('rejects silently omitted terminal usage ledger reservation counter or claim writes without retaining partial accounting and permits exact retry', async () => {
 for (const table of ['capacity_usage_actuals', 'capacity_ledger_entries', 'capacity_reservations', 'capacity_admission_counters', 'capacity_reservation_counter_claims']) {
  const f = await fixture();
  try {
   const before = await f.snapshot(), update = !['capacity_usage_actuals', 'capacity_ledger_entries'].includes(table);
   await f.db.exec('CREATE FUNCTION retained_accounting_state_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ' +
    (table === 'capacity_reservations' ? "IF NEW.state='consumed' THEN RETURN NULL; END IF; RETURN NEW;" : 'RETURN NULL;') +
    ' END $$; CREATE TRIGGER retained_accounting_state_fault BEFORE ' + (update ? 'UPDATE' : 'INSERT') + ' ON ' + table + ' FOR EACH ROW EXECUTE FUNCTION retained_accounting_state_fault();');
   let error = ''; try { await f.service.settle(auth, frozenAttempt.id, { ...terminalUsage }, terminalUsage.settlementKey); } catch (cause) { error = String(cause); }
   expect.soft(error, table + ' requires complete owning state').not.toBe(''); expect.soft(await f.snapshot(), table + ' must roll back every attempted write').toEqual(before);
   await f.db.exec('DROP TRIGGER retained_accounting_state_fault ON ' + table + '; DROP FUNCTION retained_accounting_state_fault();');
   // If the broken candidate committed anything, retain that original failure;
   // never delete or repair fixture rows to manufacture a clean retry.
   if (JSON.stringify(await f.snapshot()) === JSON.stringify(before)) {
    expect((await f.service.settle(auth, frozenAttempt.id, { ...terminalUsage }, terminalUsage.settlementKey)).replayed).toBe(false);
   }
  } finally { await f.db.close(); }
 }
});

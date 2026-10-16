import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { postgresGraph } from '../../execution/graph/architecture/living/living-postgres-fixture.ts';
import { copyNativeAssignmentCustody } from '../../../providers/assignments/architecture/native-assignment-custody.ts';
import { frozenAttempt, settlementDatabase, terminalUsage } from './settlement-fixture.ts';
import { ControlPlaneStore } from '../../../../../../src/api/persistence/store.ts';
import { createProviderAssignmentService } from '../../../../../../src/api/control-plane/repositories/providers/provider-assignment-service.ts';
import { CapacityWorkdayEventRepository } from '../../../../../../src/api/capacity/repositories/capacity/workdays/workday-event.ts';
import { serializeCapacityReservationRow } from '../../../../../../src/api/capacity/repositories/capacity/accounting/reservation.ts';
import { serializeTaskUsageActualRow } from '../../../../../../src/api/capacity/repositories/capacity/accounting/task-usage.ts';
import { serializeCapacityLedgerEntryRow } from '../../../../../../src/api/capacity/repositories/capacity/accounting/ledger.ts';

const auth = { principal: { teamId: 'team', membershipId: 'membership', capacityProviderId: 'provider', scopes: ['provider:usage:write', 'provider:assignments:write'] } };
const tables = ['capacity_workday_runs', 'execution_nodes', 'capacity_reservations', 'capacity_provider_assignments', 'capacity_admission_counters', 'capacity_reservation_counter_claims','capacity_workday_events'];

it('native PostgreSQL accounting producers retain exact complete public observations across competing requests interruption missing writes denial and unchanged retry', async () => {
 const failures: Array<{ operation: string; mode: string; error: string; custodySha256: string }> = [];
 for (const operation of ['usage', 'settlement']) {
  const native = await postgresGraph();
  try {
   const supplied = await settlementDatabase();
   try { await supplied.query('UPDATE capacity_provider_assignments SET reservation_id=? WHERE id=?', ['reservation', frozenAttempt.id]);
    await copyNativeAssignmentCustody(native.left, { attempt: frozenAttempt, query: supplied.query }, tables);
   } finally { await supplied.db.close(); }
   const stores = [native.left, native.right].map(database => { const store = new ControlPlaneStore({ TREESEED_ENVIRONMENT: 'test' }, database); store.initializationPromise = Promise.resolve(); return store; });
   const services = stores.map(store => createProviderAssignmentService(store));
   const connections = await Promise.all([native.left, native.right].map(database => database.pool.query('SELECT pg_backend_pid() AS pid,current_database() AS name')));
   expect(connections.map(result => result.rows[0].name)).toEqual([native.name, native.name]); expect(connections[0]!.rows[0].pid).not.toBe(connections[1]!.rows[0].pid);
   const body = operation === 'usage' ? { assignmentAttempt: 1, usageDimension: 'checkpoint', accountingMode: 'incremental', activeSeconds: 1,
    elapsedSeconds: 1, usageActual: { ...terminalUsage.usageActual, inputTokens: 3, nativeUsage: { activeSeconds: 1, tokens: 3 } } } : { ...terminalUsage };
   const key = operation === 'usage' ? 'native-accounting-checkpoint' : terminalUsage.settlementKey;
   const apply = (index: number, changes = {}, principal = auth) => operation === 'usage' ? services[index]!.reportUsage(principal, frozenAttempt.id, { ...body, ...changes }, key)
    : services[index]!.settle(principal, frozenAttempt.id, { ...body, ...changes }, key);
   const snapshot = async () => Object.fromEntries(await Promise.all([...tables, 'capacity_usage_actuals', 'capacity_ledger_entries'].map(async table =>
    [table, (await native.right.pool.query('SELECT * FROM '+table+' ORDER BY '+(table === 'capacity_reservation_counter_claims' ? 'reservation_id,counter_id' : 'id'))).rows])));
   const events = () => new CapacityWorkdayEventRepository(stores[1]!).list('team', 'workday', { limit: 100 });
   const original = structuredClone({ body, auth, frozenAttempt }), before = await snapshot();
   for (const mode of ['missing', 'interrupted', 'altered', 'usage-state-missing', ...(operation==='settlement'?['ledger-state-missing','reservation-state-missing','counter-state-missing','claim-state-missing']:[])]) {
    const target=mode==='usage-state-missing'?'capacity_usage_actuals':mode==='ledger-state-missing'?'capacity_ledger_entries':mode==='reservation-state-missing'?'capacity_reservations':mode==='counter-state-missing'?'capacity_admission_counters':mode==='claim-state-missing'?'capacity_reservation_counter_claims':'capacity_workday_events';
    const body=target==='capacity_workday_events'?"IF NEW.event_type='capacity.accounting.updated' THEN "+(mode==='missing'?'RETURN NULL;':mode==='altered'?"NEW.context_json='{}';":"RAISE EXCEPTION 'retained native accounting interruption';")+' END IF; RETURN NEW;':target==='capacity_reservations'?"IF NEW.state='consumed' THEN RETURN NULL; END IF; RETURN NEW;":'RETURN NULL;';
    await native.left.pool.query('CREATE FUNCTION retained_native_accounting_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN '+body+' END $$');
    await native.left.pool.query('CREATE TRIGGER retained_native_accounting_fault BEFORE '+(['capacity_reservations','capacity_admission_counters','capacity_reservation_counter_claims'].includes(target)?'UPDATE':'INSERT')+' ON '+target+' FOR EACH ROW EXECUTE FUNCTION retained_native_accounting_fault()');
    let error = ''; try { await apply(0); } catch (cause) { error = String(cause); }
    failures.push({ operation, mode, error, custodySha256: createHash('sha256').update(JSON.stringify(await snapshot())).digest('hex') });
    expect(error, operation + ':' + mode + ' must reject before commit').not.toBe(''); expect(await snapshot()).toEqual(before);
    await native.left.pool.query('DROP TRIGGER retained_native_accounting_fault ON '+target); await native.left.pool.query('DROP FUNCTION retained_native_accounting_fault()');
   }
   for (const change of [{ assignmentAttempt: 2 }, { activeSeconds: '1' }]) { await expect(apply(0, change)).rejects.toThrow(); expect(await snapshot()).toEqual(before); }
   await expect(apply(0, {}, { principal: { ...auth.principal, capacityProviderId: 'foreign-provider' } })).rejects.toThrow(); expect(await snapshot()).toEqual(before);
   const results = await Promise.all([apply(0), apply(1)]); expect(results.map(result => result.replayed).sort()).toEqual([false, true]);
   const history = await events(); expect(history.items).toHaveLength(1); expect(history.page).toEqual({ limit: 100, hasMore: false, nextCursor: null });
   const raw = (await native.right.pool.query('SELECT * FROM capacity_workday_events ORDER BY event_index')).rows; expect(raw).toHaveLength(1);
   const usage = serializeTaskUsageActualRow((await native.right.pool.query('SELECT * FROM capacity_usage_actuals')).rows[0]!);
   const ledger = serializeCapacityLedgerEntryRow((await native.right.pool.query('SELECT * FROM capacity_ledger_entries')).rows[0] ?? null);
   const reservation = serializeCapacityReservationRow((await native.right.pool.query('SELECT * FROM capacity_reservations')).rows[0]!);
   expect(history.items[0]).toMatchObject({ id: raw[0]!.id, eventType: 'capacity.accounting.updated', eventIndex: 0, runId: 'workday', workdayId: 'workday',
    teamId: 'team', projectId: frozenAttempt.projectId, assignmentId: frozenAttempt.id, createdAt: ledger?.createdAt ?? usage!.createdAt,
    context: { reservation, usageActual: usage, ledgerEntry: ledger } });
   expect(JSON.parse(String(raw[0]!.context_json))).toEqual(history.items[0]!.context);
   expect(history.items[0]!.context.remainingSupply).toEqual([
 {id:'concurrency',teamId:'team',scope:'concurrency',scopeId:'provider',periodKey:'current',hardLimit:1,committedAmount:(operation==='settlement')?0:1,stateVersion:(operation==='settlement')?2:1,reservedAmount:1,releasedAmount:(operation==='settlement')?1:0,releasePolicy:'assignment-terminal',remainingAmount:(operation==='settlement')?1:0},
 {id:'seconds',teamId:'team',scope:'model-active-seconds',scopeId:'provider',periodKey:'day',hardLimit:3,committedAmount:2,stateVersion:(operation==='settlement')?2:1,reservedAmount:2,releasedAmount:0,releasePolicy:'period',remainingAmount:1}
]);
   const retained = await snapshot(); expect((await apply(1)).replayed).toBe(true); expect(await snapshot()).toEqual(retained); expect(await events()).toEqual(history);
   await expect(apply(0, { activeSeconds: 9 })).rejects.toThrow(); expect(await snapshot()).toEqual(retained); expect({ body, auth, frozenAttempt }).toEqual(original);
  } finally { await native.close(); }
 }
 expect(failures).toHaveLength(12); console.log(JSON.stringify({ retainedNativeAccountingFailures: failures }));
 // Complete original migrations and independent native connections, supplied
 // measurements and principals; no provider-generated or managed pass claim.
});

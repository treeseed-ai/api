import * as transactions from '../../../../../../../src/api/capacity/transaction.ts';
import {eventObserved} from '../../../../realtime/architecture/session-postgres-fixture.ts';
import {ControlPlaneStore} from '../../../../../../../src/api/persistence/store.ts';
import {createCapacityControlPlane} from '../../../../../../../src/api/capacity/control-plane.ts';
import {createWorkdayService} from '../../../../../../../src/api/control-plane/repositories/capacity/workday-service.ts';
import {copyNativeAssignmentCustody} from '../native-assignment-custody.ts';
import { describe, expect, it, vi } from 'vitest';
import { postgresGraph } from '../../../../capacity/execution/graph/architecture/living/living-postgres-fixture.ts';
import { cancellationDatabase } from '../cancellation-fixture.ts';
import { OperatorAssignmentService } from '../../../../../../../src/api/capacity/services/capacity/assignments/observability/operator-assignment-service.ts';
import { createAssignmentService } from '../../../../../../../src/api/control-plane/repositories/capacity/assignment-service.ts';
import { createAssignmentOperations } from '../../../../../../../src/api/control-plane/catalog/capacity/assignments.ts';
import { OperationRegistry } from '../../../../../../../src/api/control-plane/catalog/operation-registry.ts';
import { settleCapacityReservationExactlyOnce } from '../../../../../../../src/api/capacity/services/capacity/accounting/settlement-service.ts';
import { terminalUsage } from '../../../../capacity/accounting/architecture/settlement-fixture.ts';
import { createProviderAssignmentService } from '../../../../../../../src/api/control-plane/repositories/providers/provider-assignment-service.ts';
import { ProviderAssignmentRepository } from '../../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';

async function exercisePostgresRecovery(dispute: boolean) {
		const native = await postgresGraph();
		try {
			// Controlled original owning fixture inputs, not fabricated provider charges.
			const supplied = await cancellationDatabase('expired');
			try {

				await supplied.query("UPDATE capacity_provider_assignments SET lease_state='expired',metadata_json=? WHERE id=?",
					[JSON.stringify({ leaseRecovery: { disposition: 'operator-action' } }), supplied.assignment.id]);
				if (dispute) await settleCapacityReservationExactlyOnce(supplied.owner, { ...terminalUsage,
					activeSeconds: 0, elapsedSeconds: 0, source: 'capacity_workday_deadline_terminalization', usageActual: undefined });
				await copyNativeAssignmentCustody(native.left,supplied,['capacity_workday_runs','execution_nodes','capacity_reservations','capacity_provider_assignments','capacity_admission_counters','capacity_reservation_counter_claims',...(dispute?['capacity_usage_actuals','capacity_ledger_entries']:[])]);
			} finally { await supplied.db.close(); }
			const audit = () => native.left.pool.query('SELECT * FROM capacity_audit_events ORDER BY id');
			const assignments = () => native.left.pool.query('SELECT * FROM capacity_provider_assignments ORDER BY id');
			const held = (await assignments()).rows;
			const accounting = async () => ({
				reservation: (await native.left.pool.query('SELECT * FROM capacity_reservations ORDER BY id')).rows,
				usage: (await native.left.pool.query('SELECT * FROM capacity_usage_actuals ORDER BY id')).rows,
				ledger: (await native.left.pool.query('SELECT * FROM capacity_ledger_entries ORDER BY id')).rows,
				claims: (await native.left.pool.query('SELECT * FROM capacity_reservation_counter_claims ORDER BY reservation_id,counter_id')).rows,
				counters: (await native.left.pool.query('SELECT * FROM capacity_admission_counters ORDER BY id')).rows });
			const original = await accounting();
			const reads: Array<(recovery: unknown) => Promise<void>> = [];
			const calls = [native.left, native.right].map(db => {
				const store = { db, ensureInitialized: async () => {},
					run: async (sql: string, params: unknown[] = []) => { await db.prepare(sql).bind(...params).run(); },
					first: <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => db.prepare(sql).bind(...params).first<T>(),
					all: async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.prepare(sql).bind(...params).all<T>()).results,
					batch: (operations: Array<{ query: string; params?: unknown[] }>) => db.batch(operations) };
				const repository = new ProviderAssignmentRepository(store);
				const unused = async () => { throw new Error('Provider audit read cannot invoke productive lifecycle'); };
				const provider = createProviderAssignmentService({ ...store, getProviderAssignment: (team, id) => repository.get(team, id),
					leaseNextProviderAssignment: unused, renewProviderAssignmentLease: unused, returnProviderAssignment: unused,
					completeProviderAssignment: unused, failProviderAssignment: unused,
					createCapacityWorkdayRun: unused, tickCapacityWorkdayRun: unused, updateCapacityWorkdayRun: unused });
				reads.push(async recovery => {
					const principal = { principal: { teamId: 'team', capacityProviderId: 'provider', membershipId: 'membership', scopes: ['provider:assignments:read'] } };
					expect(await provider.show(principal, 'assignment-report')).toEqual({
						...await repository.get('team', 'assignment-report'), unresolvedUsageRecovery: recovery });
				});
				const operator = new OperatorAssignmentService(store);
				const service = createAssignmentService({ ...store, recoverCapacityAssignment: (team: string, id: string, body: Record<string, unknown>) => operator.recover(team, id, body) });
				const registry = new OperationRegistry(createAssignmentOperations({ assignments: service }));
				return () => registry.require('assignments.recover').handler({ path: { teamId: 'team', assignmentId: 'assignment-report' }, query: {},
					body: { expectedStateVersion: 1, reason: 'Original native usage unavailable' } }, { interface: 'rest', requestId: 'native-recovery',
					principal: { id: 'operator', roles: ['admin'] }, idempotencyKey: 'independent-recovery' });
			});
			await native.left.pool.query(`CREATE FUNCTION interrupt_operator_recovery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'independent audit interruption'; END $$;
				CREATE TRIGGER interrupt_operator_recovery BEFORE INSERT ON capacity_audit_events FOR EACH ROW EXECUTE FUNCTION interrupt_operator_recovery();`);
			await expect(calls[0]!()).rejects.toThrow('independent audit interruption');
			expect((await assignments()).rows).toEqual(held); expect((await audit()).rows).toEqual([]);
			expect(await accounting()).toEqual(original);
			expect((await native.left.pool.query('SELECT id,committed_amount FROM capacity_admission_counters ORDER BY id')).rows)
				.toEqual([{ id: 'concurrency', committed_amount: dispute ? 0 : 1 }, { id: 'seconds', committed_amount: dispute ? 0 : 2 }]);
			await native.left.pool.query('DROP TRIGGER interrupt_operator_recovery ON capacity_audit_events');
			const results = await Promise.all(calls.map(call => call())); expect(results[0]).toEqual(results[1]);
			expect(results[0]).toMatchObject({ usageStatus: 'unresolved', settled: false }); expect((await audit()).rows).toHaveLength(dispute ? 2 : 1);
			expect((await assignments()).rows).toEqual(held);
			expect((await native.left.pool.query('SELECT id,committed_amount FROM capacity_admission_counters ORDER BY id')).rows)
				.toEqual([{ id: 'concurrency', committed_amount: 0 }, { id: 'seconds', committed_amount: 2 }]);
			expect((await native.left.pool.query('SELECT * FROM capacity_usage_actuals ORDER BY id')).rows).toEqual(original.usage);
			expect((await native.left.pool.query('SELECT * FROM capacity_ledger_entries ORDER BY id')).rows).toEqual(original.ledger);
			if (dispute) {
				const after = await accounting(); expect(after.reservation).toEqual(original.reservation);
				const audits = (await audit()).rows, retained = audits.find(value => value.action === 'assignment.settlement.disputed');
				expect(JSON.parse(String(retained?.metadata_json))).toEqual({ originalLedger: original.ledger, originalUsage: original.usage, originalClaims: original.claims });
				expect(after.claims.map(value => ({ counter: value.counter_id, released: value.released_amount })))
					.toEqual([{ counter: 'concurrency', released: 1 }, { counter: 'seconds', released: 0 }]);
				expect(after.counters.find(value => value.id === 'concurrency')).toEqual(original.counters.find(value => value.id === 'concurrency'));
			}
			const final = await accounting(), finalAudit = (await audit()).rows;
			await Promise.all(reads.map(read => read(results[0])));
			expect(await calls[0]!()).toEqual(results[0]);
			expect(await accounting()).toEqual(final); expect((await audit()).rows).toEqual(finalAudit);
		} finally { await native.close(); }
}

describe('unresolved recovery with independent native PostgreSQL connections', () => {
	it('native PostgreSQL public recovery rolls back an interrupted audit then serializes independent matching operator calls without measurements or historical rewrites', async () => {
		await exercisePostgresRecovery(false);
	});
	it('native PostgreSQL settlement dispute restores only original holds after atomic audit rollback and independent matching calls without rewriting zero history', async () => {
		await exercisePostgresRecovery(true);
	});
});

async function exerciseNativeCancellation(status: 'leased' | 'returned' | 'retry') {
 const native=await postgresGraph();
 try {
  const supplied=await cancellationDatabase(status==='leased'?'leased':'returned',status==='returned');const attempt=supplied.attempt;
  try {
   if(status==='returned')await settleCapacityReservationExactlyOnce(supplied.owner,terminalUsage);
   if(status==='retry')await supplied.query("UPDATE execution_nodes SET status='failed' WHERE id=?",[attempt.nodeId]);
   await copyNativeAssignmentCustody(native.left,supplied,['capacity_workday_runs','execution_nodes','capacity_reservations','capacity_provider_assignments','capacity_admission_counters','capacity_reservation_counter_claims','capacity_usage_actuals','capacity_ledger_entries']);
  }finally{await supplied.db.close();}
  const owners=[native.left,native.right].map(db=>{const host=new ControlPlaneStore({TREESEED_ENVIRONMENT:'test'},db);host.initializationPromise=Promise.resolve();return createCapacityControlPlane(host);});
  const services=owners.map(owner=>createAssignmentService(owner)),body={reason:'Original independent native cancellation'},held=structuredClone(body);
  const calls=services.map(service=>async()=>status==='retry'?(await service.retry(native.principal,'team',attempt.id,body,'original-native-cancellation')).assignment:service.cancel(native.principal,'team',attempt.id,body,'original-native-cancellation'));
  const snapshot=async()=>Object.fromEntries(await Promise.all(['capacity_provider_assignments','capacity_workday_runs','capacity_workday_events','execution_nodes','capacity_reservations','capacity_admission_counters','capacity_reservation_counter_claims','capacity_usage_actuals','capacity_ledger_entries'].map(async table=>[table,(await native.right.pool.query('SELECT * FROM '+table+' ORDER BY 1,2')).rows])));
  const before=await snapshot(),failures:unknown[]=[];
  await expect(services[0]![status==='retry'?'retry':'cancel'](undefined,'team',attempt.id,body,'denied')).rejects.toMatchObject({status:401});
  await expect(services[0]![status==='retry'?'retry':'cancel'](native.principal,'foreign-team',attempt.id,body,'denied')).rejects.toMatchObject({status:404});
  await expect(services[0]![status==='retry'?'retry':'cancel'](native.principal,'team',attempt.id,body,'')).rejects.toMatchObject({status:400});
  expect(await snapshot()).toEqual(before);
  for(const mode of ['missing','interrupted']as const){
   await native.left.pool.query('CREATE FUNCTION native_cancel_observation_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN '+(mode==='missing'?'RETURN NULL;':"RAISE EXCEPTION 'retained native cancellation interruption';")+' END $$');
   await native.left.pool.query('CREATE TRIGGER native_cancel_observation_fault BEFORE INSERT ON capacity_workday_events FOR EACH ROW EXECUTE FUNCTION native_cancel_observation_fault()');
   let failed:unknown;
   try{await calls[0]!();}catch(error){failed=error;}
   finally{await native.left.pool.query('DROP TRIGGER native_cancel_observation_fault ON capacity_workday_events');await native.left.pool.query('DROP FUNCTION native_cancel_observation_fault()');}
   expect(failed).toMatchObject({message:expect.stringContaining(mode==='interrupted'?'retained native cancellation interruption':status==='leased'?'Exact durable cancellation request observation required.':status==='returned'?'Exact durable terminal cancellation observation required.':'Exact durable retry observation required.')});
   expect(await snapshot()).toEqual(before);failures.push(failed);
  }
  const outcomes=[];
  if(status==='returned'){
   let release=()=>{},entered=()=>{},held=false,firstClock='';const gate=new Promise<void>(resolve=>release=resolve),ready=new Promise<void>(resolve=>entered=resolve),real=transactions.capacityTransaction;
   const spy=vi.spyOn(transactions,'capacityTransaction').mockImplementation(async(store,apply)=>{const result=await real(store,apply);if(!held&&result&&typeof result==='object'&&Reflect.get(result,'status')==='cancelled'){held=true;firstClock=String(Reflect.get(result,'updatedAt'));entered();await gate;}return result;});
   const pending=calls[0]!();try{await Promise.race([ready,pending.then(()=>{throw new Error('Original native terminal transaction barrier not reached');})]);await eventObserved(()=>Date.now()>Date.parse(firstClock));const second=await calls[1]!(),beforeCleanup=await snapshot();release();outcomes.push(await pending,second);expect(await snapshot()).toEqual(beforeCleanup);}finally{release();await pending.catch(()=>undefined);spy.mockRestore();}
  }else outcomes.push(...await Promise.all(calls.map(call=>call())));
  expect(outcomes[0]).toEqual(outcomes[1]);
  const first=outcomes[0]!;expect(first).toMatchObject({status:status==='leased'?'leased':status==='returned'?'cancelled':'returned',stateVersion:2});
  expect(first.assignmentAttempt).toEqual(status!=='returned'?{...attempt}:{...attempt,status:'cancelled',finishedAt:first.assignmentAttempt!.finishedAt});
  const raw=(await native.right.pool.query('SELECT * FROM capacity_workday_events WHERE assignment_id=$1 ORDER BY event_index',[attempt.id])).rows;
  expect(raw).toHaveLength(1);const row=raw[0]!,type=status==='leased'?'assignment.cancellation-requested':status==='returned'?'assignment.cancelled':'assignment.retry-requested';
  expect(row).toMatchObject({event_type:type,team_id:attempt.teamId,project_id:attempt.projectId,run_id:attempt.workdayId,workday_id:attempt.workdayId});
  const retry=first.metadata.operatorRetry;const observedAt=status==='retry'&&retry&&typeof retry==='object'&&!Array.isArray(retry)?Reflect.get(retry,'requestedAt'):status==='leased'?first.metadata.cancellationRequestedAt:first.assignmentAttempt!.finishedAt;expect(row.created_at).toBe(observedAt);
  if(status==='retry'){const node=(await native.right.pool.query('SELECT status,node_revision FROM execution_nodes WHERE id=$1',[attempt.nodeId])).rows;expect(node).toEqual([{status:'ready',node_revision:2}]);expect(JSON.parse(String(row.context_json))).toMatchObject({nodeId:attempt.nodeId,nodeRevision:2,stateVersion:2});}
  expect(JSON.stringify(row)).not.toContain('lease-token');
  const publicEvents=await createWorkdayService(owners[1]!).events(native.principal,'team',attempt.workdayId,{limit:1});
  expect(publicEvents.items).toHaveLength(1);expect(publicEvents.page.hasMore).toBe(false);expect(publicEvents.items[0]).toMatchObject({id:row.id,eventType:type,createdAt:observedAt});
  expect(await services[1]!.show(native.principal,'team',attempt.id)).toMatchObject(first);
  const after=await snapshot();for(const table of ['capacity_reservations','capacity_admission_counters','capacity_reservation_counter_claims','capacity_usage_actuals','capacity_ledger_entries'])expect(after[table]).toEqual(before[table]);
  expect(await calls[1]!()).toEqual(first);expect(await snapshot()).toEqual(after);expect(body).toEqual(held);expect(failures).toHaveLength(2);
 }finally{await native.close();}
}


describe('native public cancellation observation custody',()=>{
 it('native PostgreSQL active cancellation serializes original request and exact public history after missing and interrupted observations',async()=>exerciseNativeCancellation('leased'));
 it('native PostgreSQL released cancellation serializes original terminal state and exact public history after missing and interrupted observations',async()=>exerciseNativeCancellation('returned'));
});

it('native PostgreSQL public retry serializes original node reopening and exact public history after missing and interrupted observations',async()=>exerciseNativeCancellation('retry'));

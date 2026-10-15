import * as transactions from '../../../../../../src/api/capacity/transaction.ts';
import {CapacityWorkdayEventRepository} from '../../../../../../src/api/capacity/repositories/capacity/workdays/workday-event.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperatorAssignmentService } from '../../../../../../src/api/capacity/services/capacity/assignments/observability/operator-assignment-service.ts';
import { settleCapacityReservationExactlyOnce } from '../../../../../../src/api/capacity/services/capacity/accounting/settlement-service.ts';
import { terminalUsage } from '../../../capacity/accounting/architecture/settlement-fixture.ts';
import { cancellationDatabase, cancelNow } from './cancellation-fixture.ts';
import { ProviderAssignmentRepository } from '../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';
import { validateProviderAssignment } from '@treeseed/sdk/agent-capacity';

afterEach(() => vi.useRealTimers());
function atNow() { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(cancelNow)); }
// REAL owning cancellation/repository/accounting + original DDL/PGlite.
// No authenticated HTTP, provider-generated clocks/usage, physical teardown,
// or separate PostgreSQL connection concurrency is claimed.
describe('cancellation retains productive and financial authority through original SQL', () => {
 it('retains the first actual revocation and updated clock when a stale released cancellation resumes after another cleanup has completed',async()=>{
  const f=await cancellationDatabase('returned',true);let release=()=>{},entered=()=>{};const gate=new Promise<void>(resolve=>release=resolve),ready=new Promise<void>(resolve=>entered=resolve);let held=false,pending:ReturnType<OperatorAssignmentService['cancel']>|undefined;const real=transactions.capacityTransaction;
  const spy=vi.spyOn(transactions,'capacityTransaction').mockImplementation(async(store,apply)=>{const result=await real(store,apply);if(!held&&result&&typeof result==='object'&&Reflect.get(result,'status')==='cancelled'){held=true;entered();await gate;}return result;});
  try{atNow();await settleCapacityReservationExactlyOnce(f.owner,terminalUsage);const service=new OperatorAssignmentService(f.owner),input={idempotencyKey:'original-delayed-cleanup',actorId:'operator',reason:'Retain original exact cleanup.'};pending=service.cancel('team',f.assignment.id,input);await Promise.race([ready,pending.then(()=>{throw new Error('Original terminal transaction barrier was not reached');})]);vi.setSystemTime(new Date(Date.parse(cancelNow)+1_000));const second=await service.cancel('team',f.assignment.id,input),before=await f.snapshot();release();const first=await pending;pending=undefined;expect(first).toEqual(second);expect(await f.snapshot()).toEqual(before);
  }finally{release();if(pending)await pending.catch(()=>undefined);spy.mockRestore();await f.db.close();vi.useRealTimers();}
 });

 it('native retry publishes one original owning observation and unchanged replay retains terminal authority and first request clock',async()=>{
  const f=await cancellationDatabase('returned');try{
   atNow();await f.query("UPDATE execution_nodes SET status='failed' WHERE id=?",[f.attempt.nodeId]);
   const service=new OperatorAssignmentService(f.owner),input={idempotencyKey:'original-retry',actorId:'operator',reason:'Original bounded retry request.'},held=structuredClone(input);
   const first=await service.requeue('team',f.assignment.id,input);
   const observations=(await f.query('SELECT * FROM capacity_workday_events WHERE assignment_id=? ORDER BY event_index',[f.assignment.id])).rows;
   expect.soft(observations,'retry requires one original durable owning observation').toHaveLength(1);
   const actual=await new ProviderAssignmentRepository(f.owner).get('team',f.assignment.id);expect(actual!.assignmentAttempt).toEqual(f.attempt);expect(actual!.status).toBe('returned');
   const snapshot=async()=>({custody:await f.snapshot(),events:(await f.query('SELECT * FROM capacity_workday_events ORDER BY event_index')).rows,runs:(await f.query('SELECT * FROM capacity_workday_runs ORDER BY id')).rows}),before=await snapshot();
   vi.setSystemTime(new Date(Date.parse(cancelNow)+1_000));await service.requeue('team',f.assignment.id,input);expect(await snapshot()).toEqual(before);expect(input).toEqual(held);
   expect(first.assignment.assignmentAttempt).toEqual(f.attempt);
  }finally{await f.db.close();}
 });

 it('native active cancellation publishes one owning request observation and exact replay preserves the first request clock and immutable attempt',async()=>{
  const f=await cancellationDatabase();try{
   atNow();

   const input={idempotencyKey:'original-cancel-request',actorId:'operator',reason:'Original bounded cancellation request.'},held=structuredClone(input),service=new OperatorAssignmentService(f.owner);
   const snapshotBefore=async()=>({custody:await f.snapshot(),events:(await f.query('SELECT * FROM capacity_workday_events ORDER BY event_index')).rows,workdays:(await f.query('SELECT * FROM capacity_workday_runs ORDER BY id')).rows}),initial=await snapshotBefore();
   const failures:unknown[]=[];
   for(const mode of ['missing','interrupted']as const){
    await f.db.exec('CREATE FUNCTION native_cancellation_observation_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN '+(mode==='missing'?'RETURN NULL;':"RAISE EXCEPTION 'retained cancellation observation interruption';")+' END $$');
    await f.db.exec('CREATE TRIGGER native_cancellation_observation_failure BEFORE INSERT ON capacity_workday_events FOR EACH ROW EXECUTE FUNCTION native_cancellation_observation_failure()');
    let failure:unknown;try{await service.cancel('team',f.assignment.id,input);}catch(error){failure=error;}
    finally{await f.db.exec('DROP TRIGGER native_cancellation_observation_failure ON capacity_workday_events');await f.db.exec('DROP FUNCTION native_cancellation_observation_failure()');}
    expect(failure).toMatchObject({message:mode==='missing'?'Exact durable cancellation request observation required.':'retained cancellation observation interruption'});expect(await snapshotBefore()).toEqual(initial);expect(input).toEqual(held);failures.push(failure);
   }
   const first=await service.cancel('team',f.assignment.id,input);expect(failures).toHaveLength(2);

   const observations=(await f.query('SELECT * FROM capacity_workday_events WHERE assignment_id=? ORDER BY event_index',[f.assignment.id])).rows;
   expect.soft(observations,'active cancellation requires one durable owning observation').toHaveLength(1);
   const originalEvent=observations[0]!;const columns=Object.keys(originalEvent),duplicate={...originalEvent,id:'denied-duplicate-event-index'};
   await expect(f.query('INSERT INTO capacity_workday_events ('+columns.join(',')+') VALUES ('+columns.map(()=>'?').join(',')+')',columns.map(column=>Reflect.get(duplicate,column)))).rejects.toMatchObject({code:'23505'});
   expect((await f.query('SELECT * FROM capacity_workday_events ORDER BY event_index')).rows).toEqual(observations);
   if(observations.length===1){const event=observations[0]!;expect(event).toMatchObject({team_id:first.teamId,run_id:first.workDayId,assignment_id:first.id,event_type:'assignment.cancellation-requested',created_at:cancelNow});expect(await new CapacityWorkdayEventRepository(f.owner).get('team',first.workDayId!,String(event.id))).toMatchObject({eventType:'assignment.cancellation-requested',createdAt:cancelNow});}
   const snapshot=async()=>({custody:await f.snapshot(),events:(await f.query('SELECT * FROM capacity_workday_events ORDER BY event_index')).rows,workdays:(await f.query('SELECT * FROM capacity_workday_runs ORDER BY id')).rows}),before=await snapshot();
   vi.setSystemTime(new Date(Date.parse(cancelNow)+1_000));const replay=await service.cancel('team',f.assignment.id,input);
   console.log(JSON.stringify({nativeCancellationRequestReplay:{firstVersion:first.stateVersion,replayedVersion:replay.stateVersion,observations:observations.length}}));
   expect(replay).toEqual(first);expect(await snapshot()).toEqual(before);expect(input).toEqual(held);expect(replay.assignmentAttempt).toEqual(f.attempt);
  }finally{await f.db.close();}
 });

	it('native operator cancellation advances only canonical terminal metadata and retains exact failed history on replay', async () => {
		const native = await cancellationDatabase('returned', true);
		try {
			atNow(); await settleCapacityReservationExactlyOnce(native.owner, terminalUsage);
			const before = await new ProviderAssignmentRepository(native.owner).get('team', native.assignment.id);
			if (!before?.assignmentAttempt) throw new Error('Missing original canonical attempt');
			const service = new OperatorAssignmentService(native.owner), input = { idempotencyKey: 'canonical-cancellation' };
			const original = structuredClone(input);
   const snapshot=async()=>({custody:await native.snapshot(),events:(await native.query('SELECT * FROM capacity_workday_events ORDER BY event_index')).rows,runs:(await native.query('SELECT * FROM capacity_workday_runs ORDER BY id')).rows}),initial=await snapshot();
   const failures:unknown[]=[];
   for(const mode of ['missing','interrupted']as const){
    await native.db.exec('CREATE FUNCTION cancellation_terminal_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN '+(mode==='missing'?'RETURN NULL;':"RAISE EXCEPTION 'retained terminal cancellation interruption';")+' END $$');
    await native.db.exec('CREATE TRIGGER cancellation_terminal_fault BEFORE INSERT ON capacity_workday_events FOR EACH ROW EXECUTE FUNCTION cancellation_terminal_fault()');
    let failure:unknown;try{await service.cancel('team',before.id,input);}catch(error){failure=error;}
    finally{await native.db.exec('DROP TRIGGER cancellation_terminal_fault ON capacity_workday_events');await native.db.exec('DROP FUNCTION cancellation_terminal_fault()');}
    expect(failure).toMatchObject({message:mode==='missing'?'Exact durable terminal cancellation observation required.':'retained terminal cancellation interruption'});
    expect(await snapshot()).toEqual(initial);expect(input).toEqual(original);failures.push(failure);
   }
   const result=await service.cancel('team',before.id,input);expect(failures).toHaveLength(2);
			expect(result.assignmentAttempt).toEqual({ ...before.assignmentAttempt, status: 'cancelled', finishedAt: cancelNow });
			expect(result.attemptCount).toBe(before.attemptCount);
			const events=(await native.query('SELECT * FROM capacity_workday_events WHERE assignment_id=? ORDER BY event_index',[before.id])).rows;expect.soft(events,'terminal cancellation requires one original durable observation').toHaveLength(1);
			const terminal = await snapshot();
			vi.setSystemTime(new Date(Date.parse(cancelNow)+1_000));
			await service.cancel('team', before.id, input);
			expect(await snapshot()).toEqual(terminal); expect(input).toEqual(original);
			expect((await native.query('SELECT COUNT(*) AS total FROM capacity_ledger_entries')).rows).toEqual([{ total: 1 }]);
		} finally { await native.db.close(); }
	});
	it('requests active lease cancellation without terminalizing releasing or rewriting its immutable attempt', async () => {
		const { db, owner, query, assignment, attempt, snapshot } = await cancellationDatabase();
		try {
			atNow(); const before = structuredClone(attempt);
			const result = await new OperatorAssignmentService(owner).cancel('team', assignment.id, { idempotencyKey: 'cancel-request' });
			expect(result).toMatchObject({ status: 'leased', leaseState: 'leased', leaseToken: 'lease-token',
				metadata: { cancellationRequested: true }, lifecycleCode: 'operator_cancellation_requested' });
			expect(result.assignmentAttempt).toEqual(before); expect(result.attemptCount).toBe(1);
			expect((await query('SELECT state,active_seconds,elapsed_seconds FROM capacity_reservations')).rows)
				.toEqual([{ state: 'consuming', active_seconds: 0, elapsed_seconds: 0 }]);
			expect((await query('SELECT COUNT(*) AS total FROM capacity_ledger_entries')).rows).toEqual([{ total: 0 }]);
			expect((await query('SELECT COUNT(*) AS total FROM capacity_usage_actuals')).rows).toEqual([{ total: 0 }]);
			expect(attempt).toEqual(before);
			const repository = new ProviderAssignmentRepository(owner);
			for (const bytes of ['{}', 'not-json', JSON.stringify({ ...attempt, teamId: 'foreign-team' })]) {
				await query('UPDATE capacity_provider_assignments SET assignment_attempt_json=? WHERE id=?', [bytes, attempt.id]);
				const retained = await snapshot();
				await expect(repository.get('team', attempt.id)).rejects.toMatchObject({ code: expect.stringMatching(/provider_assignment_(contract|json)_invalid/u) });
				const diagnostic = await repository.getForCancellation('team', attempt.id);
				expect(diagnostic).toMatchObject({ id: attempt.id,
					assignmentAttempt: null, assignmentResult: null, explanation: { snapshotValidation: { valid: false } } });
				expect(validateProviderAssignment(diagnostic).ok).toBe(false);
				expect(await repository.getForCancellation('foreign-team', attempt.id)).toBeNull();
				expect(await snapshot()).toEqual(retained);
			}
		} finally { await db.close(); }
	});
	it('replays terminal cancellation without replacing measured settlement or releasing counters twice', async () => {
		const { db, owner, query, assignment, snapshot } = await cancellationDatabase('returned', true);
		try {
			atNow(); await settleCapacityReservationExactlyOnce(owner, terminalUsage);
			const service = new OperatorAssignmentService(owner), first = await service.cancel('team', assignment.id, { idempotencyKey: 'cancel-terminal' });
			const before = await snapshot(); const repeated = await service.cancel('team', assignment.id, { idempotencyKey: 'cancel-terminal' });
			expect(first.status).toBe('cancelled'); expect(repeated.assignmentAttempt).toEqual(first.assignmentAttempt);
			expect(await snapshot()).toEqual(before);
			expect((await query('SELECT active_seconds,elapsed_seconds FROM capacity_usage_actuals')).rows).toEqual([{ active_seconds: 2, elapsed_seconds: 3 }]);
			expect((await query('SELECT COUNT(*) AS total FROM capacity_ledger_entries')).rows).toEqual([{ total: 1 }]);
			expect((await query("SELECT committed_amount FROM capacity_admission_counters WHERE id='concurrency'")).rows).toEqual([{ committed_amount: 0 }]);
		} finally { await db.close(); }
	});
	it('refuses unknown productive usage instead of fabricating a zero settlement during terminal cancellation', async () => {
		const { db, owner, query, assignment, snapshot } = await cancellationDatabase('returned', true);
		try {
			atNow(); const retained = await snapshot(); let denied = false;
			try { await new OperatorAssignmentService(owner).cancel('team', assignment.id, { idempotencyKey: 'cancel-unknown-usage' }); }
			catch { denied = true; }
			expect({ denied, measurements: (await query('SELECT active_seconds,elapsed_seconds FROM capacity_usage_actuals')).rows,
				settlements: (await query('SELECT COUNT(*) AS total FROM capacity_ledger_entries')).rows })
				.toEqual({ denied: true, measurements: [], settlements: [{ total: 0 }] });
			expect(await snapshot()).toEqual(retained);
		} finally { await db.close(); }
	});
	it('retains durable measured settlement when workspace cleanup is interrupted and retried', async () => {
		const { db, owner, query, assignment } = await cancellationDatabase('returned', true);
		try {
			atNow(); await settleCapacityReservationExactlyOnce(owner, terminalUsage);
			await expect(new OperatorAssignmentService(owner, async () => { throw new Error('isolated cleanup interruption'); })
				.cancel('team', assignment.id, { idempotencyKey: 'cancel-cleanup' })).rejects.toThrow('isolated cleanup interruption');
			const result = await new OperatorAssignmentService(owner).cancel('team', assignment.id, { idempotencyKey: 'cancel-cleanup' });
			expect(result.status).toBe('cancelled'); expect(result.attemptCount).toBe(1);
			expect((await query('SELECT active_seconds,elapsed_seconds FROM capacity_usage_actuals')).rows).toEqual([{ active_seconds: 2, elapsed_seconds: 3 }]);
			expect((await query('SELECT COUNT(*) AS total FROM capacity_ledger_entries')).rows).toEqual([{ total: 1 }]);
		} finally { await db.close(); }
	});
	it('denies foreign team missing idempotency and completed assignment cancellation without accounting mutation', async () => {
		const { db, owner, assignment, snapshot } = await cancellationDatabase('completed');
		try {
			atNow(); const before = await snapshot(), service = new OperatorAssignmentService(owner);
			await expect(service.cancel('foreign-team', assignment.id, { idempotencyKey: 'cancel' })).rejects.toMatchObject({ status: 404 });
			await expect(service.cancel('team', assignment.id, { idempotencyKey: '' })).rejects.toMatchObject({ status: 400 });
			await expect(service.cancel('team', assignment.id, { idempotencyKey: 'cancel' })).rejects.toMatchObject({ status: 409 });
			expect(await snapshot()).toEqual(before);
		} finally { await db.close(); }
	});
});

import {proveNativeStoppedReportContext} from './reporting/native-stopped-report-context.ts';
import {proveNativeReportGraphScope} from './native-report-context-scope.ts';
import {expect} from 'vitest';
import type pg from 'pg';
import {compileWorkday,DEFAULT_WORKDAY_POLICY,appliedWorkdaySchema} from '@treeseed/sdk/agent-capacity';
import type {createControlPlanePostgresDatabase} from '../../../../../../src/api/support/control-plane-postgres.ts';
import {ControlPlaneStore} from '../../../../../../src/api/persistence/store.ts';
import {CapacityWorkdayRunRepository} from '../../../../../../src/api/capacity/repositories/capacity/workdays/workday-run.ts';
import {CapacityWorkdayRunWriteRepository} from '../../../../../../src/api/capacity/repositories/capacity/workdays/workday-run-write.ts';
import {CapacityWorkdayEventRepository,serializeCapacityWorkdayEventRow} from '../../../../../../src/api/capacity/repositories/capacity/workdays/workday-event.ts';
import {eventObserved} from '../../../realtime/architecture/session-postgres-fixture.ts';

/** Original full native schema, independent lock owner and public repositories. Plan/report values are controlled inputs, not genuine managed lifecycle or TreeDX output. */
export async function proveNativeWorkdayLifecycleObservations(database:ReturnType<typeof createControlPlanePostgresDatabase>,observer:pg.Pool,deadline:number){
 const owner=new ControlPlaneStore({TREESEED_ENVIRONMENT:'test'},database);owner.initializationPromise=Promise.resolve();
 const reads=new CapacityWorkdayRunRepository(owner),writes=new CapacityWorkdayRunWriteRepository(owner),events=new CapacityWorkdayEventRepository(owner);
 const original=(await reads.get('team','sdk'))!,id='native-lifecycle-observation',now=new Date().toISOString();
 const plan={...compileWorkday({id,teamId:'team',policyId:'default',policyRevision:1,executionMode:'simulation',startsAt:now,agentIds:[],policy:DEFAULT_WORKDAY_POLICY}),state:'active' as const,activatedAt:now,planningRounds:[{round:1,state:'complete' as const,assignmentIds:['controlled-original-turn'],startedAt:now,completedAt:now}]};
 const run={...original,id,status:'running' as const,startedAt:now,completedAt:null,createdAt:now,updatedAt:now,
  parameters:{...original.parameters,...plan.policySnapshot,deadlineAt:plan.endsAt,appliedPlan:plan},summary:{},error:{},reportRefs:{}};
 const unrelated=(await observer.query('SELECT * FROM capacity_workday_runs ORDER BY id')).rows;
 const finances=async()=>Object.fromEntries(await Promise.all(['capacity_provider_assignments','capacity_reservations','capacity_usage_actuals','capacity_ledger_entries'].map(async table=>[table,(await observer.query('SELECT * FROM '+table+' ORDER BY id')).rows])));
 const financial=await finances(),lock=await observer.connect();let pending:Promise<unknown>|undefined;
 try{
  expect(await writes.create(run)).toEqual(run);
  const closingAt=new Date().toISOString();await new Promise(resolve=>setTimeout(resolve,2));const observedAt=new Date().toISOString();expect(Date.parse(observedAt)).toBeGreaterThan(Date.parse(closingAt));const closing={...run,parameters:{...run.parameters,appliedPlan:{...plan,state:'closing' as const,closingAt}},updatedAt:observedAt};
  const held=structuredClone(closing);
  await lock.query('BEGIN');await lock.query('SELECT id FROM capacity_workday_runs WHERE id=$1 AND team_id=$2 FOR UPDATE',[id,'team']);
  pending=Promise.all([writes.update(closing,'running'),writes.update(structuredClone(closing),'running')]);
  let waiting:Array<{pid:number}>=[];
  await eventObserved(async()=>{waiting=(await observer.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%capacity_workday_runs%' ")).rows;return waiting.length>=2;},Math.min(deadline,Date.now()+5_000));
  expect(new Set(waiting.map(value=>value.pid)).size).toBeGreaterThanOrEqual(2);
  await lock.query('COMMIT');expect(await pending).toEqual([closing,closing]);pending=undefined;
  expect(closing).toEqual(held);expect(await reads.get('team',id)).toEqual(closing);
  await proveNativeReportGraphScope(owner,observer,id);
  await proveNativeStoppedReportContext(owner,observer);
  const first=await events.list('team',id,{limit:50});expect(first.items).toHaveLength(1);
  expect(first.items[0]).toMatchObject({eventType:'workday.lifecycle.changed',workdayId:id,runId:id,teamId:'team',context:{previousStatus:'running',status:'running',previousPlan:plan,plan:closing.parameters.appliedPlan}});
  const snapshot=async()=>({run:(await observer.query('SELECT * FROM capacity_workday_runs WHERE id=$1',[id])).rows,events:(await observer.query('SELECT * FROM capacity_workday_events WHERE run_id=$1 ORDER BY event_index',[id])).rows});
  const heldHistory=await snapshot();
  await expect(writes.update({...closing,parameters:{...closing.parameters,appliedPlan:{...closing.parameters.appliedPlan,planningRounds:[]}}},'running')).rejects.toMatchObject({code:'workday_transition_stale',status:409});expect(await snapshot()).toEqual(heldHistory);
  await expect(writes.update({...closing,executionMode:'production'},'running')).rejects.toMatchObject({code:'workday_transition_stale',status:409});expect(await snapshot()).toEqual(heldHistory);
  const before=await snapshot(),reference={kind:'treedx' as const,projectId:'project',repository:'controlled-library',commit:'a'.repeat(40),path:'notes/controlled-report.mdx'};
  for(const mode of ['missing','interrupted','altered']){
   const body=mode==='missing'?'RETURN NULL;':mode==='interrupted'?"RAISE EXCEPTION 'retained native lifecycle interruption';":"NEW.context_json='{}'; RETURN NEW;";
   await database.pool.query('CREATE FUNCTION native_lifecycle_observation_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN '+body+' END $$');
   await database.pool.query('CREATE TRIGGER native_lifecycle_observation_failure BEFORE INSERT ON capacity_workday_events FOR EACH ROW EXECUTE FUNCTION native_lifecycle_observation_failure()');
   const endedAt=new Date().toISOString(),terminal={...closing,status:'completed' as const,completedAt:endedAt,updatedAt:endedAt,parameters:{...closing.parameters,appliedPlan:{...closing.parameters.appliedPlan,state:'ended' as const,endedAt,reportRef:reference}}};
   try{await expect(writes.update(terminal,'running')).rejects.toThrow(mode==='missing'?'workday_transition_observation_missing':mode==='interrupted'?'retained native lifecycle interruption':'workday_transition_observation_conflict');expect(await snapshot()).toEqual(before);}
   finally{await database.pool.query('DROP TRIGGER native_lifecycle_observation_failure ON capacity_workday_events');await database.pool.query('DROP FUNCTION native_lifecycle_observation_failure()');}
  }
  await expect(writes.update({...run,updatedAt:new Date().toISOString()},'running')).rejects.toMatchObject({code:'workday_transition_stale',status:409});expect(await snapshot()).toEqual(before);
  const endedAt=new Date().toISOString(),terminal={...closing,status:'completed' as const,completedAt:endedAt,updatedAt:endedAt,parameters:{...closing.parameters,appliedPlan:{...closing.parameters.appliedPlan,state:'ended' as const,endedAt,reportRef:reference}}};
  expect(await writes.update(terminal,'running')).toEqual(terminal);
  const raw=(await observer.query('SELECT * FROM capacity_workday_events WHERE run_id=$1 ORDER BY event_index',[id])).rows;expect(raw).toHaveLength(2);
  expect(raw.map(value=>value.event_index)).toEqual([0,1]);expect(await events.get('team',id,String(raw[0]!.id))).toEqual(serializeCapacityWorkdayEventRow(raw[0]!));
  expect(await events.get('team',id,String(raw[1]!.id))).toMatchObject({eventType:'workday.lifecycle.changed',context:{previousPlan:closing.parameters.appliedPlan,plan:terminal.parameters.appliedPlan}});
  const ended=(await reads.get('team',id))!;expect(appliedWorkdaySchema.parse(ended.parameters.appliedPlan).reportRef).toEqual(reference);
  expect(await writes.update(terminal,'completed')).toEqual(terminal);expect((await observer.query('SELECT * FROM capacity_workday_events WHERE run_id=$1 ORDER BY event_index',[id])).rows).toEqual(raw);
  expect(await finances()).toEqual(financial);expect((await observer.query('SELECT * FROM capacity_workday_runs WHERE id<>$1 ORDER BY id',[id])).rows).toEqual(unrelated);
 }finally{
  await lock.query('ROLLBACK');lock.release();if(pending)await pending.catch(()=>undefined);
  await database.pool.query('DELETE FROM capacity_workday_events WHERE run_id=$1',[id]);await database.pool.query('DELETE FROM capacity_workday_runs WHERE id=$1',[id]);
 }
 expect((await observer.query('SELECT * FROM capacity_workday_runs ORDER BY id')).rows).toEqual(unrelated);expect(await finances()).toEqual(financial);
}

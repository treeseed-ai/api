import {proveNativeStoppedReportContext} from './reporting/native-stopped-report-context.ts';
import {expectWorkdayLifecycleHistory} from '../scheduling/architecture/node-birth-history.ts';
import {describe,expect,it} from 'vitest';
import {appliedWorkdaySchema,compileWorkday} from '@treeseed/sdk/agent-capacity';
import {settlementDatabase} from '../../accounting/architecture/settlement-fixture.ts';
import {CapacityWorkdayRunWriteRepository} from '../../../../../../src/api/capacity/repositories/capacity/workdays/workday-run-write.ts';
import {CapacityWorkdayEventRepository} from '../../../../../../src/api/capacity/repositories/capacity/workdays/workday-event.ts';

describe('original Workday lifecycle and public observation custody',()=>{
 it('reconciles a projected cancelled never-admitted turn through real SQL lifecycle history and the original Reporter guard',async()=>{
  const f=await settlementDatabase();try{await proveNativeStoppedReportContext(f.owner,{query:(sql,params)=>f.db.query(sql,params)},'workday');}finally{await f.db.close();}
 });

 it('retains initial native applied-plan creation as one null-to-active observation before every later transition and exact replay',async()=>{
  const f=await settlementDatabase();try{
   const original=(await f.reads.get('team','workday'))!,parsed=appliedWorkdaySchema.parse(original.parameters.appliedPlan),plan={...compileWorkday({id:original.id,teamId:original.teamId,executionMode:original.executionMode,policyId:parsed.policyId,policyRevision:parsed.policyRevision,policy:parsed.policySnapshot,startsAt:parsed.startsAt,agentIds:['renamed-native-planner']}),admittedSecondsByProject:parsed.admittedSecondsByProject,admittedSecondsByAgentClass:parsed.admittedSecondsByAgentClass,state:'active' as const,activatedAt:parsed.startsAt};
   const parameters={...original.parameters};delete parameters.appliedPlan;await f.query('UPDATE capacity_workday_runs SET parameters_json=? WHERE id=?',[JSON.stringify(parameters),original.id]);
   const before=(await f.reads.get('team','workday'))!,candidate={...before,parameters:{...parameters,appliedPlan:plan}},writer=new CapacityWorkdayRunWriteRepository(f.owner);
   expect(await writer.update(candidate,before.status)).toEqual(candidate);
   const snapshot={workdays:(await f.query('SELECT * FROM capacity_workday_runs ORDER BY id')).rows,events:(await f.query('SELECT * FROM capacity_workday_events ORDER BY event_index')).rows};
   expect(expectWorkdayLifecycleHistory(snapshot)).toHaveLength(1);expect(JSON.parse(String(snapshot.events[0]!.context_json))).toEqual({previousStatus:before.status,status:candidate.status,previousPlan:null,plan});
   expect(await writer.update(candidate,candidate.status)).toEqual(candidate);expect((await f.query('SELECT * FROM capacity_workday_events ORDER BY event_index')).rows).toEqual(snapshot.events);
  }finally{await f.db.close();}
 });

 it('commits each original plan transition with its exact public lifecycle observation and makes an unchanged replay a noop',async()=>{
  const f=await settlementDatabase();
  try{
   const original=(await f.reads.get('team','workday'))!,parsed=appliedWorkdaySchema.parse(original.parameters.appliedPlan);
   const active={...parsed,state:'active' as const};delete active.closingAt;
   await f.query('UPDATE capacity_workday_runs SET parameters_json=? WHERE id=?',[JSON.stringify({...original.parameters,appliedPlan:active}),original.id]);
   const before=(await f.reads.get('team','workday'))!,financial=await f.snapshot();
   const plan={...active,state:'closing' as const,closingAt:'2026-10-02T21:01:00.000Z'};
   const candidate={...before,parameters:{...before.parameters,appliedPlan:plan},updatedAt:plan.closingAt},held=structuredClone(candidate);
   const writes=new CapacityWorkdayRunWriteRepository(f.owner),events=new CapacityWorkdayEventRepository(f.owner);
   expect(await writes.update(candidate,before.status)).toEqual(candidate);
   const observed=await events.list('team','workday',{limit:50});expect(observed.items).toHaveLength(1);
   expect(observed.items[0]).toMatchObject({teamId:'team',runId:'workday',workdayId:'workday',assignmentId:null,eventType:'workday.lifecycle.changed',
    status:'recorded',createdAt:plan.closingAt,context:{previousStatus:before.status,status:candidate.status,previousPlan:active,plan}});
   const stored=(await f.query('SELECT * FROM capacity_workday_events ORDER BY event_index')).rows;
   expect(await writes.update(candidate,candidate.status)).toEqual(candidate);expect(await events.list('team','workday',{limit:50})).toEqual(observed);
   expect((await f.query('SELECT * FROM capacity_workday_events ORDER BY event_index')).rows).toEqual(stored);
   expect(await f.snapshot()).toEqual(financial);expect(candidate).toEqual(held);
  }finally{await f.db.close();}
 });
 it('rolls back plan changes and original event-index custody when the required public observation is missing or interrupted',async()=>{
  const f=await settlementDatabase();
  try{
   const original=(await f.reads.get('team','workday'))!,parsed=appliedWorkdaySchema.parse(original.parameters.appliedPlan),active={...parsed,state:'active' as const};delete active.closingAt;
   await f.query('UPDATE capacity_workday_runs SET parameters_json=? WHERE id=?',[JSON.stringify({...original.parameters,appliedPlan:active}),original.id]);
   const before=(await f.reads.get('team','workday'))!,candidate={...before,parameters:{...before.parameters,appliedPlan:{...active,state:'closing',closingAt:'2026-10-02T21:01:00.000Z'}}};
   const snapshot=async()=>({financial:await f.snapshot(),workdays:(await f.query('SELECT * FROM capacity_workday_runs ORDER BY id')).rows,events:(await f.query('SELECT * FROM capacity_workday_events ORDER BY event_index')).rows});
   const held=await snapshot(),writes=new CapacityWorkdayRunWriteRepository(f.owner);
   for(const mode of ['missing','interrupted']){
    await f.db.exec("CREATE FUNCTION retained_workday_observation_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "+(mode==='missing'?'RETURN NULL;':"RAISE EXCEPTION 'retained native workday observation interruption';")+' END $$');
    await f.db.exec('CREATE TRIGGER retained_workday_observation_failure BEFORE INSERT ON capacity_workday_events FOR EACH ROW EXECUTE FUNCTION retained_workday_observation_failure()');
    try{
     await expect(writes.update(candidate,before.status)).rejects.toThrow(mode==='missing'?'workday_transition_observation_missing':'retained native workday observation interruption');
     expect(await snapshot()).toEqual(held);
    }finally{await f.db.exec('DROP TRIGGER retained_workday_observation_failure ON capacity_workday_events');await f.db.exec('DROP FUNCTION retained_workday_observation_failure()');}
   }
  }finally{await f.db.close();}
 });

 it('retains every completed original planning round when an active-plan update carries stale history',async()=>{
  const f=await settlementDatabase();try{
   const original=(await f.reads.get('team','workday'))!,parsed=appliedWorkdaySchema.parse(original.parameters.appliedPlan),active={...parsed,state:'active' as const,
    planningRounds:[{round:1,state:'complete' as const,assignmentIds:['supplied-original-turn'],startedAt:parsed.startsAt,completedAt:'2026-10-02T21:01:00.000Z'}]};delete active.closingAt;
   await f.query('UPDATE capacity_workday_runs SET parameters_json=? WHERE id=?',[JSON.stringify({...original.parameters,appliedPlan:active}),original.id]);
   const before=(await f.reads.get('team','workday'))!,candidate={...before,parameters:{...before.parameters,appliedPlan:active}},writes=new CapacityWorkdayRunWriteRepository(f.owner);
   const snapshot=async()=>({runs:(await f.query('SELECT * FROM capacity_workday_runs ORDER BY id')).rows,events:(await f.query('SELECT * FROM capacity_workday_events ORDER BY event_index')).rows,financial:await f.snapshot()}),held=await snapshot();
   for(const mode of ['missing','assignments','state','started','completed']){
    const changed=structuredClone(candidate),round=changed.parameters.appliedPlan.planningRounds[0]!;
    if(mode==='missing')changed.parameters.appliedPlan.planningRounds=[];if(mode==='assignments')round.assignmentIds=['foreign'];
    if(mode==='state')Reflect.set(round,'state','active');if(mode==='started')round.startedAt='2026-10-02T21:00:01.000Z';if(mode==='completed')round.completedAt='2026-10-02T21:01:01.000Z';
    const input=structuredClone(changed);await expect(writes.update(changed,before.status)).rejects.toMatchObject({code:'workday_transition_stale',status:409});expect(changed).toEqual(input);expect(await snapshot()).toEqual(held);
   }
  }finally{await f.db.close();}
 });
 it('rejects a substituted sole Workday mode without persisting a contradiction or creating a lifecycle observation',async()=>{
  const f=await settlementDatabase();try{
   const before=(await f.reads.get('team','workday'))!,candidate={...before,executionMode:'production' as const},held=(await f.query('SELECT * FROM capacity_workday_runs')).rows;
   await expect(new CapacityWorkdayRunWriteRepository(f.owner).update(candidate,before.status)).rejects.toMatchObject({code:'workday_transition_stale',status:409});
   expect((await f.query('SELECT * FROM capacity_workday_runs')).rows).toEqual(held);expect((await f.query('SELECT * FROM capacity_workday_events')).rows).toEqual([]);
  }finally{await f.db.close();}
 });
});

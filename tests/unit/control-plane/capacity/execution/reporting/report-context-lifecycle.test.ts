import{appliedWorkdaySchema}from'@treeseed/sdk/agent-capacity';
import{describe,expect,it}from'vitest';
import{settlementDatabase,frozenAttempt}from'../../accounting/architecture/settlement-fixture.ts';
import{CapacityWorkdayRunWriteRepository}from'../../../../../../src/api/capacity/repositories/capacity/workdays/workday-run-write.ts';
import{CapacityWorkdayEventRepository}from'../../../../../../src/api/capacity/repositories/capacity/workdays/workday-event.ts';
import{workdayReportContext}from'../../../../../../src/api/capacity/services/capacity/assignments/admission/workday-report-context.ts';
const reporter={...frozenAttempt,effectiveProfile:{...frozenAttempt.effectiveProfile,activity:'reporting' as const},sourceRef:{store:'postgresql' as const,model:'workday',id:'workday',revision:1,digest:'sha256:'+'a'.repeat(64)}};
describe('original Reporter lifecycle input custody',()=>{
 it('requires the original closing observation instead of accepting a supplied closing status with no owning event',async()=>{
  const f=await settlementDatabase();try{
   await f.query("UPDATE capacity_reservations SET state='expired' WHERE id='reservation'");const held=await f.snapshot();
   await expect(workdayReportContext(f.owner,reporter)).rejects.toMatchObject({code:'reporter_workday_authority_required',status:409});expect(await f.snapshot()).toEqual(held);
  }finally{await f.db.close();}
 });
 it('freezes the exact original closing event and completed planning rounds and denies lost malformed or unfinished lifecycle authority without repairing financial history',async()=>{
  const f=await settlementDatabase();try{
   await f.query("UPDATE capacity_reservations SET state='expired' WHERE id='reservation'");
   const original=(await f.reads.get('team','workday'))!,plan=original.parameters.appliedPlan as Record<string,unknown>,active={...plan,state:'active',planningRounds:[{round:1,state:'complete',assignmentIds:['controlled-original-turn'],startedAt:plan.startsAt,completedAt:'2026-10-02T21:00:30.000Z'}]};Reflect.deleteProperty(active,'closingAt');
   await f.query('UPDATE capacity_workday_runs SET parameters_json=? WHERE id=?',[JSON.stringify({...original.parameters,appliedPlan:active}),original.id]);
   const before=(await f.reads.get('team','workday'))!,closing={...before,parameters:{...before.parameters,appliedPlan:{...appliedWorkdaySchema.parse(before.parameters.appliedPlan),state:'closing',closingAt:'2026-10-02T21:01:00.000Z'}},updatedAt:'2026-10-02T21:01:00.000Z'};
   await new CapacityWorkdayRunWriteRepository(f.owner).update(closing,'running');const event=(await new CapacityWorkdayEventRepository(f.owner).list('team','workday',{limit:50})).items[0]!;
   const [context]=await workdayReportContext(f.owner,reporter);expect(context!.value).toMatchObject({closingEvent:{...event,context:{...event.context,plan:closing.parameters.appliedPlan}}});expect(await workdayReportContext(f.owner,reporter)).toEqual([context]);
   const stored=(await f.query('SELECT * FROM capacity_workday_runs WHERE id=?',[original.id])).rows[0]!,observed=(await f.query('SELECT * FROM capacity_workday_events WHERE id=?',[event.id])).rows[0]!,financial=await f.snapshot();
   for(const state of ['pending','active']){const changed=structuredClone(closing.parameters);Reflect.set(changed.appliedPlan.planningRounds[0]!,'state',state);await f.query('UPDATE capacity_workday_runs SET parameters_json=? WHERE id=?',[JSON.stringify(changed),original.id]);await expect(workdayReportContext(f.owner,reporter)).rejects.toMatchObject({code:'reporter_workday_authority_required',status:409});expect(await f.snapshot()).toEqual(financial);}
   await f.query('UPDATE capacity_workday_runs SET parameters_json=? WHERE id=?',[stored.parameters_json,original.id]);
   for(const mode of ['missing','altered']){await f.query('UPDATE capacity_workday_events SET event_type=?,context_json=? WHERE id=?',[mode==='missing'?'controlled-excluded':observed.event_type,mode==='altered'?'{}':observed.context_json,event.id]);await expect(workdayReportContext(f.owner,reporter)).rejects.toMatchObject({code:'reporter_workday_authority_required',status:409});expect(await f.snapshot()).toEqual(financial);await f.query('UPDATE capacity_workday_events SET event_type=?,context_json=? WHERE id=?',[observed.event_type,observed.context_json,event.id]);}
   expect(await workdayReportContext(f.owner,reporter)).toEqual([context]);expect((await f.query('SELECT * FROM capacity_workday_events WHERE id=?',[event.id])).rows[0]).toEqual(observed);
  }finally{await f.db.close();}
 });

 it('retains the original phase clock and later actual persistence observation without equating or rewriting either clock',async()=>{
  const f=await settlementDatabase();try{
   await f.query("UPDATE capacity_reservations SET state='expired' WHERE id='reservation'");const original=(await f.reads.get('team','workday'))!,active={...appliedWorkdaySchema.parse(original.parameters.appliedPlan),state:'active' as const};delete active.closingAt;
   await f.query('UPDATE capacity_workday_runs SET parameters_json=? WHERE id=?',[JSON.stringify({...original.parameters,appliedPlan:active}),original.id]);
   const before=(await f.reads.get('team','workday'))!,closingAt='2026-10-02T21:01:00.000Z',observedAt='2026-10-02T21:01:00.001Z';
   await new CapacityWorkdayRunWriteRepository(f.owner).update({...before,updatedAt:observedAt,parameters:{...before.parameters,appliedPlan:{...active,state:'closing',closingAt}}},before.status);
   const held=(await f.query('SELECT * FROM capacity_workday_events ORDER BY event_index')).rows;
   const [context]=await workdayReportContext(f.owner,reporter);expect(context!.value).toMatchObject({closingEvent:{createdAt:observedAt,context:{plan:{closingAt}}}});
   expect((await f.query('SELECT * FROM capacity_workday_events ORDER BY event_index')).rows).toEqual(held);
  }finally{await f.db.close();}
 });
 it('retains the original stop while proving later terminal planning through its exact public lifecycle chain',async()=>{
  const f=await settlementDatabase();try{
   await f.query("UPDATE capacity_reservations SET state='expired' WHERE id='reservation'");
   const original=(await f.reads.get('team','workday'))!,plan=appliedWorkdaySchema.parse(original.parameters.appliedPlan);
   const active={...plan,state:'active' as const,planningRounds:[{round:1,state:'active' as const,assignmentIds:['stopped-turn'],startedAt:plan.startsAt}]};delete active.closingAt;
   await f.query('UPDATE capacity_workday_runs SET parameters_json=? WHERE id=?',[JSON.stringify({...original.parameters,appliedPlan:active}),original.id]);
   const write=new CapacityWorkdayRunWriteRepository(f.owner),at='2026-10-02T21:01:00.000Z';
   const closing={...original,parameters:{...original.parameters,appliedPlan:{...active,state:'closing' as const,closingAt:at}},updatedAt:at};
   await write.update(closing,'running');const first=(await new CapacityWorkdayEventRepository(f.owner).list('team','workday',{limit:50})).items[0]!;
   await expect(workdayReportContext(f.owner,reporter)).rejects.toMatchObject({code:'reporter_workday_authority_required'});
   await f.query(`INSERT INTO execution_nodes (id,team_id,project_id,workday_id,kind,source_ref_json,rule_revision,node_revision,status,graph_revision_created,graph_revision_updated,created_at,updated_at)
    VALUES ('stopped-turn','team','project','workday','estimating','{}',1,1,'cancelled',1,1,?,?)`,[at,at]);
   const completedAt='2026-10-02T21:01:01.000Z',complete={...closing,parameters:{...closing.parameters,appliedPlan:{...closing.parameters.appliedPlan,planningRounds:[{...active.planningRounds[0]!,state:'complete' as const,completedAt}]}},updatedAt:completedAt};
   await write.update(complete,'running');const held=await f.snapshot(),events=(await f.query('SELECT * FROM capacity_workday_events ORDER BY event_index')).rows;
   const [context]=await workdayReportContext(f.owner,reporter);expect(context!.value).toMatchObject({closingEvent:first});
   expect(await workdayReportContext(f.owner,reporter)).toEqual([context]);expect(await f.snapshot()).toEqual(held);
   for(const mode of ['missing-terminal-event','altered-terminal-event','unfinished-node']){
    const latest=events.at(-1)!;
    if(mode==='unfinished-node')await f.query("UPDATE execution_nodes SET status='running' WHERE id='stopped-turn'");
    else await f.query('UPDATE capacity_workday_events SET event_type=?,context_json=? WHERE id=?',[mode==='missing-terminal-event'?'controlled-excluded':latest.event_type,mode==='altered-terminal-event'?'{}':latest.context_json,latest.id]);
    await expect(workdayReportContext(f.owner,reporter)).rejects.toMatchObject({code:'reporter_workday_authority_required'});expect(await f.snapshot()).toEqual(held);
    await f.query("UPDATE execution_nodes SET status='cancelled' WHERE id='stopped-turn'");await f.query('UPDATE capacity_workday_events SET event_type=?,context_json=? WHERE id=?',[latest.event_type,latest.context_json,latest.id]);
   }
   expect((await f.query('SELECT * FROM capacity_workday_events ORDER BY event_index')).rows).toEqual(events);
  }finally{await f.db.close();}
 });

});

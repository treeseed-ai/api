import{expect,it,vi}from'vitest';
import{initialAdmission}from'../initial/initial-admission-fixture.ts';
import{completionFixture,principal,report}from'../../../../providers/assignments/lifecycle/architecture/terminal-report-fixture.ts';
import{CapacityWorkdayEventRepository}from'../../../../../../../src/api/capacity/repositories/capacity/workdays/workday-event.ts';

it('original concurrent admission publishes one exact ready to assigned node observation and retains it unchanged on replay',async()=>{
 const f=await initialAdmission();try{
  const input=f.input(),held=structuredClone(input);await Promise.all([f.admit(input),f.admit(structuredClone(input))]);
  const read=()=>new CapacityWorkdayEventRepository(f.store).list(f.attempt.teamId,f.attempt.workdayId,{limit:100,afterEventIndex:-1});
  const events=await read(),nodes=events.items.filter(event=>event.eventType==='execution.node.state');expect(nodes).toHaveLength(1);
  expect(nodes[0]).toMatchObject({teamId:f.attempt.teamId,runId:f.attempt.workdayId,workdayId:f.attempt.workdayId,projectId:f.attempt.projectId,assignmentId:null,context:{nodeId:f.attempt.nodeId,nodeRevision:f.attempt.nodeRevision,graphRevision:f.attempt.graphRevision,status:'assigned',previousStatus:'ready'}});
  const retained=structuredClone(events);await f.admit(input);expect(await read()).toEqual(retained);expect(input).toEqual(held);
 }finally{await f.db.close();}
});

it('original terminal service publishes one exact failed node observation with its released attempt and preserves settled history on duplicate report',async()=>{
 const f=await completionFixture();try{
  const before=(await f.query('SELECT * FROM capacity_reservations ORDER BY id')).rows,prior=(await f.query('SELECT status FROM execution_nodes WHERE id=?',[f.attempt.nodeId])).rows[0]!;
  const input={...report,activeSeconds:1,elapsedSeconds:2,usage:{inputTokens:7,nativeUsage:{activeSeconds:1,tokens:7}}};await f.service.fail(principal,f.attempt.id,input);
  const read=()=>new CapacityWorkdayEventRepository(f.store).list(f.attempt.teamId,f.attempt.workdayId,{limit:100,afterEventIndex:-1}),events=await read(),nodes=events.items.filter(event=>event.eventType==='execution.node.state');expect(nodes).toHaveLength(1);
  expect(nodes[0]).toMatchObject({teamId:f.attempt.teamId,runId:f.attempt.workdayId,workdayId:f.attempt.workdayId,projectId:f.attempt.projectId,assignmentId:null,context:{nodeId:f.attempt.nodeId,nodeRevision:f.attempt.nodeRevision,status:'failed',previousStatus:prior.status}});
  expect((await f.query('SELECT * FROM capacity_reservations ORDER BY id')).rows).toEqual(before);const held=structuredClone(events);await f.service.fail(principal,f.attempt.id,input);expect(await read()).toEqual(held);
 }finally{vi.useRealTimers();await f.close();}
});

it('original admission rolls back assignment reservation and event writes when the exact ready node claim is suppressed',async()=>{
 const f=await initialAdmission();try{
  const snapshot=async()=>({custody:await f.snapshot(),events:(await f.query('SELECT * FROM capacity_workday_events ORDER BY event_index')).rows,runs:(await f.query('SELECT * FROM capacity_workday_runs ORDER BY id')).rows}),before=await snapshot();
  await f.db.exec("CREATE FUNCTION suppress_node_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='assigned' THEN RETURN NULL; END IF; RETURN NEW; END $$;CREATE TRIGGER suppress_node_claim BEFORE UPDATE ON execution_nodes FOR EACH ROW EXECUTE FUNCTION suppress_node_claim();");
  await expect(f.admit()).rejects.toThrow('execution_node_observation_state_mismatch');expect(await snapshot()).toEqual(before);
  await f.db.exec('DROP TRIGGER suppress_node_claim ON execution_nodes;DROP FUNCTION suppress_node_claim();');await f.admit();expect((await f.query('SELECT status FROM execution_nodes WHERE id=?',[f.attempt.nodeId])).rows).toEqual([{status:'assigned'}]);
 }finally{await f.db.close();}
});

import{expect,it,vi}from'vitest';
import{cancellationDatabase,cancelNow}from'../../../../providers/assignments/architecture/cancellation-fixture.ts';
import{terminalizeCapacityWorkdayAssignments}from'../../../../../../../src/api/capacity/services/capacity/workdays/lifecycle/workday-assignment-terminalization-service.ts';
import{CapacityWorkdayEventRepository}from'../../../../../../../src/api/capacity/repositories/capacity/workdays/workday-event.ts';

it('original workday stop retains every claimed and unclaimed node cancellation in exact public history without cancelling another workday or replaying settlement',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(cancelNow));const f=await cancellationDatabase('returned',false);
 try{
  const columns='id,team_id,project_id,workday_id,kind,source_ref_json,authority_refs_json,rule_revision,node_revision,agent_class,status,graph_revision_created,graph_revision_updated,created_at,updated_at';
  await f.query('INSERT INTO execution_nodes ('+columns+") SELECT 'unclaimed',team_id,project_id,workday_id,kind,source_ref_json,authority_refs_json,rule_revision,node_revision,agent_class,'ready',graph_revision_created,graph_revision_updated,created_at,updated_at FROM execution_nodes WHERE id=?",[f.attempt.nodeId]);
  await f.query('INSERT INTO execution_nodes ('+columns+") SELECT 'unrelated',team_id,project_id,'unrelated-workday',kind,source_ref_json,authority_refs_json,rule_revision,node_revision,agent_class,'ready',graph_revision_created,graph_revision_updated,created_at,updated_at FROM execution_nodes WHERE id=?",[f.attempt.nodeId]);
  const before=(await f.query('SELECT id,status,node_revision,graph_revision_updated FROM execution_nodes ORDER BY id')).rows,foreign=(await f.query("SELECT * FROM execution_nodes WHERE id='unrelated'")).rows;
  await terminalizeCapacityWorkdayAssignments(f.owner,'team',f.attempt.workdayId,{now:cancelNow});
  const read=()=>new CapacityWorkdayEventRepository(f.owner).list('team',f.attempt.workdayId,{limit:100,afterEventIndex:-1}),events=await read(),nodes=events.items.filter(event=>event.eventType==='execution.node.state');expect(nodes).toHaveLength(2);
  expect(nodes.map(event=>event.context.nodeId).sort()).toEqual([f.attempt.nodeId,'unclaimed'].sort());
  for(const event of nodes){const prior=before.find(node=>node.id===event.context.nodeId)!;expect(event).toMatchObject({teamId:'team',runId:f.attempt.workdayId,workdayId:f.attempt.workdayId,projectId:f.attempt.projectId,assignmentId:null,context:{nodeId:prior.id,nodeRevision:prior.node_revision,graphRevision:prior.graph_revision_updated,status:'cancelled',previousStatus:prior.status}});}
  expect((await f.query("SELECT * FROM execution_nodes WHERE id='unrelated'")).rows).toEqual(foreign);const retained=structuredClone(events),settled=(await f.query('SELECT * FROM capacity_ledger_entries ORDER BY id')).rows;await terminalizeCapacityWorkdayAssignments(f.owner,'team',f.attempt.workdayId,{now:cancelNow});expect(await read()).toEqual(retained);expect((await f.query('SELECT * FROM capacity_ledger_entries ORDER BY id')).rows).toEqual(settled);
 }finally{vi.useRealTimers();await f.db.close();}
});

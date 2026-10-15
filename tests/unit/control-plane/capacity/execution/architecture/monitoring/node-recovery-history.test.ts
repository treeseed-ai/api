import{expect,it,vi}from'vitest';
import{cancellationDatabase,cancelNow}from'../../../../providers/assignments/architecture/cancellation-fixture.ts';
import{OperatorAssignmentService}from'../../../../../../../src/api/capacity/services/capacity/assignments/observability/operator-assignment-service.ts';
import{recoverExpiredProviderAssignments}from'../../../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-recovery-service.ts';
import{executePostgresBatch}from'../../../../../../../src/api/support/control-plane-postgres.ts';
import{CapacityWorkdayEventRepository}from'../../../../../../../src/api/capacity/repositories/capacity/workdays/workday-event.ts';

async function prove(mode:'retry'|'cancel'|'recover'){
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(cancelNow));const f=await cancellationDatabase(mode==='recover'?'leased':'returned');
 try{
  const owner=Object.assign(f.owner,{db:{transaction:<T>(apply:(client:Parameters<typeof executePostgresBatch>[0])=>Promise<T>)=>f.db.transaction(transaction=>apply(transaction as unknown as Parameters<typeof executePostgresBatch>[0]))}});
  if(mode==='retry')await f.query("UPDATE execution_nodes SET status='failed' WHERE id=?",[f.attempt.nodeId]);
  const before=(await f.query('SELECT status,node_revision FROM execution_nodes WHERE id=?',[f.attempt.nodeId])).rows[0]!,service=new OperatorAssignmentService(owner),input={idempotencyKey:'node-history-'+mode,actorId:'operator',reason:'Controlled original owner transition.'};
  const run=()=>mode==='retry'?service.requeue('team',f.assignment.id,input):mode==='cancel'?service.cancel('team',f.assignment.id,input):recoverExpiredProviderAssignments(owner,{now:cancelNow,teamId:'team',providerId:'provider'});
  await run();const after=(await f.query('SELECT status,node_revision,graph_revision_updated FROM execution_nodes WHERE id=?',[f.attempt.nodeId])).rows[0]!;
  const read=()=>new CapacityWorkdayEventRepository(owner).list('team',f.attempt.workdayId,{limit:100,afterEventIndex:-1}),events=await read(),nodes=events.items.filter(event=>event.eventType==='execution.node.state');expect(nodes).toHaveLength(1);
  expect(nodes[0]).toMatchObject({teamId:'team',runId:f.attempt.workdayId,workdayId:f.attempt.workdayId,projectId:f.attempt.projectId,assignmentId:null,context:{nodeId:f.attempt.nodeId,nodeRevision:after.node_revision,graphRevision:after.graph_revision_updated,status:after.status,previousStatus:before.status}});
  const retained=structuredClone(events);await run();expect(await read()).toEqual(retained);
 }finally{vi.useRealTimers();await f.db.close();}
}
it('original retry retains exactly one actual node transition and public observation through unchanged replay',()=>prove('retry'));
it('original cancel retains exactly one actual node transition and public observation through unchanged replay',()=>prove('cancel'));
it('original recover retains exactly one actual node transition and public observation through unchanged replay',()=>prove('recover'));

it('original retry retains an unchanged connected predecessor from its own earlier workday without denying its authority or publishing foreign observations',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(cancelNow));const f=await cancellationDatabase('returned');try{
  await f.query("UPDATE execution_nodes SET status='failed' WHERE id=?",[f.attempt.nodeId]);
  await f.query("INSERT INTO capacity_workday_runs(id,team_id,status,execution_mode,created_at,updated_at) VALUES('retained-workday','team','completed','simulation',?,?)",[cancelNow,cancelNow]);
  await f.query("INSERT INTO execution_nodes(id,team_id,project_id,workday_id,kind,pair_role,source_ref_json,authority_refs_json,rule_revision,node_revision,agent_class,status,estimate_json,required_capabilities_json,requested_permissions_json,workspace,graph_revision_created,graph_revision_updated,created_at,updated_at) SELECT 'retained-predecessor',team_id,project_id,'retained-workday',kind,pair_role,source_ref_json,authority_refs_json,rule_revision,node_revision,agent_class,'completed',estimate_json,required_capabilities_json,requested_permissions_json,workspace,graph_revision_created,graph_revision_updated,created_at,updated_at FROM execution_nodes WHERE id=?",[f.attempt.nodeId]);
  await f.query("INSERT INTO execution_edges(id,team_id,from_node_id,to_node_id,provenance,graph_revision_created,created_at) VALUES('retained-edge','team','retained-predecessor',?,'work-item',1,?)",[f.attempt.nodeId,cancelNow]);
  const prior=(await f.query("SELECT * FROM execution_nodes WHERE id='retained-predecessor'")).rows,service=new OperatorAssignmentService(f.owner),input={idempotencyKey:'retained-neighbor-retry',actorId:'operator',reason:'Current bounded retry keeps original predecessor history.'};
  await service.requeue('team',f.assignment.id,input);expect((await f.query("SELECT * FROM execution_nodes WHERE id='retained-predecessor'")).rows).toEqual(prior);
  expect((await new CapacityWorkdayEventRepository(f.owner).list('team','retained-workday',{limit:100})).items).toEqual([]);
  const events=await new CapacityWorkdayEventRepository(f.owner).list('team',f.attempt.workdayId,{limit:100,afterEventIndex:-1});expect(events.items.filter(event=>event.eventType==='execution.node.state')).toHaveLength(1);const held=structuredClone(events);await service.requeue('team',f.assignment.id,input);expect(await new CapacityWorkdayEventRepository(f.owner).list('team',f.attempt.workdayId,{limit:100,afterEventIndex:-1})).toEqual(held);
 }finally{vi.useRealTimers();await f.db.close();}
});

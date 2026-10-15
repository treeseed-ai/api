import{expect,it,vi}from'vitest';
import{cancellationDatabase,cancelNow}from'../../../../providers/assignments/architecture/cancellation-fixture.ts';
import{OperatorAssignmentService}from'../../../../../../../src/api/capacity/services/capacity/assignments/observability/operator-assignment-service.ts';
import{recoverExpiredProviderAssignments}from'../../../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-recovery-service.ts';
import{executePostgresBatch}from'../../../../../../../src/api/support/control-plane-postgres.ts';
import{CapacityWorkdayEventRepository}from'../../../../../../../src/api/capacity/repositories/capacity/workdays/workday-event.ts';

for(const mode of ['retry','cancel','recover']as const)it('original '+mode+' retains exactly one actual node transition and public observation through unchanged replay',async()=>{
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
});

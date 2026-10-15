import{createHash}from'node:crypto';
import type{ExecutionNode}from'@treeseed/sdk/agent-capacity';
import{CapacityWorkdayEventRepository}from'../../../../capacity/repositories/capacity/workdays/workday-event.ts';
import type{CapacityGovernanceDatabase}from'../../../../capacity/database.ts';

/** Observations use the existing public workday event stream, never another node projection. */
export function executionNodeObservationOperations(database:CapacityGovernanceDatabase,
 before:readonly Pick<ExecutionNode,'id'|'teamId'|'projectId'|'workdayId'|'status'|'nodeRevision'|'graphRevisionUpdated'>[],
 after:typeof before,transitionId:string,createdAt:string):Array<{query:string;params:unknown[]}>{
 const prior=new Map(before.map(node=>[node.id,node]));const repository=new CapacityWorkdayEventRepository(database);
 return after.flatMap(node=>{
  const previous=prior.get(node.id);
  if(!node.workdayId||previous?.status===node.status&&previous.nodeRevision===node.nodeRevision)return[];
  const id='execution-node-state:'+createHash('sha256').update(JSON.stringify([transitionId,node.teamId,node.workdayId,node.id])).digest('hex');
  return repository.createOperations(node.teamId,node.workdayId,{id,projectId:node.projectId,workdayId:node.workdayId,assignmentId:null,
   eventType:'execution.node.state',status:'recorded',title:'Execution node '+node.status,message:null,parameters:{},metadata:{},refs:{},createdAt,
   context:{nodeId:node.id,nodeRevision:node.nodeRevision,graphRevision:node.graphRevisionUpdated,status:node.status,previousStatus:previous?.status??null}});
 });
}

import{createHash}from'node:crypto';
import{isDeepStrictEqual}from'node:util';
import type{ExecutionNode}from'@treeseed/sdk/agent-capacity';
import{CapacityWorkdayEventRepository}from'../../../../capacity/repositories/capacity/workdays/workday-event.ts';
import type{CapacityGovernanceDatabase}from'../../../../capacity/database.ts';

/** Observations use the existing public workday event stream, never another node projection. */
export async function recordExecutionNodeObservations(database:CapacityGovernanceDatabase,
 before:readonly Pick<ExecutionNode,'id'|'teamId'|'projectId'|'workdayId'|'status'|'nodeRevision'|'graphRevisionUpdated'>[],
 after:typeof before,transitionId:string,createdAt:string):Promise<void>{
 const prior=new Map(before.map(node=>[node.id,node]));const repository=new CapacityWorkdayEventRepository(database);
 for(const node of after){
  const previous=prior.get(node.id);
  if(!node.workdayId||previous?.status===node.status&&previous.nodeRevision===node.nodeRevision)continue;
  const id='execution-node-state:'+createHash('sha256').update(JSON.stringify([transitionId,node.teamId,node.workdayId,node.id])).digest('hex');
  const value={id,projectId:node.projectId,workdayId:node.workdayId,assignmentId:null,
   eventType:'execution.node.state',status:'recorded' as const,title:'Execution node '+node.status,message:null,parameters:{},metadata:{},refs:{},createdAt,
   context:{nodeId:node.id,nodeRevision:node.nodeRevision,graphRevision:node.graphRevisionUpdated,status:node.status,previousStatus:previous?.status??null}};
  const observed=await repository.create(node.teamId,node.workdayId,value);
  if(!observed||observed.teamId!==node.teamId||observed.runId!==node.workdayId||Object.entries(value).some(([key,expected])=>!isDeepStrictEqual(Reflect.get(observed,key),expected)))throw new Error('execution_node_observation_missing');
 }
}

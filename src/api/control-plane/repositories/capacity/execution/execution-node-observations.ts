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
  if(!node.workdayId||previous?.status===node.status&&previous.nodeRevision===node.nodeRevision&&previous.workdayId===node.workdayId)continue;
  const id='execution-node-state:'+createHash('sha256').update(JSON.stringify([transitionId,node.teamId,node.workdayId,node.id])).digest('hex');
  const value={id,projectId:node.projectId,workdayId:node.workdayId,assignmentId:null,
   eventType:'execution.node.state',status:'recorded' as const,title:'Execution node '+node.status,message:null,parameters:{},metadata:{},refs:{},createdAt,
   context:{nodeId:node.id,nodeRevision:node.nodeRevision,graphRevision:node.graphRevisionUpdated,status:node.status,previousStatus:previous&&previous.workdayId===node.workdayId?previous.status:null}};
  const observed=await repository.create(node.teamId,node.workdayId,value);
  if(!observed||observed.teamId!==node.teamId||observed.runId!==node.workdayId||Object.entries(value).some(([key,expected])=>!isDeepStrictEqual(Reflect.get(observed,key),expected)))throw new Error('execution_node_observation_missing');
 }
}

/** Read only existing canonical state fields on the transaction that owns their mutation. */
export async function readExecutionNodeStates(database:CapacityGovernanceDatabase,teamId:string,workdayId:string,ids:readonly string[]){
 if(!ids.length)return[];const unique=[...new Set(ids)].sort();
 const nodes=await database.all<Parameters<typeof recordExecutionNodeObservations>[1][number]>(`SELECT id,team_id AS "teamId",project_id AS "projectId",COALESCE(workday_id,?) AS "workdayId",status,node_revision AS "nodeRevision",graph_revision_updated AS "graphRevisionUpdated" FROM execution_nodes WHERE team_id=? AND id IN (${unique.map(()=>'?').join(',')}) ORDER BY id FOR UPDATE`,[workdayId,teamId,...unique]);
 if(nodes.some(node=>node.teamId!==teamId||typeof node.workdayId!=='string'||!node.workdayId))throw new Error('execution_node_observation_scope_invalid');return nodes;
}

/** Existing active edges determine the immediate mutation neighborhood, including a review pair. */
export async function readExecutionNodeNeighborhood(database:CapacityGovernanceDatabase,teamId:string,workdayId:string,nodeId:string){
 const linked=await database.all<{from_node_id:string;to_node_id:string}>("SELECT from_node_id,to_node_id FROM execution_edges WHERE team_id=? AND graph_revision_removed IS NULL AND (from_node_id=? OR to_node_id=?)",[teamId,nodeId,nodeId]);
 return readExecutionNodeStates(database,teamId,workdayId,[nodeId,...linked.flatMap(edge=>[edge.from_node_id,edge.to_node_id])]);
}

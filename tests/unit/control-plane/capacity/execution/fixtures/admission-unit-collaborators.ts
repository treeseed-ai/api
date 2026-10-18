import * as accounting from '../../../../../../src/api/capacity/services/capacity/accounting/accounting-observations.ts';
import {assignment} from './assignment.ts';
import {compileWorkday,DEFAULT_WORKDAY_POLICY} from '@treeseed/sdk/agent-capacity';
import {afterEach,beforeEach,vi} from 'vitest';
import * as transactions from '../../../../../../src/api/capacity/transaction.ts';
import {ProviderAssignmentRepository} from '../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';
import {CapacityWorkdayEventRepository} from '../../../../../../src/api/capacity/repositories/capacity/workdays/workday-event.ts';

/** Unit collaborators only. Owning SQL and native PostgreSQL cases exercise
 * the actual transaction and repositories without this helper. */
export function admissionUnitCollaborators(){
 beforeEach(()=>{
  vi.spyOn(accounting,'recordCapacityAccountingObservation').mockImplementation(async(_database,input)=>({id:'controlled-unit-accounting',runId:assignment.workdayId,teamId:input.teamId,projectId:assignment.projectId,workdayId:assignment.workdayId,assignmentId:assignment.id,eventIndex:0,eventType:'capacity.accounting.updated',status:'recorded',title:null,message:null,parameters:{},context:{},refs:{},metadata:{},createdAt:input.createdAt}));
  vi.spyOn(transactions,'capacityTransaction').mockImplementation(async(store,apply)=>apply({...store,
   first:async<R extends Record<string,unknown>>(sql:string,params?:unknown[]):Promise<R|null>=>sql.startsWith('SELECT parameters_json,execution_mode,execution_kind FROM capacity_workday_runs')?{execution_mode:'simulation',execution_kind:params?.[2]??'workday',parameters_json:JSON.stringify({appliedPlan:compileWorkday({id:assignment.workdayId,teamId:assignment.teamId,policyId:'default',policyRevision:1,executionMode:'simulation',startsAt:assignment.createdAt,agentIds:[],policy:DEFAULT_WORKDAY_POLICY})})}as unknown as R:sql.includes('FROM capacity_provider_availability_sessions')?{id:'session',team_id:assignment.teamId,membership_id:'membership',capacity_provider_id:assignment.provider.providerId,status:'open',available_from:assignment.createdAt,available_until:null,expires_at:assignment.deadline}as unknown as R:store.first<R>(sql,params),
   all:async<R extends Record<string,unknown>>(sql:string,params?:unknown[]):Promise<R[]>=>{
    // Native PostgreSQL REAL text values around an observed fractional usage plus the three-second fixture reservation.
    const inserts=vi.mocked(store.batch).mock.calls.flatMap(([operations])=>operations).filter(operation=>operation.query.startsWith('INSERT INTO capacity_admission_counters'));
    if(sql.startsWith('SELECT id,hard_limit,committed_amount,state_version,scope,scope_id,period_key'))return inserts.map(({params:values=[]})=>({id:values[0],hard_limit:values[5],committed_amount:1.2345679,state_version:1,scope:values[2],scope_id:values[3],period_key:values[4]}))as unknown as R[];
    if(sql.startsWith('SELECT claim.counter_id,claim.reserved_amount,claim.released_amount,counter.committed_amount'))return inserts.map(({params:values=[]})=>({counter_id:values[0],reserved_amount:assignment.limits.maximumSeconds,released_amount:0,committed_amount:4.2345676,state_version:2,hard_limit:values[5]}))as unknown as R[];
    return store.all<R>(sql,params);
   }
  }));
  vi.spyOn(ProviderAssignmentRepository.prototype,'get').mockImplementation(async function(this:ProviderAssignmentRepository,teamId,id){
   const database=Reflect.get(this,'database') as {getProviderAssignment:ProviderAssignmentRepository['get'];batch:Parameters<typeof transactions.capacityTransaction>[0]['batch']};
   if(vi.isMockFunction(database.batch)&&vi.mocked(database.batch).mock.calls.length===0)return null;
   return database.getProviderAssignment(teamId,id);
  });
  vi.spyOn(CapacityWorkdayEventRepository.prototype,'create').mockImplementation(async(teamId,runId,value)=>({...value,teamId,runId,eventIndex:0}));
 });
 afterEach(()=>vi.restoreAllMocks());
}

/** Controlled unit node snapshots; actual transactional SQL is proved by the native cases. */
export function admissionNodeObservationStore(attempt=assignment){
 let reads=0;
 return {run:vi.fn(async(sql:string,params:unknown[])=>{
  if(sql!=="SELECT id FROM capacity_workday_runs WHERE team_id=? AND id=? AND status='running' FOR UPDATE"||params[0]!==attempt.teamId||params[1]!==attempt.workdayId)throw new Error('Unexpected unit admission lock');
 }),all:vi.fn(async(sql:string,params:unknown[])=>{
  if(!sql.startsWith('SELECT id,team_id AS "teamId"')||!sql.includes('FROM execution_nodes')||JSON.stringify(params)!==JSON.stringify([attempt.workdayId,attempt.teamId,attempt.nodeId]))throw new Error('Unexpected unit admission node read');
  return [{id:attempt.nodeId,teamId:attempt.teamId,projectId:attempt.projectId,workdayId:attempt.workdayId,status:reads++===0?'ready':'assigned',nodeRevision:attempt.nodeRevision,graphRevisionUpdated:attempt.graphRevision}];
 })};
}

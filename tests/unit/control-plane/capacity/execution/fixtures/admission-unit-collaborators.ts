import {assignment} from './assignment.ts';
import {afterEach,beforeEach,vi} from 'vitest';
import * as transactions from '../../../../../../src/api/capacity/transaction.ts';
import {ProviderAssignmentRepository} from '../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';
import {CapacityWorkdayEventRepository} from '../../../../../../src/api/capacity/repositories/capacity/workdays/workday-event.ts';

/** Unit collaborators only. Owning SQL and native PostgreSQL cases exercise
 * the actual transaction and repositories without this helper. */
export function admissionUnitCollaborators(){
 beforeEach(()=>{
  vi.spyOn(transactions,'capacityTransaction').mockImplementation(async(store,apply)=>apply({...store,first:async<R extends Record<string,unknown>>(sql:string,params?:unknown[]):Promise<R|null>=>sql.includes('FROM capacity_provider_availability_sessions')?{id:'session',team_id:assignment.teamId,membership_id:'membership',capacity_provider_id:assignment.provider.providerId,status:'open',available_from:assignment.createdAt,available_until:null,expires_at:assignment.deadline}as unknown as R:store.first<R>(sql,params)}));
  vi.spyOn(ProviderAssignmentRepository.prototype,'get').mockImplementation(function(this:ProviderAssignmentRepository,teamId,id){
   const database=Reflect.get(this,'database') as {getProviderAssignment:ProviderAssignmentRepository['get']};
   return database.getProviderAssignment(teamId,id);
  });
  vi.spyOn(CapacityWorkdayEventRepository.prototype,'create').mockImplementation(async(teamId,runId,value)=>({...value,teamId,runId,eventIndex:0}));
 });
 afterEach(()=>vi.restoreAllMocks());
}

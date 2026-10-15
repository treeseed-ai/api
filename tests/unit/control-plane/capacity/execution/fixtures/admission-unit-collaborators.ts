import {afterEach,beforeEach,vi} from 'vitest';
import * as transactions from '../../../../../../src/api/capacity/transaction.ts';
import {ProviderAssignmentRepository} from '../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';
import {CapacityWorkdayEventRepository} from '../../../../../../src/api/capacity/repositories/capacity/workdays/workday-event.ts';

/** Unit collaborators only. Owning SQL and native PostgreSQL cases exercise
 * the actual transaction and repositories without this helper. */
export function admissionUnitCollaborators(){
 beforeEach(()=>{
  vi.spyOn(transactions,'capacityTransaction').mockImplementation(async(store,apply)=>apply(store));
  vi.spyOn(ProviderAssignmentRepository.prototype,'get').mockImplementation(function(this:ProviderAssignmentRepository,teamId,id){
   const database=Reflect.get(this,'database') as {getProviderAssignment:ProviderAssignmentRepository['get']};
   return database.getProviderAssignment(teamId,id);
  });
  vi.spyOn(CapacityWorkdayEventRepository.prototype,'create').mockImplementation(async(teamId,runId,value)=>({...value,teamId,runId,eventIndex:0}));
 });
 afterEach(()=>vi.restoreAllMocks());
}

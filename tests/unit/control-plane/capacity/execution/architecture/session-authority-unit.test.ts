import { describe, expect, it } from 'vitest';
import { admitLivingExecutionAssignment } from '../../../../../../src/api/capacity/services/capacity/assignments/admission/living-execution-admission.ts';
import { replayAttempt, replayInput } from './admission-replay-fixture.ts';

describe('locked availability authority at final admission', () => {
 it('denies missing foreign closed stale and malformed locked sessions before downstream writes while retaining exact replay authority', async () => {
  const input=replayInput(replayAttempt()),original=structuredClone(input),now=input.now;
  const session={id:input.providerSessionId,team_id:input.principal.teamId,membership_id:input.principal.membershipId,capacity_provider_id:input.principal.capacityProviderId,status:'open',available_from:now,available_until:null,expires_at:input.assignment.deadline};
  const denied=[null,...['team_id','membership_id','capacity_provider_id'].map(field=>({...session,[field]:'foreign'})),...['closed','expired','draining','unknown','',null].map(status=>({...session,status})),
   ...['available_from','expires_at','available_until'].flatMap(field=>['invalid','',undefined].map(value=>({...session,[field]:value}))),
   {...session,available_from:new Date(Date.parse(now)+1).toISOString()},{...session,expires_at:now},{...session,available_until:now}];
  const interruption=new Error('retained downstream unit interruption');
  for(const value of [...denied,session]){
   const held=structuredClone(value),queries:Array<{sql:string;params:unknown[]}>=[];
   const store={getProviderAssignment:async()=>null,first:async()=>({id:input.assignment.nodeId}),db:{transaction:async(apply:(client:unknown)=>Promise<unknown>)=>apply({query:async(sql:string,params:unknown[]=[])=>{queries.push({sql,params});if(sql.includes('FROM capacity_provider_availability_sessions'))return{rows:value?[value]:[]};throw interruption;}})}};
   const failure=await admitLivingExecutionAssignment(store as never,input).then(()=>null,error=>error);
   if(value===session){expect(failure).toBe(interruption);expect(queries).toHaveLength(2);}else{expect(failure).toMatchObject({code:'provider_availability_session_unavailable',status:409});expect(queries).toHaveLength(1);}
   expect(queries[0]).toMatchObject({sql:expect.stringContaining('FOR NO KEY UPDATE'),params:[input.providerSessionId]});
   expect(value).toEqual(held);expect(input).toEqual(original);
  }
 });
});

import {observeAvailabilitySession} from '../../../../../src/api/capacity/repositories/accounts/availability-observation.ts';
import {createCapacityQueryService} from '../../../../../src/api/control-plane/repositories/capacity/capacity-query-service.ts';
import {expect,it,vi} from 'vitest';
import {AvailabilitySessionRepository,type AvailabilitySessionWrite} from '../../../../../src/api/capacity/repositories/accounts/availability-session.ts';
import type {CapacityGovernanceDatabase,CapacityDatabaseOperation} from '../../../../../src/api/capacity/database.ts';
import {canonicalOfferBuildInput} from '../execution/fixtures/assignment-attempt-fixtures.ts';

it('publishes the committed provider availability transition into existing scoped capacity audit history without private adapter observations',async()=>{
 const at='2026-10-17T00:00:00.000Z',provider=canonicalOfferBuildInput(at).providers[0]!;
 const input:AvailabilitySessionWrite={id:'session',membershipId:'membership',teamId:'team',providerId:'provider',environment:'local',sequence:1,
  openedAt:at,refreshedAt:at,expiresAt:'2026-10-17T00:01:00.000Z',availableFrom:at,availableUntil:null,
  executionProviders:[{...provider,id:'configured-adapter',adapter:'codex',status:'active',maxConcurrentRunners:1,
   observations:{credential:'PRIVATE_ADAPTER_OBSERVATION'},accountingObservation:{modelUsage:{day:'2026-10-17',observedAt:at,healthy:true,activeSeconds:0,reservedSeconds:0},capabilityUsage:{}}}],
  capabilities:provider.capabilities,nativeLimits:{},runnerPressure:{},constraints:{},metadata:{}};
 const row={id:input.id,membership_id:input.membershipId,team_id:input.teamId,capacity_provider_id:input.providerId,status:'open',sequence:1,
  opened_at:at,refreshed_at:at,expires_at:input.expiresAt,available_from:at,available_until:null,closed_at:null,
  execution_providers_json:JSON.stringify(input.executionProviders),capabilities_json:JSON.stringify(input.capabilities),
  native_limits_json:'{}',runner_pressure_json:'{}',constraints_json:'{}',metadata_json:'{}'};
 const operations:CapacityDatabaseOperation[]=[],before=structuredClone(input);
 const all=vi.fn<CapacityGovernanceDatabase['all']>().mockResolvedValue([]);
 const database:CapacityGovernanceDatabase={ensureInitialized:vi.fn(async()=>{}),run:vi.fn(async(query:string,params:unknown[]=[])=>{operations.push({query,params});if(query.includes('INSERT INTO capacity_audit_events')){const [id,team_id,capacity_provider_id,membership_id,actor_type,actor_id,action,resource_type,resource_id,request_id,idempotency_key,metadata_json,created_at]=params;all.mockResolvedValue([{id,team_id,capacity_provider_id,membership_id,actor_type,actor_id,action,resource_type,resource_id,request_id,idempotency_key,metadata_json,created_at}]);}}),
  first:async<T extends Record<string,unknown>>()=>structuredClone(row) as T,
  all:async<T extends Record<string,unknown>>(query:string,params?:unknown[])=>await all(query,params) as T[],
  batch:vi.fn(async batch=>{operations.push(...structuredClone(batch));return batch.map(()=>({results:[]}));})};
 const result=await new AvailabilitySessionRepository(database).open(input,[]);
 expect(result).toMatchObject({id:'session',sequence:1,status:'open'});
 const observations=operations.filter(operation=>operation.query.includes('INSERT INTO capacity_audit_events'));
 expect(observations).toHaveLength(1);
 expect(JSON.stringify(observations)).toContain('provider.availability.updated');
 expect(JSON.stringify(observations)).toContain('session');
 expect(JSON.stringify(observations)).not.toContain('PRIVATE_ADAPTER_OBSERVATION');
 expect(input).toEqual(before);
 if(!result)throw new Error('Original successful session required');
 for(const field of ['expiresAt','openedAt']as const){const bad=structuredClone(result);Reflect.set(bad,field,'not-a-clock');const count=operations.length;await expect(observeAvailabilitySession(database,bad)).rejects.toMatchObject({code:'provider_availability_observation_invalid'});expect(operations).toHaveLength(count);}
 const unmeasured=structuredClone(result);unmeasured.snapshot.availableWorkers=NaN;const count=operations.length;await expect(observeAvailabilitySession(database,unmeasured)).rejects.toMatchObject({code:'provider_availability_observation_invalid'});expect(operations).toHaveLength(count);
});

it('public capacity audit preserves raw records and complete cursor pagination including equal-clock identities',async()=>{
 const at='2026-10-17T00:00:00.000Z',rows=[{id:'audit-b',created_at:at,metadata_json:'{}'},{id:'audit-a',created_at:at,metadata_json:'{}'}];
 const all=vi.fn(async(sql:string,parameters:unknown[])=>rows.filter(row=>parameters.length<3||row.id<String(parameters[3])).slice(0,Number(parameters.at(-1)))),query=createCapacityQueryService({ensureInitialized:async()=>{},all});
 const principal={id:'operator',roles:['admin']};
 const first=await query.audit(principal,'team',{limit:1});expect(first.items).toEqual([rows[0]]);expect(first.page.hasMore).toBe(true);expect(first.page.nextCursor).toBeTruthy();
 const second=await query.audit(principal,'team',{limit:1,cursor:first.page.nextCursor});expect(second.items).toEqual([rows[1]]);expect(second.page.hasMore).toBe(false);expect(second.page.nextCursor).toBeNull();
 expect(all.mock.calls[1]![0]).toContain('id < ?');expect(all.mock.calls[1]![1]).toContain('audit-b');
});

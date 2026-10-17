import {expect,it,vi} from 'vitest';
import {AvailabilitySessionRepository,type AvailabilitySessionWrite} from '../../../../../src/api/capacity/repositories/accounts/availability-session.ts';
import type {CapacityGovernanceDatabase,CapacityDatabaseOperation} from '../../../../../src/api/capacity/database.ts';
import {canonicalOfferBuildInput} from '../execution/fixtures/assignment-attempt-fixtures.ts';

it('publishes the committed provider availability transition into existing scoped Workday event operations without private adapter observations',async()=>{
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
 const database:CapacityGovernanceDatabase={ensureInitialized:vi.fn(async()=>{}),run:vi.fn(async()=>{}),
  first:vi.fn<CapacityGovernanceDatabase['first']>().mockResolvedValue(row),
  all:vi.fn<CapacityGovernanceDatabase['all']>().mockResolvedValue([{id:'workday',team_id:'team',status:'running'}]),
  batch:vi.fn(async batch=>{operations.push(...structuredClone(batch));return batch.map(()=>({results:[]}));})};
 const result=await new AvailabilitySessionRepository(database).open(input,[]);
 expect(result).toMatchObject({id:'session',sequence:1,status:'open'});
 const observations=operations.filter(operation=>operation.query.includes('INSERT INTO capacity_workday_events'));
 expect(observations).toHaveLength(1);
 expect(JSON.stringify(observations)).toContain('provider.availability.updated');
 expect(JSON.stringify(observations)).toContain('session');
 expect(JSON.stringify(observations)).not.toContain('PRIVATE_ADAPTER_OBSERVATION');
 expect(input).toEqual(before);
});

import {upsertCapacityExecutionProviderOperations} from '../../../../../src/api/capacity/repositories/capacity/providers/execution-provider.ts';
import {translateControlPlaneSqlToPostgres} from '../../../../../src/api/support/control-plane-postgres.ts';
import {maintainCapacityRuntimeRetention} from '../../../../../src/api/capacity/services/runtime/runtime-retention-service.ts';
import {PGlite} from '@electric-sql/pglite';
import {availabilityObservationFaultSql} from './fixtures/availability-observation.ts';
import {observeAvailabilitySession} from '../../../../../src/api/capacity/repositories/accounts/availability-observation.ts';
import {createCapacityQueryService} from '../../../../../src/api/control-plane/repositories/capacity/capacity-query-service.ts';
import {expect,it,vi} from 'vitest';
import {AvailabilitySessionRepository,type AvailabilitySessionWrite} from '../../../../../src/api/capacity/repositories/accounts/availability-session.ts';
import type {CapacityGovernanceDatabase,CapacityDatabaseOperation} from '../../../../../src/api/capacity/database.ts';
import {canonicalOfferBuildInput} from '../execution/fixtures/assignment-attempt-fixtures.ts';

vi.mock('../../../../../src/api/capacity/transaction.ts',()=>({capacityTransaction:async<T>(database:CapacityGovernanceDatabase,apply:(value:CapacityGovernanceDatabase)=>Promise<T>)=>apply(database)}));

function availabilityHistoryInput(){
 const at='2026-10-17T00:00:00.000Z',provider=canonicalOfferBuildInput(at).providers[0]!;
 const input:AvailabilitySessionWrite={id:'session',membershipId:'membership',teamId:'team',providerId:'provider',environment:'local',sequence:1,
  openedAt:at,refreshedAt:at,expiresAt:'2026-10-17T00:01:00.000Z',availableFrom:at,availableUntil:null,
  executionProviders:[{...provider,id:'configured-adapter',adapter:'codex',status:'active',maxConcurrentRunners:1,
   observations:{credential:'PRIVATE_ADAPTER_OBSERVATION'},accountingObservation:{modelUsage:{day:'2026-10-17',observedAt:at,healthy:true,activeSeconds:0,reservedSeconds:0},capabilityUsage:{}}}],
  capabilities:provider.capabilities,nativeLimits:{},runnerPressure:{},constraints:{},metadata:{}};
 const row={id:input.id,membership_id:input.membershipId,team_id:input.teamId,capacity_provider_id:input.providerId,status:'open',sequence:1,
  opened_at:at,refreshed_at:at,expires_at:input.expiresAt,available_from:at,available_until:null,closed_at:null as string|null,
  execution_providers_json:JSON.stringify(input.executionProviders),capabilities_json:JSON.stringify(input.capabilities),
  native_limits_json:'{}',runner_pressure_json:'{}',constraints_json:'{}',metadata_json:'{}'};
 return {at,input,row};
}

it('publishes the committed provider availability transition into existing scoped capacity audit history without private adapter observations',async()=>{
 const {at,input,row}=availabilityHistoryInput();
 const operations:CapacityDatabaseOperation[]=[],before=structuredClone(input);
 const all=vi.fn<CapacityGovernanceDatabase['all']>().mockResolvedValue([]);
 const database:CapacityGovernanceDatabase={ensureInitialized:vi.fn(async()=>{}),run:vi.fn(async(query:string,params:unknown[]=[])=>{operations.push({query,params});if(query.includes('INSERT INTO capacity_audit_events')){const [id,team_id,capacity_provider_id,membership_id,actor_type,actor_id,action,resource_type,resource_id,request_id,idempotency_key,metadata_json,created_at]=params;all.mockResolvedValue([{id,team_id,capacity_provider_id,membership_id,actor_type,actor_id,action,resource_type,resource_id,request_id,idempotency_key,metadata_json,created_at}]);}}),
  first:async<T extends Record<string,unknown>>(query:string,params?:unknown[]):Promise<T|null>=>{void query;void params;const result:Record<string,unknown>=structuredClone(row);return result as T;},
  all:async<T extends Record<string,unknown>>(query:string,params?:unknown[]):Promise<T[]>=>await all(query,params) as T[],
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
 const invalidCalendar=structuredClone(result);invalidCalendar.openedAt='2026-02-30T00:00:00.000Z';const calendarWrites=operations.length;await expect(observeAvailabilitySession(database,invalidCalendar)).rejects.toMatchObject({code:'provider_availability_observation_invalid'});expect(operations).toHaveLength(calendarWrites);
 const unmeasured=structuredClone(result);unmeasured.snapshot.availableWorkers=NaN;const count=operations.length;await expect(observeAvailabilitySession(database,unmeasured)).rejects.toMatchObject({code:'provider_availability_observation_invalid'});expect(operations).toHaveLength(count);
});

it('public capacity audit preserves raw records and complete cursor pagination including equal-clock identities',async()=>{
 const at='2026-10-17T00:00:00.000Z',rows=[{id:'audit-b',created_at:at,metadata_json:'{}'},{id:'audit-a',created_at:at,metadata_json:'{}'}];
 const all=vi.fn(async(sql:string,parameters:unknown[])=>rows.filter(row=>parameters.length<3||row.id<String(parameters[3])).slice(0,Number(parameters.at(-1)))),query=createCapacityQueryService({ensureInitialized:async()=>{},all,principalCanAccessTeam:async()=>false});
 const principal={id:'operator',roles:['admin']};
 await expect(query.audit(undefined,'team',{limit:1})).rejects.toMatchObject({status:401,code:'authentication_required'});await expect(query.audit({id:'denied',roles:[]},'team',{limit:1})).rejects.toMatchObject({status:403,code:'team_access_denied'});expect(all).not.toHaveBeenCalled();
 await expect(query.audit(principal,'team',{limit:1,cursor:'not-a-valid-cursor'})).rejects.toMatchObject({status:400,code:'capacity_page_invalid'});expect(all).not.toHaveBeenCalled();
 const first=await query.audit(principal,'team',{limit:1});expect(first.items).toEqual([rows[0]]);expect(first.page.hasMore).toBe(true);expect(first.page.nextCursor).toBeTruthy();
 const second=await query.audit(principal,'team',{limit:1,cursor:first.page.nextCursor});expect(second.items).toEqual([rows[1]]);expect(second.page.hasMore).toBe(false);expect(second.page.nextCursor).toBeNull();
 expect(all.mock.calls[1]![0]).toContain('id < ?');expect(all.mock.calls[1]![1]).toContain('audit-b');
});

it('executes the exact owning native availability fault SQL with missing interrupted and altered audit writes before original source retry',async()=>{
 const database=new PGlite();try{
  await database.exec('CREATE TABLE capacity_audit_events (action TEXT NOT NULL, metadata_json TEXT NOT NULL)');
  for(const mode of ['missing','interrupted','altered']as const){
   await database.exec(availabilityObservationFaultSql(mode));
   await database.exec('CREATE TRIGGER retained_availability_observation_fault BEFORE INSERT ON capacity_audit_events FOR EACH ROW EXECUTE FUNCTION retained_availability_observation_fault()');
   const insert=()=>database.query('INSERT INTO capacity_audit_events (action,metadata_json) VALUES ($1,$2)',['provider.availability.updated','{"original":true}']);
   try{if(mode==='interrupted')await expect(insert()).rejects.toThrow('retained native availability observation interruption');else await insert();expect((await database.query('SELECT * FROM capacity_audit_events')).rows).toEqual(mode==='altered'?[{action:'provider.availability.updated',metadata_json:'{}'}]:[]);}
   finally{await database.exec('DROP TRIGGER retained_availability_observation_fault ON capacity_audit_events; DROP FUNCTION retained_availability_observation_fault(); DELETE FROM capacity_audit_events');}
  }
  await database.query('INSERT INTO capacity_audit_events (action,metadata_json) VALUES ($1,$2)',['provider.availability.updated','{"original":true}']);expect((await database.query('SELECT * FROM capacity_audit_events')).rows).toEqual([{action:'provider.availability.updated',metadata_json:'{"original":true}'}]);
 }finally{await database.close();}
 // Controlled PostgreSQL grammar in WASM is a focused check, never native
 // concurrency, complete prerequisite or managed evidence.
});

it('retains each actual runtime expiry in the original availability audit clock and reports only newly expired sessions through unchanged replay',async()=>{
 const {at,row:original}=availabilityHistoryInput(),now='2026-10-17T00:02:00.000Z',session={...original},audits:Array<Record<string,unknown>>=[];
 const expire=()=>{if(!['open','draining'].includes(session.status)||session.expires_at>now)return[];session.status='expired';session.closed_at=now;return[{id:session.id,team_id:session.team_id}];};
 const database:CapacityGovernanceDatabase={ensureInitialized:async()=>{},
  first:async<T extends Record<string,unknown>>(query:string):Promise<T|null>=>{const value:Record<string,unknown>=query.includes('COUNT(*)')?{total:query.includes('capacity_provider_availability_sessions')&&['open','draining'].includes(session.status)?1:0}:structuredClone(session);return value as T;},
  all:async<T extends Record<string,unknown>>(query:string):Promise<T[]>=>{const values=query.startsWith('UPDATE capacity_provider_availability_sessions')?expire():query.includes('capacity_audit_events')?structuredClone(audits):[];return values as T[];},
  run:async(query,params=[])=>{if(query.includes('INSERT INTO capacity_audit_events')){const[id,team_id,capacity_provider_id,membership_id,actor_type,actor_id,action,resource_type,resource_id,request_id,idempotency_key,metadata_json,created_at]=params;audits.push({id,team_id,capacity_provider_id,membership_id,actor_type,actor_id,action,resource_type,resource_id,request_id,idempotency_key,metadata_json,created_at});}},
  batch:async operations=>{if(operations.some(value=>value.query.includes("SET status = 'expired'")&&value.query.includes('capacity_provider_availability_sessions')))expire();return operations.map(()=>({results:[]}));}};
 const result=await maintainCapacityRuntimeRetention(database,now);expect(result.expiredAvailabilitySessions).toBe(1);expect(audits).toHaveLength(1);
 expect(audits[0]).toMatchObject({created_at:now,resource_id:session.id,idempotency_key:'1:expired'});expect(JSON.parse(String(audits[0]!.metadata_json))).toMatchObject({status:'expired',closedAt:now,refreshedAt:at});
 const bad=await new AvailabilitySessionRepository(database).get(session.team_id,session.id);if(!bad)throw new Error('Original expired session required');bad.closedAt=at;const writes=audits.length;await expect(observeAvailabilitySession(database,bad)).rejects.toMatchObject({code:'provider_availability_observation_invalid'});expect(audits).toHaveLength(writes);
 const held=structuredClone({session,audits});expect((await maintainCapacityRuntimeRetention(database,now)).expiredAvailabilitySessions).toBe(0);expect({session,audits}).toEqual(held);
 // Transaction mechanics and independent native concurrency are covered by
 // the owning PostgreSQL case; this unit controls only the database protocol.
});

it('retains exact capability offer bytes on stale foreign or terminal availability publication before original guarded retry',async()=>{
 const {at,input}=availabilityHistoryInput(),database=new PGlite(),later='2026-10-17T00:00:10.000Z';try{
  await database.exec("CREATE TABLE capacity_provider_availability_sessions (id TEXT,membership_id TEXT,team_id TEXT,sequence INTEGER,status TEXT);CREATE TABLE execution_capability_offers (capacity_provider_id TEXT,execution_provider_id TEXT,offer_id TEXT,offer_digest TEXT,offer_json TEXT,status TEXT,last_seen_at TEXT,PRIMARY KEY(capacity_provider_id,offer_id));INSERT INTO capacity_provider_availability_sessions VALUES ('session','membership','team',2,'open')");
  const base={providerId:input.providerId,executionProviders:input.executionProviders,providerNativeLimits:input.nativeLimits,createdAt:at},guard={sessionId:'session',membershipId:'membership',teamId:'team',expectedSequence:2};
  const publish=async(value:Parameters<typeof upsertCapacityExecutionProviderOperations>[0])=>{const operations=upsertCapacityExecutionProviderOperations(value).filter(item=>item.query.startsWith('INSERT INTO execution_capability_offers'));expect(operations).toHaveLength(1);for(const operation of operations)await database.query(translateControlPlaneSqlToPostgres(operation.query),operation.params);};
  await publish(base);const held=(await database.query<Record<string,unknown>>('SELECT * FROM execution_capability_offers')).rows;
  for(const denied of[{...guard,expectedSequence:1},{...guard,sessionId:'foreign'},{...guard,membershipId:'foreign'},{...guard,teamId:'foreign'}]){await publish({...base,createdAt:later,availabilityGuard:denied});expect((await database.query<Record<string,unknown>>('SELECT * FROM execution_capability_offers')).rows).toEqual(held);}
  for(const status of['closed','expired','draining']){await database.query('UPDATE capacity_provider_availability_sessions SET status=$1',[status]);await publish({...base,createdAt:later,availabilityGuard:guard});expect((await database.query<Record<string,unknown>>('SELECT * FROM execution_capability_offers')).rows).toEqual(held);}
  await database.query("UPDATE capacity_provider_availability_sessions SET status='open'");await publish({...base,createdAt:later,availabilityGuard:guard});expect((await database.query<Record<string,unknown>>('SELECT * FROM execution_capability_offers')).rows).toEqual(held.map(value=>({...value,last_seen_at:later})));
  await database.query("UPDATE execution_capability_offers SET status='context_overflow'");const exact=(await database.query<Record<string,unknown>>('SELECT * FROM execution_capability_offers')).rows;await publish({...base,createdAt:later,availabilityGuard:guard});expect((await database.query<Record<string,unknown>>('SELECT * FROM execution_capability_offers')).rows).toEqual(exact);
 }finally{await database.close();}
 // Real generated SQL grammar and owning guards, with controlled local data;
 // independent PostgreSQL contention remains the original native case.
});

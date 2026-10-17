import {canonicalJson,sha256} from '../../security.ts';
import {isDeepStrictEqual} from 'node:util';
import type {ProviderAvailabilitySession} from '@treeseed/sdk/capacity-provider/contracts';
import type {CapacityGovernanceDatabase} from '../../database.ts';
import {CapacityGovernanceError} from '../../database.ts';
import {CapacityAuditRepository} from '../support/audit.ts';
type Row=Record<string,unknown>;
const object=(value:unknown):Row=>value&&typeof value==='object'&&!Array.isArray(value)?value as Row:{};
const healthy=(value:unknown):boolean|null=>{if(value===undefined||value===null)return null;if(typeof value!=='boolean')throw new CapacityGovernanceError('provider_availability_observation_invalid','Availability health observation must remain an original boolean.',500);return value;};

/** Existing audit is observation history; the session remains the supply authority. */
export async function observeAvailabilitySession(database:CapacityGovernanceDatabase,session:ProviderAvailabilitySession):Promise<void>{
 const now=session.status==='closed'?session.closedAt:session.refreshedAt;
 const clocks=[session.openedAt,session.refreshedAt,session.expiresAt,session.snapshot.availableFrom,...(session.closedAt?[session.closedAt]:[]),...(session.snapshot.availableUntil?[session.snapshot.availableUntil]:[])];
 if(!clocks.every(value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value)||Date.parse(session.openedAt)>Date.parse(session.refreshedAt)||Date.parse(session.expiresAt)<=Date.parse(session.refreshedAt)||session.closedAt&&Date.parse(session.closedAt)<Date.parse(session.refreshedAt)||![session.snapshot.maxConcurrentWorkers,session.snapshot.availableWorkers,session.snapshot.reservedWorkers,session.snapshot.borrowedWorkers].every(value=>Number.isSafeInteger(value)&&value>=0))
  throw new CapacityGovernanceError('provider_availability_observation_invalid','Original lifecycle clocks and measured worker quantities required.',500);
 if(!now||!Number.isFinite(Date.parse(now))||!Number.isSafeInteger(session.sequence)||session.sequence<1)
  throw new CapacityGovernanceError('provider_availability_observation_invalid','Original availability identity sequence and clock required.',500);
 const adapters=session.snapshot.adapters.map(adapter=>{
  const accounting=object(adapter.accountingObservation),model=object(accounting.modelUsage),capabilities=object(accounting.capabilityUsage);
  const policy=object(adapter.observations).modelPolicy;
  return{id:adapter.id,status:adapter.status,runtimeBuild:adapter.runtimeBuild??null,capabilities:adapter.capabilities,laneIds:adapter.laneIds,
   nativeLimitsDigest:'sha256:'+sha256(canonicalJson(adapter.nativeLimits)),modelPolicyDigest:policy===undefined?null:'sha256:'+sha256(canonicalJson(policy)),
   offers:(adapter.offers??[]).map(offer=>({offerId:offer.offerId,offerDigest:offer.offerDigest})),
   modelHealthy:healthy(model.healthy),capabilityHealth:Object.fromEntries(adapter.capabilities.map(id=>[id,healthy(object(capabilities[id]).healthy)]))};
 });
 if(new Set(adapters.map(adapter=>adapter.id)).size!==adapters.length)
  throw new CapacityGovernanceError('provider_availability_observation_invalid','Ambiguous adapter inventory cannot become history.',500);
 const metadata={providerId:session.providerId,membershipId:session.membershipId,availabilitySessionId:session.id,sequence:session.sequence,status:session.status,
  openedAt:session.openedAt,refreshedAt:session.refreshedAt,expiresAt:session.expiresAt,closedAt:session.closedAt,
  pressure:session.snapshot.pressure,availableFrom:session.snapshot.availableFrom,availableUntil:session.snapshot.availableUntil,
  maxConcurrentWorkers:session.snapshot.maxConcurrentWorkers,availableWorkers:session.snapshot.availableWorkers,reservedWorkers:session.snapshot.reservedWorkers,borrowedWorkers:session.snapshot.borrowedWorkers,
  lanes:session.snapshot.lanes,constraintsDigest:'sha256:'+sha256(canonicalJson(session.snapshot.constraints)),adapters};
 const action='provider.availability.updated',key=session.sequence+':'+session.status;
 await new CapacityAuditRepository(database).recordOnce({teamId:session.teamId,providerId:session.providerId,membershipId:session.membershipId,
  actorType:'system',actorId:null,action,resourceType:'provider-availability-session',resourceId:session.id,idempotencyKey:key,metadata,now},session.id+':'+key);
 const rows=await database.all('SELECT * FROM capacity_audit_events WHERE team_id=? AND action=? AND resource_id=? AND idempotency_key=?',[session.teamId,action,session.id,key]);
 const row=rows[0];let retained:unknown;try{retained=JSON.parse(String(row?.metadata_json));}catch{/* Original malformed bytes remain retained. */}
 if(rows.length!==1||!row||row.capacity_provider_id!==session.providerId||row.membership_id!==session.membershipId||row.created_at!==now||!isDeepStrictEqual(retained,metadata))
  throw new CapacityGovernanceError('provider_availability_observation_conflict','Availability requires its exact original durable public audit observation.',500);
}

import { randomUUID } from 'node:crypto';
import {
	validateWorkdayIntent,
	validateWorkdayPreflight,
	validateWorkdayPreflightFreshness,
	type WorkdayIntent,
	type WorkdayPreflightObservation,
	type WorkdayPreflightReceipt,
	type WorkdayStartReceipt,
	type WorkdayStartRequest,
} from '@treeseed/sdk/operator-contracts';
import { CapacityGovernanceError,type CapacityGovernanceDatabase } from '../../../../database.ts';
import { canonicalJson,sha256 } from '../../../../security.ts';

type JsonRecord = Record<string,unknown>;

interface WorkdayIntentStore extends CapacityGovernanceDatabase {
	preflightCapacityWorkdayRunRequest(teamId:string,input:JsonRecord): Promise<JsonRecord>;
	createCapacityWorkdayRun(teamId:string,input:JsonRecord):Promise<JsonRecord|null>;
}

interface StoredPreflight { receipt:WorkdayPreflightReceipt; intent:WorkdayIntent; runInput:JsonRecord }

function record(value:unknown):JsonRecord { return value&&typeof value==='object'&&!Array.isArray(value)?value as JsonRecord:{}; }
function text(value:unknown):string { return typeof value==='string'?value.trim():''; }
function integer(value:unknown,fallback:number):number { const parsed=Number(value); return Number.isInteger(parsed)&&parsed>0?parsed:fallback; }
function digest(value:unknown):string { return `sha256:${sha256(canonicalJson(value))}`; }
function diagnosticsError(code:string,message:string,diagnostics:unknown):never { throw new CapacityGovernanceError(code,message,400,{diagnostics}); }

export function parsePublicWorkdayIntent(teamId:string,input:JsonRecord):WorkdayIntent {
	const allowed=new Set(['schemaVersion','teamId','profileId','projects','startsAt','endsAt','durationSeconds','objectiveFilters','operatorConstraints']);
	const forbidden=Object.keys(input).filter((key)=>!allowed.has(key));
	if(forbidden.length) diagnosticsError('workday_intent_derived_fields_forbidden','Workday preflight accepts high-level intent only.',forbidden.map((path)=>({code:'field_forbidden',path})));
	if(input.teamId!==undefined&&text(input.teamId)!==teamId) diagnosticsError('workday_intent_team_mismatch','Workday intent team must match the route team.',[{code:'team_mismatch',path:'teamId'}]);
	const projects=input.projects==='all'?'all':Array.isArray(input.projects)?input.projects.map(text).filter(Boolean):[];
	const constraints=record(input.operatorConstraints);
	const intent:WorkdayIntent={
		schemaVersion:'treeseed.workday-intent/v1', teamId, profileId:text(input.profileId), projects,
		startsAt:text(input.startsAt),
		...(input.endsAt!==undefined?{endsAt:text(input.endsAt)}:{}),
		...(input.durationSeconds!==undefined?{durationSeconds:Number(input.durationSeconds)}:{}),
		...(Array.isArray(input.objectiveFilters)?{objectiveFilters:input.objectiveFilters.map(text).filter(Boolean)}:{}),
		...(Object.keys(constraints).length?{operatorConstraints:{
			...(Array.isArray(constraints.providerIds)?{providerIds:constraints.providerIds.map(text).filter(Boolean)}:{}),
			...(constraints.maxConcurrency!==undefined?{maxConcurrency:Number(constraints.maxConcurrency)}:{}),
			...(constraints.reservePercent!==undefined?{reservePercent:Number(constraints.reservePercent)}:{}),
		}}:{}),
	};
	const diagnostics=validateWorkdayIntent(intent);
	if(projects!=='all'&&!projects.length) diagnostics.push({code:'projects_required',path:'projects',message:'Select at least one project or all.'});
	if(diagnostics.length) diagnosticsError('workday_intent_invalid','Workday intent is invalid.',diagnostics);
	return intent;
}

export class WorkdayPreflightService {
	constructor(private readonly store:WorkdayIntentStore) {}

	private async providerId(teamId:string,intent:WorkdayIntent):Promise<string> {
		const constrained=intent.operatorConstraints?.providerIds??[];
		if(constrained.length>1) throw new CapacityGovernanceError('workday_provider_ambiguous','Select at most one capacity provider for this workday.',409,{candidates:constrained});
		if(constrained[0]) return constrained[0];
		const rows=await this.store.all(`SELECT capacity_provider_id FROM capacity_provider_team_memberships WHERE team_id = ? AND status = 'approved' ORDER BY approved_at ASC, id ASC LIMIT 2`,[teamId]);
		if(rows.length!==1) throw new CapacityGovernanceError('workday_provider_ambiguous','Workday provider selection is not unambiguous.',409,{candidateCount:rows.length});
		return String(rows[0].capacity_provider_id);
	}

	private async compile(teamId:string,intent:WorkdayIntent,requestedById:string|null,id:string):Promise<StoredPreflight> {
		await this.store.ensureInitialized();
		const providerId=await this.providerId(teamId,intent);
		const allocation=await this.store.first(`SELECT * FROM capacity_allocation_sets WHERE team_id = ? AND id = ? AND status = 'active' LIMIT 1`,[teamId,intent.profileId]);
		if(!allocation) throw new CapacityGovernanceError('workday_profile_not_indexed','The selected repository allocation profile has not been indexed into an accepted allocation generation.',409,{profileId:intent.profileId});
		const startsAt=intent.startsAt;
		const endsAt=intent.endsAt??new Date(Date.parse(startsAt)+(intent.durationSeconds??0)*1000).toISOString();
		const durationSeconds=Math.floor((Date.parse(endsAt)-Date.parse(startsAt))/1000);
		const maxConcurrency=integer(intent.operatorConstraints?.maxConcurrency,1);
		const reservePercent=Number(intent.operatorConstraints?.reservePercent??10);
		if(!Number.isFinite(reservePercent)||reservePercent<0||reservePercent>100) diagnosticsError('workday_intent_invalid','Workday reserve must be between zero and one hundred percent.',[{code:'reserve_invalid',path:'operatorConstraints.reservePercent'}]);
		const cooperativePlanningPercent=Math.min(20,100-reservePercent);
		const runInput:JsonRecord={
			id:`workday-${id}`,capacityProviderId:providerId,status:'running',startedAt:startsAt,requestedById,
			environment:'local',scenarioId:`profile:${intent.profileId}`,
			parameters:{ profileId:intent.profileId,allocationSetId:String(allocation.id),projectSlugs:intent.projects==='all'?[]:intent.projects,
				projects:intent.projects==='all'?[]:intent.projects,durationSeconds,maxActiveAssignments:maxConcurrency,
				objectiveRefs:intent.objectiveFilters??[],planningOnly:false,planningSession:{rounds:3,assignmentTimeboxSeconds:60},timePolicy:{cooperativePlanningPercent,governedExecutionPercent:100-reservePercent-cooperativePlanningPercent,reservePercent} },
		};
		const projection=await this.store.preflightCapacityWorkdayRunRequest(teamId,runInput);
		const participants=Array.isArray(projection.planningParticipants)?projection.planningParticipants.map(record):[];
		const acting=Array.isArray(projection.actingDemands)?projection.actingDemands.map(record):[];
		const classIds=[...new Set([...participants,...acting].map((entry)=>text(entry.projectAgentClassId)).filter(Boolean))];
		const classRows=classIds.length?await this.store.all(`SELECT id,slug FROM project_agent_classes WHERE id IN (${classIds.map(()=>'?').join(',')}) ORDER BY id`,classIds):[];
		const classSlugs=new Map(classRows.map((entry)=>[String(entry.id),String(entry.slug)]));
		const selectedPlanning=participants.map((entry,index)=>{
			const nodeId=text(entry.nodeId); const projectId=nodeId.split(':')[0]??''; const classId=text(entry.projectAgentClassId);
			return {id:`planning:${nodeId}`,projectId,sourceType:'agent-planning-profile',sourceId:text(entry.agentId),mode:'planning' as const,
				classSlug:classSlugs.get(classId)??classId,requestedSeconds:integer(entry.timeboxSeconds,900),priority:index};
		});
		const selectedActing=acting.map((entry,index)=>{
			const classId=text(entry.projectAgentClassId); const payload=record(entry.payload); const executionInputId=text(payload.decisionExecutionInputId); const estimateId=text(payload.estimateId);
			return {id:`acting:${text(entry.capacityPlanId)}:${text(entry.sourceId)}`,projectId:text(entry.projectId),sourceType:'capacity-plan',sourceId:text(entry.sourceId),mode:'acting' as const,
				classSlug:classSlugs.get(classId)??classId,requestedSeconds:integer(entry.requestedSeconds,1),priority:integer(entry.priority,index+100),actingAuthority:{
					decisionId:text(entry.decisionId),decisionStatus:'approved' as const,executionInputId,executionInputStatus:'accepted' as const,estimateId,
					capacityPlanId:text(entry.capacityPlanId),capacityPlanDigest:digest(entry),
				}};
		});
		const selectedDemands=[...selectedPlanning,...selectedActing];
		const classAccounting=[...new Set(selectedDemands.map((entry)=>entry.classSlug))].sort().map((classSlug)=>({classSlug,
			allocatedSeconds:selectedDemands.filter((entry)=>entry.classSlug===classSlug).reduce((sum,entry)=>sum+entry.requestedSeconds,0),
			borrowedSeconds:0,lentSeconds:0,idleSeconds:0,reservedSeconds:0,activeSeconds:0,releasedSeconds:0,overrunSeconds:0}));
		const profileGeneration=integer(allocation.state_version??allocation.version,1);
		const state:WorkdayPreflightObservation={
			profileGeneration, profileDigest:digest(allocation), demandSetDigest:digest({selectedDemands,objectives:intent.objectiveFilters??[]}),
			providerCapacityDigest:digest({providerId,membershipTeam:teamId,availableSeconds:projection.availableSeconds??null}),
			authorizationDigest:digest({teamId,requestedById,profileId:intent.profileId}),
			reservationDigest:digest(await this.store.all(`SELECT id,state,requested_seconds,reserved_seconds,active_seconds,elapsed_seconds,released_seconds,overrun_seconds FROM capacity_reservations WHERE team_id = ? AND state IN ('reserved','consuming','overran_pending_approval','continuation_required') ORDER BY id`,[teamId])),
		};
		const base={ schemaVersion:'treeseed.workday-preflight/v1' as const,id,teamId,intentDigest:digest(intent),profileId:intent.profileId,
			profileVersion:text(allocation.version)||`generation-${profileGeneration}`,...state,selectedDemands,classAccounting,borrowing:[],startsAt,endsAt,
			maxConcurrency,reserveSeconds:Math.floor(durationSeconds*maxConcurrency*reservePercent/100),expiresAt:new Date(Date.now()+5*60_000).toISOString() };
		const receipt:WorkdayPreflightReceipt={...base,preflightDigest:digest(base)};
		const diagnostics=validateWorkdayPreflight(receipt);
		if(diagnostics.length) diagnosticsError('workday_preflight_invalid','API-derived workday preflight is invalid.',diagnostics);
		return {receipt,intent,runInput};
	}

	async preflight(teamId:string,intent:WorkdayIntent,requestedById:string|null):Promise<WorkdayPreflightReceipt> {
		const stored=await this.compile(teamId,intent,requestedById,randomUUID());
		await this.store.run(`INSERT INTO capacity_operation_receipts (id,team_id,operation,idempotency_key,request_digest,resource_type,resource_id,response_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,[
			randomUUID(),teamId,'workday.preflight',stored.receipt.id,stored.receipt.intentDigest,'workday_preflight',stored.receipt.id,canonicalJson(stored),new Date().toISOString(),new Date().toISOString(),
		]);
		return stored.receipt;
	}

	async start(teamId:string,request:WorkdayStartRequest,requestedById:string|null):Promise<WorkdayStartReceipt> {
		if(!text(request.preflightId)||!text(request.preflightDigest)||!text(request.idempotencyKey)) throw new CapacityGovernanceError('workday_start_invalid','preflightId, preflightDigest, and idempotencyKey are required.',400);
		const requestDigest=digest(request);
		const replay=await this.store.first(`SELECT request_digest,response_json FROM capacity_operation_receipts WHERE team_id=? AND operation='workday.start' AND idempotency_key=? LIMIT 1`,[teamId,request.idempotencyKey]);
		if(replay) {
			if(String(replay.request_digest)!==requestDigest) throw new CapacityGovernanceError('capacity_idempotency_key_conflict','The workday start idempotency key is bound to different input.',409);
			return JSON.parse(String(replay.response_json)) as WorkdayStartReceipt;
		}
		const row=await this.store.first(`SELECT response_json FROM capacity_operation_receipts WHERE team_id=? AND resource_type='workday_preflight' AND resource_id=? LIMIT 1`,[teamId,request.preflightId]);
		if(!row) throw new CapacityGovernanceError('workday_preflight_not_found','Unknown workday preflight.',404);
		const stored=JSON.parse(String(row.response_json)) as StoredPreflight;
		if(stored.receipt.preflightDigest!==request.preflightDigest) throw new CapacityGovernanceError('workday_preflight_digest_mismatch','Workday start must bind the exact preflight digest.',409);
		const {preflightDigest,...preflightPayload}=stored.receipt;
		if(digest(preflightPayload)!==preflightDigest) throw new CapacityGovernanceError('workday_preflight_integrity_invalid','Stored workday preflight evidence does not match its digest; generate a fresh plan.',409);
		const diagnostics=validateWorkdayPreflight(stored.receipt);
		if(diagnostics.length) throw new CapacityGovernanceError('workday_preflight_stale','Workday preflight is expired or invalid; generate a fresh plan.',409,{diagnostics});
		const current=await this.compile(teamId,stored.intent,requestedById,stored.receipt.id);
		const freshness=validateWorkdayPreflightFreshness(stored.receipt,current.receipt);
		if(freshness.length) throw new CapacityGovernanceError('workday_preflight_stale','Workday authority or capacity changed after preflight; generate a fresh plan.',409,{diagnostics:freshness});
		const existing=await this.store.first(`SELECT * FROM capacity_workday_runs WHERE team_id=? AND id=? LIMIT 1`,[teamId,String(stored.runInput.id)]);
		const run=existing??await this.store.createCapacityWorkdayRun(teamId,stored.runInput);
		if(!run) throw new CapacityGovernanceError('workday_start_failed','The API did not create the governed workday.',500);
		const receipt:WorkdayStartReceipt={schemaVersion:'treeseed.workday-start-receipt/v1',workdayId:String(run.id),preflightId:request.preflightId,preflightDigest:request.preflightDigest,
			acceptedCapacityPlanIds:stored.receipt.selectedDemands.flatMap((demand)=>demand.actingAuthority?[demand.actingAuthority.capacityPlanId]:[]),assignmentIds:[],reservationIds:[],
			startedAt:String(run.startedAt??run.started_at??stored.receipt.startsAt),providerReceiptRefs:[],transactionReceiptId:`workday-start:${sha256(canonicalJson(request))}`};
		await this.store.run(`INSERT INTO capacity_operation_receipts (id,team_id,operation,idempotency_key,request_digest,resource_type,resource_id,response_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,[
			randomUUID(),teamId,'workday.start',request.idempotencyKey,requestDigest,'workday_start',receipt.workdayId,canonicalJson(receipt),new Date().toISOString(),new Date().toISOString(),
		]);
		return receipt;
	}
}

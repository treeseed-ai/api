import { randomUUID } from 'node:crypto';
import {
	normalizeRepositoryWorkdayProfileBundle,
	validateOneClassPerProjectAgent,
	validateRepositoryWorkdayProfileBundle,
	type ProjectAgentClassMembership,
	type RepositoryWorkdayProfileBundle,
	type RepositoryProfileGenerationReceipt,
	type RepositoryProfileReconciliationReceipt,
	type WorkdayAllocationProfile,
} from '@treeseed/sdk/operator-contracts';
import type { CapacityGovernanceDatabase } from '../../../../database.ts';
import { CapacityGovernanceError } from '../../../../database.ts';
import { CapacityOperationReceiptRepository } from '../../../../repositories/operations/operation-receipt.ts';
import { canonicalJson,sha256 } from '../../../../security.ts';

type Row = Record<string,unknown>;
type IndexedGeneration = {generation:RepositoryProfileGenerationReceipt;allocationSetId:string;active:boolean};

export const REPOSITORY_WORKDAY_PROFILE_PATH='.treeseed/workdays/allocation-profile.json';

export interface RepositoryWorkdayProfileObservation {
	repository:string;
	ref:string;
	commit:string;
	path:string;
	content:string;
	observedAt?:string;
}

function text(value:unknown):string { return value==null?'':String(value).trim(); }
function record(value:unknown):Row { return value&&typeof value==='object'&&!Array.isArray(value)?value as Row:{}; }
function digest(value:unknown):string { return `sha256:${sha256(canonicalJson(value))}`; }
function safeJson(value:unknown):Row { try { return record(JSON.parse(String(value??'{}'))); } catch { return {}; } }
function bundleFrom(content:string):RepositoryWorkdayProfileBundle {
	let parsed:unknown;
	try { parsed=JSON.parse(content); } catch { throw new CapacityGovernanceError('repository_workday_profile_json_invalid','Repository workday profile JSON is invalid.',400); }
	const candidate=record(parsed);
	if(candidate.schemaVersion!=='treeseed.workday-allocation-profile-bundle/v1'||!Array.isArray(candidate.profiles)) throw new CapacityGovernanceError('repository_workday_profile_bundle_invalid','Repository workday profile content must be a versioned profile bundle.',400);
	return candidate as unknown as RepositoryWorkdayProfileBundle;
}
function repositoryIdentity(value:string):{owner:string;name:string} {
	const [owner,name,...rest]=value.trim().toLowerCase().split('/');
	if(!owner||!name||rest.length) throw new CapacityGovernanceError('repository_workday_profile_repository_invalid','Repository identity must be owner/name.',400);
	return {owner,name};
}
function configuredAgents(row:Row):Array<{slug:string}> {
	const agents=safeJson(row.handler_refs_json).agents;
	return Array.isArray(agents)?agents.map(record).map((agent)=>({slug:text(agent.slug||agent.agentId)})).filter((agent)=>agent.slug):[];
}

export class RepositoryWorkdayProfileService {
	private readonly receipts:CapacityOperationReceiptRepository;
	constructor(private readonly database:CapacityGovernanceDatabase) { this.receipts=new CapacityOperationReceiptRepository(database); }

	async reconcile(observation:RepositoryWorkdayProfileObservation):Promise<RepositoryProfileReconciliationReceipt[]> {
		await this.database.ensureInitialized();
		const repository=repositoryIdentity(observation.repository);
		if(!/^refs\/heads\/[A-Za-z0-9._/-]+$/u.test(observation.ref)) throw new CapacityGovernanceError('repository_workday_profile_ref_invalid','An exact accepted branch ref is required.',400);
		if(!/^[a-f0-9]{40}$/u.test(observation.commit)) throw new CapacityGovernanceError('repository_workday_profile_commit_invalid','An exact 40-character source commit is required.',400);
		if(observation.path!==REPOSITORY_WORKDAY_PROFILE_PATH) throw new CapacityGovernanceError('repository_workday_profile_path_invalid','Repository workday profiles must use the canonical path.',400);
		const binding=await this.database.first<Row>(`SELECT * FROM project_remote_repository_bindings WHERE LOWER(owner)=? AND LOWER(name)=? LIMIT 1`,[repository.owner,repository.name]);
		if(!binding) throw new CapacityGovernanceError('repository_workday_profile_binding_missing','Repository is not bound to a TreeSeed project.',409,{repository:observation.repository});
		const acceptedRef=`refs/heads/${text(binding.publication_ref)}`;
		if(observation.ref!==acceptedRef) throw new CapacityGovernanceError('repository_workday_profile_ref_not_accepted','Only the repository publication ref can create an accepted profile generation.',409,{acceptedRef});
		const candidate=bundleFrom(observation.content);
		const allProjects=await this.database.all<Row>(`SELECT id,slug FROM projects WHERE team_id=? ORDER BY slug,id`,[binding.team_id]);
		const classes=await this.database.all<Row>(`SELECT * FROM project_agent_classes WHERE team_id=? ORDER BY project_id,slug,id`,[binding.team_id]);
		const catalogs=allProjects.flatMap((project)=>{
			const projectId=text(project.id); const slug=text(project.slug); const classSlugs=classes.filter((entry)=>text(entry.project_id)===projectId&&text(entry.status)==='active').map((entry)=>text(entry.slug));
			return [...new Set([projectId,slug].filter(Boolean))].map((key)=>({projectId:key,classSlugs}));
		});
		const memberships:ProjectAgentClassMembership[]=classes.flatMap((entry)=>configuredAgents(entry).map((agent)=>({projectId:text(entry.project_id),agentId:agent.slug,classSlug:text(entry.slug),status:(['active','paused','archived'].includes(text(entry.status))?text(entry.status):'archived') as ProjectAgentClassMembership['status']})));
		const diagnostics=[...validateRepositoryWorkdayProfileBundle(candidate,catalogs),...validateOneClassPerProjectAgent(memberships,memberships.map(({projectId,agentId})=>({projectId,agentId})))];
		if(diagnostics.length) throw new CapacityGovernanceError('repository_workday_profile_invalid','Repository workday profile is incompatible with the accepted project agent catalog.',409,{diagnostics});
		const bundle=normalizeRepositoryWorkdayProfileBundle(candidate);
		const projectSets=[] as Array<Array<{id:string;slug:string;key:string}>>;
		for(const profile of bundle.profiles) projectSets.push(await this.resolveProjects(text(binding.team_id),profile,binding,allProjects));
		const responses:RepositoryProfileReconciliationReceipt[]=[];
		for(const [index,profile] of bundle.profiles.entries()) responses.push(await this.reconcileProfile(observation,binding,profile,projectSets[index]!,classes));
		await this.retireRemovedProfiles(observation,binding,new Set(bundle.profiles.map((profile)=>profile.id)));
		return responses;
	}

	private async reconcileProfile(observation:RepositoryWorkdayProfileObservation,binding:Row,profile:WorkdayAllocationProfile,projects:Array<{id:string;slug:string;key:string}>,classes:Row[]) {
		const profileDigest=digest(profile);
		const request={...observation,observedAt:undefined,content:undefined,contentDigest:digest(observation.content),profileId:profile.id,profileDigest};
		const operation={teamId:text(binding.team_id),operation:'repository-workday-profile.reconcile',idempotencyKey:`${observation.repository}:${observation.commit}:${observation.path}:${profile.id}`,request};
		const replay=await this.receipts.replay<RepositoryProfileReconciliationReceipt>(operation);
		if(replay.found) return replay.response;
		const previous=await this.previous(text(binding.team_id),observation.repository,observation.path,profile.id);
		const observedAt=observation.observedAt??new Date().toISOString();
		if(previous?.active&&previous.generation.profileDigest===profileDigest) return this.recordUnchanged(operation,observation,profile,previous,observedAt);
		const version=Number((await this.database.first<Row>(`SELECT COALESCE(MAX(version),0)+1 AS version FROM capacity_allocation_sets WHERE team_id=?`,[binding.team_id]))?.version??1);
		const allocationId=`profile-${sha256(`${observation.repository}:${observation.commit}:${profile.id}:${profileDigest}`).slice(0,32)}`;
		const generation:RepositoryProfileGenerationReceipt={schemaVersion:'treeseed.repository-profile-generation/v1',repository:observation.repository,ref:observation.ref,commit:observation.commit,path:observation.path,profileId:profile.id,profileVersion:profile.version,profileDigest,generation:version,indexedAt:observedAt};
		const response=this.reconciliation(observation,previous?.generation.generation??null,generation,allocationId,previous?'updated':'created',[]);
		const allocation=this.allocation(profile,projects,classes,allocationId,version,generation,observedAt);
		await this.database.batch([
			{query:'SELECT id FROM teams WHERE id=? FOR UPDATE',params:[binding.team_id]},
			{query:`INSERT INTO capacity_allocation_sets (id,team_id,version,status,effective_from,effective_until,reserve_policy_json,slices_json,borrowing_rules_json,metadata_json,created_by_id,activated_at,superseded_by_id,created_at,updated_at) VALUES (?,?,?,'active',?,NULL,?,?,?,?,NULL,?,NULL,?,?)`,params:[allocationId,binding.team_id,version,observedAt,JSON.stringify(allocation.reservePolicy),JSON.stringify(allocation.slices),JSON.stringify(allocation.borrowingRules),JSON.stringify(allocation.metadata),observedAt,observedAt,observedAt]},
			...(previous?.active?[{query:`UPDATE capacity_allocation_sets SET status='superseded',superseded_by_id=?,updated_at=? WHERE team_id=? AND id=? AND status='active'`,params:[allocationId,observedAt,binding.team_id,previous.allocationSetId]}]:[]),
			this.receipts.insertOperation(operation,'repository-workday-profile',`${observation.repository}:${observation.path}:${profile.id}`,response,observedAt),
		]);
		return response;
	}

	private async resolveProjects(teamId:string,profile:WorkdayAllocationProfile,binding:Row,knownRows?:Row[]) {
		const rows=knownRows??await this.database.all<Row>(`SELECT id,slug FROM projects WHERE team_id=? ORDER BY slug,id`,[teamId]);
		const selected=profile.projects==='all'?rows:profile.projects.map((key)=>rows.find((row)=>text(row.id)===key||text(row.slug)===key)).filter(Boolean) as Row[];
		if(!selected.length) throw new CapacityGovernanceError('repository_workday_profile_projects_missing','Profile project scope does not resolve to this team.',409);
		if(!selected.some((project)=>text(project.id)===text(binding.project_id))) throw new CapacityGovernanceError('repository_workday_profile_binding_scope_invalid','Profile must include the repository-bound project.',409);
		return selected.map((row)=>({id:text(row.id),slug:text(row.slug),key:profile.projects==='all'?text(row.id):(profile.projects as string[]).find((key)=>key===text(row.id)||key===text(row.slug))??text(row.id)}));
	}

	private async previous(teamId:string,repository:string,path:string,profileId:string):Promise<IndexedGeneration|null> {
		const row=await this.database.first<Row>(`SELECT response_json FROM capacity_operation_receipts WHERE team_id=? AND operation='repository-workday-profile.reconcile' AND resource_id=? ORDER BY created_at DESC LIMIT 1`,[teamId,`${repository}:${path}:${profileId}`]);
		if(!row) return null;
		try {
			const receipt=JSON.parse(String(row.response_json)) as RepositoryProfileReconciliationReceipt&Partial<IndexedGeneration>;
			if(!receipt.generation||!text(receipt.allocationSetId)) return null;
			const allocation=await this.database.first<Row>(`SELECT status FROM capacity_allocation_sets WHERE team_id=? AND id=? LIMIT 1`,[teamId,text(receipt.allocationSetId)]);
			return {generation:receipt.generation,allocationSetId:text(receipt.allocationSetId),active:text(allocation?.status)==='active'};
		} catch { throw new CapacityGovernanceError('repository_workday_profile_receipt_invalid','Stored repository profile receipt is invalid.',500); }
	}

	private async retireRemovedProfiles(observation:RepositoryWorkdayProfileObservation,binding:Row,desiredProfileIds:Set<string>) {
		const rows=await this.database.all<Row>(`SELECT resource_id,response_json FROM capacity_operation_receipts WHERE team_id=? AND operation='repository-workday-profile.reconcile' AND resource_id LIKE ? ORDER BY created_at DESC`,[binding.team_id,`${observation.repository}:${observation.path}:%`]);
		const seen=new Set<string>(); const now=observation.observedAt??new Date().toISOString();
		for(const row of rows) {
			let receipt:Row; try { receipt=record(JSON.parse(String(row.response_json))); } catch { throw new CapacityGovernanceError('repository_workday_profile_receipt_invalid','Stored repository profile receipt is invalid.',500); }
			const generation=record(receipt.generation); const profileId=text(generation.profileId); const allocationSetId=text(receipt.allocationSetId);
			if(!profileId||seen.has(profileId)) continue; seen.add(profileId);
			if(desiredProfileIds.has(profileId)||!allocationSetId) continue;
			const allocation=await this.database.first<Row>(`SELECT status FROM capacity_allocation_sets WHERE team_id=? AND id=? LIMIT 1`,[binding.team_id,allocationSetId]);
			if(text(allocation?.status)!=='active') continue;
			const request={repository:observation.repository,commit:observation.commit,path:observation.path,profileId,allocationSetId};
			const operation={teamId:text(binding.team_id),operation:'repository-workday-profile.retire',idempotencyKey:`${observation.repository}:${observation.commit}:${observation.path}:${profileId}`,request};
			const replay=await this.receipts.replay<Row>(operation); if(replay.found) continue;
			const response={schemaVersion:'treeseed.repository-profile-retirement/v1',repository:observation.repository,observedCommit:observation.commit,profileId,allocationSetId,status:'archived',retiredAt:now};
			await this.database.batch([
				{query:'SELECT id FROM teams WHERE id=? FOR UPDATE',params:[binding.team_id]},
				{query:`UPDATE capacity_allocation_sets SET status='archived',updated_at=? WHERE team_id=? AND id=? AND status='active'`,params:[now,binding.team_id,allocationSetId]},
				this.receipts.insertOperation(operation,'repository-workday-profile',`${observation.repository}:${observation.path}:${profileId}`,response,now),
			]);
		}
	}

	private reconciliation(observation:RepositoryWorkdayProfileObservation,previousGeneration:number|null,generation:RepositoryProfileGenerationReceipt,allocationSetId:string,status:RepositoryProfileReconciliationReceipt['status'],diagnostics:string[]) {
		const base={schemaVersion:'treeseed.repository-profile-reconciliation/v1' as const,repository:observation.repository,observedCommit:observation.commit,previousGeneration,acceptedGeneration:generation.generation,profileDigests:[generation.profileDigest],status,diagnostics,generation,allocationSetId};
		return {...base,receiptDigest:digest(base)};
	}

	private async recordUnchanged(operation:Parameters<CapacityOperationReceiptRepository['replay']>[0],observation:RepositoryWorkdayProfileObservation,profile:WorkdayAllocationProfile,previous:IndexedGeneration,now:string) {
		const generation={...previous.generation,ref:observation.ref,commit:observation.commit,profileVersion:profile.version,indexedAt:now};
		const response=this.reconciliation(observation,previous.generation.generation,generation,previous.allocationSetId,'unchanged',[]);
		await this.database.batch([this.receipts.insertOperation(operation,'repository-workday-profile',`${observation.repository}:${observation.path}:${profile.id}`,response,now)]);
		return response;
	}

	private allocation(profile:WorkdayAllocationProfile,projects:Array<{id:string}>,classes:Row[],id:string,version:number,generation:RepositoryProfileGenerationReceipt,now:string) {
		const projectTarget=100/projects.length;
		const slices:Row[]=[];
		for(const project of projects) {
			const projectSlice=`project:${project.id}`;
			slices.push({id:projectSlice,scope:'project',targetId:project.id,policy:{minPercent:0,targetPercent:projectTarget,maxPercent:100,hardCapPercent:100}});
			for(const configured of profile.classes) {
				const agentClass=classes.find((entry)=>text(entry.project_id)===project.id&&text(entry.slug)===configured.classSlug);
				if(!agentClass) continue;
				slices.push({id:`class:${project.id}:${configured.classSlug}`,scope:'agent-class',targetId:text(agentClass.id),parentSliceId:projectSlice,policy:{minPercent:configured.minimumPercent,targetPercent:configured.targetPercent,maxPercent:configured.maximumPercent,hardCapPercent:configured.maximumPercent},metadata:{classSlug:configured.classSlug}});
			}
		}
		const borrowingRules:Row[]=[];
		for(const project of projects) for(const lender of profile.classes.filter((entry)=>entry.mayLend&&classes.some((row)=>text(row.project_id)===project.id&&text(row.slug)===entry.classSlug))) for(const borrower of profile.classes.filter((entry)=>entry.mayBorrow&&entry.classSlug!==lender.classSlug&&classes.some((row)=>text(row.project_id)===project.id&&text(row.slug)===entry.classSlug))) {
			const maxPercent=Math.min(lender.targetPercent-lender.minimumPercent,borrower.maximumPercent-borrower.targetPercent);
			if(maxPercent>0) borrowingRules.push({id:`borrow:${project.id}:${lender.classSlug}:${borrower.classSlug}`,fromSliceId:`class:${project.id}:${lender.classSlug}`,toSliceId:`class:${project.id}:${borrower.classSlug}`,maxPercent,requiresApproval:false,allocationPriorityBand:'normal',allocationPriorityScore:0});
		}
		return {id,version,reservePolicy:{percent:profile.reservePercent,overflow:borrowingRules.length?'borrow':'deny'},slices,borrowingRules,metadata:{repositoryProfile:generation,workdayProfile:profile},now};
	}
}

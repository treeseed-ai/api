import { createHash } from 'node:crypto';
import { CapacityGovernanceError } from '../../../../database.ts';
import { resolveKnowledgeGatewayConnection } from '../../../../../knowledge/gateway-treedx-connection.ts';
import { listUnpublishedTreeDxAuthoringState,recordTreeDxAuthoringState } from '../../../treedx/repositories/treedx-authoring-journal.ts';

type Row=Record<string,unknown>;
type Store={
	getProviderAssignment(teamId:string,assignmentId:string):Promise<Row|null>;
	getProject(projectId:string):Promise<{teamId:string}|null>;
	upsertProjectTreeDxLibrary(projectId:string,input:Row):Promise<Row|null>;
	first<T extends Row=Row>(query:string,params?:unknown[]):Promise<T|null>;
	all<T extends Row=Row>(query:string,params?:unknown[]):Promise<T[]>;
	run(query:string,params?:unknown[]):Promise<unknown>;
	recordAuditEvent(input:Row):Promise<unknown>;
};

function record(value:unknown):Row{return value&&typeof value==='object'&&!Array.isArray(value)?value as Row:{};}
function text(...values:unknown[]){for(const value of values)if(typeof value==='string'&&value.trim())return value.trim();return '';}
function exactCommit(value:string){return /^[a-f0-9]{40}$/u.test(value);}
function exactCommits(values:string[]){return [...new Set(values.map((value)=>value.trim()))].sort();}
function abandonmentId(assignmentId:string){return `assignment_content_abandonment_${createHash('sha256').update(assignmentId).digest('hex').slice(0,32)}`;}
function sourceRef(assignment:Row){return text(record(assignment.treedxProxyHandle).branchName,record(record(assignment.workspaceContext).treedxProxyHandle).branchName);}
function refHead(refs:unknown[],ref:string){const short=ref.replace(/^refs\/heads\//u,'');const match=refs.map(record).find((entry)=>[text(entry.name),text(entry.ref)].includes(ref)||[text(entry.name),text(entry.ref)].includes(short));return text(match?.target,match?.sha);}
function sameValues(left:string[],right:string[]){return left.length===right.length&&left.every((value,index)=>value===right[index]);}

export async function abandonAssignmentContent(input:{
	store:Store;teamId:string;assignmentId:string;actorId:string;idempotencyKey:string;
	expectedCommitShas:string[];reason:string;workdayId:string;simulateHuman:boolean;
}){
	if(!input.idempotencyKey)throw new CapacityGovernanceError('idempotency_key_required','Content abandonment requires an idempotency key.',422);
	if(!input.simulateHuman||!input.reason||!input.workdayId)throw new CapacityGovernanceError('simulated_human_evidence_required','Content abandonment requires --simulate-human, an exact workday, and an evidence reason.',422);
	const expected=exactCommits(input.expectedCommitShas);
	if(!expected.length||expected.some((commit)=>!exactCommit(commit)))throw new CapacityGovernanceError('assignment_content_abandonment_refs_invalid','Content abandonment requires every exact unpublished commit SHA.',422);
	const assignment=await input.store.getProviderAssignment(input.teamId,input.assignmentId);
	if(!assignment)throw new CapacityGovernanceError('assignment_not_found','Unknown assignment.',404);
	if(!['completed','failed','cancelled','expired'].includes(text(assignment.status)))throw new CapacityGovernanceError('assignment_content_abandonment_status_invalid','Only released terminal assignments can abandon unpublished content.',409,{status:assignment.status});
	if(text(assignment.status)==='completed'&&await input.store.first('SELECT id FROM audit_events WHERE target_type = ? AND target_id = ? AND event_type = ? LIMIT 1',['capacity_provider_assignment',input.assignmentId,'assignment.content.integrated']))throw new CapacityGovernanceError('assignment_content_abandonment_integrated','Integrated assignment content cannot be abandoned.',409,{assignmentId:input.assignmentId});
	const leaseState=text(assignment.leaseState,assignment.lease_state);
	if(leaseState!=='released'&&!(text(assignment.status)==='expired'&&leaseState==='expired'))throw new CapacityGovernanceError('assignment_content_abandonment_lease_active','Content abandonment requires terminal released or expired lease custody.',409);
	if(text(assignment.workDayId,assignment.work_day_id)!==input.workdayId)throw new CapacityGovernanceError('assignment_content_workday_mismatch','The simulated-human workday does not own this assignment.',409);
	const auditId=abandonmentId(input.assignmentId);const prior=await input.store.first('SELECT data_json FROM audit_events WHERE id = ? LIMIT 1',[auditId]);
	if(prior){const payload=record(JSON.parse(text(prior.data_json)||'{}'));const recorded=exactCommits(Array.isArray(payload.expectedCommitShas)?payload.expectedCommitShas.map(String):[]);
		if(!sameValues(recorded,expected))throw new CapacityGovernanceError('assignment_content_abandonment_replay_conflict','The assignment already has different abandonment evidence.',409,{expectedCommitShas:recorded});
		return {...payload,replayed:true};}
	const projectId=text(assignment.projectId,assignment.project_id);const branch=sourceRef(assignment);
	if(!projectId||!branch)throw new CapacityGovernanceError('assignment_content_authority_missing','Assignment TreeDX source authority is missing.',409);
	if(branch!==`refs/heads/${input.assignmentId}`)throw new CapacityGovernanceError('assignment_content_abandonment_ref_not_isolated','Content abandonment is restricted to the exact assignment-owned TreeDX ref.',409,{branch});
	const unpublished=await listUnpublishedTreeDxAuthoringState(input.store,projectId,input.assignmentId);
	const observed=exactCommits(unpublished.map((entry)=>text(entry.commitSha)));
	if(!sameValues(observed,expected))throw new CapacityGovernanceError('assignment_content_abandonment_refs_mismatch','The supplied commits do not exactly match authoritative unpublished assignment state.',409,{expectedCommitShas:expected,observedCommitShas:observed});
	const connection=await resolveKnowledgeGatewayConnection(input.store,{projectId,write:false,maintenanceRefs:[branch],authoringPaths:true,communicationPaths:true,relationPaths:true});
	if(!connection)throw new CapacityGovernanceError('assignment_content_treedx_unavailable','TreeDX maintenance custody is unavailable.',503);
	const beforeRefs=await connection.client.listRepositoryRefs(connection.repositoryId);const beforeHead=refHead(beforeRefs,branch);
	if(beforeHead&&!expected.includes(beforeHead))throw new CapacityGovernanceError('assignment_content_abandonment_source_stale','The assignment ref advanced beyond the exact unpublished evidence.',409,{beforeHead});
	if(beforeHead)await connection.client.discardOrphanRef({repoId:connection.repositoryId,ref:branch,expectedHead:beforeHead,reason:input.reason});
	const afterRefs=await connection.client.listRepositoryRefs(connection.repositoryId);const afterHead=refHead(afterRefs,branch);
	if(afterHead)throw new CapacityGovernanceError('assignment_content_abandonment_readback_failed','Fresh TreeDX read-back still observes the abandoned assignment ref.',502,{afterHead});
	for(const entry of unpublished)await recordTreeDxAuthoringState(input.store,'abandoned',{projectId,repositoryId:text(entry.repositoryId,connection.repositoryId),commitSha:text(entry.commitSha),ref:text(entry.ref,branch),changedPaths:Array.isArray(entry.changedPaths)?entry.changedPaths.map(String):[],assignmentId:input.assignmentId,actorType:'user',actorId:input.actorId,advanceProjectContentRef:false});
	const remaining=await listUnpublishedTreeDxAuthoringState(input.store,projectId,input.assignmentId);
	if(remaining.length)throw new CapacityGovernanceError('assignment_content_abandonment_journal_failed','The authoring journal still reports unpublished assignment state after abandonment.',502,{remaining});
	const payload={assignmentId:input.assignmentId,projectId,ref:branch,beforeHead,afterHead:null,expectedCommitShas:expected,abandonedCommitShas:observed,reason:input.reason,workdayId:input.workdayId,actorId:input.actorId,readBackVerified:true,replayed:false};
	await input.store.recordAuditEvent({id:auditId,actorType:'user',actorId:input.actorId,eventType:'assignment.content.abandoned',targetType:'capacity_provider_assignment',targetId:input.assignmentId,data:{...payload,idempotencyKey:input.idempotencyKey}});
	return payload;
}

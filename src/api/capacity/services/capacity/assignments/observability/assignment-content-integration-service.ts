import { createHash } from 'node:crypto';
import { type ArtifactMutationReceipt } from '@treeseed/sdk/agent-capacity';
import { validateArtifactMutationReceipt } from '../../../../policy/artifact-mutation-receipt.ts';
import { CapacityGovernanceError } from '../../../../database.ts';
import { resolveKnowledgeGatewayConnection } from '../../../../../knowledge/gateway-treedx-connection.ts';
import { listUnpublishedTreeDxAuthoringState,recordTreeDxAuthoringState } from '../../../treedx/repositories/treedx-authoring-journal.ts';
import { terminalizeCompletedConversationInvocation } from '../../invocations/discussion-invocation-service.ts';

type Row = Record<string, unknown>;
type Store = {
	config: Record<string, unknown>;
	getProviderAssignment(teamId: string, assignmentId: string): Promise<Row | null>;
	getProjectTreeDxLibrary(projectId: string): Promise<Row | null>;
	getProject(projectId: string): Promise<{ teamId: string } | null>;
	upsertProjectTreeDxLibrary(projectId: string,input: Row): Promise<{ repositoryId?: string | null; contentRepositoryRef?: string | null } | null>;
	first<T extends Row = Row>(query: string,params?: unknown[]): Promise<T | null>;
	all<T extends Row = Row>(query: string,params?: unknown[]): Promise<T[]>;
	run(query: string,params?: unknown[]): Promise<unknown>;
	recordAuditEvent(input: Row): Promise<unknown>;
};

function record(value: unknown): Row { return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}; }
function text(...values: unknown[]) { for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim(); return ''; }
function parse(value: unknown): Row { if (typeof value !== 'string') return record(value); try { return record(JSON.parse(value)); } catch { return {}; } }
function exactCommit(value: string) { return /^[a-f0-9]{40}$/u.test(value); }
function integrationId(assignmentId: string,commitSha: string) {
	return `assignment_content_integration_${createHash('sha256').update(`${assignmentId}\n${commitSha}`).digest('hex').slice(0,32)}`;
}
function lifecycleManifest(assignment: Row) {
	const output=record(assignment.lifecycleOutput ?? assignment.lifecycle_output);
	return record(output.artifactManifest ?? output.artifact_manifest);
}
function validatedProvisionalReceipts(assignment: Row,manifest:Row) {
	const candidates=Array.isArray(manifest.mutationReceipts)?manifest.mutationReceipts as unknown[]:[];
	return candidates.map((candidate)=>{
		const validation=validateArtifactMutationReceipt(candidate);
		if(!validation.ok)throw new CapacityGovernanceError('assignment_content_receipt_invalid',validation.reason,409,{assignmentId:assignment.id});
		return validation.value;
	}).filter((receipt)=>receipt.kind==='treedx-content'&&receipt.phase==='provisional');
}

async function provisionalReceipts(store:Pick<Store,'first'>,assignment:Row) {
	const durable=validatedProvisionalReceipts(assignment,lifecycleManifest(assignment));
	if(durable.length)return durable;
	const metadata=record(assignment.metadata);
	if(text(assignment.status)!=='returned'||text(assignment.leaseState,assignment.lease_state)!=='released'
		||text(assignment.executionKind,assignment.execution_kind)!=='conversation'
		||text(assignment.lifecycleCode,assignment.lifecycle_code)!=='discussion_response_required'
		||text(metadata.operationalState)!=='suspended')return durable;
	const modeRun=await store.first(`SELECT outputs_json FROM agent_mode_runs WHERE provider_assignment_id=? AND team_id=?
		ORDER BY updated_at DESC,id DESC LIMIT 1`,[assignment.id,text(assignment.teamId,assignment.team_id)]);
	return validatedProvisionalReceipts(assignment,record(parse(modeRun?.outputs_json).artifactManifest));
}

export async function readAssignmentContentIntegrations(store: Pick<Store,'all'>,teamId:string,assignmentId:string) {
	const rows=await store.all('SELECT data_json, created_at FROM audit_events WHERE target_type = ? AND target_id = ? AND event_type = ? ORDER BY created_at, id',
		['capacity_provider_assignment',assignmentId,'assignment.content.integrated']);
	return rows.flatMap((row)=>[parse(row.data_json).receipt,...(Array.isArray(parse(row.data_json).relatedReceipts)?parse(row.data_json).relatedReceipts as unknown[]:[])].map((candidate)=>{
		const validation=validateArtifactMutationReceipt(candidate);
		if(!validation.ok) throw new CapacityGovernanceError('assignment_content_integration_receipt_invalid',validation.reason,500,{ assignmentId });
		if(validation.value.assignmentId!==assignmentId||validation.value.teamId!==teamId) {
			throw new CapacityGovernanceError('assignment_content_integration_receipt_mismatch','Stored content integration receipt does not match the requested assignment authority.',500,{ assignmentId });
		}
		const receipt=validation.value; const observedPaths=receipt.integration?.observedPaths??[];
		const simulationIsolated=receipt.executionMode!=='simulation'||receipt.integration?.canonicalHeadBefore===receipt.integration?.canonicalHeadAfter;
		const readBackVerified=receipt.phase==='integrated'&&receipt.integration?.observedRef===receipt.effectiveRef
			&&receipt.changedPaths.every((path)=>observedPaths.includes(path))&&simulationIsolated;
		return { receipt,readBackVerified,integratedAt:text(row.created_at,receipt.createdAt) };
	}));
}
function provisionalReceipt(assignment: Row,receipts:ArtifactMutationReceipt[],expectedCommitSha: string) {
	const candidate=receipts.find((entry)=>entry.effectiveRef===expectedCommitSha);
	if(!candidate)throw new CapacityGovernanceError('assignment_content_receipt_invalid','The exact provisional TreeDX receipt does not exist.',409,{ assignmentId:assignment.id });
	return candidate;
}
function refHead(refs: unknown[],ref: string) {
	const short=ref.replace(/^refs\/heads\//u,'');
	const match=refs.map(record).find((entry)=>[text(entry.name),text(entry.ref)].includes(ref)||[text(entry.name),text(entry.ref)].includes(short));
	return text(match?.target,match?.sha);
}
async function treeDxCall<T>(stage:string,operation:()=>Promise<T>):Promise<T> {
	try { return await operation(); }
	catch(error) {
		if(error instanceof CapacityGovernanceError) throw error;
		const candidate=record(error); const status=Number(candidate.status);
		throw new CapacityGovernanceError(`assignment_content_treedx_${stage}_failed`,
			`TreeDX ${stage.replaceAll('_',' ')} failed: ${text(candidate.message,'unknown error')}`,
			Number.isInteger(status)&&status>=400&&status<=599?status:502,{ stage,treeDxCode:text(candidate.code)||null });
	}
}
async function completeIntegratedConversation(store:Store,assignment:Row,teamId:string,assignmentId:string) {
	const invocationId=text(assignment.invocationId,assignment.invocation_id);
	if(!invocationId)return;
	const now=new Date().toISOString();
	await store.run(`UPDATE agent_invocation_requests SET status='completed',assignment_id=?,completed_at=COALESCE(completed_at,?),blocking_state_json='{}',updated_at=?
		WHERE id=? AND team_id=? AND status IN ('running','completed') AND final_message_ref IS NOT NULL
		AND EXISTS (SELECT 1 FROM audit_events WHERE target_type='capacity_provider_assignment' AND target_id=? AND event_type='assignment.content.integrated')`,
		[assignmentId,now,now,invocationId,teamId,assignmentId]);
	await terminalizeCompletedConversationInvocation(store,teamId,invocationId);
}
export function resolveContentIntegrationRefs(input: { executionMode?: unknown; sourceRef: string; authoringBranch: string }) {
	const canonicalRef=`refs/heads/${input.authoringBranch.replace(/^refs\/heads\//u,'')}`;
	const simulation=input.executionMode!=='production';
	return { canonicalRef,targetRef:simulation?input.sourceRef:canonicalRef,simulation };
}
async function refreshIntegratedIndexes(connection: Awaited<ReturnType<typeof resolveKnowledgeGatewayConnection>>,ref:string,expectedCommit:string,paths:string[]) {
	if(!connection) return;
	const refresh=await treeDxCall('graph_refresh',()=>connection.client.refreshGraph({ repoId:connection.repositoryId,ref,paths,forceFull:true }));
	if(refresh.jobId) {
		let completed=false;
		for(let attempt=0;attempt<120;attempt+=1) {
			const job=await connection.client.getGraphRefreshJob({ repoId:connection.repositoryId,ref,jobId:refresh.jobId });
			if(job.status==='completed'){completed=true;break;}
			if(job.status==='failed')throw new CapacityGovernanceError('assignment_content_graph_refresh_failed','TreeDX graph refresh failed for the integrated checkpoint.',502);
			await new Promise((resolve)=>setTimeout(resolve,100));
		}
		if(!completed)throw new CapacityGovernanceError('assignment_content_graph_refresh_timeout','TreeDX graph refresh did not complete for the integrated checkpoint.',504);
	}
	const search=await treeDxCall('search_refresh',()=>connection.client.refreshSearchIndex({ repoId:connection.repositoryId,ref,paths }));
	const resolved=text(search.resolvedRef,search.sourceCommit);
	if(search.stale||resolved!==expectedCommit)throw new CapacityGovernanceError('assignment_content_index_stale','TreeDX search did not resolve the integrated checkpoint.',502,{ ref,expectedCommit,resolved });
}

export async function integrateAssignmentContent(input: {
	store: Store; teamId: string; assignmentId: string; actorId: string;
	idempotencyKey: string; expectedBaseRef: string; expectedCommitSha: string;
	reason: string; workdayId: string; simulateHuman: boolean;
}) {
	if (!input.idempotencyKey) throw new CapacityGovernanceError('idempotency_key_required','Content integration requires an idempotency key.',422);
	if (!input.simulateHuman||!input.reason||!input.workdayId) throw new CapacityGovernanceError('simulated_human_evidence_required','Content integration requires --simulate-human, an exact workday, and an evidence reason.',422);
	if (!exactCommit(input.expectedBaseRef)||!exactCommit(input.expectedCommitSha)) throw new CapacityGovernanceError('assignment_content_ref_invalid','Content integration requires exact base and checkpoint commit SHAs.',422);
	const assignment=await input.store.getProviderAssignment(input.teamId,input.assignmentId);
	if (!assignment) throw new CapacityGovernanceError('assignment_not_found','Unknown assignment.',404);
	const completed=text(assignment.status)==='completed'&&text(record(record(assignment.lifecycleOutput).completion).disposition)==='completed';
	const metadata=record(assignment.metadata);
	const suspended=text(assignment.status)==='returned'&&text(assignment.leaseState,assignment.lease_state)==='released'
		&&text(assignment.executionKind,assignment.execution_kind)==='conversation'
		&&text(assignment.lifecycleCode,assignment.lifecycle_code)==='discussion_response_required'
		&&text(metadata.operationalState)==='suspended';
	if (!completed&&!suspended) {
		throw new CapacityGovernanceError('assignment_content_not_completed','Only a truthfully completed assignment or exact required-response suspension can be integrated.',409,{ status:assignment.status });
	}
	if(suspended){const invocation=await input.store.first(`SELECT status,assignment_id,final_message_ref FROM agent_invocation_requests WHERE id=? AND team_id=? LIMIT 1`,[text(assignment.invocationId,assignment.invocation_id),input.teamId]);
		if(text(invocation?.status)!=='suspended'||text(invocation?.assignment_id)!==input.assignmentId||!text(invocation?.final_message_ref))throw new CapacityGovernanceError('assignment_content_suspension_invalid','Suspended content integration requires the exact durable final response and invocation postcondition.',409,{assignmentId:input.assignmentId});}
	if (text(assignment.workDayId,assignment.work_day_id)!==input.workdayId) throw new CapacityGovernanceError('assignment_content_workday_mismatch','The simulated-human workday does not own this assignment.',409);
	const receipts=await provisionalReceipts(input.store,assignment);
	const receipt=provisionalReceipt(assignment,receipts,input.expectedCommitSha);
	if (receipt.baseRef!==input.expectedBaseRef||receipt.assignmentId!==input.assignmentId||receipt.teamId!==input.teamId) {
		throw new CapacityGovernanceError('assignment_content_receipt_mismatch','The provisional receipt does not match the requested assignment authority.',409);
	}
	const auditId=integrationId(input.assignmentId,input.expectedCommitSha);
	const prior=await input.store.first('SELECT data_json FROM audit_events WHERE id = ? LIMIT 1',[auditId]);
	if (prior) { const data=parse(prior.data_json); await completeIntegratedConversation(input.store,assignment,input.teamId,input.assignmentId);
		return { receipt:data.receipt as ArtifactMutationReceipt,relatedReceipts:Array.isArray(data.relatedReceipts)?data.relatedReceipts:[],journalReadBack:Array.isArray(data.journalReadBack)?data.journalReadBack:[],replayed:true }; }
	const projectId=text(assignment.projectId,assignment.project_id);
	const sourceRef=text(record(assignment.treedxProxyHandle).branchName,record(record(assignment.workspaceContext).treedxProxyHandle).branchName);
	if (!projectId||!sourceRef) throw new CapacityGovernanceError('assignment_content_authority_missing','Assignment TreeDX source authority is missing.',409);
	const connection=await resolveKnowledgeGatewayConnection(input.store,{ projectId,write:false,publishRefs:[sourceRef],relationPaths:true,communicationPaths:true,authoringPaths:true });
	if (!connection) throw new CapacityGovernanceError('assignment_content_treedx_unavailable','TreeDX integration is unavailable.',503);
	const { canonicalRef,targetRef,simulation }=resolveContentIntegrationRefs({ executionMode:receipt.executionMode,sourceRef,authoringBranch:connection.authoringBranch });
	const refs=await treeDxCall('ref_observation',()=>connection.client.listRepositoryRefs(connection.repositoryId));
	const sourceHead=refHead(refs,sourceRef); const targetHead=refHead(refs,targetRef); const canonicalHeadBefore=refHead(refs,canonicalRef);
	if (sourceHead&&sourceHead!==input.expectedCommitSha) throw new CapacityGovernanceError('assignment_content_source_stale','The assignment branch no longer resolves the reviewed checkpoint.',409,{ sourceHead });
	if (!simulation&&targetHead!==input.expectedBaseRef&&targetHead!==input.expectedCommitSha) throw new CapacityGovernanceError('assignment_content_base_stale','The target content ref advanced after assignment admission.',409,{ targetHead });
	if (!simulation&&targetHead!==input.expectedCommitSha) await treeDxCall('ref_promotion',()=>connection.client.promoteRef({ repoId:connection.repositoryId,sourceRef,destinationRef:targetRef,expectedDestinationHead:input.expectedBaseRef }));
	const observedRefs=await treeDxCall('ref_readback',()=>connection.client.listRepositoryRefs(connection.repositoryId));
	if (refHead(observedRefs,targetRef)!==input.expectedCommitSha) throw new CapacityGovernanceError('assignment_content_readback_failed','Fresh TreeDX read-back did not observe the integrated checkpoint.',502);
	const canonicalHeadAfter=refHead(observedRefs,canonicalRef);
	if(simulation&&canonicalHeadAfter!==canonicalHeadBefore) throw new CapacityGovernanceError('assignment_content_simulation_upstream_changed','Simulation integration changed the canonical content authoring ref.',502,{ canonicalRef,canonicalHeadBefore,canonicalHeadAfter });
	const observedFiles=await treeDxCall('artifact_readback',()=>connection.client.readRepositoryFiles({ repoId:connection.repositoryId,ref:targetRef,paths:receipt.changedPaths,encoding:'utf8',parseFrontmatter:true,allowProtected:true }));
	const observedPaths=(observedFiles.files??[]).map((file)=>text(record(file).path)).filter(Boolean).sort();
	if(observedPaths.length!==receipt.changedPaths.length||receipt.changedPaths.some((path)=>!observedPaths.includes(path))) {
		throw new CapacityGovernanceError('assignment_content_artifact_readback_failed','Target-ref read-back did not observe every exact changed artifact.',502,{ observedPaths });
	}
	await refreshIntegratedIndexes(connection,targetRef,input.expectedCommitSha,receipt.changedPaths);
	const integrated: ArtifactMutationReceipt={ ...receipt,id:`${receipt.id}:integrated:${input.expectedCommitSha}`,phase:'integrated',
		upstreamMutationPolicy: receipt.executionMode === 'production' ? 'exact-approved-ref' : 'denied',
		review:{ reviewerId:input.actorId,disposition:'approved',evidenceReason:input.reason,workdayId:input.workdayId },
		integration:{ actorId:input.actorId,targetRef,observedRef:input.expectedCommitSha,observedPaths,
			canonicalRef,canonicalHeadBefore,canonicalHeadAfter },createdAt:new Date().toISOString() };
	await recordTreeDxAuthoringState(input.store,'integrated',{ projectId,repositoryId:connection.repositoryId,commitSha:input.expectedCommitSha,
		ref:targetRef,changedPaths:integrated.changedPaths,assignmentId:input.assignmentId,actorType:'user',actorId:input.actorId,
		advanceProjectContentRef:!simulation });
	const relatedReceipts:ArtifactMutationReceipt[]=[]; const journalReadBack:string[]=[];
	if(simulation&&text(assignment.executionKind,assignment.execution_kind)==='conversation'){
		const unpublished=await listUnpublishedTreeDxAuthoringState(input.store,projectId,input.assignmentId);
		const refs=[...new Set([...receipts.map((entry)=>entry.effectiveRef),...unpublished.map((entry)=>text(entry.commitSha))])].filter(exactCommit);
		const evidenceConnection=await resolveKnowledgeGatewayConnection(input.store,{projectId,write:false,readRefs:refs,relationPaths:true,authoringPaths:true,communicationPaths:true});
		if(!evidenceConnection)throw new CapacityGovernanceError('assignment_content_treedx_unavailable','TreeDX simulation evidence read-back is unavailable.',503);
		for(const commitSha of refs){
			const receiptEntry=receipts.find((entry)=>entry.effectiveRef===commitSha); const journal=unpublished.find((entry)=>text(entry.commitSha)===commitSha);
			const changedPaths=[...new Set([...(receiptEntry?.changedPaths??[]),...(Array.isArray(journal?.changedPaths)?journal.changedPaths.map(String):[])])].sort();
			if(!changedPaths.length)continue;
			const read=await treeDxCall('simulation_evidence_readback',()=>evidenceConnection.client.readRepositoryFiles({repoId:connection.repositoryId,ref:commitSha,paths:changedPaths,encoding:'utf8',parseFrontmatter:true,allowProtected:true}));
			const paths=(read.files??[]).map((file)=>text(record(file).path)).filter(Boolean).sort();
			if(paths.length!==changedPaths.length||changedPaths.some((path)=>!paths.includes(path)))throw new CapacityGovernanceError('assignment_content_artifact_readback_failed','Simulation evidence read-back did not observe every exact changed artifact.',502,{commitSha,changedPaths,observedPaths:paths});
			await recordTreeDxAuthoringState(input.store,'integrated',{projectId,repositoryId:connection.repositoryId,commitSha,ref:text(journal?.ref,receiptEntry?.after.ref,commitSha),changedPaths,assignmentId:input.assignmentId,actorType:'user',actorId:input.actorId,advanceProjectContentRef:false});
			journalReadBack.push(commitSha);
			if(receiptEntry&&commitSha!==input.expectedCommitSha)relatedReceipts.push({ ...receiptEntry,id:`${receiptEntry.id}:integrated:${commitSha}`,phase:'integrated',upstreamMutationPolicy:'denied',
				review:{reviewerId:input.actorId,disposition:'approved',evidenceReason:input.reason,workdayId:input.workdayId},
				integration:{actorId:input.actorId,targetRef:text(journal?.ref,receiptEntry.after.ref),observedRef:commitSha,observedPaths:paths,canonicalRef,canonicalHeadBefore,canonicalHeadAfter},createdAt:new Date().toISOString() });
		}
	}
	if (!simulation&&sourceHead===input.expectedCommitSha) await treeDxCall('source_retirement',()=>connection.client.retireRef({ repoId:connection.repositoryId,ref:sourceRef,mergedIntoRef:targetRef,
		expectedHead:input.expectedCommitSha,expectedMergedIntoHead:input.expectedCommitSha }));
	await input.store.recordAuditEvent({ id:auditId,actorType:'user',actorId:input.actorId,eventType:'assignment.content.integrated',
		targetType:'capacity_provider_assignment',targetId:input.assignmentId,data:{ receipt:integrated,relatedReceipts,journalReadBack,idempotencyKey:input.idempotencyKey } });
	await completeIntegratedConversation(input.store,assignment,input.teamId,input.assignmentId);
	return { receipt:integrated,relatedReceipts,journalReadBack,replayed:false };
}

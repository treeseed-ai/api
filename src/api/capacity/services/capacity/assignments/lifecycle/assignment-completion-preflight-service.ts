import { validateAgentArtifactManifest } from '../../../../artifact-manifest.ts';
import { TreeDxClient } from '@treeseed/sdk/treedx/client';
import { createHash } from 'node:crypto';
import { CapacityGovernanceError,type CapacityGovernanceDatabase } from '../../../../database.ts';
import { resolveWorkdayTreeDxConnection,type WorkdayTreeDxConnectionStore } from '../../workdays/treedx/workday-treedx-connection.ts';
import type { ProviderLeasePrincipal } from '../../../accounts/lease-authority-service.ts';
import { semanticArtifactChecks,type SemanticArtifactExpectation } from './semantic/artifact-checks.ts';

type Row=Record<string,unknown>;
type Store=CapacityGovernanceDatabase&WorkdayTreeDxConnectionStore&{
	getProviderAssignment(teamId:string,assignmentId:string):Promise<Row|null>;
	createCapacityWorkdayEvent(teamId:string,runId:string,input:Row):Promise<Row|null>;
};
const record=(value:unknown):Row=>value&&typeof value==='object'&&!Array.isArray(value)?value as Row:{};
const text=(...values:unknown[])=>{for(const value of values)if(typeof value==='string'&&value.trim())return value.trim();return '';};
const records=(value:unknown)=>Array.isArray(value)?value.map(record):[];
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function semanticCompletionPreflightRequired(assignment:Row,input:Row){const output=record(input.output);const manifest=record(output.artifactManifest??record(output.metadata).artifactManifest);const expectations=record(record(assignment.decisionInput).input).semanticArtifactExpectations;return manifest.schemaVersion===1||(Array.isArray(expectations)&&expectations.length>0);}

function assertLease(assignment:Row|null,principal:ProviderLeasePrincipal,leaseToken:unknown) {
	if(!assignment||assignment.capacityProviderId!==principal.capacityProviderId||assignment.membershipId!==principal.membershipId
		||assignment.status!=='leased'||assignment.leaseState!=='leased'||text(assignment.leaseToken)!==text(leaseToken)) {
		throw new CapacityGovernanceError('assignment_completion_preflight_lease_invalid','Semantic completion preflight requires the exact active assignment lease.',409);
	}
	return assignment;
}

export async function preflightProviderAssignmentCompletion(store:Store,principal:ProviderLeasePrincipal,assignmentId:string,input:Row) {
	await store.ensureInitialized();const assignment=assertLease(await store.getProviderAssignment(principal.teamId,assignmentId),principal,input.leaseToken);
	if(text(input.idempotencyKey)!==`assignment:${assignmentId}:semantic-completion-preflight`)throw new CapacityGovernanceError('assignment_completion_preflight_idempotency_invalid','Semantic completion preflight requires the canonical assignment idempotency key.',400,{assignmentId});
	const manifest=record(input.artifactManifest);const validation=validateAgentArtifactManifest(manifest as never);
	if(!validation.ok)throw new CapacityGovernanceError('assignment_completion_manifest_invalid',validation.reason??'Completion artifact manifest is invalid.',409,{assignmentId});
	if(text(manifest.assignmentId)!==assignmentId||text(manifest.projectId)!==text(assignment.projectId))throw new CapacityGovernanceError('assignment_completion_manifest_scope_invalid','Completion manifest does not belong to the exact assignment and project.',409,{assignmentId});
	const payload=record(record(assignment.decisionInput).input);const expectations=records(payload.semanticArtifactExpectations) as SemanticArtifactExpectation[];
	const references=records(manifest.contentReferences);const runId=text(record(assignment.metadata).workdayRunId,assignment.workDayId);
	const results:Row[]=[];
	if(expectations.length){
		const repositoryId=text(payload.repositoryId);const connection=await resolveWorkdayTreeDxConnection(store,{projectId:text(assignment.projectId),repositoryId,runId,capabilities:['repos:read','files:read']});
		if(!connection)throw new CapacityGovernanceError('assignment_completion_treedx_unavailable','Semantic preflight cannot read the exact project repository.',503,{assignmentId});
		const client=new TreeDxClient({...connection,repoId:connection.repositoryId,timeoutMs:60_000,fetch:connection.fetchImpl});
		for(const expectation of expectations){
			const candidates=references.filter((reference)=>text(reference.model)===expectation.model||text(reference.contentPath).startsWith(expectation.pathPrefix));
			const attempts=[];
			for(const reference of candidates){
				const ref=text(reference.ref,reference.commitSha,record(manifest.commit).sha);const path=text(reference.contentPath);
				const response=await client.readRepositoryFiles({ref,paths:[path],encoding:'utf8',parseFrontmatter:true});const file=record(response.files?.[0]??response.results?.[0]??response.file);
				const artifact={...reference,...file,content:text(file.content,file.body)};attempts.push({path,ref,checks:semanticArtifactChecks(artifact,expectation)});
			}
			const passed=attempts.some((attempt)=>Object.values(attempt.checks).every(Boolean));results.push({id:expectation.id,passed,attempts});
			if(!passed)throw new CapacityGovernanceError('assignment_semantic_artifact_preflight_failed',`Artifact ${expectation.id} failed semantic preflight before settlement.`,409,{assignmentId,expectationId:expectation.id,attempts});
		}
	}
	const receiptDigest=digest({assignmentId,manifestDigest:digest(manifest),expectations,results});
	await store.createCapacityWorkdayEvent(principal.teamId,runId,{id:`semantic-preflight:${assignmentId}:${receiptDigest.slice(0,20)}`,eventType:'assignment.semantic_completion_preflight_passed',status:'completed',title:'Semantic artifact preflight passed',message:'Exact repository artifacts passed completion preflight before settlement.',assignmentId,projectId:assignment.projectId,context:{receiptDigest,expectations:expectations.map((entry)=>entry.id),results},metadata:{source:'api-control-plane'}});
	return {assignmentId,receiptDigest,required:expectations.length>0,assertions:results};
}

import {
	TREESEED_AGENT_CONTRIBUTION_ATTESTATION_VERSION,TREESEED_CONTRIBUTION_GRANT_VERSION,
	contributionAttestationPayload,contributionAttestationPayloadDigest,validateAgentContributionAttestation,validateProjectContributionAuthorization,
	type AgentContributionAttestation,type ProjectContributionAuthorization,
} from '@treeseed/sdk/work-providers';
import { createHash,createPrivateKey,createPublicKey,randomUUID,sign } from 'node:crypto';

const GRANT_TEXT='I have the right to authorize contributions to this project and grant the project owner a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to use, reproduce, modify, distribute, publicly perform, publicly display, sublicense, and relicense authorized contributions, including under the project AGPL and alternative commercial licenses.';
const GRANT_VERSION='treeseed-dual-license-project-authorization/v1';
const json=(value:unknown)=>JSON.stringify(value);
const parse=(value:unknown,fallback:unknown)=>{try{return JSON.parse(String(value??''));}catch{return fallback;}};
const text=(value:unknown)=>typeof value==='string'?value.trim():'';
const list=(value:unknown)=>[...new Set(Array.isArray(value)?value.map(text).filter(Boolean):[])].sort();
export const projectContributionGrant=()=>({version:GRANT_VERSION,text:GRANT_TEXT,digest:`sha256:${createHash('sha256').update(GRANT_TEXT).digest('base64url')}`});

function signer(secret:string) {
	if(!secret) throw new Error('Project contribution receipt signing is not configured.');
	const seed=createHash('sha256').update(`treeseed:project-contribution:${secret}`).digest();
	const privateKey=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed]),format:'der',type:'pkcs8'});
	const publicKeyJwk=createPublicKey(privateKey).export({format:'jwk'}) as JsonWebKey;
	const keyId=`contribution-ed25519:${createHash('sha256').update(String(publicKeyJwk.x)).digest('base64url').slice(0,24)}`;
	return {privateKey,keyId,publicKeyJwk};
}

function serialize(row:Record<string,unknown>|null):ProjectContributionAuthorization|null {
	if(!row)return null;
	return {schemaVersion:TREESEED_CONTRIBUTION_GRANT_VERSION,id:String(row.id),generation:Number(row.generation),status:String(row.status) as ProjectContributionAuthorization['status'],projectId:String(row.project_id),
		repository:parse(row.repository_json,{}) as ProjectContributionAuthorization['repository'],grant:{version:String(row.grant_version),digest:String(row.grant_digest)},receiptKey:parse(row.receipt_key_json,{}) as ProjectContributionAuthorization['receiptKey'],
		authorizedBy:{principalId:String(row.authorized_by_principal_id),...(row.authorized_by_display_name?{displayName:String(row.authorized_by_display_name)}:{})},agentIds:parse(row.agent_ids_json,[]) as string[],capacityProviderIds:parse(row.capacity_provider_ids_json,[]) as string[],
		contributionModes:parse(row.contribution_modes_json,[]) as ProjectContributionAuthorization['contributionModes'],targetBranches:parse(row.target_branches_json,[]) as string[],allowedActions:parse(row.allowed_actions_json,[]) as ProjectContributionAuthorization['allowedActions'],
		effectiveAt:String(row.effective_at),expiresAt:row.expires_at?String(row.expires_at):null,revokedAt:row.revoked_at?String(row.revoked_at):null};
}

export async function activeProjectContributionAuthorization(store:any,projectId:string) {
	return serialize(await store.first(`SELECT * FROM project_contribution_authorizations WHERE project_id=? AND status='active' ORDER BY generation DESC LIMIT 1`,[projectId]));
}
export async function listProjectContributionAuthorizations(store:any,projectId:string) {
	return (await store.all(`SELECT * FROM project_contribution_authorizations WHERE project_id=? ORDER BY generation DESC`,[projectId])).map(serialize);
}
export function planProjectContributionAuthorization(input:any,principal:any,secret:string) {
	const key=signer(secret); const grant=projectContributionGrant(); const now=new Date();
	const authorization:ProjectContributionAuthorization={schemaVersion:TREESEED_CONTRIBUTION_GRANT_VERSION,id:text(input.id)||randomUUID(),generation:Number(input.generation)||1,status:'active',projectId:text(input.projectId),repository:{provider:text(input.repository?.provider),owner:text(input.repository?.owner),name:text(input.repository?.name)},grant:{version:grant.version,digest:grant.digest},receiptKey:{keyId:key.keyId,algorithm:'Ed25519',publicKeyJwk:key.publicKeyJwk},authorizedBy:{principalId:String(principal.id),displayName:text(principal.displayName)||undefined},agentIds:list(input.agentIds),capacityProviderIds:list(input.capacityProviderIds),contributionModes:list(input.contributionModes) as ProjectContributionAuthorization['contributionModes'],targetBranches:list(input.targetBranches),allowedActions:['populate_pr_attestation','update_pr_attestation'],effectiveAt:text(input.effectiveAt)||now.toISOString(),expiresAt:text(input.expiresAt)||null};
	const confirmationDigest=`sha256:${createHash('sha256').update(json(authorization)).digest('base64url')}`;
	return {authorization,grantText:grant.text,confirmationDigest};
}
export async function applyProjectContributionAuthorization(store:any,input:any,principal:any,secret:string) {
	const current=await activeProjectContributionAuthorization(store,text(input.projectId)); const generation=(current?.generation??0)+1;
	const planned=planProjectContributionAuthorization({...input,generation},principal,secret);
	if(input.confirmationDigest!==planned.confirmationDigest) return {ok:false,code:'contribution_authorization_confirmation_mismatch',planned};
	const validation=validateProjectContributionAuthorization(planned.authorization); if(!validation.ok)return {ok:false,code:'contribution_authorization_invalid',diagnostics:validation.diagnostics};
	const a=planned.authorization,now=new Date().toISOString();
	await store.batch([
		...(current?[{query:`UPDATE project_contribution_authorizations SET status='superseded',updated_at=? WHERE id=? AND status='active'`,params:[now,current.id]}]:[]),
		{query:`INSERT INTO project_contribution_authorizations (id,project_id,generation,status,repository_json,grant_version,grant_digest,receipt_key_json,authorized_by_principal_id,authorized_by_display_name,agent_ids_json,capacity_provider_ids_json,contribution_modes_json,target_branches_json,allowed_actions_json,effective_at,expires_at,revoked_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,params:[a.id,a.projectId,a.generation,a.status,json(a.repository),a.grant.version,a.grant.digest,json(a.receiptKey),a.authorizedBy.principalId,a.authorizedBy.displayName??null,json(a.agentIds),json(a.capacityProviderIds),json(a.contributionModes),json(a.targetBranches),json(a.allowedActions),a.effectiveAt,a.expiresAt??null,null,now,now]},
	]);
	await store.recordAuditEvent({actorType:'user',actorId:a.authorizedBy.principalId,eventType:'project.contribution_authorization.applied',targetType:'project',targetId:a.projectId,data:{authorizationId:a.id,generation:a.generation,grantVersion:a.grant.version,grantDigest:a.grant.digest,repository:a.repository}});
	return {ok:true,payload:a};
}
export async function revokeProjectContributionAuthorization(store:any,projectId:string,id:string,actorId:string) {
	const now=new Date().toISOString(); const current=serialize(await store.first(`SELECT * FROM project_contribution_authorizations WHERE id=? AND project_id=?`,[id,projectId]));
	if(!current)return {ok:false,code:'contribution_authorization_not_found'}; if(current.status!=='active')return {ok:false,code:'contribution_authorization_inactive'};
	await store.run(`UPDATE project_contribution_authorizations SET status='revoked',revoked_at=?,updated_at=? WHERE id=? AND status='active'`,[now,now,id]);
	await store.recordAuditEvent({actorType:'user',actorId,eventType:'project.contribution_authorization.revoked',targetType:'project',targetId:projectId,data:{authorizationId:id,generation:current.generation}});
	return {ok:true,payload:{...current,status:'revoked' as const,revokedAt:now}};
}

export async function issueAgentContributionAttestation(store:any,input:any,secret:string) {
	const authorization=await activeProjectContributionAuthorization(store,text(input.projectId)); if(!authorization)return {ok:false,code:'contribution_authorization_missing'};
	const assignment=await store.first(`SELECT * FROM capacity_provider_assignments WHERE id=? AND project_id=? AND capacity_provider_id=? LIMIT 1`,[text(input.assignmentId),text(input.projectId),text(input.capacityProviderId)]);
	if(!assignment||String(assignment.agent_id)!==text(input.agentId))return {ok:false,code:'contribution_assignment_authority_mismatch'};
	if(!['leased','running','completed'].includes(String(assignment.status)))return {ok:false,code:'contribution_assignment_status_invalid'};
	const key=signer(secret); const issuedAt=new Date().toISOString(); const receiptId=randomUUID();
	const attestation:AgentContributionAttestation={schemaVersion:TREESEED_AGENT_CONTRIBUTION_ATTESTATION_VERSION,authorization:{id:authorization.id,generation:authorization.generation,digest:authorization.grant.digest},projectId:authorization.projectId,repository:input.repository,assignmentId:String(assignment.id),checkpointId:text(input.checkpointId)||null,agentId:text(input.agentId),capacityProviderId:text(input.capacityProviderId),mode:input.mode,base:input.base,head:input.head,issuedAt,receipt:{keyId:key.keyId,algorithm:'Ed25519',payloadDigest:'pending',signature:'pending'}};
	attestation.receipt.payloadDigest=await contributionAttestationPayloadDigest(attestation); attestation.receipt.signature=sign(null,Buffer.from(contributionAttestationPayload(attestation)),key.privateKey).toString('base64url');
	const validation=validateAgentContributionAttestation({authorization,attestation,expected:{projectId:authorization.projectId,repository:input.repository,assignmentId:String(assignment.id),baseBranch:text(input.base?.branch),baseSha:text(input.base?.sha),headBranch:text(input.head?.branch),headSha:text(input.head?.sha)}});
	if(!validation.ok)return {ok:false,code:'contribution_attestation_invalid',diagnostics:validation.diagnostics};
	await store.run(`INSERT INTO project_contribution_attestation_receipts (id,authorization_id,authorization_generation,project_id,assignment_id,checkpoint_id,agent_id,capacity_provider_id,repository_json,base_branch,base_sha,head_branch,head_sha,payload_digest,signing_key_id,signature,status,issued_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[receiptId,authorization.id,authorization.generation,authorization.projectId,attestation.assignmentId,attestation.checkpointId,attestation.agentId,attestation.capacityProviderId,json(attestation.repository),attestation.base.branch,attestation.base.sha,attestation.head.branch,attestation.head.sha,attestation.receipt.payloadDigest,key.keyId,attestation.receipt.signature,'active',issuedAt,issuedAt]);
	return {ok:true,payload:{attestation,authorization,receiptId}};
}

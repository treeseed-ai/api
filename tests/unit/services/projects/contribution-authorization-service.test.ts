import { verifyAgentContributionReceipt } from '@treeseed/sdk/work-providers';
import { describe,expect,it } from 'vitest';
import { applyProjectContributionAuthorization,issueAgentContributionAttestation,planProjectContributionAuthorization,projectContributionGrant } from '../../../../src/api/projects/contribution-authorization-service.ts';

describe('agent contribution receipt issuance',()=>{
	it('selects license-specific grant profiles without changing the workflow',()=>{
		expect(projectContributionGrant({name:'sdk'})).toMatchObject({version:'apache-2.0-section-5-project-authorization/v1',text:expect.stringContaining('Apache License, Version 2.0')});
		expect(projectContributionGrant({name:'api'})).toMatchObject({version:'treeseed-dual-license-project-authorization/v1',text:expect.stringContaining('alternative commercial licenses')});
	});
	it('records the accountable human and exact grant digest when applying authority',async()=>{
		const secret='test-contribution-signing-secret';const principal={id:'human-1',displayName:'Human'};const input={id:'grant-1',projectId:'project-1',repository:{provider:'github',owner:'treeseed-ai',name:'api'},agentIds:['agent-1'],capacityProviderIds:['provider-1'],contributionModes:['agent-authored'],targetBranches:['staging'],effectiveAt:'2026-08-20T12:00:00.000Z',expiresAt:'2027-08-20T12:00:00.000Z'};const plan=planProjectContributionAuthorization({...input,generation:1},principal,secret);let audit:any;
		const result=await applyProjectContributionAuthorization({first:async()=>null,batch:async()=>{},recordAuditEvent:async(value:any)=>{audit=value;}},{...input,confirmationDigest:plan.confirmationDigest},principal,secret);
		expect(result.ok).toBe(true);expect(audit).toMatchObject({actorType:'user',actorId:'human-1',eventType:'project.contribution_authorization.applied',targetType:'project',targetId:'project-1',data:{authorizationId:'grant-1',generation:1,grantDigest:plan.authorization.grant.digest,repository:input.repository}});
	});
	it('binds a signed receipt to active project, assignment, agent, provider, and exact refs',async()=>{
		const secret='test-contribution-signing-secret';
		const authorization=planProjectContributionAuthorization({id:'grant-1',generation:1,projectId:'project-1',repository:{provider:'github',owner:'treeseed-ai',name:'api'},agentIds:['agent-1'],capacityProviderIds:['provider-1'],contributionModes:['agent-authored'],targetBranches:['staging'],effectiveAt:'2026-08-20T12:00:00.000Z',expiresAt:'2027-08-20T12:00:00.000Z'},{id:'human-1',displayName:'Human'},secret).authorization;
		const row={id:authorization.id,project_id:authorization.projectId,generation:authorization.generation,status:authorization.status,repository_json:JSON.stringify(authorization.repository),grant_version:authorization.grant.version,grant_digest:authorization.grant.digest,receipt_key_json:JSON.stringify(authorization.receiptKey),authorized_by_principal_id:authorization.authorizedBy.principalId,authorized_by_display_name:authorization.authorizedBy.displayName,agent_ids_json:JSON.stringify(authorization.agentIds),capacity_provider_ids_json:JSON.stringify(authorization.capacityProviderIds),contribution_modes_json:JSON.stringify(authorization.contributionModes),target_branches_json:JSON.stringify(authorization.targetBranches),allowed_actions_json:JSON.stringify(authorization.allowedActions),effective_at:authorization.effectiveAt,expires_at:authorization.expiresAt,revoked_at:null};
		let reads=0;let writes=0;const store={first:async()=>++reads===1?row:{id:'assignment-1',project_id:'project-1',capacity_provider_id:'provider-1',agent_id:'agent-1',status:'completed'},run:async()=>{writes+=1;}};
		const result=await issueAgentContributionAttestation(store,{projectId:'project-1',repository:authorization.repository,assignmentId:'assignment-1',agentId:'agent-1',capacityProviderId:'provider-1',mode:'agent-authored',base:{branch:'staging',sha:'a'.repeat(40)},head:{branch:'codex/assignment-1',sha:'b'.repeat(40)}},secret);
		expect(result.ok).toBe(true);expect(writes).toBe(1);
		if(!result.ok)throw new Error(result.code);
		expect(await verifyAgentContributionReceipt(result.payload.attestation,result.payload.authorization)).toBe(true);
	});
	it('rejects an assignment owned by another provider before issuing a receipt',async()=>{
		const secret='test-contribution-signing-secret';const authorization=planProjectContributionAuthorization({id:'grant-1',generation:1,projectId:'project-1',repository:{provider:'github',owner:'treeseed-ai',name:'api'},agentIds:['agent-1'],capacityProviderIds:['provider-1'],contributionModes:['agent-authored'],targetBranches:['staging'],effectiveAt:'2026-08-20T12:00:00.000Z',expiresAt:'2027-08-20T12:00:00.000Z'},{id:'human-1'},secret).authorization;
		const row={id:authorization.id,project_id:authorization.projectId,generation:1,status:'active',repository_json:JSON.stringify(authorization.repository),grant_version:authorization.grant.version,grant_digest:authorization.grant.digest,receipt_key_json:JSON.stringify(authorization.receiptKey),authorized_by_principal_id:'human-1',agent_ids_json:'["agent-1"]',capacity_provider_ids_json:'["provider-1"]',contribution_modes_json:'["agent-authored"]',target_branches_json:'["staging"]',allowed_actions_json:'["populate_pr_attestation"]',effective_at:authorization.effectiveAt,expires_at:authorization.expiresAt};let reads=0;
		const result=await issueAgentContributionAttestation({first:async()=>++reads===1?row:null},{projectId:'project-1',repository:authorization.repository,assignmentId:'assignment-1',agentId:'agent-1',capacityProviderId:'provider-other',mode:'agent-authored',base:{branch:'staging',sha:'a'.repeat(40)},head:{branch:'codex/assignment-1',sha:'b'.repeat(40)}},secret);
		expect(result).toEqual({ok:false,code:'contribution_assignment_authority_mismatch'});
	});
});

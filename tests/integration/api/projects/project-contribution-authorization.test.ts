import { authorizeApp,createTeamAndProject,createTestApp,createTestPostgresDatabase,createTestStore,describe,expect,it,json } from '../../../support/api-harness.ts';

describe('project contribution authorization',()=>{
	it('fails closed when dedicated contribution signing custody is unavailable',async()=>{
		const db=createTestPostgresDatabase();const store=createTestStore(db);store.config.contributionSigningSecret=undefined;const app=createTestApp({db,store});
		const token=await authorizeApp(app,{principalId:'missing-signing-owner'});const {project}=await createTeamAndProject(app,token,{slug:'missing-signing-project',name:'Missing Signing Project',description:'Fail-closed signing custody.'});
		const response=await app.request(`/v1/projects/${project.id}/contribution-authorizations/plan`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({repository:{provider:'github',owner:'treeseed-ai',name:'sdk'}})});
		expect(response.status).toBe(503);expect(await json(response)).toMatchObject({code:'contribution_signing_key_unavailable'});
	});
	it('plans, applies, reads, and revokes one human-owned standing grant',async()=>{
		const db=createTestPostgresDatabase();const store=createTestStore(db);const app=createTestApp({db,store});
		const token=await authorizeApp(app,{principalId:'contribution-owner',displayName:'Contribution Owner'});
		const {project}=await createTeamAndProject(app,token,{slug:'contribution-project',name:'Contribution Project',description:'Standing agent contribution authority.'});
		const headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
		const scope={repository:{provider:'github',owner:'treeseed-ai',name:'sdk'},agentIds:['agent-engineer'],capacityProviderIds:['provider-local'],contributionModes:['agent-assisted','agent-authored'],targetBranches:['staging'],expiresAt:'2027-08-20T12:00:00.000Z'};
		const planResponse=await app.request(`/v1/projects/${project.id}/contribution-authorizations/plan`,{method:'POST',headers,body:JSON.stringify(scope)});
		expect(planResponse.status).toBe(200);const plan=(await json(planResponse)).payload;
		expect(plan).toMatchObject({grantText:expect.stringContaining('right to authorize contributions'),confirmationDigest:expect.stringMatching(/^sha256:/u),authorization:{projectId:project.id,status:'active',authorizedBy:{principalId:'contribution-owner'},receiptKey:{algorithm:'Ed25519'}}});
		const applyInput={...scope,id:plan.authorization.id,effectiveAt:plan.authorization.effectiveAt,confirmationDigest:plan.confirmationDigest};
		const applied=await app.request(`/v1/projects/${project.id}/contribution-authorizations/apply`,{method:'POST',headers,body:JSON.stringify(applyInput)});
		expect(applied.status).toBe(201);const authorization=(await json(applied)).payload;expect(authorization).toMatchObject({generation:1,status:'active'});
		const listed=await json(await app.request(`/v1/projects/${project.id}/contribution-authorizations`,{headers}));expect(listed.payload.items).toHaveLength(1);
		const revoked=await app.request(`/v1/projects/${project.id}/contribution-authorizations/${authorization.id}/revoke`,{method:'POST',headers,body:'{}'});expect(revoked.status).toBe(200);expect((await json(revoked)).payload.status).toBe('revoked');
	});
	it('fails apply when the exact human-reviewed plan digest changes',async()=>{
		const db=createTestPostgresDatabase();const store=createTestStore(db);const app=createTestApp({db,store});const token=await authorizeApp(app,{principalId:'digest-owner'});const {project}=await createTeamAndProject(app,token,{slug:'digest-project',name:'Digest Project',description:'Digest guard.'});
		const response=await app.request(`/v1/projects/${project.id}/contribution-authorizations/apply`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({id:'grant-1',repository:{provider:'github',owner:'treeseed-ai',name:'sdk'},agentIds:['agent-engineer'],capacityProviderIds:['provider-local'],contributionModes:['agent-authored'],targetBranches:['staging'],effectiveAt:'2026-08-20T12:00:00.000Z',expiresAt:'2027-08-20T12:00:00.000Z',confirmationDigest:'sha256:stale'})});
		expect(response.status).toBe(409);expect((await json(response)).code).toBe('contribution_authorization_confirmation_mismatch');
	});
});

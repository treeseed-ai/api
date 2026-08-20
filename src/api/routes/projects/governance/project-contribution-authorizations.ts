import { applyProjectContributionAuthorization,issueAgentContributionAttestation,listProjectContributionAuthorizations,planProjectContributionAuthorization,projectContributionGrant,revokeProjectContributionAuthorization } from '../../../projects/contribution-authorization-service.ts';

export function installProjectContributionAuthorizationRoutes(context:any) {
	const {app,jsonError,requireProjectAccess,store}=context;
	const signingSecret=()=>String(store.config?.assertionSecret??'');
	const access=async(c:any,manage=false)=>requireProjectAccess(c,store,c.req.param('projectId'),manage?'projects:manage:team':'projects:read:team');
	const owner=async(c:any)=>{
		const allowed=await access(c,true); if(allowed.response)return allowed;
		if(c.get('actorType')==='service')return {response:jsonError(c,403,'A human team owner is required.',{code:'contribution_authorization_human_required'})};
		const team=await store.resolvePrincipalTeamContext(allowed.details.project.teamId,allowed.principal);
		if(!team?.roles?.includes('team_owner'))return {response:jsonError(c,403,'A human team owner is required.',{code:'contribution_authorization_owner_required'})};
		return allowed;
	};
	app.get('/v1/projects/:projectId/contribution-authorizations',async(c:any)=>{const allowed=await access(c);if(allowed.response)return allowed.response;return c.json({ok:true,payload:{items:await listProjectContributionAuthorizations(store,c.req.param('projectId')),grant:projectContributionGrant()}});});
	app.post('/v1/projects/:projectId/contribution-authorizations/plan',async(c:any)=>{const allowed=await owner(c);if(allowed.response)return allowed.response;const body=await c.req.json().catch(()=>({}));return c.json({ok:true,payload:planProjectContributionAuthorization({...body,projectId:c.req.param('projectId')},allowed.principal,signingSecret())});});
	app.post('/v1/projects/:projectId/contribution-authorizations/apply',async(c:any)=>{const allowed=await owner(c);if(allowed.response)return allowed.response;const body=await c.req.json().catch(()=>({}));const result=await applyProjectContributionAuthorization(store,{...body,projectId:c.req.param('projectId')},allowed.principal,signingSecret());return c.json(result,result.ok?201:result.code==='contribution_authorization_confirmation_mismatch'?409:400);});
	app.post('/v1/projects/:projectId/contribution-authorizations/:authorizationId/revoke',async(c:any)=>{const allowed=await owner(c);if(allowed.response)return allowed.response;const result=await revokeProjectContributionAuthorization(store,c.req.param('projectId'),c.req.param('authorizationId'),String(allowed.principal.id));return c.json(result,result.ok?200:409);});
	app.post('/v1/projects/:projectId/contribution-attestations',async(c:any)=>{const principal=c.get('principal');if(!principal?.capacityProviderId)return jsonError(c,403,'A capacity-provider assignment principal is required.',{code:'contribution_attestation_provider_required'});const body=await c.req.json().catch(()=>({}));if(String(body.capacityProviderId??'')!==String(principal.capacityProviderId))return jsonError(c,403,'Capacity provider identity mismatch.',{code:'contribution_attestation_provider_mismatch'});const result=await issueAgentContributionAttestation(store,{...body,projectId:c.req.param('projectId')},signingSecret());return c.json(result,result.ok?201:403);});
}

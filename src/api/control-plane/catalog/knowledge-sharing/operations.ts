import { CONTROL_PLANE_OPERATIONS,knowledgeShareGrantInputSchema,knowledgeShareSchema,teamKnowledgeRequestSchema } from '@treeseed/sdk/operator-contracts';
import type { TreeDxProxyOperationService } from '../../repositories/treedx/proxy-operation-service.ts';
import { ControlPlaneOperationError,type BoundOperation,type OperationInvocationContext } from '../operation-registry.ts';

const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const strings=(value:unknown)=>Array.isArray(value)?[...new Set(value.map(String).map((item)=>item.trim()).filter(Boolean))]:[];
const stringValues=(value:unknown)=>typeof value==='string'&&value.trim()?[value.trim()]:strings(value);

export interface KnowledgeShareOperationDependencies { store:any; treeDxProxy:TreeDxProxyOperationService; }

function principal(context:OperationInvocationContext){if(!context.principal)throw new ControlPlaneOperationError(401,'authentication_required','Authentication is required.');return context.principal;}
async function access(dependencies:KnowledgeShareOperationDependencies,teamId:string,context:OperationInvocationContext,owner=false){
	const actor=principal(context),admin=actor.roles?.some((role)=>role==='admin'||role==='platform_admin')||actor.permissions?.includes('*:*:*');
	if(!admin&&!await dependencies.store.principalCanAccessTeam(actor,teamId))throw new ControlPlaneOperationError(403,'team_forbidden','The principal cannot access this team.');
	if(owner&&!admin){const membership=await dependencies.store.resolvePrincipalTeamContext(teamId,actor);if(!membership?.roles?.includes('team_owner'))throw new ControlPlaneOperationError(403,'team_owner_required','Team owner authority is required.');}
	return actor;
}
function view(row:Record<string,unknown>){
	const grant=record(row.trustGrant),parsed=knowledgeShareSchema.parse({schemaVersion:'treeseed.knowledge-share/v1',id:row.id,sourceTeamId:row.teamId,targetTeamId:row.targetTeamId,
		projectIds:strings(grant.projectIds??row.projectId),contentModels:strings(grant.contentModels),paths:strings(grant.paths).length?strings(grant.paths):['**'],
		operations:strings(grant.operations),expiresAt:row.expiresAt??null,status:row.status,createdAt:row.createdAt,updatedAt:row.updatedAt,revokedAt:row.revokedAt??null});
	return parsed;
}
function active(row:Record<string,unknown>){return row.status==='active'&&(!row.expiresAt||Date.parse(String(row.expiresAt))>Date.now());}

async function resolveProjects(dependencies:KnowledgeShareOperationDependencies,teamId:string,body:unknown,operation:'read'|'query'|'context'|'graph'){
	const request=teamKnowledgeRequestSchema.parse(body),sameTeam=await dependencies.store.listTeamProjects(teamId),bySlug=new Map(sameTeam.map((project:Record<string,unknown>)=>[String(project.slug),project]));
	const sameIds=new Set(sameTeam.map((project:Record<string,unknown>)=>String(project.id)));
	const missingIds=request.projectIds.filter((id)=>!sameIds.has(id)),missingSlugs=request.projectSlugs.filter((slug)=>!bySlug.has(slug));
	if(missingIds.length||missingSlugs.length)throw new ControlPlaneOperationError(404,'knowledge_project_not_found','A selected same-team project was not found.');
	const requestedSame=new Set([...request.projectIds,...request.projectSlugs.map((slug)=>String(bySlug.get(slug)!.id))]);
	const selectedSame=(requestedSame.size?sameTeam.filter((project:Record<string,unknown>)=>requestedSame.has(String(project.id))):sameTeam)
		.map((project:Record<string,unknown>)=>({projectId:String(project.id),paths:['**']}));
	if(selectedSame.length!==(requestedSame.size||sameTeam.length))throw new ControlPlaneOperationError(404,'knowledge_project_not_found','A selected same-team project was not found.');
	const incoming=(await dependencies.store.listTreeDxSharesForRecipient(teamId)).filter(active),selectedShared:Array<{projectId:string;paths:string[]}>=[];
	const filters=record(record(request.request).filters);
	const requestModels=[...new Set([
		...stringValues(filters.model),
		...stringValues(filters.models),
	])];
	for(const source of request.sharedSources){
		const shares=incoming.filter((row:Record<string,unknown>)=>row.teamId===source.teamId&&strings(record(row.trustGrant).operations).includes(operation));
		const eligible=new Map<string,Record<string,unknown>>();for(const share of shares)for(const projectId of strings(record(share.trustGrant).projectIds??share.projectId))eligible.set(projectId,share);
		const selected=source.projectIds.length?source.projectIds:[...eligible.keys()];
		for(const projectId of selected){const share=eligible.get(projectId);if(!share)throw new ControlPlaneOperationError(403,'knowledge_share_denied','The requested shared project is not covered by an active grant.');
			const grant=record(share.trustGrant),models=strings(grant.contentModels);if(models.length&&(!requestModels.length||requestModels.some((model)=>!models.includes(model))))throw new ControlPlaneOperationError(403,'knowledge_model_denied','The request must select only content models allowed by the knowledge share.');
			selectedShared.push({projectId,paths:strings(grant.paths).length?strings(grant.paths):['**']});}
	}
	return {request,projects:[...selectedSame,...selectedShared]};
}

function federated(dependencies:KnowledgeShareOperationDependencies,kind:'search'|'query'|'context'|'graph'):BoundOperation<any>{
	const binding=CONTROL_PLANE_OPERATIONS.knowledge[kind==='search'?'teamSearch':kind==='query'?'teamQuery':kind==='context'?'teamContext':'teamGraph'];
	const upstream=CONTROL_PLANE_OPERATIONS.treedx.federated[kind];
	return {binding,async handler(input,context){const actor=await access(dependencies,input.path.teamId,context);const resolved=await resolveProjects(dependencies,input.path.teamId,input.body,kind==='search'?'read':kind);
		return dependencies.treeDxProxy.invokeAuthorizedFederation({principal:actor,teamId:input.path.teamId,descriptor:upstream.descriptor,projects:resolved.projects,request:resolved.request.request,context});}};
}

export function createKnowledgeShareOperations(dependencies:KnowledgeShareOperationDependencies):BoundOperation[]{return [
	{binding:CONTROL_PLANE_OPERATIONS.knowledge.shares.list,async handler(input,context){await access(dependencies,input.path.teamId,context);const outgoing=await dependencies.store.listTreeDxShares(input.path.teamId),incoming=await dependencies.store.listTreeDxSharesForRecipient(input.path.teamId);return {items:[...outgoing,...incoming].map(view)};}},
	{binding:CONTROL_PLANE_OPERATIONS.knowledge.shares.show,async handler(input,context){await access(dependencies,input.path.teamId,context);const row=await dependencies.store.getTreeDxShare(input.path.shareId);if(!row||(row.teamId!==input.path.teamId&&row.targetTeamId!==input.path.teamId))throw new ControlPlaneOperationError(404,'knowledge_share_not_found','The knowledge share was not found.');return view(row);}},
	{binding:CONTROL_PLANE_OPERATIONS.knowledge.shares.grant,async handler(input,context){await access(dependencies,input.path.teamId,context,true);const body=knowledgeShareGrantInputSchema.parse(input.body);if(body.targetTeamId===input.path.teamId)throw new ControlPlaneOperationError(400,'knowledge_share_same_team','Same-team reads do not require a share.');if(!await dependencies.store.getTeam(body.targetTeamId))throw new ControlPlaneOperationError(404,'target_team_not_found','The recipient team was not found.');for(const projectId of body.projectIds){const details=await dependencies.store.getProjectDetails(projectId);if(!details||details.project.teamId!==input.path.teamId)throw new ControlPlaneOperationError(400,'knowledge_share_project_invalid','Every shared project must belong to the source team.');}
		const row=await dependencies.store.createTreeDxShare(input.path.teamId,{scope:'library',targetTeamId:body.targetTeamId,trustGrant:{schemaVersion:'treeseed.knowledge-share/v1',projectIds:body.projectIds,contentModels:body.contentModels,paths:body.paths,operations:body.operations},expiresAt:body.expiresAt,status:'active'});await dependencies.store.recordAuditEvent({actorType:'user',actorId:context.principal!.id,eventType:'knowledge.share.granted',targetType:'knowledge_share',targetId:row.id,data:{sourceTeamId:input.path.teamId,targetTeamId:body.targetTeamId,projectIds:body.projectIds}});return view(row);}},
	{binding:CONTROL_PLANE_OPERATIONS.knowledge.shares.revoke,async handler(input,context){await access(dependencies,input.path.teamId,context,true);const existing=await dependencies.store.getTreeDxShare(input.path.shareId);if(!existing||existing.teamId!==input.path.teamId)throw new ControlPlaneOperationError(404,'knowledge_share_not_found','The knowledge share was not found.');const row=await dependencies.store.revokeTreeDxShare(input.path.teamId,input.path.shareId);await dependencies.store.recordAuditEvent({actorType:'user',actorId:context.principal!.id,eventType:'knowledge.share.revoked',targetType:'knowledge_share',targetId:input.path.shareId});return view(row);}},
	federated(dependencies,'search'),federated(dependencies,'query'),federated(dependencies,'context'),federated(dependencies,'graph'),
];}

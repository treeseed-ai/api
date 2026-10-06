import type { CapacityGovernanceDatabase } from '../../../../../database.ts';

type JsonRecord = Record<string, unknown>;
type ReadRepository = {
	projectId:string;
	projectSlug:string;
	repositoryId:string;
	baseRef:string;
	allowedPaths:string[];
	allowedModels:string[];
	source:'team-library'|'same-team'|'shared-team';
};

interface Store extends CapacityGovernanceDatabase {
	getProject(projectId:string):Promise<JsonRecord|null>;
	getProjectTreeDxLibrary(projectId:string):Promise<JsonRecord|null>;
	listTeamProjects(teamId:string):Promise<JsonRecord[]>;
	listTreeDxSharesForRecipient(teamId:string):Promise<JsonRecord[]>;
}

const record=(value:unknown):JsonRecord=>value&&typeof value==='object'&&!Array.isArray(value)?value as JsonRecord:{};
const text=(...values:unknown[])=>values.find((value)=>typeof value==='string'&&value.trim())?.toString().trim()??'';
const stringList=(value:unknown)=>Array.isArray(value)?[...new Set(value.map(String).map((item)=>item.trim()).filter(Boolean))]:[];

function contentScope(payload:JsonRecord){
	const collections:Record<string,string>={agent:'agents',book:'books',decision:'decisions',knowledge:'knowledge',note:'notes',objective:'objectives',page:'pages',proposal:'proposals',question:'questions',agent_context_query:'agent-context-queries',agent_context_query_set:'agent-context-query-sets',agent_instruction_template:'agent-instruction-templates'};
	const readable=new Set(['describe','query','read']),models:string[]=[],paths:string[]=[];
	for(const [model,value] of Object.entries(record(record(payload.permissions).content))){
		const policy=record(value),operations=stringList(policy.operations);if(!operations.some((operation)=>readable.has(operation)))continue;
		models.push(model);const configured=record(policy.filters).paths;
		if(Array.isArray(configured)&&configured.length)paths.push(...configured.map(String));else if(collections[model])paths.push(`${collections[model]}/**`);
	}
	return {models:[...new Set(models)],paths:[...new Set(paths.map((path)=>path.replace(/^\.\//u,'')).filter((path)=>path&&!path.startsWith('/')&&!path.split('/').includes('..')))]};
}

function intersectValues(left:string[],right:string[]){
	if(!left.length)return [];
	if(!right.length)return left;
	const allowed=new Set(right);return left.filter((value)=>allowed.has(value));
}

function intersectPaths(activityPaths:string[],grantPaths:string[]){
	const normalizedGrant=grantPaths.length?grantPaths:['**'];
	if(!activityPaths.length)return [];
	if(normalizedGrant.includes('**'))return activityPaths;
	return activityPaths.filter((path)=>normalizedGrant.some((grant)=>{
		const prefix=grant.replace(/\/\*\*$/u,'').replace(/\/$/u,'');
		return path===grant||path===prefix||path.startsWith(`${prefix}/`)||grant.startsWith(`${path.replace(/\/\*\*$/u,'').replace(/\/$/u,'')}/`);
	}));
}

function bindingIdentity(binding:JsonRecord|null){
	return {
		repositoryId:text(binding?.repositoryId,record(record(record(binding?.topology).contentRepository).treeDx).repositoryId),
		baseRef:text(record(binding?.metadata).resolvedRef,binding?.contentRepositoryRef),
	};
}

export async function resolveCrossProjectReadRepositories(input:{
	store:Store; teamId:string; projectId:string; teamLibraryProject:JsonRecord; payload:JsonRecord; now?:Date;
}):Promise<ReadRepository[]> {
	const result:ReadRepository[]=[],scope=contentScope(input.payload),now=input.now??new Date();
	for(const candidate of await input.store.listTeamProjects(input.teamId)){
		if(text(candidate.id)===input.projectId)continue;
		const identity=bindingIdentity(await input.store.getProjectTreeDxLibrary(text(candidate.id)));
		if(!identity.repositoryId||!identity.baseRef)continue;
		const teamLibrary=text(candidate.id)===text(input.teamLibraryProject.id);
		result.push({projectId:text(candidate.id),projectSlug:text(candidate.slug),...identity,
			allowedPaths:[...new Set([...(teamLibrary?['README.md','objectives/**']:[]),...scope.paths])],allowedModels:scope.models,
			source:teamLibrary?'team-library':'same-team'});
	}
	for(const share of await input.store.listTreeDxSharesForRecipient(input.teamId)){
		if(share.status!=='active'||(share.expiresAt&&Date.parse(String(share.expiresAt))<=now.getTime()))continue;
		const grant=record(share.trustGrant);
		if(!stringList(grant.operations).some((operation)=>['read','query','context','graph'].includes(operation)))continue;
		const allowedModels=intersectValues(scope.models,stringList(grant.contentModels));
		const allowedPaths=intersectPaths(scope.paths,stringList(grant.paths));
		if(!allowedModels.length||!allowedPaths.length)continue;
		for(const projectId of stringList(grant.projectIds??share.projectId)){
			const project=await input.store.getProject(projectId);
			if(!project||text(project.teamId,project.team_id)!==text(share.teamId))continue;
			const identity=bindingIdentity(await input.store.getProjectTreeDxLibrary(projectId));
			if(identity.repositoryId&&identity.baseRef)result.push({projectId,projectSlug:text(project.slug),...identity,allowedPaths,allowedModels,source:'shared-team'});
		}
	}
	return result;
}

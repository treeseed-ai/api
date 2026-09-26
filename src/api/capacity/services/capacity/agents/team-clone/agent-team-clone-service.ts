import { createHash,randomUUID } from 'node:crypto';
import {
	agentTeamClonePlanSchema,
	agentTeamCloneRequestSchema,
	validateAgentDefinitionModel,
	type AgentTeamClonePlan,
	type AgentTeamCloneRequest,
} from '@treeseed/sdk/agent-capacity';
import { parseFrontmatterDocument,serializeFrontmatterDocument } from '../../../../../content/frontmatter.ts';
import { applyTextChangeset } from '../../../../../knowledge/changesets/apply-text-changeset.ts';
import { projectLibraryPath,resolveKnowledgeGatewayConnection,type KnowledgeGatewayConnection } from '../../../../../knowledge/gateway-treedx-connection.ts';
import { treeDxWorkspaceId } from '../../../../../knowledge/workspaces/identity.ts';
import { projectTreeDxCommitSignals } from '../../../treedx/repositories/treedx-change-projector.ts';
import { recordTreeDxAuthoringState } from '../../../treedx/repositories/treedx-authoring-journal.ts';
import { authorizeCapacityTeam,type CapacityPrincipal } from '../../../../../control-plane/repositories/capacity/capacity-authorization.ts';
import { CapacityOperationError } from '../../../../../control-plane/repositories/capacity/capacity-operation-error.ts';
import { snapshotAgentDefinitions, type AgentDefinitionSourceFile } from '../agent-definition-snapshot.ts';

type Row = Record<string,unknown>;
type Project = { id:string; slug:string; name:string; status?:string };
type SourceFile = AgentDefinitionSourceFile;
const record=(value:unknown):Row=>value&&typeof value==='object'&&!Array.isArray(value)?value as Row:{};
const text=(value:unknown):string=>typeof value==='string'?value.trim():'';
const hash=(value:string)=>`sha256:${createHash('sha256').update(value).digest('hex')}`;
const stable=(value:unknown):string=>Array.isArray(value)?`[${value.map(stable).join(',')}]`:value&&typeof value==='object'
	?`{${Object.entries(value as Row).filter(([key])=>key!=='digest').sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
	:JSON.stringify(value);
const planDigest=(value:Omit<AgentTeamClonePlan,'digest'>)=>hash(stable(value));
const branch=(connection:KnowledgeGatewayConnection)=>`refs/heads/${connection.authoringBranch.replace(/^refs\/heads\//u,'')}`;

function fileRows(value:unknown):Row[]{const row=record(value);return (Array.isArray(row.files)?row.files:Array.isArray(row.results)?row.results:[]).map(record);}
function selectProject(projects:Project[],selector:string):Project|null{return projects.find((project)=>project.id===selector||project.slug===selector)??null;}
function classAgents(value:unknown):unknown[]{const agents=record(record(value).handlerRefs).agents;return Array.isArray(agents)?agents:[];}
function replaceIdentityText(value:string,source:Project,target:Project):string{return value
		.replace(new RegExp(`\\b${source.name.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&')}\\b`,'gu'),target.name)
		.replace(new RegExp(`\\b${source.slug.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&')}\\b`,'gu'),target.slug);}
function replacePromptText(value:unknown,source:Project,target:Project):unknown{
	if(typeof value==='string')return replaceIdentityText(value,source,target);
	if(Array.isArray(value))return value.map((item)=>replacePromptText(item,source,target));
	if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value as Row).map(([key,item])=>[key,replacePromptText(item,source,target)]));
	return value;
}
function adapt(sourceFile:SourceFile,source:Project,target:Project){
	const parsed=parseFrontmatterDocument(sourceFile.content);
	const frontmatter=structuredClone(parsed.frontmatter) as Row;
	frontmatter.id=`${target.slug}/${sourceFile.definition.agentClass}`;
	for(const key of ['name','purpose'] as const)if(typeof frontmatter[key]==='string')frontmatter[key]=replaceIdentityText(frontmatter[key] as string,source,target);
	if(Array.isArray(frontmatter.responsibilities))frontmatter.responsibilities=frontmatter.responsibilities.map((item)=>typeof item==='string'?replaceIdentityText(item,source,target):item);
	if(frontmatter.activityProfiles&&typeof frontmatter.activityProfiles==='object')frontmatter.activityProfiles=replacePromptText(frontmatter.activityProfiles,source,target);
	const content=serializeFrontmatterDocument(frontmatter,replaceIdentityText(parsed.body,source,target));
	const validation=validateAgentDefinitionModel(frontmatter);
	if(!validation.ok)throw new CapacityOperationError(422,'agent_team_definition_invalid','The adapted agent definition is invalid.',{ projectId:target.id,path:sourceFile.path,diagnostics:validation.diagnostics });
	return {path:projectLibraryPath('.',`agents/${sourceFile.definition.agentClass}.mdx`),content,digest:hash(content),agentClass:sourceFile.definition.agentClass};
}

async function connection(store:any,projectId:string,write:boolean,readRefs:string[]=[]){
	const value=await resolveKnowledgeGatewayConnection(store,{projectId,write,authoringPaths:true,readRefs});
	if(!value)throw new CapacityOperationError(409,'agent_team_library_unavailable','Every selected project requires an authoritative TreeDX library binding.',{projectId});
	return value;
}
function failed(stage:string,projectId:string,error:unknown):never{
	const message=error instanceof Error?error.message:String(error);
	throw new CapacityOperationError(503,`agent_team_${stage}_failed`,`${stage.replaceAll('_',' ')} failed for project ${projectId}: ${message}`);
}
async function acceptedSourceCommit(store:any,projectId:string){
	const page=await store.listProjectAgentClassesPage(projectId,{limit:200,cursor:null});
	const refs=new Set((Array.isArray(page?.items)?page.items:[]).filter((item:Row)=>item.status==='active').map((item:Row)=>text(record(item.metadata).immutableRef)).filter((value:string)=>/^[0-9a-f]{40}$/u.test(value)));
	if(refs.size!==1)throw new CapacityOperationError(409,'agent_team_source_authority_invalid','The source agent team must resolve to one active immutable TreeDX commit.',{projectId,activeCommitCount:refs.size});
	return [...refs][0]!;
}
async function resolveTargetSnapshot(store:any,projectId:string){
	const initial=await connection(store,projectId,false);
	const refs=await initial.client.listRepositoryRefs(initial.repositoryId).catch((error)=>failed('target_refs',projectId,error));
	const authoring=branch(initial),remote=`refs/remotes/origin/${authoring.replace(/^refs\/heads\//u,'')}`;
	const row=(Array.isArray(refs)?refs:[]).map(record).find((item)=>text(item.name)===authoring)
		??(Array.isArray(refs)?refs:[]).map(record).find((item)=>text(item.name)===remote);
	const commit=text(row?.target);
	if(!/^[0-9a-f]{40}$/u.test(commit))throw new CapacityOperationError(409,'agent_team_target_authority_invalid',`Project ${projectId} has no exact authoring commit.`);
	const exact=await connection(store,projectId,false,[commit]);
	return {connection:exact,snapshot:await snapshotAgents(exact,commit).catch((error)=>failed('target_read',projectId,error))};
}
export const snapshotAgents = snapshotAgentDefinitions;
async function readExisting(value:KnowledgeGatewayConnection,commit:string,paths:string[]){
	if(!paths.length)return new Map<string,string>();
	const response=await value.client.readRepositoryFiles({repoId:value.repositoryId,ref:commit,paths,encoding:'utf8',parseFrontmatter:false,allowProtected:true}).catch((error)=>{if(Number(record(error).status)===404)return {resolvedRef:commit,files:[]};throw error;});
	if(text(response.resolvedRef)!==commit)throw new CapacityOperationError(409,'agent_team_target_moved','Target definition bytes did not match the planned commit.');
	return new Map(fileRows(response).filter((file)=>typeof file.content==='string').map((file)=>[text(file.path),String(file.content)]));
}
async function classes(store:any,projectId:string){const page=await store.listProjectAgentClassesPage(projectId,{limit:200,cursor:null});return Array.isArray(page?.items)?page.items.map(record):[];}
function projectionMatches(entries:Row[],definitions:ReturnType<typeof adapt>[],commit:string){return definitions.every((item)=>entries.some((entry)=>
	text(entry.slug)===item.agentClass&&entry.status==='active'&&text(record(entry.metadata).immutableRef)===commit
	&&stable(classAgents(entry))===stable([validateAgentDefinitionModel(parseFrontmatterDocument(item.content).frontmatter).data])));}
async function activateDefinitions(store:any,target:Project,definitions:ReturnType<typeof adapt>[],commit:string,libraryRef:string,idempotencyKey:string){
	const entries=await classes(store,target.id);
	for(const item of definitions){
		const validation=validateAgentDefinitionModel(parseFrontmatterDocument(item.content).frontmatter);
		if(!validation.ok||!validation.data)throw new CapacityOperationError(422,'agent_team_definition_invalid','The cloned agent definition cannot be activated.');
		const existing=entries.find((entry)=>text(entry.slug)===item.agentClass&&entry.status==='active')??entries.find((entry)=>text(entry.slug)===item.agentClass);
		const input={slug:item.agentClass,name:validation.data.name,status:'active',handlerRefs:{agents:[validation.data]},metadata:{...record(existing?.metadata),source:'project-library',immutableRef:commit,libraryRef,definitionPaths:[item.path],definitionDigest:item.digest.replace(/^sha256:/u,'')}};
		if(existing)await store.updateProjectAgentClass(target.id,text(existing.id),input,`${idempotencyKey}:${target.id}:${item.agentClass}:update`);
		else await store.createProjectAgentClass(target.id,{id:`${target.id}:${item.agentClass}`,...input},`${idempotencyKey}:${target.id}:${item.agentClass}:create`);
	}
}

export class AgentTeamCloneService{
	constructor(private readonly store:any){}
	async plan(principal:CapacityPrincipal,teamId:string,input:AgentTeamCloneRequest){
		await authorizeCapacityTeam(this.store,principal,teamId,'projects:read:team');
		const request=agentTeamCloneRequestSchema.parse(input),projects=(await this.store.listTeamProjects(teamId)) as Project[];
		const source=selectProject(projects,request.sourceProject);if(!source)throw new CapacityOperationError(404,'agent_team_source_project_missing','The source project does not exist in this team.');
		const candidates=request.allEligible===true?projects.filter((project)=>project.id!==source.id&&(!project.status||project.status==='active')):(request.targetProjects??[]).map((selector)=>{const project=selectProject(projects,selector);if(!project)throw new CapacityOperationError(404,'agent_team_target_project_missing',`Target project ${selector} does not exist in this team.`);return project;}).filter((project)=>project.id!==source.id);
		const targets=request.allEligible===true?(await Promise.all(candidates.map(async(project)=>await this.store.getProjectTreeDxLibrary(project.id)?project:null))).filter((project):project is Project=>Boolean(project)):candidates;
		if(!targets.length)throw new CapacityOperationError(422,'agent_team_targets_required','Select at least one target project other than the source.');
		const sourceCommit=await acceptedSourceCommit(this.store,source.id),sourceConnection=await connection(this.store,source.id,false,[sourceCommit]);
		const sourceSnapshot=await snapshotAgents(sourceConnection,sourceCommit).catch((error)=>failed('source_read',source.id,error));
		if(!sourceSnapshot.files.length)throw new CapacityOperationError(409,'agent_team_source_empty','The source project has no valid agent definitions.');
		const targetPlans=[];
		for(const target of targets){
			const targetState=await resolveTargetSnapshot(this.store,target.id),targetConnection=targetState.connection,targetSnapshotData=targetState.snapshot,definitions=sourceSnapshot.files.map((file)=>({source:file,...adapt(file,source,target)}));
			const existing=await readExisting(targetConnection,targetSnapshotData.commit,definitions.map((item)=>projectLibraryPath(targetConnection.contentPath,item.path))).catch((error)=>failed('target_definition_read',target.id,error));
			const changes=definitions.filter((item)=>existing.get(projectLibraryPath(targetConnection.contentPath,item.path))!==item.content),projected=projectionMatches(await classes(this.store,target.id),definitions,targetSnapshotData.commit);
			const action=changes.length===0&&projected?'noop':changes.some((item)=>!existing.has(projectLibraryPath(targetConnection.contentPath,item.path)))?'create':'update';
			targetPlans.push({projectId:target.id,slug:target.slug,name:target.name,repository:targetConnection.repositoryId,commit:targetSnapshotData.commit,action,definitions:definitions.map((item)=>({path:item.path,agentClass:item.agentClass,sourceDigest:item.source.sourceDigest,desiredDigest:item.digest}))});
		}
		const value={schemaVersion:'treeseed.agent-team-clone-plan/v1' as const,teamId,source:{projectId:source.id,slug:source.slug,name:source.name,repository:sourceConnection.repositoryId,commit:sourceSnapshot.commit},targets:targetPlans};
		return agentTeamClonePlanSchema.parse({...value,digest:planDigest(value)});
	}
	async apply(principal:CapacityPrincipal,teamId:string,input:AgentTeamClonePlan){
		await authorizeCapacityTeam(this.store,principal,teamId,'projects:manage:team');const plan=agentTeamClonePlanSchema.parse(input);
		const {digest:ignoredDigest,...unsignedPlan}=plan;void ignoredDigest;
		if(plan.teamId!==teamId||plan.digest!==planDigest(unsignedPlan))throw new CapacityOperationError(409,'agent_team_plan_invalid','The clone plan digest or team binding is invalid.');
		const projects=(await this.store.listTeamProjects(teamId)) as Project[],source=selectProject(projects,plan.source.projectId);
		if(!source||source.slug!==plan.source.slug)throw new CapacityOperationError(409,'agent_team_source_changed','The planned source project identity changed.');
		const sourceConnection=await connection(this.store,source.id,false,[plan.source.commit]);if(sourceConnection.repositoryId!==plan.source.repository)throw new CapacityOperationError(409,'agent_team_source_changed','The planned source repository changed.');
		const sourceSnapshot=await snapshotAgents(sourceConnection,plan.source.commit);if(sourceSnapshot.commit!==plan.source.commit)throw new CapacityOperationError(409,'agent_team_source_changed','The planned source commit changed.');
		const results=[];
		for(const targetPlan of plan.targets){
			const target=selectProject(projects,targetPlan.projectId);if(!target||target.slug!==targetPlan.slug)throw new CapacityOperationError(409,'agent_team_target_changed','A planned target project identity changed.',{projectId:targetPlan.projectId});
			const targetConnection=await connection(this.store,target.id,true,[targetPlan.commit]);if(targetConnection.repositoryId!==targetPlan.repository)throw new CapacityOperationError(409,'agent_team_target_changed','A planned target repository changed.',{projectId:target.id});
			const targetSnapshot=await snapshotAgents(targetConnection,targetPlan.commit);if(targetSnapshot.commit!==targetPlan.commit)throw new CapacityOperationError(409,'agent_team_target_moved','A target snapshot moved after planning.',{projectId:target.id,expected:targetPlan.commit,actual:targetSnapshot.commit});
			const desired=sourceSnapshot.files.map((file)=>({source:file,...adapt(file,source,target)}));
			if(stable(desired.map((item)=>({path:item.path,agentClass:item.agentClass,sourceDigest:item.source.sourceDigest,desiredDigest:item.digest})))!==stable(targetPlan.definitions))throw new CapacityOperationError(409,'agent_team_plan_stale','Adapted definitions no longer match the frozen plan.',{projectId:target.id});
			const paths=desired.map((item)=>projectLibraryPath(targetConnection.contentPath,item.path)),existing=await readExisting(targetConnection,targetPlan.commit,paths);
			const changes=desired.flatMap((item)=>{const path=projectLibraryPath(targetConnection.contentPath,item.path),before=existing.get(path)??null;return before===item.content?[]:[{path,before,after:item.content}];});
			if(!changes.length){
				if(targetPlan.action!=='noop')await activateDefinitions(this.store,target,desired,targetPlan.commit,branch(targetConnection),plan.digest);
				results.push({projectId:target.id,action:targetPlan.action==='create'?'created' as const:targetPlan.action==='update'?'updated' as const:'noop' as const,repository:targetConnection.repositoryId,commit:targetPlan.commit,definitionCount:desired.length});continue;
			}
			const branchName=branch(targetConnection),workspace=await targetConnection.client.createWorkspace({workspaceId:treeDxWorkspaceId(randomUUID()),repoId:targetConnection.repositoryId,baseRef:targetPlan.commit,branchName,mode:'writable',allowedPaths:targetConnection.allowedPaths,ttlSeconds:600});
			try{
				if(workspace.baseCommitSha!==targetPlan.commit)throw new CapacityOperationError(409,'agent_team_target_moved','A target authoring branch moved before apply.',{projectId:target.id});
				await applyTextChangeset({client:targetConnection.client,workspace,changes,idempotencyKey:plan.digest});
				const committed=await targetConnection.client.commit({workspaceId:workspace.workspaceId,message:`agents: adopt ${source.name} team for ${target.name}`,author:{name:text(record(principal).name)||text(record(principal).id)||'TreeSeed operator',email:text(record(principal).email)||'agents@users.treeseed.local'}});
				await recordTreeDxAuthoringState(this.store,'unpublished',{projectId:target.id,repositoryId:targetConnection.repositoryId,commitSha:committed.commitSha,ref:committed.branchName,changedPaths:committed.changedPaths,actorType:'user',actorId:text(record(principal).id)});
				await projectTreeDxCommitSignals(this.store,{projectId:target.id,commitSha:committed.commitSha,immutableRef:committed.branchName,changedPaths:committed.changedPaths,changeSummary:`Adopt ${source.name} agent team`,actorType:'user',actorId:text(record(principal).id)});
				await activateDefinitions(this.store,target,desired,committed.commitSha,committed.branchName,plan.digest);
				results.push({projectId:target.id,action:changes.some((change)=>change.before===null)?'created' as const:'updated' as const,repository:targetConnection.repositoryId,commit:committed.commitSha,definitionCount:desired.length});
			}catch(error){await targetConnection.client.closeWorkspace(workspace.workspaceId).catch(()=>undefined);throw error;}
		}
		return {schemaVersion:'treeseed.agent-team-clone-receipt/v1' as const,teamId,planDigest:plan.digest,mutation:results.some((result)=>result.action!=='noop'),noop:results.every((result)=>result.action==='noop'),targets:results};
	}
}

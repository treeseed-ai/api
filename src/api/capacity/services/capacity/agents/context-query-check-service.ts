import { createHash,randomUUID } from 'node:crypto';
import { assignmentPathAllowed, authorizedContextItemSchema, type AssignmentAttempt, type AssignmentContext, type ExactEntityReference } from '@treeseed/sdk/agent-capacity';
import { canonicalStandardsJson } from '@treeseed/sdk/standards';
import { compileDeclarativeContextQuery } from '@treeseed/sdk/graph/context-query-contracts';
import type { ProjectAgentActivityRef } from '../../projects/projects-core/project-agent-activity-refs.ts';
import {
	contextQueryReadiness,executeContextQuerySetTest,executeContextQueryTest,
	type ContextQuerySetDefinition,type ContextQueryTestDefinition,type DeclarativeContextQuery,
} from '../../../../knowledge/runtime/context-query-runtime.ts';
import { validateContentFrontmatter } from '@treeseed/sdk/content-validation';
import { parseFrontmatterDocument } from '../../../../content/frontmatter.ts';
import type { CapacityGovernanceDatabase } from '../../../database.ts';
import { CapacityGovernanceError } from '../../../database.ts';
import { completedGraphRefresh, projectLibraryPath, resolveKnowledgeGatewayConnection } from '../../../../knowledge/gateway-treedx-connection.ts';

export interface AssignmentQueryContext {
	references: ExactEntityReference[];
	authorizedContext: AssignmentContext['context'];
	selectors: Array<{ kind: 'query' | 'query-set'; id: string; revision: number; layer: 'agent' | 'activity' }>;
	checks: Array<Record<string, unknown>>;
}

export function assignmentQueryContext(attempt: AssignmentAttempt, resolved?: AssignmentQueryContext): AssignmentContext['context'] {
	const items=(resolved?.authorizedContext??[]).map(value=>authorizedContextItemSchema.parse(value));
	const refs=items.map(item=>canonicalStandardsJson(item.ref));
	const expected=[...(attempt.effectiveProfile.contextQueryRefs??[]).map(ref=>({...ref,kind:'query'})),
		...(attempt.effectiveProfile.contextQuerySetRefs??[]).map(ref=>({...ref,kind:'query-set'}))];
	if(expected.some(ref=>!resolved?.selectors.some(selector=>selector.kind===ref.kind&&selector.id===ref.id&&selector.revision===ref.revision))
		||new Set(refs).size!==refs.length||canonicalStandardsJson(resolved?.references??[])!==canonicalStandardsJson(items.map(item=>item.ref))
		||items.some(item=>item.ref.store!=='treedx'||!item.ref.commit||!item.ref.path||!item.ref.anchor
		||item.ref.digest!==item.digest||item.digest!==`sha256:${createHash('sha256').update(canonicalStandardsJson(item.value)).digest('hex')}`
		||!attempt.contextRefs.some(ref=>canonicalStandardsJson(ref)===canonicalStandardsJson(item.ref))
		||!attempt.grant.contentRead.some(ref=>canonicalStandardsJson(ref)===canonicalStandardsJson(item.ref))))
		throw new CapacityGovernanceError('assignment_context_query_authority_mismatch','Query context must match its exact immutable assignment grant and digest.',409);
	return items;
}

const COLLECTIONS = { agent:'agents',test:'agent-tests',query:'agent-context-queries',set:'agent-context-query-sets' } as const;
const DEFAULT_FRESH_SECONDS = 86_400;

function record(value:unknown):Record<string,unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : {}; }
function parseJson(value:unknown,fallback:unknown) { try { return typeof value === 'string' ? JSON.parse(value) : value ?? fallback; } catch { return fallback; } }
function safeId(value:unknown) {
	const id=String(value??'').trim();
	if (!/^[a-z0-9][a-z0-9/_-]*$/u.test(id)||id.includes('..')) throw new CapacityGovernanceError('context_query_test_id_invalid','Context-query test id is unsafe.',400);
	return id;
}
function path(root:string,collection:string,id:string) { return projectLibraryPath(root, collection, `${safeId(id)}.mdx`); }
function digest(value:unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function strings(value:unknown) { return Array.isArray(value)?[...new Set(value.map(String).map((item)=>item.trim()).filter(Boolean))]:[]; }
function queryPathModel(root:string,filePath:string) {
	if(!filePath||filePath.startsWith('/')||filePath.includes('\\')||filePath.split('/').some(part=>!part||part==='.'||part==='..')
		||(root!=='.'&&!filePath.startsWith(`${root}/`)))return undefined;
	const relative=root==='.'?filePath:filePath.slice(root.length+1);
	if(relative==='README.md')return 'knowledge';
	const models:Record<string,string>={knowledge:'knowledge',objectives:'objective',proposals:'proposal',decisions:'decision',notes:'note',questions:'question',agents:'agent',books:'book',discussions:'discussion','discussion-messages':'discussion-message','discussion-events':'discussion'};
	return models[relative.split('/')[0]!];
}
export async function executeCurrentContext(connection:Awaited<ReturnType<typeof resolveKnowledgeGatewayConnection>>,exactRef:string,request:Record<string,unknown>) {
	if(!connection) throw new CapacityGovernanceError('context_query_treedx_unavailable','Project TreeDX content is unavailable.',409);
	if(!/^[a-f0-9]{40}$/u.test(exactRef)) throw new CapacityGovernanceError('context_query_reference_invalid','Context execution requires an exact commit.',409);
	// Use the existing job observer and the original grant, never a wider graph
	// refresh merely because the query requests the repository root.
	await completedGraphRefresh(connection.client,{repoId:connection.repositoryId,ref:exactRef,paths:connection.allowedPaths,forceFull:true});
	return connection.client.buildContext({...request,repoId:connection.repositoryId,ref:exactRef});
}

function rowCheck(row:Record<string,unknown>) {
	return {
		id:String(row.id),teamId:String(row.team_id),projectId:String(row.project_id),testId:String(row.test_id),testRef:String(row.test_ref),
		definition:{kind:String(row.definition_kind) as 'query'|'query-set',id:String(row.definition_id),revision:Number(row.definition_revision),commit:String(row.definition_commit)},
		status:String(row.status) as 'passing'|'failing'|'stale',checkedAt:String(row.checked_at),expiresAt:String(row.expires_at),latencyMs:Number(row.latency_ms),
		stats:parseJson(row.stats_json,{}),assertions:parseJson(row.assertions_json,[]),resultDigest:String(row.result_digest),
	};
}

export class ContextQueryCheckService {
	constructor(private readonly store:CapacityGovernanceDatabase) {}

	/** Initialize missing/expired isolated evidence through the same authority used
	 * by admission. Seed reconciliation and governed profile edits share this path. */
	async verifyCatalog(input:{projectId:string;teamId:string;ref:string}) {
		const catalog=await this.catalog(input.projectId,input.ref);
		const referenced=new Map(catalog.agentReferences.map(entry=>[`${entry.kind}:${entry.id}@${entry.revision}`,
			{kind:entry.kind,id:entry.id,revision:entry.revision}]));
		const relevantTests=catalog.tests.filter(test=>referenced.has(`${test.definitionKind}:${test.definitionId}@${test.definitionRevision}`));
		const tested=new Set(relevantTests.map(test=>`${test.definitionKind}:${test.definitionId}@${test.definitionRevision}`));
		const missing=[...referenced.entries()].filter(([key])=>!tested.has(key)).map(([,reference])=>reference);
		if(missing.length)throw new Error(`Agent context references have no isolated tests: ${missing.map(item=>`${item.kind}:${item.id}@${item.revision}`).join(', ')}.`);
		if(referenced.size) {
			try {
				await this.requirePassing(input.teamId,input.projectId,input.ref,[...referenced.values()]);
				return {references:referenced.size,tests:relevantTests.length};
			} catch(error) {
				if(!(error instanceof CapacityGovernanceError)||error.code!=='agent_context_query_not_ready')throw error;
			}
		}
		const attempt=randomUUID();
		for(const test of relevantTests) {
			let result;
			try { result=await this.check(input.teamId,input.projectId,{testId:test.id,testPath:test.path,definitionRef:input.ref,
				idempotencyKey:`library-reconcile:${attempt}:${input.projectId}:${input.ref}:${test.id}`}); }
			catch(error){throw new Error(`Context-query test ${test.id} could not run: ${error instanceof Error?error.message:'unknown error'}`);}
			if(result.status!=='passing')throw new Error(`Context-query test ${test.id} did not pass for ${input.ref}.`);
		}
		if(referenced.size)await this.requirePassing(input.teamId,input.projectId,input.ref,[...referenced.values()]);
		return {references:referenced.size,tests:relevantTests.length};
	}

	private async queryProjects(teamId:string,projectId:string,query:DeclarativeContextQuery) {
		const sources=query.sources?.length?query.sources:[{scope:'current-project' as const}],projects=new Map<string,{projectId:string;paths:string[];source:string;allowedModels?:string[]}>();
		const add=(id:string,paths:string[],source:string,allowedModels?:string[])=>projects.set(id,{projectId:id,paths:paths.length?paths:['**'],source,...(allowedModels?.length?{allowedModels}:{})});
		for(const selector of sources) {
			if(selector.scope==='current-project') { add(projectId,['**'],'current-project'); continue; }
			if(selector.scope==='team-library') {
				const teamProject=await (this.store as any).getProjectByTeamAndSlug(teamId,'team');
				if(!teamProject) throw new CapacityGovernanceError('team_library_unavailable','The managed Team Library is unavailable.',409);
				add(String(teamProject.id),['**'],'team-library'); continue;
			}
			if(selector.scope==='same-team') {
				const teamProjects=await (this.store as any).listTeamProjects(teamId),ids=new Set(selector.projectIds??[]),slugs=new Set(selector.projectSlugs??[]);
				const selected=ids.size||slugs.size?teamProjects.filter((project:Record<string,unknown>)=>ids.has(String(project.id))||slugs.has(String(project.slug))):teamProjects;
				if(selected.length!==(ids.size+slugs.size||teamProjects.length))throw new CapacityGovernanceError('context_query_source_missing','A selected same-team project does not exist.',404);
				for(const project of selected)add(String(project.id),['**'],'same-team');continue;
			}
			if(selector.scope==='shared-team') {
				const shares=(await (this.store as any).listTreeDxSharesForRecipient(teamId)).filter((share:Record<string,unknown>)=>String(share.teamId)===selector.teamId&&share.status==='active'&&(!share.expiresAt||Date.parse(String(share.expiresAt))>Date.now()));
				const eligible=new Map<string,Record<string,unknown>>();for(const share of shares){const grant=record(share.trustGrant);if(!strings(grant.operations).includes('context'))continue;for(const id of strings(grant.projectIds??share.projectId))eligible.set(id,grant);}
				const selected=selector.projectIds?.length?selector.projectIds:[...eligible.keys()];
				for(const id of selected){const grant=eligible.get(id);if(!grant)throw new CapacityGovernanceError('context_query_share_denied','An active knowledge share does not cover the selected project.',403);add(id,strings(grant.paths),`shared-team:${selector.teamId}`,strings(grant.contentModels));}
			}
		}
		return [...projects.values()];
	}

	private async executeQuerySources(teamId:string,projectId:string,exactProjectRef:string,exactProjectConnection:NonNullable<Awaited<ReturnType<typeof resolveKnowledgeGatewayConnection>>>,query:DeclarativeContextQuery,request:Record<string,unknown>) {
		const selected=await this.queryProjects(teamId,projectId,query),results=[] as Array<{projectId:string;source:string;ref:string;repositoryId:string;contentPath:string;allowedPaths:string[];allowedModels?:string[];result:any}>;
		for(const source of selected) {
			const connection=source.projectId===projectId?exactProjectConnection
				:await resolveKnowledgeGatewayConnection(this.store,{projectId:source.projectId,write:false,authoringPaths:true,relationPaths:true,communicationPaths:true});
			if(!connection)throw new CapacityGovernanceError('context_query_treedx_unavailable',`TreeDX content is unavailable for source project ${source.projectId}.`,409);
			const requestedPaths=strings(request.scopePaths).map((path)=>path.replace(/^\/+/,''));
			const sourceIsUnbounded=source.paths.length===1&&source.paths[0]==='**';
			if(!sourceIsUnbounded&&requestedPaths.some(value=>!assignmentPathAllowed(value.replace(/\/\*\*$/u,''),source.paths)))
				throw new CapacityGovernanceError('assignment_context_query_permission_denied','Query scope exceeds the active source share.',403);
			const scopePaths=requestedPaths.length?requestedPaths:source.paths;
			// The project under test must use the immutable commit that supplied its
			// definitions. A moving remote branch can lag publication and would make a
			// valid query appear empty. Other projects remain pinned to their own
			// authoritative connection refs.
			let sourceRef=source.projectId===projectId?exactProjectRef:connection.baseRef;
			if(!/^[a-f0-9]{40}$/u.test(sourceRef)) sourceRef=String((await connection.client.listRepositoryPaths({repoId:connection.repositoryId,ref:sourceRef,paths:scopePaths,kinds:['blob'],limit:1})).resolvedRef??'');
			const refresh=source.projectId===projectId?connection:await resolveKnowledgeGatewayConnection(this.store,{projectId:source.projectId,write:false,authoringPaths:true,relationPaths:true,communicationPaths:true,readRefs:[sourceRef],refreshGraph:true});
			if(!refresh||refresh.repositoryId!==connection.repositoryId)throw new CapacityGovernanceError('context_query_treedx_unavailable','Exact query source authority is unavailable.',409);
			const result=await executeCurrentContext(refresh,sourceRef,{...request,scopePaths});
			if(String(record(result).resolvedRef??'')!==sourceRef)throw new CapacityGovernanceError('context_query_reference_moved','Query source changed its immutable commit.',409);
			for(const raw of Array.isArray(record(result).nodes)?record(result).nodes as unknown[]:[]){
				const entry=record(raw),node=record(entry.node??entry),filePath=String(node.path??''),model=queryPathModel(connection.contentPath,filePath);
				if(!model||!assignmentPathAllowed(filePath,source.paths)||!assignmentPathAllowed(filePath,connection.allowedPaths)
					||(source.allowedModels&&!source.allowedModels.includes(model)))
					throw new CapacityGovernanceError('assignment_context_query_permission_denied','Native query result exceeds its source path or content-model grant.',403);
			}
			results.push({projectId:source.projectId,source:source.source,ref:sourceRef,repositoryId:connection.repositoryId,contentPath:connection.contentPath,allowedPaths:source.paths,...(source.allowedModels?{allowedModels:source.allowedModels}:{}),result});
		}
		const unpack=(value:any)=>record(record(value).payload??value),nodes=results.flatMap((entry)=>Array.isArray(unpack(entry.result).nodes)?unpack(entry.result).nodes:[]),edges=results.flatMap((entry)=>Array.isArray(unpack(entry.result).edges)?unpack(entry.result).edges:[]);
		return {nodes,edges,sources:results.map(({result,...source})=>{const value=unpack(result),sourceNodes=Array.isArray(value.nodes)?value.nodes.map(record):[];
			return {...source,paths:[...new Set(sourceNodes.map((entry)=>record(entry.node??entry)).map((node)=>String(node.path??'').trim()).filter(Boolean))].sort()};}),memberResults:results.map((entry)=>entry.result)};
	}

	async definitionCommit(projectId:string) {
		const connection=await resolveKnowledgeGatewayConnection(this.store,{projectId,write:false,authoringPaths:true});
		if(!connection) return null;
		const ref=`refs/heads/${connection.authoringBranch.replace(/^refs\/heads\//u,'')}`;
		const listed=await connection.client.listRepositoryPaths({repoId:connection.repositoryId,ref,paths:[projectLibraryPath(connection.contentPath,COLLECTIONS.query,'**')],kinds:['blob'],limit:1,allowProtected:true});
		return String(listed.resolvedRef??'').trim()||null;
	}

	async catalog(projectId:string,ref:string) {
		const connection=await resolveKnowledgeGatewayConnection(this.store,{projectId,write:false,authoringPaths:true,readRefs:[ref]});
		if(!connection) throw new CapacityGovernanceError('context_query_treedx_unavailable','Project TreeDX content is unavailable.',409);
		const collections=[['query',COLLECTIONS.query,'agent_context_query'],['query-set',COLLECTIONS.set,'agent_context_query_set'],['test',COLLECTIONS.test,'agent_test'],['agent',COLLECTIONS.agent,'agent']] as const;
		const listed=await connection.client.listRepositoryPaths({repoId:connection.repositoryId,ref,paths:collections.map(([,collection])=>projectLibraryPath(connection.contentPath,collection,'**')),kinds:['blob'],extensions:['.md','.mdx'],limit:500,allowProtected:true});
		const paths=(listed.entries??[]).map((entry:unknown)=>String(record(entry).path??'').trim()).filter(Boolean);
		const exactRef=String(listed.resolvedRef??ref),files:unknown[]=[];let resolvedRef=exactRef;
		for(let offset=0;offset<paths.length;offset+=16){
			const batch=paths.slice(offset,offset+16);let read;
			try { read=await connection.client.readRepositoryFiles({repoId:connection.repositoryId,ref:exactRef,paths:batch,encoding:'utf8',parseFrontmatter:false,allowProtected:true}); }
			catch(error){throw new CapacityGovernanceError('context_query_catalog_read_failed',`Context-query catalog read failed for ${batch.join(', ')}: ${error instanceof Error?error.message:'unknown error'}`,502);}
			resolvedRef=String((read as Record<string,unknown>).resolvedRef??resolvedRef);files.push(...(read.files??[]));
		}
		const commit=resolvedRef;
		const entries=files.map((file:unknown)=>{
			const row=record(file); const filePath=String(row.path??''); const source=String(row.content??'');
			const contract=collections.find(([,collection])=>filePath.startsWith(`${collection}/`)||filePath.includes(`/${collection}/`)); if(!contract||!source) return [];
			const validation=validateContentFrontmatter(contract[2],parseFrontmatterDocument(source).frontmatter);
			if(!validation.ok||!validation.data) return [];
			const value=validation.data as Record<string,unknown>;
			if(contract[0]==='agent') {
				const profiles=record(value.activityProfiles);
				return Object.entries(profiles).flatMap(([profileId,candidate])=>{
					// Presence in the validated activityProfiles map is the configured
					// profile authority; canonical profiles have no enabled property.
					const profile=record(candidate);
					return [
						...([...(Array.isArray(value.contextQueryRefs)?value.contextQueryRefs:[]),...(Array.isArray(profile.contextQueryRefs)?profile.contextQueryRefs:[])]).map((reference)=>({kind:'query' as const,reference:record(reference)})),
						...([...(Array.isArray(value.contextQuerySetRefs)?value.contextQuerySetRefs:[]),...(Array.isArray(profile.contextQuerySetRefs)?profile.contextQuerySetRefs:[])]).map((reference)=>({kind:'query-set' as const,reference:record(reference)})),
					].filter(({reference})=>reference.id&&reference.revision).map(({kind,reference})=>({entryType:'agent-reference' as const,agentId:String(value.id),profileId,kind,id:String(reference.id),revision:Number(reference.revision)}));
				});
			}
			if(contract[0]==='test') {
				const kind=String(value.kind??''); const reference=record(kind==='context-query'?value.queryRef:kind==='context-query-set'?value.querySetRef:null);
				if(!reference.id) return [];
				return [{entryType:'test' as const,id:String(value.id),testRef:String(value.testRef),kind,definitionKind:kind==='context-query'?'query' as const:'query-set' as const,definitionId:String(reference.id),definitionRevision:Number(reference.revision),path:filePath,commit}];
			}
			return [{entryType:'definition' as const,kind:contract[0],id:String(value.id),revision:Number(value.revision),maturity:String(value.maturity??''),queryRefs:contract[0]==='query-set'?(Array.isArray(value.queryRefs)?value.queryRefs.map(record):[]):[],path:filePath,commit}];
		}).flat();
		return {commit,definitions:entries.filter((entry)=>entry.entryType==='definition'),tests:entries.filter((entry)=>entry.entryType==='test'),agentReferences:entries.filter((entry)=>entry.entryType==='agent-reference')};
	}

	private async source(projectId:string,ref:string,filePath:string) {
		const connection=await resolveKnowledgeGatewayConnection(this.store,{projectId,write:false,authoringPaths:true,readRefs:[ref]});
		if(!connection) throw new CapacityGovernanceError('context_query_treedx_unavailable','Project TreeDX content is unavailable.',409);
		const read=await connection.client.readRepositoryFiles({repoId:connection.repositoryId,ref,paths:[filePath],encoding:'utf8',parseFrontmatter:false,allowProtected:true});
		const file=Array.isArray(read.files)?record(read.files[0]):{};
		if(!String(file.content??'')) throw new CapacityGovernanceError('context_query_definition_missing',`Missing ${filePath}.`,404);
		return {connection,resolvedRef:String(read.resolvedRef??ref),path:String(file.path??''),frontmatter:parseFrontmatterDocument(String(file.content)).frontmatter};
	}

	/** Execute configured queries against this admission snapshot; isolated check
	 * paths are readiness evidence, never a substitute for current query results. */
	async resolveForAssignment(input:{teamId:string;projectId:string;definitionRef:string;dataRef:string;
		allowedModels:string[];layers:ProjectAgentActivityRef['contextQueryLayers']}):Promise<AssignmentQueryContext> {
		if(!/^[a-f0-9]{40}$/u.test(input.definitionRef)||!/^[a-f0-9]{40}$/u.test(input.dataRef))
			throw new CapacityGovernanceError('context_query_reference_invalid','Assignment queries require exact definition and data commits.',409);
		const selectors=Object.entries(input.layers).flatMap(([layer,value])=>[
			...value.queryRefs.map(ref=>({...ref,kind:'query' as const,layer:layer as 'agent'|'activity'})),
			...value.querySetRefs.map(ref=>({...ref,kind:'query-set' as const,layer:layer as 'agent'|'activity'}))]);
		if(!selectors.length)return {references:[],authorizedContext:[],selectors,checks:[]};
		await this.requirePassing(input.teamId,input.projectId,input.definitionRef,selectors);
		const connection=await resolveKnowledgeGatewayConnection(this.store,{projectId:input.projectId,write:false,
			authoringPaths:true,relationPaths:true,communicationPaths:true,readRefs:[input.dataRef],refreshGraph:true});
		if(!connection)throw new CapacityGovernanceError('context_query_treedx_unavailable','Assignment query source is unavailable.',409);
		const contexts=new Map<string,AssignmentContext['context']>(),checks:AssignmentQueryContext['checks']=[];
		const cached=new Map<string,Promise<{context:AssignmentContext['context'];check:Record<string,unknown>}>>();
		const readDefinition=async(kind:'query'|'query-set',ref:{id:string;revision:number})=>{
			const expectedPath=path(connection.contentPath,kind==='query'?COLLECTIONS.query:COLLECTIONS.set,ref.id);
			const source=await this.source(input.projectId,input.definitionRef,expectedPath);
			const validation=validateContentFrontmatter(kind==='query'?'agent_context_query':'agent_context_query_set',source.frontmatter);
			if(source.resolvedRef!==input.definitionRef||source.path!==expectedPath||!validation.ok||!validation.data
				||record(validation.data).id!==ref.id||record(validation.data).revision!==ref.revision)
				throw new CapacityGovernanceError('context_query_definition_invalid','The exact configured query definition is missing, moved or invalid.',409,{id:ref.id,revision:ref.revision});
			return validation.data;
		};
		const execute=async(ref:{id:string;revision:number})=>{
			const query=await readDefinition('query',ref) as DeclarativeContextQuery;
			const definition={kind:'query',id:ref.id,revision:ref.revision,commit:input.definitionRef},compiled=compileDeclarativeContextQuery(query);
			if(!compiled.ok||!compiled.compiled)throw new CapacityGovernanceError('context_query_definition_invalid','Configured query does not compile.',409,{id:ref.id,errors:compiled.errors});
			try {
				const result=await this.executeQuerySources(input.teamId,input.projectId,input.dataRef,connection,query,compiled.compiled.request as unknown as Record<string,unknown>);
				const context:AssignmentContext['context']=[];let tokens=0,characters=0;
				for(const [index,source] of result.sources.entries()){
					const pack=record(result.memberResults[index]);
					if(!Array.isArray(pack.nodes)||!Number.isInteger(pack.totalTokenEstimate)||Number(pack.totalTokenEstimate)<0)
						throw new CapacityGovernanceError('context_query_result_invalid','TreeDX must return its native bounded context pack.',502);
					let memberTokens=0;
					for(const [nodeIndex,raw] of pack.nodes.entries()){
						const entry=record(raw),node=record(entry.node),filePath=String(node.path??''),anchor=String(node.id??'');
						if(!filePath||filePath.startsWith('/')||filePath.includes('\\')||filePath.split('/').some(part=>!part||part==='.'||part==='..')
							||!assignmentPathAllowed(filePath,source.allowedPaths)
							||(source.contentPath!=='.'&&!filePath.startsWith(`${source.contentPath}/`)))
							throw new CapacityGovernanceError('assignment_context_query_permission_denied','Query result escaped its exact source path grant.',403);
						const model=queryPathModel(source.contentPath,filePath);
						if(!model||!input.allowedModels.includes(model)||(source.allowedModels&&!source.allowedModels.includes(model)))
							throw new CapacityGovernanceError('assignment_context_query_permission_denied','Query result exceeds the profile or share content-model grant.',403);
						if(!anchor||typeof entry.text!=='string'||node.text!==entry.text||!Number.isInteger(entry.tokenEstimate)||Number(entry.tokenEstimate)<0)
							throw new CapacityGovernanceError('context_query_result_invalid','TreeDX result lacks its bounded text and citation.',502);
						memberTokens+=Number(entry.tokenEstimate);characters+=[...entry.text].length;
						const value={definition,projectId:source.projectId,entry,...(nodeIndex===0?{edges:Array.isArray(pack.edges)?pack.edges:[]}: {})},valueDigest=`sha256:${createHash('sha256').update(canonicalStandardsJson(value)).digest('hex')}`;
						context.push(authorizedContextItemSchema.parse({ref:{store:'treedx',model,id:anchor,repository:source.repositoryId,commit:source.ref,path:filePath,anchor,digest:valueDigest},mediaType:'application/json',digest:valueDigest,value}));
					}
					if(memberTokens!==Number(pack.totalTokenEstimate))throw new CapacityGovernanceError('context_query_result_invalid','Native query token accounting is inconsistent.',502);
					tokens+=memberTokens;
				}
				if((query.contextBudget?.maxItems!==undefined&&context.length>query.contextBudget.maxItems)
					||(query.resultLimit!==undefined&&context.length>query.resultLimit)
					||(query.tokenBudget!==undefined&&tokens>query.tokenBudget)
					||(query.contextBudget?.maxCharacters!==undefined&&characters>query.contextBudget.maxCharacters))
					throw new CapacityGovernanceError('context_query_budget_exceeded','Query result exceeds its configured aggregate context budget.',409);
				return {context,check:{definition,status:'resolved',requirement:query.requirement,stats:{sources:result.sources,items:context.length,tokens,characters},resultDigest:digest(result)}};
			}catch(error){
				if(query.requirement==='required'||['assignment_context_query_permission_denied','context_query_reference_moved'].includes(String(record(error).code)))throw error;
				return {context:[],check:{definition,status:'failed',requirement:query.requirement,errorCode:String(record(error).code??'context_query_execution_failed')}};
			}
		};
		for(const selector of selectors){
			const set=selector.kind==='query-set'?await readDefinition('query-set',selector) as ContextQuerySetDefinition:null;
			if(set?.mergePolicy==='replace')contexts.set(selector.layer,[]);
			for(const ref of set?.queryRefs??[selector]){
				const key=`${ref.id}@${ref.revision}`;if(!cached.has(key))cached.set(key,execute(ref));
				const result=await cached.get(key)!;
				contexts.set(selector.layer,[...contexts.get(selector.layer)??[],...result.context]);
				checks.push({...result.check,layer:selector.layer,...(set?{querySet:{id:set.id,revision:set.revision,mergePolicy:set.mergePolicy}}:{})});
			}
		}
		const authorizedContext=[...new Map([...contexts.values()].flat().map(item=>[canonicalStandardsJson(item.ref),item])).values()];
		return {references:authorizedContext.map(item=>item.ref),authorizedContext,selectors,checks};
	}

	async check(teamId:string,projectId:string,input:{testId:string;testPath?:string;definitionRef?:string;idempotencyKey:string;freshForSeconds?:number}) {
		const key=String(input.idempotencyKey??'').trim();
		if(!key) throw new CapacityGovernanceError('idempotency_key_required','Context-query checks require an idempotency key.',400);
		const replay=await this.store.first('SELECT * FROM agent_context_query_checks WHERE team_id = ? AND idempotency_key = ? LIMIT 1',[teamId,key]);
		if(replay) {
			if(String(replay.project_id)!==projectId||String(replay.test_id)!==input.testId) throw new CapacityGovernanceError('idempotency_key_conflict','Idempotency key belongs to another context-query check.',409);
			return {...rowCheck(replay),idempotentReplay:true};
		}
		const project=await this.store.first('SELECT id, team_id FROM projects WHERE id = ? LIMIT 1',[projectId]);
		if(!project||String(project.team_id)!==teamId) throw new CapacityGovernanceError('context_query_project_team_mismatch','Project is not owned by the selected team.',404);
		const testId=safeId(input.testId);
		const initial=await resolveKnowledgeGatewayConnection(this.store,{projectId,write:false,authoringPaths:true});
		if(!initial) throw new CapacityGovernanceError('context_query_treedx_unavailable','Project TreeDX content is unavailable.',409);
		const catalogPath=String(input.testPath??'').trim();
		if(catalogPath&&!catalogPath.startsWith(`${projectLibraryPath(initial.contentPath,COLLECTIONS.test)}/`))throw new CapacityGovernanceError('context_query_test_path_invalid','Context-query test path is outside the registered collection.',400);
		const testSource=await this.source(projectId,String(input.definitionRef??`refs/heads/${initial.authoringBranch.replace(/^refs\/heads\//u,'')}`),catalogPath||path(initial.contentPath,COLLECTIONS.test,testId));
		const testValidation=validateContentFrontmatter('agent_test',testSource.frontmatter);
		if(!testValidation.ok||!['context-query','context-query-set'].includes(String(record(testValidation.data).kind))) throw new CapacityGovernanceError('context_query_test_invalid','Context-query test definition is invalid.',422,{diagnostics:testValidation.diagnostics});
		const test=testValidation.data as ContextQueryTestDefinition&{kind:'context-query'|'context-query-set'};
		const exactRef=testSource.resolvedRef;
		// An isolated check is a control-plane mutation: it may rebuild TreeDX's derived
		// graph for the exact current ref, but it never writes or commits query results.
		const exactConnection=await resolveKnowledgeGatewayConnection(this.store,{projectId,write:false,authoringPaths:true,relationPaths:true,communicationPaths:true,readRefs:[exactRef],refreshGraph:true});
		if(!exactConnection) throw new CapacityGovernanceError('context_query_treedx_unavailable','Project TreeDX content is unavailable.',409);
		let report:Record<string,unknown>; let definition:{kind:'query'|'query-set';id:string;revision:number;commit:string};
		if(test.kind==='context-query') {
			const querySource=await this.source(projectId,exactRef,path(initial.contentPath,COLLECTIONS.query,test.queryRef!.id));
			const validation=validateContentFrontmatter('agent_context_query',querySource.frontmatter);
			if(!validation.ok||!validation.data) throw new CapacityGovernanceError('context_query_definition_invalid','Context query definition is invalid.',422,{diagnostics:validation.diagnostics});
			const query=validation.data as DeclarativeContextQuery;
			report=await executeContextQueryTest({query,test,execute:(request)=>this.executeQuerySources(teamId,projectId,exactRef,exactConnection,query,request)}) as Record<string,unknown>;
			definition={kind:'query',id:test.queryRef!.id,revision:test.queryRef!.revision,commit:exactRef};
		} else {
			const setSource=await this.source(projectId,exactRef,path(initial.contentPath,COLLECTIONS.set,test.querySetRef!.id));
			const setValidation=validateContentFrontmatter('agent_context_query_set',setSource.frontmatter);
			if(!setValidation.ok||!setValidation.data) throw new CapacityGovernanceError('context_query_set_invalid','Context query-set definition is invalid.',422,{diagnostics:setValidation.diagnostics});
			const querySet=setValidation.data as ContextQuerySetDefinition; const queries:DeclarativeContextQuery[]=[];
			for(const reference of querySet.queryRefs) {
				const querySource=await this.source(projectId,exactRef,path(initial.contentPath,COLLECTIONS.query,reference.id));
				const validation=validateContentFrontmatter('agent_context_query',querySource.frontmatter);
				if(!validation.ok||!validation.data) throw new CapacityGovernanceError('context_query_definition_invalid','Query-set member is invalid.',422,{reference,diagnostics:validation.diagnostics});
				queries.push(validation.data as DeclarativeContextQuery);
			}
			report=await executeContextQuerySetTest({querySet,queries,test,execute:(query,request)=>this.executeQuerySources(teamId,projectId,exactRef,exactConnection,query,request)}) as Record<string,unknown>;
			definition={kind:'query-set',id:test.querySetRef!.id,revision:test.querySetRef!.revision,commit:exactRef};
		}
		const checkedAt=String(report.checkedAt??new Date().toISOString()); const fresh=Math.min(604_800,Math.max(300,Number(input.freshForSeconds??DEFAULT_FRESH_SECONDS)));
		const expiresAt=new Date(Date.parse(checkedAt)+fresh*1000).toISOString(); const id=randomUUID();
		// Identity/compile failures intentionally have no result payload. Their
		// complete deterministic report is still valid failure evidence.
		const resultDigest=digest(report.result ?? report);
		await this.store.run(`INSERT INTO agent_context_query_checks (id,idempotency_key,team_id,project_id,test_id,test_ref,definition_kind,definition_id,definition_revision,definition_commit,status,checked_at,expires_at,latency_ms,stats_json,assertions_json,result_digest) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[
			id,key,teamId,projectId,testId,String(test.testRef),definition.kind,definition.id,definition.revision,definition.commit,String(report.status),checkedAt,expiresAt,Number(report.latencyMs??0),JSON.stringify(report.stats??{}),JSON.stringify(report.assertions??[]),resultDigest,
		]);
		return {id,teamId,projectId,testId,testRef:String(test.testRef),definition,status:report.status,checkedAt,expiresAt,latencyMs:Number(report.latencyMs??0),stats:report.stats,assertions:report.assertions,resultDigest,report,idempotentReplay:false};
	}

	async list(teamId:string,projectId:string,currentCommit:string,now=new Date()) {
		const rows=await this.store.all('SELECT * FROM agent_context_query_checks WHERE team_id = ? AND project_id = ? ORDER BY checked_at DESC LIMIT 200',[teamId,projectId]);
		const latest=new Map<string,ReturnType<typeof rowCheck>>();
		for(const row of rows) { const check=rowCheck(row); if(!latest.has(check.testId)) latest.set(check.testId,check); }
		return [...latest.values()].map((check)=>({...check,readiness:contextQueryReadiness({check,definition:{...check.definition,commit:currentCommit},now})}));
	}

	async recheckDue(now=new Date(),limit=25) {
		const rows=await this.store.all(`SELECT current.* FROM agent_context_query_checks current
			WHERE current.expires_at <= ? AND NOT EXISTS (
				SELECT 1 FROM agent_context_query_checks newer
				WHERE newer.team_id = current.team_id AND newer.project_id = current.project_id
					AND newer.test_id = current.test_id AND newer.checked_at > current.checked_at
			)
			ORDER BY current.expires_at ASC LIMIT ?`,[now.toISOString(),Math.min(100,Math.max(1,limit))]);
		const outcomes:{considered:number;passing:number;failing:number;failures:Array<{testId:string;error:string}>}={considered:rows.length,passing:0,failing:0,failures:[]};
		const catalogs=new Map<string,Promise<Awaited<ReturnType<ContextQueryCheckService['catalog']>>>>();
		for(const row of rows) {
			const testId=String(row.test_id);
			try {
				const projectId=String(row.project_id);
				let pending=catalogs.get(projectId);
				if(!pending) {
					pending=(async()=>{
						const commit=await this.definitionCommit(projectId);
						if(!commit)throw new CapacityGovernanceError('context_query_treedx_unavailable','Project TreeDX content is unavailable.',409);
						return this.catalog(projectId,commit);
					})();
					catalogs.set(projectId,pending);
				}
				const catalog=await pending,tests=catalog.tests.filter(test=>test.id===testId);
				if(tests.length!==1)throw new CapacityGovernanceError('context_query_test_not_unique','Context-query renewal requires one registered test path.',409);
				const checked=await this.check(String(row.team_id),projectId,{
					testId,testPath:tests[0]!.path,definitionRef:catalog.commit,idempotencyKey:`scheduled-context-query-check:${String(row.id)}`,
				});
				if(checked.status==='passing') outcomes.passing+=1; else outcomes.failing+=1;
			} catch(error) {
				outcomes.failures.push({testId,error:error instanceof Error?error.message:String(error)});
			}
		}
		return outcomes;
	}

	async requirePassing(teamId:string,projectId:string,currentCommit:string,references:Array<{kind:'query'|'query-set';id:string;revision:number}>,now=new Date()) {
		const rows=await this.store.all('SELECT * FROM agent_context_query_checks WHERE team_id = ? AND project_id = ? ORDER BY checked_at DESC LIMIT 200',[teamId,projectId]);
		const byTest=new Map<string,ReturnType<typeof rowCheck>>();
		for(const row of rows) {
			const check=rowCheck(row); if(!byTest.has(check.testId)) byTest.set(check.testId,check);
		}
		const catalog=await this.catalog(projectId,currentCommit);
		const blocked=references.flatMap((reference)=>{
			const tests=catalog.tests.filter((test)=>test.definitionKind===reference.kind&&test.definitionId===reference.id&&test.definitionRevision===reference.revision);
			// Compare evidence to the requested definition, not to its own revision.
			const failed=tests.flatMap((test)=>{
				const check=byTest.get(test.id)??null;
				const readiness=contextQueryReadiness({check,definition:{...reference,commit:currentCommit},now});
				return readiness.selectable?[]:[{testId:test.id,reason:readiness.reason}];
			});
			return tests.length>0&&failed.length===0?[]:[{...reference,readiness:{status:'unchecked',selectable:false,reason:tests.length?'required_tests_failed':'no_tests'},requiredTestIds:tests.map((test)=>test.id),failedTestIds:failed.map((test)=>test.testId),failedChecks:failed}];
		});
		if(blocked.length) {
			// Invocation receipts retain the message even where structured details are
			// unavailable. Include bounded identifiers/reasons, never context content.
			const diagnostics=blocked.flatMap((entry)=>entry.failedChecks.length?entry.failedChecks.map((check)=>`${check.testId}: ${check.reason}`):[`${entry.id}: no_tests`]).slice(0,12).join('; ');
			throw new CapacityGovernanceError('agent_context_query_not_ready',`Every agent context query must have a fresh passing isolated check before workday admission. ${diagnostics}`,409,{projectId,currentCommit,blocked});
		}
		return references.flatMap((reference)=>catalog.tests.filter((test)=>test.definitionKind===reference.kind&&test.definitionId===reference.id&&test.definitionRevision===reference.revision).map((test)=>{
			const check=byTest.get(test.id)!;
			return {...check,readiness:contextQueryReadiness({check,definition:{...reference,commit:currentCommit},now})};
		}));
	}
}

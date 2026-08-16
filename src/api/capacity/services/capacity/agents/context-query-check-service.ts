import { createHash,randomUUID } from 'node:crypto';
import {
	contextQueryReadiness,executeContextQuerySetTest,executeContextQueryTest,
	type ContextQuerySetDefinition,type ContextQueryTestDefinition,type DeclarativeContextQuery,
} from '@treeseed/sdk';
import { validateContentFrontmatter } from '@treeseed/sdk/content-validation';
import { parseFrontmatterDocument } from '@treeseed/sdk/frontmatter';
import type { CapacityGovernanceDatabase } from '../../../database.ts';
import { CapacityGovernanceError } from '../../../database.ts';
import { resolveKnowledgeGatewayConnection } from '../../../../knowledge/gateway-treedx-connection.ts';

const COLLECTIONS = { agent:'agents',test:'agent-tests',query:'agent-context-queries',set:'agent-context-query-sets' } as const;
const DEFAULT_FRESH_SECONDS = 86_400;

function record(value:unknown):Record<string,unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : {}; }
function parseJson(value:unknown,fallback:unknown) { try { return typeof value === 'string' ? JSON.parse(value) : value ?? fallback; } catch { return fallback; } }
function safeId(value:unknown) {
	const id=String(value??'').trim();
	if (!/^[a-z0-9][a-z0-9/_-]*$/u.test(id)||id.includes('..')) throw new CapacityGovernanceError('context_query_test_id_invalid','Context-query test id is unsafe.',400);
	return id;
}
function path(root:string,collection:string,id:string) { return `${root}/${collection}/${safeId(id)}.mdx`; }
function digest(value:unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export async function executeCurrentContext(connection:Awaited<ReturnType<typeof resolveKnowledgeGatewayConnection>>,exactRef:string,request:Record<string,unknown>) {
	if(!connection) throw new CapacityGovernanceError('context_query_treedx_unavailable','Project TreeDX content is unavailable.',409);
	// A successful context response is not proof that TreeDX's derived graph includes
	// every file at the requested ref. Rebuild the exact graph before every isolated
	// check so omissions cannot be mistaken for authoritative current results.
	const refresh=await connection.client.refreshGraph({repoId:connection.repositoryId,ref:exactRef,paths:[`${connection.contentPath}/**`],forceFull:true});
	if(refresh.jobId) {
		let completed=false;
		for(let attempt=0;attempt<120;attempt+=1) {
			const job=await connection.client.getGraphRefreshJob({repoId:connection.repositoryId,ref:exactRef,jobId:refresh.jobId});
			if(job.status==='completed') { completed=true; break; }
			if(job.status==='failed') throw new CapacityGovernanceError('context_query_graph_refresh_failed','TreeDX failed to refresh the exact context-query graph.',409,{errorCode:job.errorCode});
			await new Promise((resolve)=>setTimeout(resolve,100));
		}
		if(!completed) throw new CapacityGovernanceError('context_query_graph_refresh_timeout','TreeDX did not refresh the exact context-query graph in time.',409);
	}
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

	async definitionCommit(projectId:string) {
		const connection=await resolveKnowledgeGatewayConnection(this.store,{projectId,write:false,authoringPaths:true});
		if(!connection) return null;
		const ref=`refs/heads/${connection.authoringBranch.replace(/^refs\/heads\//u,'')}`;
		const listed=await connection.client.listRepositoryPaths({repoId:connection.repositoryId,ref,paths:[`${connection.contentPath}/${COLLECTIONS.query}/**`],kinds:['blob'],limit:1,allowProtected:true});
		return String(listed.resolvedRef??'').trim()||null;
	}

	async catalog(projectId:string,ref:string) {
		const connection=await resolveKnowledgeGatewayConnection(this.store,{projectId,write:false,authoringPaths:true,readRefs:[ref]});
		if(!connection) throw new CapacityGovernanceError('context_query_treedx_unavailable','Project TreeDX content is unavailable.',409);
		const collections=[['query',COLLECTIONS.query,'agent_context_query'],['query-set',COLLECTIONS.set,'agent_context_query_set'],['test',COLLECTIONS.test,'agent_test'],['agent',COLLECTIONS.agent,'agent']] as const;
		const listed=await connection.client.listRepositoryPaths({repoId:connection.repositoryId,ref,paths:collections.map(([,collection])=>`${connection.contentPath}/${collection}/**`),kinds:['blob'],extensions:['.md','.mdx'],limit:500,allowProtected:true});
		const paths=(listed.entries??[]).map((entry:unknown)=>String(record(entry).path??'').trim()).filter(Boolean);
		const read=paths.length?await connection.client.readRepositoryFiles({repoId:connection.repositoryId,ref:String(listed.resolvedRef??ref),paths,encoding:'utf8',parseFrontmatter:false,allowProtected:true}):{files:[]};
		const commit=String((read as Record<string,unknown>).resolvedRef??listed.resolvedRef??ref);
		const entries=(read.files??[]).flatMap((file:unknown)=>{
			const row=record(file); const filePath=String(row.path??''); const source=String(row.content??'');
			const contract=collections.find(([,collection])=>filePath.includes(`/${collection}/`)); if(!contract||!source) return [];
			const validation=validateContentFrontmatter(contract[2],parseFrontmatterDocument(source).frontmatter);
			if(!validation.ok||!validation.data) return [];
			const value=validation.data as Record<string,unknown>;
			if(contract[0]==='agent') {
				const profiles=record(value.activityProfiles);
				return Object.entries(profiles).flatMap(([profileId,candidate])=>{
					const profile=record(candidate); if(profile.enabled!==true) return [];
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
		});
		return {commit,definitions:entries.filter((entry)=>entry.entryType==='definition'),tests:entries.filter((entry)=>entry.entryType==='test'),agentReferences:entries.filter((entry)=>entry.entryType==='agent-reference')};
	}

	private async source(projectId:string,ref:string,filePath:string) {
		const connection=await resolveKnowledgeGatewayConnection(this.store,{projectId,write:false,authoringPaths:true,readRefs:[ref]});
		if(!connection) throw new CapacityGovernanceError('context_query_treedx_unavailable','Project TreeDX content is unavailable.',409);
		const read=await connection.client.readRepositoryFiles({repoId:connection.repositoryId,ref,paths:[filePath],encoding:'utf8',parseFrontmatter:false,allowProtected:true});
		const file=Array.isArray(read.files)?record(read.files[0]):{};
		if(!String(file.content??'')) throw new CapacityGovernanceError('context_query_definition_missing',`Missing ${filePath}.`,404);
		return {connection,resolvedRef:String(read.resolvedRef??ref),frontmatter:parseFrontmatterDocument(String(file.content)).frontmatter};
	}

	async check(teamId:string,projectId:string,input:{testId:string;idempotencyKey:string;freshForSeconds?:number}) {
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
		const testSource=await this.source(projectId,`refs/heads/${initial.authoringBranch.replace(/^refs\/heads\//u,'')}`,path(initial.contentPath,COLLECTIONS.test,testId));
		const testValidation=validateContentFrontmatter('agent_test',testSource.frontmatter);
		if(!testValidation.ok||!['context-query','context-query-set'].includes(String(testValidation.data?.kind))) throw new CapacityGovernanceError('context_query_test_invalid','Context-query test definition is invalid.',422,{diagnostics:testValidation.diagnostics});
		const test=testValidation.data as ContextQueryTestDefinition&{kind:'context-query'|'context-query-set'};
		const exactRef=testSource.resolvedRef;
		// An isolated check is a control-plane mutation: it may rebuild TreeDX's derived
		// graph for the exact current ref, but it never writes or commits query results.
		const exactConnection=await resolveKnowledgeGatewayConnection(this.store,{projectId,write:true,authoringPaths:true,readRefs:[exactRef]});
		if(!exactConnection) throw new CapacityGovernanceError('context_query_treedx_unavailable','Project TreeDX content is unavailable.',409);
		const execute=async(request:Record<string,unknown>)=>executeCurrentContext(exactConnection,exactRef,request);
		let report:Record<string,unknown>; let definition:{kind:'query'|'query-set';id:string;revision:number;commit:string};
		if(test.kind==='context-query') {
			const querySource=await this.source(projectId,exactRef,path(initial.contentPath,COLLECTIONS.query,test.queryRef!.id));
			const validation=validateContentFrontmatter('agent_context_query',querySource.frontmatter);
			if(!validation.ok||!validation.data) throw new CapacityGovernanceError('context_query_definition_invalid','Context query definition is invalid.',422,{diagnostics:validation.diagnostics});
			report=await executeContextQueryTest({query:validation.data as DeclarativeContextQuery,test,execute}) as Record<string,unknown>;
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
			report=await executeContextQuerySetTest({querySet,queries,test,execute:async(_query,request)=>execute(request)}) as Record<string,unknown>;
			definition={kind:'query-set',id:test.querySetRef!.id,revision:test.querySetRef!.revision,commit:exactRef};
		}
		const checkedAt=String(report.checkedAt??new Date().toISOString()); const fresh=Math.min(604_800,Math.max(300,Number(input.freshForSeconds??DEFAULT_FRESH_SECONDS)));
		const expiresAt=new Date(Date.parse(checkedAt)+fresh*1000).toISOString(); const id=randomUUID(); const resultDigest=digest(report.result);
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
		for(const row of rows) {
			const testId=String(row.test_id);
			try {
				const checked=await this.check(String(row.team_id),String(row.project_id),{
					testId,idempotencyKey:`scheduled-context-query-check:${String(row.id)}`,
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
		const byTest=new Map<string,ReturnType<typeof rowCheck>&{readiness:ReturnType<typeof contextQueryReadiness>}>();
		for(const row of rows) {
			const check=rowCheck(row); if(!byTest.has(check.testId)) byTest.set(check.testId,{...check,readiness:contextQueryReadiness({check,definition:{...check.definition,commit:currentCommit},now})});
		}
		const catalog=await this.catalog(projectId,currentCommit);
		const blocked=references.flatMap((reference)=>{
			const tests=catalog.tests.filter((test)=>test.definitionKind===reference.kind&&test.definitionId===reference.id&&test.definitionRevision===reference.revision);
			const failed=tests.filter((test)=>byTest.get(test.id)?.readiness.selectable!==true);
			return tests.length>0&&failed.length===0?[]:[{...reference,readiness:{status:'unchecked',selectable:false,reason:tests.length?'required_tests_failed':'no_tests'},requiredTestIds:tests.map((test)=>test.id),failedTestIds:failed.map((test)=>test.id)}];
		});
		if(blocked.length) throw new CapacityGovernanceError('agent_context_query_not_ready','Every agent context query must have a fresh passing isolated check before workday admission.',409,{projectId,currentCommit,blocked});
		return references.flatMap((reference)=>catalog.tests.filter((test)=>test.definitionKind===reference.kind&&test.definitionId===reference.id&&test.definitionRevision===reference.revision).map((test)=>byTest.get(test.id)!));
	}
}

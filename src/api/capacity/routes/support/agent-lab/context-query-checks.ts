import type { Hono } from 'hono';
import { ContextQueryCheckService } from '../../../services/capacity/agents/context-query-check-service.ts';
import type { WorkdayRouteDependencies } from '../operator-workdays.ts';
import { readCapacityRequestObject } from '../request-json.ts';
import { contextQueryReadiness } from '../../../../knowledge/context-query-runtime.ts';
import { listUnpublishedTreeDxAuthoringState } from '../../../services/treedx/repositories/treedx-authoring-journal.ts';

function text(value:unknown) { return typeof value === 'string' ? value.trim() : ''; }

export function installContextQueryCheckRoutes(app:Hono,dependencies:WorkdayRouteDependencies) {
	app.post('/v1/teams/:teamId/projects/:projectId/context-query-checks',async(c)=>{
		const access=await dependencies.read(c); if(access.response) return access.response;
		try {
			const body=await readCapacityRequestObject(c); const key=text(body.idempotencyKey)||text(c.req.header('Idempotency-Key'));
			const checked=await new ContextQueryCheckService(dependencies.store).check(c.req.param('teamId'),c.req.param('projectId'),{
				testId:text(body.testId),idempotencyKey:key,freshForSeconds:Number(body.freshForSeconds)||undefined,
			});
			const payload=body.includeResult===true?checked:Object.fromEntries(Object.entries(checked).filter(([field])=>field!=='report'));
			return c.json({ok:true,payload},201);
		} catch(error) { return dependencies.operatorError(error); }
	});

	app.get('/v1/teams/:teamId/projects/:projectId/context-query-checks',async(c)=>{
		const access=await dependencies.read(c); if(access.response) return access.response;
		try {
			const teamId=c.req.param('teamId'); const projectId=c.req.param('projectId');
			const project=await dependencies.store.first('SELECT team_id FROM projects WHERE id = ? LIMIT 1',[projectId]);
			if(!project||String(project.team_id)!==teamId) return c.json({ok:false,code:'context_query_project_team_mismatch',error:'Project is not owned by the selected team.'},404);
			const service=new ContextQueryCheckService(dependencies.store);
			const commit=await service.definitionCommit(projectId);
			if(!commit) return c.json({ok:false,code:'context_query_treedx_unavailable',error:'Project TreeDX content is unavailable.'},409);
			const payload=await service.list(teamId,projectId,commit);
			const unpublishedAuthoring=(await listUnpublishedTreeDxAuthoringState(dependencies.store,projectId)).filter((state)=>{
				const paths=Array.isArray(state.changedPaths)?state.changedPaths.map(String):[];
				return paths.some((path)=>['agent-context-queries','agent-context-query-sets','agent-tests','agents']
					.some((collection)=>path.includes(`/${collection}/`)));
			});
			const checksByTest=new Map(payload.map((check)=>[check.testId,check]));
			const catalog=await service.catalog(projectId,commit);
			const requiredByFor=(kind:'query'|'query-set',id:string,revision:number)=>{
				const direct=catalog.agentReferences.filter((reference)=>reference.kind===kind&&reference.id===id&&reference.revision===revision);
				const throughSets=kind==='query'?catalog.agentReferences.filter((reference)=>reference.kind==='query-set').filter((reference)=>{
					const set=catalog.definitions.find((definition)=>definition.kind==='query-set'&&definition.id===reference.id&&definition.revision===reference.revision);
					return set?.queryRefs.some((query)=>String(query.id)===id&&Number(query.revision)===revision);
				}):[];
				return [...direct,...throughSets].map((reference)=>({agentId:reference.agentId,profileId:reference.profileId})).filter((reference,index,all)=>all.findIndex((other)=>other.agentId===reference.agentId&&other.profileId===reference.profileId)===index);
			};
			const tests=catalog.tests.map((test)=>{
				const check=checksByTest.get(test.id)??null;
				const definition={kind:test.definitionKind as 'query'|'query-set',id:test.definitionId,revision:test.definitionRevision,commit};
				const requiredBy=requiredByFor(definition.kind,test.definitionId,test.definitionRevision);
				return {...test,requiredBy,readiness:check?.readiness??contextQueryReadiness({check:null,definition}),latestCheck:check};
			});
			const definitions=catalog.definitions.map((definition)=>{
				const required=tests.filter((test)=>test.definitionKind===definition.kind&&test.definitionId===definition.id&&test.definitionRevision===definition.revision);
				const selectable=required.length>0&&required.every((test)=>test.readiness.selectable);
				const requiredBy=requiredByFor(definition.kind,definition.id,definition.revision);
				return {...definition,requiredBy,readiness:{status:selectable?'passing':'unchecked',selectable,reason:required.length?'all_tests_required':'no_tests'},tests:required.map((test)=>test.id)};
			});
			return c.json({ok:true,payload:{definitionCommit:commit,unpublishedAuthoring,items:payload,tests,selectableTests:tests.filter((test)=>test.readiness.selectable),definitions,selectableDefinitions:definitions.filter((definition)=>definition.readiness.selectable)}});
		} catch(error) { return dependencies.operatorError(error); }
	});
}

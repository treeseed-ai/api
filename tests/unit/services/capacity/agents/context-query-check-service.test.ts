import { describe,expect,it,vi } from 'vitest';
import { ContextQueryCheckService,executeCurrentContext } from '../../../../../src/api/capacity/services/capacity/agents/context-query-check-service.ts';

function row(overrides:Record<string,unknown>={}) {
	return {
		id:'check-a',idempotency_key:'key-a',team_id:'team-a',project_id:'project-a',test_id:'test-a',test_ref:'fixture:test-a',
		definition_kind:'query-set',definition_id:'set-a',definition_revision:2,definition_commit:'a'.repeat(40),status:'passing',
		checked_at:'2026-08-13T20:00:00.000Z',expires_at:'2026-08-14T20:00:00.000Z',latency_ms:100,
		stats_json:'{"itemCount":2}',assertions_json:'[]',result_digest:'digest-a',...overrides,
	};
}

describe('context query check service',()=>{
	it('refreshes the exact graph before accepting even a successful dynamic result',async()=>{
		const buildContext=vi.fn()
			.mockResolvedValueOnce({resolvedRef:'a'.repeat(40),items:[{path:'src/content/knowledge/guide.md'}]});
		const client={buildContext,refreshGraph:vi.fn(async()=>({jobId:'job-a'})),getGraphRefreshJob:vi.fn(async()=>({status:'completed'}))};
		const result=await executeCurrentContext({repositoryId:'repo-a',contentPath:'src/content',client} as never,'a'.repeat(40),{query:'guide'});
		expect(result).toMatchObject({resolvedRef:'a'.repeat(40)});
		expect(client.refreshGraph).toHaveBeenCalledWith(expect.objectContaining({repoId:'repo-a',ref:'a'.repeat(40),forceFull:true}));
		expect(client.refreshGraph.mock.invocationCallOrder[0]).toBeLessThan(buildContext.mock.invocationCallOrder[0]!);
		expect(buildContext).toHaveBeenCalledTimes(1);
	});

	it('replays a durable check without executing TreeDX again',async()=>{
		const store={first:vi.fn(async()=>row()),all:vi.fn(),run:vi.fn()};
		const result=await new ContextQueryCheckService(store as never).check('team-a','project-a',{testId:'test-a',idempotencyKey:'key-a'});
		expect(result).toMatchObject({id:'check-a',status:'passing',idempotentReplay:true});
		expect(store.run).not.toHaveBeenCalled();
	});

	it('projects only the latest exact check and marks it selectable when fresh',async()=>{
		const store={all:vi.fn(async()=>[row({id:'new',checked_at:'2026-08-13T21:00:00.000Z'}),row({id:'old',status:'failing'})])};
		const items=await new ContextQueryCheckService(store as never).list('team-a','project-a','a'.repeat(40),new Date('2026-08-14T00:00:00.000Z'));
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({id:'new',readiness:{status:'passing',selectable:true,reason:'fresh_passing_check'}});
	});

	it('preserves independently passing tests that target the same query revision',async()=>{
		const store={all:vi.fn(async()=>[row({id:'check-a',test_id:'test-a'}),row({id:'check-b',test_id:'test-b'})])};
		const items=await new ContextQueryCheckService(store as never).list('team-a','project-a','a'.repeat(40),new Date('2026-08-14T00:00:00.000Z'));
		expect(items.map((item)=>item.testId)).toEqual(['test-a','test-b']);
	});

	it('keeps an exact query revision ready when an unrelated repository commit advances',async()=>{
		const store={all:vi.fn(async()=>[row()])};
		const [item]=await new ContextQueryCheckService(store as never).list('team-a','project-a','b'.repeat(40),new Date('2026-08-14T00:00:00.000Z'));
		expect(item?.readiness).toEqual({status:'passing',selectable:true,reason:'fresh_passing_check'});
	});

	it('returns exact checked context only for a fresh passing definition',async()=>{
		const store={all:vi.fn(async()=>[row()])};
		const service=new ContextQueryCheckService(store as never);
		vi.spyOn(service,'catalog').mockResolvedValue({commit:'a'.repeat(40),definitions:[],tests:[{entryType:'test',id:'test-a',testRef:'fixture:test-a',kind:'context-query-set',definitionKind:'query-set',definitionId:'set-a',definitionRevision:2,path:'test.mdx',commit:'a'.repeat(40)}]});
		const [evidence]=await service.requirePassing('team-a','project-a','a'.repeat(40),[
			{kind:'query-set',id:'set-a',revision:2},
		],new Date('2026-08-14T00:00:00.000Z'));
		expect(evidence).toMatchObject({id:'check-a',readiness:{selectable:true}});
	});

	it('requires every isolated test attached to a referenced query revision',async()=>{
		const store={all:vi.fn(async()=>[row({test_id:'test-a'})])};
		const service=new ContextQueryCheckService(store as never);
		vi.spyOn(service,'catalog').mockResolvedValue({commit:'a'.repeat(40),definitions:[],tests:[
			{entryType:'test',id:'test-a',testRef:'a',kind:'context-query-set',definitionKind:'query-set',definitionId:'set-a',definitionRevision:2,path:'a.mdx',commit:'a'.repeat(40)},
			{entryType:'test',id:'test-b',testRef:'b',kind:'context-query-set',definitionKind:'query-set',definitionId:'set-a',definitionRevision:2,path:'b.mdx',commit:'a'.repeat(40)},
		]});
		await expect(service.requirePassing('team-a','project-a','a'.repeat(40),[{kind:'query-set',id:'set-a',revision:2}],new Date('2026-08-14T00:00:00.000Z')))
			.rejects.toMatchObject({code:'agent_context_query_not_ready',details:{blocked:[expect.objectContaining({failedTestIds:['test-b']})]}});
	});

	it('blocks assignment admission when an exact reference has never passed',async()=>{
		const store={all:vi.fn(async()=>[])};
		const service=new ContextQueryCheckService(store as never);
		vi.spyOn(service,'catalog').mockResolvedValue({commit:'a'.repeat(40),definitions:[],tests:[]});
		await expect(service.requirePassing('team-a','project-a','a'.repeat(40),[
			{kind:'query',id:'query-missing',revision:1},
		])).rejects.toMatchObject({code:'agent_context_query_not_ready',status:409});
	});

	it('rechecks only the latest expired test with deterministic maintenance authority',async()=>{
		const store={all:vi.fn(async()=>[row({id:'expired-check',expires_at:'2026-08-13T20:00:00.000Z'})])};
		const service=new ContextQueryCheckService(store as never);
		const check=vi.spyOn(service,'check').mockResolvedValue({status:'passing'} as never);
		const result=await service.recheckDue(new Date('2026-08-14T00:00:00.000Z'));
		expect(check).toHaveBeenCalledWith('team-a','project-a',{
			testId:'test-a',idempotencyKey:'scheduled-context-query-check:expired-check',
		});
		expect(result).toEqual({considered:1,passing:1,failing:0,failures:[]});
		expect(String(store.all.mock.calls[0]?.[0])).toContain('NOT EXISTS');
	});
});

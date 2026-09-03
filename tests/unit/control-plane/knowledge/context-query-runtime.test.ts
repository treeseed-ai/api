import { describe, expect, it } from 'vitest';
import { executeContextQuerySetTest,executeContextQueryTest } from '../../../../src/api/knowledge/runtime/context-query-runtime.ts';

describe('context query runtime', () => {
	it('evaluates the current wrapped TreeDX context-node shape', async () => {
		const report = await executeContextQueryTest({
			query: {
				id: 'guide-work', title: 'Guide work', description: 'Exact guide page.', revision: 1,
				maturity: 'draft', purpose: 'research', query: 'Guide work',
				target: { kind: 'content', models: ['knowledge'], paths: ['/knowledge/guide/work.md'] },
				relations: [], depth: 0, resultLimit: 1, contextBudget: { maxItems: 1 }, tokenBudget: 500,
				format: 'full', sources: [{ scope: 'current-project' }], requirement: 'required', priority: 100,
				filters: {}, summarization: 'none',
			},
			test: {
				queryRef: { id: 'guide-work', revision: 1 }, testRef: 'guide-work-v1',
				expectedIdentities: ['guide.work'], expectedRelations: [],
				expectedPaths: ['knowledge/guide/work.md'], expectedSchemaVersions: ['treeseed.knowledge-page/v1'],
				resultBounds: { min: 1, max: 1 }, budget: { maxContextItems: 1, maxTokens: 500 },
			},
			execute: async () => ({ nodes: [{ node: { id: 'file:1', path: 'knowledge/guide/work.md',
				data: { frontmatter: { id: 'guide.work', schemaVersion: 'treeseed.knowledge-page/v1' } } } }], edges: [] }),
		});

		expect(report.status).toBe('passing');
		expect(report.stats).toMatchObject({ itemCount: 1, identities: expect.arrayContaining(['guide.work']),
			paths: ['knowledge/guide/work.md'], schemaVersions: ['treeseed.knowledge-page/v1'] });
	});

	it('uses TreeDX token diagnostics when composing query-set budgets',async()=>{
		const query=(id:string,revision:number)=>({id,title:id,description:id,revision,maturity:'draft' as const,purpose:'research',query:id,
			target:{kind:'content' as const,paths:[`/knowledge/guide/${id}.md`]},relations:[],depth:0,resultLimit:1,
			contextBudget:{maxItems:1},tokenBudget:500,format:'full',sources:[{scope:'current-project' as const}],requirement:'required' as const,priority:100,filters:{},summarization:'none' as const});
		const queries=[query('one',1),query('two',1)];
		const report=await executeContextQuerySetTest({querySet:{id:'set',revision:1,queryRefs:queries.map(({id,revision})=>({id,revision})),mergePolicy:'append'},queries,
			test:{querySetRef:{id:'set',revision:1},testRef:'set-v1',expectedIdentities:[],expectedRelations:[],resultBounds:{min:2,max:2},budget:{maxContextItems:2,maxTokens:500}},
			execute:async(current)=>{const result={nodes:[{node:{id:current.id,path:`knowledge/guide/${current.id}.md`,data:{frontmatter:{id:current.id}}}}],edges:[],diagnostics:{budget:{estimatedTokens:200}}};
				return {nodes:result.nodes,edges:[],sources:[],memberResults:[result]};}});
		expect(report.status).toBe('passing');
		expect(report.stats).toMatchObject({reportedTokens:400,estimatedTokens:400});
	});
});

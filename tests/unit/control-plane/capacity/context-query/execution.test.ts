import { afterEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { ContextQueryCheckService } from '../../../../../src/api/capacity/services/capacity/agents/context-query-check-service.ts';
import { resolveKnowledgeGatewayConnection } from '../../../../../src/api/knowledge/gateway-treedx-connection.ts';

vi.mock('../../../../../src/api/knowledge/gateway-treedx-connection.ts', async original => ({
	...await original<object>(), resolveKnowledgeGatewayConnection: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());
const definitionRef = 'a'.repeat(40), dataRef = 'b'.repeat(40);

function fixture() {
	const query = { id: 'context-contract', title: 'Context contract', description: 'Prior context repair experience.',
		revision: 2, maturity: 'validated', purpose: 'implement', query: 'canonical context repair',
		target: { kind: 'content', models: ['knowledge'], paths: ['/knowledge/context-contract.mdx'] },
		depth: 0, relations: [], resultLimit: 5, contextBudget: { maxItems: 5 }, tokenBudget: 1000,
		sources: [{ scope: 'current-project' }], requirement: 'required', priority: 80, summarization: 'none' };
	const content = '---\nid: context-contract\nschemaVersion: treeseed.knowledge-page/v2\n---\nPrior repair findings.\n';
	const client = {
		refreshGraph: vi.fn().mockResolvedValue({ graph: { jobId: 'refresh' } }),
		getGraphRefreshJob: vi.fn().mockResolvedValue({ job: { status: 'completed' } }),
		buildContext: vi.fn().mockResolvedValue({ resolvedRef: dataRef, nodes: [{ node: { path: 'knowledge/context-contract.mdx' } }], edges: [] }),
		readRepositoryFiles: vi.fn(async (input: { ref: string; paths: string[] }) => ({ resolvedRef: input.ref,
			files: input.paths.map(path => ({ path, content: path.startsWith('agent-context-queries/')
				? `---\n${stringify(query)}---\n` : content, frontmatter: { id: 'context-contract', revision: 1 } })) })),
	};
	vi.mocked(resolveKnowledgeGatewayConnection).mockResolvedValue({ repositoryId: 'library', contentPath: '.',
		baseRef: dataRef, allowedPaths: ['knowledge/**', 'agent-context-queries/**'], client } as never);
	const service = new ContextQueryCheckService({} as never);
	const passing = vi.spyOn(service, 'requirePassing').mockResolvedValue([]);
	const input = { teamId: 'team', projectId: 'project', definitionRef, dataRef, allowedModels: ['knowledge'],
		layers: { agent: { queryRefs: [{ id: query.id, revision: 2 }], querySetRefs: [] },
			activity: { queryRefs: [], querySetRefs: [] } } };
	return { service, client, passing, query, content, input };
}

describe('canonical assignment query execution', () => {
	it('executes the exact configured definition against the frozen data and admits verified file references rather than old check paths', async () => {
		const f = fixture();
		const result = await f.service.resolveForAssignment(f.input);
		expect(f.passing).toHaveBeenCalled();
		expect(f.client.buildContext).toHaveBeenCalledWith(expect.objectContaining({ ref: dataRef, query: f.query.query }));
		expect(f.client.refreshGraph).toHaveBeenCalledWith(expect.objectContaining({ paths: ['knowledge/**', 'agent-context-queries/**'] }));
		expect(result.references).toEqual([expect.objectContaining({ store: 'treedx', model: 'knowledge',
			repository: 'library', commit: dataRef, path: 'knowledge/context-contract.mdx', id: 'context-contract' })]);
		expect(result.checks).toEqual([expect.objectContaining({ status: 'resolved', layer: 'agent',
			definition: { kind: 'query', id: f.query.id, revision: 2, commit: definitionRef } })]);
	});
	it('does not execute when the configured revision lacks passing evidence', async () => {
		const f = fixture(); f.passing.mockRejectedValue(new Error('required tests failed'));
		await expect(f.service.resolveForAssignment(f.input)).rejects.toThrow('required tests failed');
		expect(f.client.buildContext).not.toHaveBeenCalled();
	});
	it('rejects query results outside the activity read ceiling', async () => {
		const f = fixture();
		await expect(f.service.resolveForAssignment({ ...f.input, allowedModels: ['objective'] }))
			.rejects.toMatchObject({ code: 'assignment_context_query_permission_denied' });
	});
	it('retains an explicit failed preferred-query observation while required-query failure prevents admission', async () => {
		const f = fixture(); f.client.buildContext.mockRejectedValue(new Error('native query unavailable'));
		await expect(f.service.resolveForAssignment(f.input)).rejects.toThrow('native query unavailable');
		f.query.requirement = 'preferred';
		const result = await f.service.resolveForAssignment(f.input);
		expect(result.references).toEqual([]);
		expect(result.checks).toEqual([expect.objectContaining({ status: 'failed', layer: 'agent', requirement: 'preferred' })]);
	});
});

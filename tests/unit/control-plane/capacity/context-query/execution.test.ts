import { afterEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { createHash } from 'node:crypto';
import { canonicalStandardsJson } from '@treeseed/sdk/standards';
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
		buildContext: vi.fn().mockResolvedValue({ resolvedRef: dataRef, totalTokenEstimate: 6,
			nodes: [{ node: { id: 'section:context-contract', path: 'knowledge/context-contract.mdx', text: 'Prior repair findings.' },
				text: 'Prior repair findings.', tokenEstimate: 6, score: 1, provenance: { seedIds: ['section:context-contract'] } }], edges: [] }),
		readRepositoryFiles: vi.fn(async (input: { ref: string; paths: string[] }) => ({ resolvedRef: input.ref,
			files: input.paths.map(path => ({ path, content: path.startsWith('agent-context-queries/')
				? `---\n${stringify(query)}---\n` : content, frontmatter: { id: 'context-contract', revision: 1 } })) })),
	};
	vi.mocked(resolveKnowledgeGatewayConnection).mockResolvedValue({ repositoryId: 'library', contentPath: '.',
		baseRef: dataRef, allowedPaths: ['knowledge/**', 'agent-context-queries/**'], client } as never);
	const store = { listTreeDxSharesForRecipient: vi.fn().mockResolvedValue([]) };
	const service = new ContextQueryCheckService(store as never);
	const passing = vi.spyOn(service, 'requirePassing').mockResolvedValue([]);
	const input = { teamId: 'team', projectId: 'project', definitionRef, dataRef, allowedModels: ['knowledge'],
		layers: { agent: { queryRefs: [{ id: query.id, revision: 2 }], querySetRefs: [] },
			activity: { queryRefs: [], querySetRefs: [] } } };
	return { service, client, passing, query, content, input, store };
}

describe('canonical assignment query execution', () => {
	it('executes the exact configured definition against frozen data and retains bounded native text rather than expanding entire files', async () => {
		const f = fixture();
		const result = await f.service.resolveForAssignment(f.input);
		expect(f.passing).toHaveBeenCalled();
		expect(f.client.buildContext).toHaveBeenCalledWith(expect.objectContaining({ ref: dataRef, query: f.query.query }));
		expect(f.client.refreshGraph).toHaveBeenCalledWith(expect.objectContaining({ paths: ['knowledge/**', 'agent-context-queries/**'] }));
		expect(result.references).toEqual([expect.objectContaining({ store: 'treedx', model: 'knowledge',
			repository: 'library', commit: dataRef, path: 'knowledge/context-contract.mdx', anchor: 'section:context-contract' })]);
		expect(result.authorizedContext).toHaveLength(1);
		const item = result.authorizedContext[0]!;
		expect(item.value).toMatchObject({ entry: { text: 'Prior repair findings.', tokenEstimate: 6 } });
		expect(item.digest).toBe(`sha256:${createHash('sha256').update(canonicalStandardsJson(item.value)).digest('hex')}`);
		expect(item.ref.digest).toBe(item.digest);
		expect(f.client.readRepositoryFiles.mock.calls.every(([input]) => input.paths.every(path => path.startsWith('agent-context-queries/')))).toBe(true);
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
		expect(result.authorizedContext).toEqual([]);
		expect(result.checks).toEqual([expect.objectContaining({ status: 'failed', layer: 'agent', requirement: 'preferred' })]);
	});
	it.each(['definitionRef', 'dataRef'] as const)('rejects a moving %s before readiness or query execution', async field => {
		const f = fixture();
		await expect(f.service.resolveForAssignment({ ...f.input, [field]: 'staging' })).rejects.toMatchObject({ code: 'context_query_reference_invalid' });
		expect(f.passing).not.toHaveBeenCalled();
	});
	it.each(['../private.mdx', '/knowledge/context-contract.mdx', 'private/context-contract.mdx'])('rejects unsafe or out-of-scope native result %s', async path => {
		const f = fixture();
		f.client.buildContext.mockResolvedValue({ resolvedRef: dataRef, totalTokenEstimate: 1,
			nodes: [{ node: { id: 'section', path, text: 'x' }, text: 'x', tokenEstimate: 1 }], edges: [] } as never);
		await expect(f.service.resolveForAssignment(f.input)).rejects.toMatchObject({ code: 'assignment_context_query_permission_denied' });
	});
	it('rejects a native result exceeding the configured budget rather than publishing an oversized assignment context', async () => {
		const f = fixture(); f.query.tokenBudget = 5;
		await expect(f.service.resolveForAssignment(f.input)).rejects.toMatchObject({ code: 'context_query_budget_exceeded' });
	});
	it('executes a duplicate global/activity query once while retaining both layer observations', async () => {
		const f = fixture(); f.input.layers.activity.queryRefs = [...f.input.layers.agent.queryRefs];
		const result = await f.service.resolveForAssignment(f.input);
		expect(f.client.buildContext).toHaveBeenCalledTimes(1);
		expect(result.authorizedContext).toHaveLength(1);
		expect(result.checks.map(check => check.layer)).toEqual(['agent', 'activity']);
	});
	it('preserves the original share path ceiling when query patterns would broaden a one-level share', async () => {
		const f = fixture();
		f.query.sources = [{ scope: 'shared-team', teamId: 'owner', projectIds: ['foreign'] }] as never;
		f.query.target.paths = ['/knowledge/**'];
		f.store.listTreeDxSharesForRecipient.mockResolvedValue([{ teamId: 'owner', status: 'active', trustGrant: {
			operations: ['context'], projectIds: ['foreign'], paths: ['knowledge/*'], contentModels: ['knowledge'] } }]);
		f.client.buildContext.mockResolvedValue({ resolvedRef: dataRef, totalTokenEstimate: 1,
			nodes: [{ node: { id: 'section', path: 'knowledge/private/secret.mdx', text: 'x' }, text: 'x', tokenEstimate: 1 }], edges: [] } as never);
		await expect(f.service.resolveForAssignment(f.input)).rejects.toMatchObject({ code: 'assignment_context_query_permission_denied' });
	});
	it('accepts a normal directory query under an equivalent active share ceiling', async () => {
		const f = fixture(); f.query.sources = [{ scope: 'shared-team', teamId: 'owner', projectIds: ['foreign'] }] as never;
		f.query.target.paths = ['/knowledge/**'];
		f.store.listTreeDxSharesForRecipient.mockResolvedValue([{ teamId: 'owner', status: 'active', trustGrant: {
			operations: ['context'], projectIds: ['foreign'], paths: ['knowledge/**'], contentModels: ['knowledge'] } }]);
		const result = await f.service.resolveForAssignment(f.input);
		expect(result.authorizedContext).toHaveLength(1);
		expect(result.authorizedContext[0]!.value).toMatchObject({ projectId: 'foreign' });
	});
	it('applies a replacing query set only to its own layer without rerunning shared members or losing global context', async () => {
		const f = fixture(), other = { ...f.query, id: 'activity-context' };
		const set = { id: 'focused-context', title: 'Focused context', description: 'Replace optional activity context.',
			revision: 1, mergePolicy: 'replace', queryRefs: [{ id: f.query.id, revision: f.query.revision }] };
		f.client.readRepositoryFiles.mockImplementation(async input => ({ resolvedRef: input.ref, files: input.paths.map(path => ({ path,
			content: `---\n${stringify(path.startsWith('agent-context-query-sets/') ? set : path.endsWith('activity-context.mdx') ? other : f.query)}---\n`, frontmatter: {} })) }));
		const input: Parameters<typeof f.service.resolveForAssignment>[0] = { ...f.input, layers: { agent: f.input.layers.agent,
			activity: { queryRefs: [{ id: other.id, revision: other.revision }], querySetRefs: [{ id: set.id, revision: set.revision }] } } };
		const result = await f.service.resolveForAssignment(input);
		expect(f.client.buildContext).toHaveBeenCalledTimes(2);
		expect(result.authorizedContext).toHaveLength(1);
		expect(result.authorizedContext[0]!.value).toMatchObject({ definition: { id: f.query.id } });
		expect(result.checks[2]).toMatchObject({ layer: 'activity', querySet: { id: set.id, revision: 1, mergePolicy: 'replace' } });
	});
});

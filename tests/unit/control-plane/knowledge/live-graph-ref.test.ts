import { beforeEach, expect, it, vi } from 'vitest';
import { loadFederatedKnowledgeCatalog, relatedFederatedKnowledge, searchFederatedKnowledgeCatalog } from '../../../../src/api/knowledge/federated-catalog.ts';
import { resolveKnowledgeGatewayConnection } from '../../../../src/api/knowledge/gateway-treedx-connection.ts';
import { listKnowledgeContentPaths } from '../../../../src/api/knowledge/read-model/repository-paths.ts';

vi.mock('../../../../src/api/knowledge/gateway-treedx-connection.ts', async original => ({
	...await original<any>(), resolveKnowledgeGatewayConnection: vi.fn(),
}));
vi.mock('../../../../src/api/knowledge/read-model/repository-paths.ts', () => ({ listKnowledgeContentPaths: vi.fn() }));
vi.mock('../../../../src/api/knowledge/runtime/catalog.ts', async original => ({ ...await original<any>(),
	parseBook: () => ({ id: 'guide', slug: 'guide' }),
	parseKnowledgePage: () => ({ id: 'help', bookId: 'guide', slug: 'help' }),
}));
const commit = 'a'.repeat(40), ref = 'refs/heads/staging';
const client = {
	readRepositoryFiles: vi.fn(async ({ paths }: any) => ({ resolvedRef: commit, files: paths.map((path: string) => ({ path, content: 'document', frontmatter: {} })) })),
	queryGraph: vi.fn(async () => ({ resolvedRef: commit, graph: { nodes: [] } })),
	searchGraphSections: vi.fn(async () => []),
};
const context = { options: { environment: 'local', knowledgePublicationStorage: { readCurrent: async () => null } },
	store: { listPublicProjects: async () => [{ id: 'admin', teamId: 'team' }], getTeam: async () => ({ slug: 'team' }) } };
beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(resolveKnowledgeGatewayConnection).mockResolvedValue({ client, repositoryId: 'repo', baseRef: ref, contentPath: '.' } as any);
	vi.mocked(listKnowledgeContentPaths).mockResolvedValue({ resolvedRef: commit, entries: [{ path: 'books/guide.md' }, { path: 'knowledge/guide/help.md' }] } as any);
	client.queryGraph.mockResolvedValue({ resolvedRef: commit, graph: { nodes: [] } });
});
it('keeps live graph queries on their indexed ref while pinning content to its commit', async () => {
	const catalog = await loadFederatedKnowledgeCatalog(context, { get: () => null });
	expect(catalog.pages[0].source).toMatchObject({ graphRef: ref, commitSha: commit });
	await relatedFederatedKnowledge(context, catalog, catalog.pages[0]);
	await searchFederatedKnowledgeCatalog(context, catalog, 'help');
	expect(client.queryGraph).toHaveBeenCalledWith(expect.objectContaining({ ref,
		seeds: [{ id: 'page', kind: 'path', value: 'knowledge/guide/help.md' }] }));
	expect(client.searchGraphSections).toHaveBeenCalledWith(expect.objectContaining({ ref }));
});
it('rejects relationships and search if the indexed ref no longer matches loaded content', async () => {
	const catalog = await loadFederatedKnowledgeCatalog(context, { get: () => null });
	client.queryGraph.mockResolvedValue({ resolvedRef: 'b'.repeat(40), graph: { nodes: [] } });
	await expect(relatedFederatedKnowledge(context, catalog, catalog.pages[0])).rejects.toThrow('source changed');
	vi.mocked(listKnowledgeContentPaths).mockResolvedValue({ resolvedRef: 'b'.repeat(40), entries: [] } as any);
	await expect(searchFederatedKnowledgeCatalog(context, catalog, 'help')).rejects.toThrow('source changed');
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveConnection = vi.fn();
vi.mock('../../../src/api/knowledge/gateway-treedx-connection.ts', () => ({
	resolveKnowledgeGatewayConnection: resolveConnection,
}));

const book = `---
schemaVersion: treeseed.book/v2
id: book.one
slug: book-one
title: Book one
summary: Exact source book.
description: Exact source book.
status: published
visibility: public
order: 1
topics: [exact]
audience: [readers]
relatedBookIds: []
packPolicy: allowed
---
Book overview.
`;

const page = `---
schemaVersion: treeseed.knowledge-page/v1
id: page.one
bookId: book.one
slug: start
title: Start
summary: Exact source page.
status: published
visibility: public
order: 1
relatedKnowledgeIds: []
---
# Start
`;

describe('federated catalog exact source closure', () => {
	beforeEach(() => resolveConnection.mockReset());

	it('pins document reads and graph search to the resolved repository commit', async () => {
		const readRefs: string[] = [];
		const searchRefs: string[] = [];
		const relatedRefs: string[] = [];
		const client = {
			async listRepositoryPaths() {
				return { resolvedRef: 'commit-exact', entries: [
					{ path: 'docs/src/content/books/book.md' },
					{ path: 'docs/src/content/knowledge/start.md' },
				] };
			},
			async readRepositoryFiles(input: any) {
				readRefs.push(input.ref);
				return { resolvedRef: input.ref, files: input.paths.map((path: string) => ({
					path, content: path.includes('/books/') ? book : page, frontmatter: { id: 'parsed-by-treedx' },
				})) };
			},
			async searchGraphSections(input: any) {
				searchRefs.push(input.ref);
				return [{ score: 1, node: { id: 'page.one' } }];
			},
			async getRelated(input: any) {
				relatedRefs.push(input.ref);
				return { resolvedRef: input.ref, graph: { nodes: [{ id: 'page.one' }] } };
			},
		};
		resolveConnection.mockResolvedValue({ client, repositoryId: 'repo-one', baseRef: 'staging',
			contentPath: 'docs/src/content' });
		const context = { store: {
			async listPublicProjects() { return [{ id: 'project-one', teamId: 'team-one' }]; },
			async getTeam() { return { slug: 'team-one' }; },
		} };
		const request = { get() { return null; } };
		const { loadFederatedKnowledgeCatalog, relatedFederatedKnowledge, searchFederatedKnowledgeCatalog } = await import(
			'../../../src/api/knowledge/federated-catalog.ts'
		);
		const catalog = await loadFederatedKnowledgeCatalog(context, request);
		expect(resolveConnection).toHaveBeenCalledWith(context.store, expect.objectContaining({
			projectId: 'project-one', readRefs: ['commit-exact'],
		}));
		expect(readRefs).toEqual(['commit-exact', 'commit-exact']);
		expect(client.readRepositoryFiles).toBeDefined();
		expect(catalog.pages[0]?.source.commitSha).toBe('commit-exact');
		await searchFederatedKnowledgeCatalog(context, catalog, 'start');
		expect(searchRefs).toEqual(['commit-exact']);
		await relatedFederatedKnowledge(context, catalog, catalog.pages[0]!);
		expect(relatedRefs).toEqual(['commit-exact']);
		expect(resolveConnection).toHaveBeenLastCalledWith(context.store, expect.objectContaining({
			projectId: 'project-one', readRefs: ['commit-exact'],
		}));
	});
});

import { describe, expect, it, vi } from 'vitest';
import { listKnowledgeContentPaths } from '../../../../src/api/knowledge/read-model/repository-paths.ts';

describe('knowledge repository path pagination', () => {
	it('collects every TreeDX page while pinning the resolved commit', async () => {
		const listRepositoryPaths = vi.fn()
			.mockResolvedValueOnce({ resolvedRef: 'commit-a', entries: [{ path: 'content/books/a.md' }],
				page: { hasMore: true, nextCursor: 'next' } })
			.mockResolvedValueOnce({ resolvedRef: 'commit-a', entries: [{ path: 'content/knowledge/a.md' }],
				page: { hasMore: false } });
		const result = await listKnowledgeContentPaths({ repositoryId: 'repo-a', baseRef: 'main', contentPath: 'content',
			client: { listRepositoryPaths } });
		expect(result).toEqual({ resolvedRef: 'commit-a', entries: [
			{ path: 'content/books/a.md' }, { path: 'content/knowledge/a.md' },
		] });
		expect(listRepositoryPaths).toHaveBeenNthCalledWith(2, expect.objectContaining({
			ref: 'commit-a', cursor: 'next', limit: 500,
		}));
	});

	it('rejects a commit change between pages', async () => {
		const client = { listRepositoryPaths: vi.fn()
			.mockResolvedValueOnce({ resolvedRef: 'commit-a', entries: [], page: { hasMore: true, nextCursor: 'next' } })
			.mockResolvedValueOnce({ resolvedRef: 'commit-b', entries: [], page: { hasMore: false } }) };
		await expect(listKnowledgeContentPaths({ repositoryId: 'repo-a', baseRef: 'main', contentPath: 'content', client }))
			.rejects.toThrow(/source changed/u);
	});

	it('rejects cursor cycles instead of issuing thousands of duplicate reads', async () => {
		const client = { listRepositoryPaths: vi.fn()
			.mockResolvedValueOnce({ resolvedRef: 'commit-a', entries: [], page: { hasMore: true, nextCursor: 'a' } })
			.mockResolvedValueOnce({ resolvedRef: 'commit-a', entries: [], page: { hasMore: true, nextCursor: 'b' } })
			.mockResolvedValueOnce({ resolvedRef: 'commit-a', entries: [], page: { hasMore: true, nextCursor: 'a' } }) };
		await expect(listKnowledgeContentPaths({ repositoryId: 'repo-a', baseRef: 'main', contentPath: 'content', client }))
			.rejects.toThrow(/invalid knowledge path cursor/u);
		expect(client.listRepositoryPaths).toHaveBeenCalledTimes(3);
	});
});

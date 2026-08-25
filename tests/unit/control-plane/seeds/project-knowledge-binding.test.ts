import { describe, expect, it } from 'vitest';
import { ensureProjectKnowledgeBinding } from '../../../../src/control-plane/seeds/apply-support/projects/projects-core/project-knowledge-binding.ts';

describe('seed TreeDX knowledge binding', () => {
	it('creates and binds a missing deterministic project repository', async () => {
		const calls: Array<{ method: string; path: string; body?: unknown }> = [];
		const bindings: unknown[] = [];
		const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
			const body = init?.body ? JSON.parse(String(init.body)) : undefined;
			calls.push({ method, path: url.pathname, body });
			if (method === 'GET' && url.pathname === '/api/v1/repos') return Response.json({ ok: true, repos: [] });
			if (method === 'POST' && url.pathname === '/api/v1/repos') {
				return Response.json({ ok: true, repo: { repoId: 'repo-platform', repositoryName: 'treeseed-platform', defaultRef: 'refs/heads/main' } });
			}
			if (method === 'POST' && url.pathname === '/api/v1/repos/repo-platform/sync') return Response.json({ ok: true, sync: {} });
			if (method === 'GET' && url.pathname === '/api/v1/repos/repo-platform/refs') return Response.json({ ok: true, refs: [
				{ name: 'refs/remotes/origin/main', kind: 'remote', sha: '1'.repeat(40) },
				{ name: 'refs/remotes/origin/staging', kind: 'remote', sha: '2'.repeat(40) },
			] });
			if (method === 'POST' && url.pathname === '/api/v1/repos/repo-platform/graph/refresh') return Response.json({ ok: true, graph: { status: 'completed', graphVersion: 'graph-1' } });
			if (method === 'POST' && url.pathname === '/api/v1/repos/repo-platform/search/index/refresh') return Response.json({ ok: true, index: { status: 'ready', indexVersion: 'index-1' } });
			if (method === 'GET' && url.pathname === '/api/v1/repos/repo-platform/search/index/status') return Response.json({ ok: true, index: { ready: true, segmentCount: 1 } });
			if (method === 'POST' && url.pathname === '/api/v1/repos/repo-platform/paths/list') {
				if ((body as { paths?: string[] }).paths?.[0] === 'agents/**') return Response.json({ ok: true, query: { resolvedRef: '2'.repeat(40), results: [] } });
				return Response.json({ ok: true, query: { resolvedRef: '2'.repeat(40), results: [{ path: 'documentation/README.mdx' }] } });
			}
			throw new Error(`Unexpected fake TreeDX request: ${method} ${url.pathname}`);
		};
		const store = {
			config: { fetchImpl },
			async getProjectTreeDxLibrary() { return null; },
			async upsertTeamTreeDx(_teamId: string, value: unknown) { bindings.push(value); },
			async upsertProjectTreeDxLibrary(_projectId: string, value: unknown) { bindings.push(value); },
		};

		await expect(ensureProjectKnowledgeBinding({
			store, projectId: 'project-platform', teamId: 'team-treeseed', projectSlug: 'platform',
			libraryRoot: '.', libraryRepositoryUrl: 'https://github.com/treeseed-ai/platform-library.git', libraryRef: 'refs/remotes/origin/staging',
			env: { NODE_ENV: 'test', TREESEED_TREEDX_URL: 'http://127.0.0.1:4000' }, dependencyState: {},
		})).resolves.toEqual({ kind: 'projectKnowledgeBinding', projectId: 'project-platform', repositoryId: 'repo-platform', agents: { count: 0, immutableRef: '2'.repeat(40) } });
			expect(calls).toEqual([
			{ method: 'GET', path: '/api/v1/repos', body: undefined },
			{ method: 'POST', path: '/api/v1/repos', body: { repositoryName: 'treeseed-platform', defaultRef: 'refs/heads/main' } },
			{ method: 'POST', path: '/api/v1/repos/repo-platform/sync', body: { remoteName: 'origin', remoteUrl: 'https://github.com/treeseed-ai/platform-library.git', refspecs: [
				'+refs/heads/main:refs/remotes/origin/main', '+refs/heads/staging:refs/remotes/origin/staging',
			] } },
			{ method: 'GET', path: '/api/v1/repos/repo-platform/refs', body: undefined },
			{ method: 'POST', path: '/api/v1/repos/repo-platform/graph/refresh', body: { ref: 'refs/remotes/origin/staging', paths: ['**'], forceFull: true } },
			{ method: 'POST', path: '/api/v1/repos/repo-platform/search/index/refresh', body: { ref: 'refs/remotes/origin/staging', paths: ['**'], incremental: false } },
			{ method: 'GET', path: '/api/v1/repos/repo-platform/search/index/status', body: undefined },
			{ method: 'POST', path: '/api/v1/repos/repo-platform/paths/list', body: { ref: 'refs/remotes/origin/staging', paths: ['**'], kinds: ['blob'], limit: 1, allowProtected: true } },
			{ method: 'POST', path: '/api/v1/repos/repo-platform/paths/list', body: { ref: 'refs/remotes/origin/staging', paths: ['agents/**'], extensions: ['.md', '.mdx', '.yaml', '.yml'], kinds: ['blob'], limit: 500, allowProtected: true } },
		]);
		expect(bindings).toHaveLength(2);
		expect(bindings[1]).toMatchObject({ repositoryId: 'repo-platform', contentPath: '.', contentRepositoryUrl: 'https://github.com/treeseed-ai/platform-library.git', contentRepositoryRef: 'refs/remotes/origin/staging' });
	});

	it('rejects a malformed TreeDX repository catalog instead of guessing its shape', async () => {
		const store = {
			config: { fetchImpl: async () => Response.json([]) },
		};
		await expect(ensureProjectKnowledgeBinding({
			store, projectId: 'project-platform', teamId: 'team-treeseed', projectSlug: 'platform',
			libraryRepositoryUrl: 'https://github.com/treeseed-ai/platform-library.git',
			env: { NODE_ENV: 'test', TREESEED_TREEDX_URL: 'http://127.0.0.1:4000' }, dependencyState: {},
		})).rejects.toThrow('TreeDX repository catalog response is invalid.');
	});
});

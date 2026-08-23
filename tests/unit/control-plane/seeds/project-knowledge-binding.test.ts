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
			if (method === 'GET' && url.pathname === '/api/v1/repos') return Response.json([]);
			if (method === 'POST' && url.pathname === '/api/v1/repos') {
				return Response.json({ ok: true, repo: { repoId: 'repo-platform', repositoryName: 'treeseed-platform', defaultRef: 'refs/heads/main' } });
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
			env: { NODE_ENV: 'test', TREESEED_TREEDX_URL: 'http://127.0.0.1:4000' }, dependencyState: {},
		})).resolves.toEqual({ kind: 'projectKnowledgeBinding', projectId: 'project-platform', repositoryId: 'repo-platform' });
		expect(calls).toEqual([
			{ method: 'GET', path: '/api/v1/repos', body: undefined },
			{ method: 'POST', path: '/api/v1/repos', body: { repositoryName: 'treeseed-platform', defaultRef: 'refs/heads/main' } },
		]);
		expect(bindings).toHaveLength(2);
	});
});

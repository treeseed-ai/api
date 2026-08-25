import { describe, expect, it } from 'vitest';
import { ensureProjectSeedDependencies } from '../../../../src/control-plane/seeds/apply-support/projects/projects-core/project-dependencies.ts';

describe('project library reconciliation', () => {
	it('preserves historical records and reconciles the declared library role', async () => {
		const upserts: Record<string, unknown>[] = [];
		const fetchImpl = async (input: string | URL | Request) => {
			const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
			if (path === '/repos/fixture/knowledge-library') return Response.json({ id: 42, name: 'knowledge-library', owner: { login: 'fixture' }, private: false });
			if (path.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: '1'.repeat(40) } });
			if (path.endsWith('/git/ref/heads/staging')) return Response.json({ object: { sha: '2'.repeat(40) } });
			return new Response(null, { status: 404 });
		};
		const store = {
			config: { fetchImpl },
			async listHubRepositories() {
				return [{ role: 'content' }, { role: 'primary' }];
			},
			async upsertHubRepository(_projectId: string, input: Record<string, unknown>) { upserts.push(input); return input; },
		};
		const repairs = await ensureProjectSeedDependencies({
			action: {
				kind: 'project', key: 'project:fixture/knowledge', existing: null,
				payload: { teamKey: 'team:fixture', slug: 'knowledge', repository: null, library: { role: 'library', provider: 'github', owner: 'fixture', name: 'knowledge-library', gitUrl: 'https://github.com/fixture/knowledge-library.git', defaultBranch: 'main', repositoryPolicy: { visibility: 'public', stagingBranch: 'staging' } }, metadata: {} },
			},
			store,
			ids: { projects: new Map([['project:fixture/knowledge', 'project-1']]), teams: new Map([['team:fixture', 'team-1']]) },
			manifestHash: 'sha256:fixture', appliedAt: '2026-08-23T00:00:00.000Z', env: {}, localOnly: false,
			dependencyState: {}, plan: { actions: [] },
		});
		expect(upserts).toHaveLength(1);
		expect(upserts[0]).toMatchObject({ role: 'library', name: 'knowledge-library', url: 'https://github.com/fixture/knowledge-library.git' });
		expect(repairs).toContainEqual({ kind: 'hubRepository', projectId: 'project-1', role: 'library' });
		expect(repairs).toContainEqual({ kind: 'libraryProvider', projectId: 'project-1', repository: 'fixture/knowledge-library', heads: { main: '1'.repeat(40), staging: '2'.repeat(40) } });
	});
});

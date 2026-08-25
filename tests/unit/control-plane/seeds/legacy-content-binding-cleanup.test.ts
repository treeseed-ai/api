import { describe, expect, it } from 'vitest';
import { ensureProjectSeedDependencies } from '../../../../src/control-plane/seeds/apply-support/projects/projects-core/project-dependencies.ts';

describe('project library reconciliation', () => {
	it('preserves historical records and reconciles the declared library role', async () => {
		const upserts: Record<string, unknown>[] = [];
		const store = {
			async listHubRepositories() {
				return [{ role: 'content' }, { role: 'primary' }];
			},
			async upsertHubRepository(_projectId: string, input: Record<string, unknown>) { upserts.push(input); return input; },
		};
		const repairs = await ensureProjectSeedDependencies({
			action: {
				kind: 'project', key: 'project:fixture/knowledge', existing: null,
				payload: { teamKey: 'team:fixture', slug: 'knowledge', repository: null, library: { role: 'library', provider: 'github', owner: 'fixture', name: 'knowledge-library', gitUrl: 'https://github.com/fixture/knowledge-library.git', defaultBranch: 'main', repositoryPolicy: { stagingBranch: 'staging' } }, metadata: {} },
			},
			store,
			ids: { projects: new Map([['project:fixture/knowledge', 'project-1']]), teams: new Map([['team:fixture', 'team-1']]) },
			manifestHash: 'sha256:fixture', appliedAt: '2026-08-23T00:00:00.000Z', env: {}, localOnly: false,
			dependencyState: {}, plan: { actions: [] },
		});
		expect(upserts).toHaveLength(1);
		expect(upserts[0]).toMatchObject({ role: 'library', name: 'knowledge-library', url: 'https://github.com/fixture/knowledge-library.git' });
		expect(repairs).toContainEqual({ kind: 'hubRepository', projectId: 'project-1', role: 'library' });
	});
});

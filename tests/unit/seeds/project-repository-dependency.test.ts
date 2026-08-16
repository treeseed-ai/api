import { describe, expect, it, vi } from 'vitest';
import { ensureProjectSeedDependencies } from '../../../src/market/seeds/apply-support/projects/projects-core/project-dependencies.ts';

describe('project seed repository dependency', () => {
	it('repairs an existing primary repository onto the declared staging branch', async () => {
		const upsertHubRepository = vi.fn();
		const store = {
			listHubRepositories: vi.fn(async () => [{
				id: 'repository-a', role: 'primary', provider: 'github', owner: 'treeseed-ai', name: 'api',
				url: 'https://github.com/treeseed-ai/api.git', defaultBranch: 'main', currentBranch: 'main',
				status: 'active', submodulePath: 'packages/api',
			}]),
			upsertHubRepository,
		};
		const action = {
			kind: 'project', key: 'project:treeseed/api', existing: { id: 'project-a', metadata: {} },
			payload: {
				teamKey: 'team:treeseed', slug: 'api', metadata: {}, repository: {
					role: 'primary', provider: 'github', owner: 'treeseed-ai', name: 'api',
					gitUrl: 'https://github.com/treeseed-ai/api.git', defaultBranch: 'main', submodulePath: 'packages/api',
					repositoryPolicy: { stagingBranch: 'staging' },
				},
			},
		};

		const repairs = await ensureProjectSeedDependencies({ action, store, ids: {
			projects: new Map([['project:treeseed/api', 'project-a']]), teams: new Map([['team:treeseed', 'team-a']]),
		}, manifestHash: 'hash-a', appliedAt: '2026-08-11T00:00:00.000Z', env: {}, localOnly: false, dependencyState: {} });

		expect(upsertHubRepository).toHaveBeenCalledWith('project-a', expect.objectContaining({ id: 'repository-a', currentBranch: 'staging' }));
		expect(repairs).toEqual([{ kind: 'hubRepository', projectId: 'project-a', role: 'primary' }]);
	});
});

import { describe, expect, it, vi } from 'vitest';
import { ensureProjectKnowledgeBinding } from '../../../../src/market/seeds/apply-support/projects/projects-core/project-knowledge-binding.ts';

describe('project knowledge binding reconciliation', () => {
	it('preserves an explicitly selected publication ref across local seed reconciliation', async () => {
		const upsertProjectTreeDxLibrary = vi.fn(async () => ({}));
		const store = {
			getProjectTreeDxLibrary: vi.fn(async () => ({
				contentRepositoryDefaultBranch: 'refs/heads/main',
				contentRepositoryRef: 'refs/heads/staging',
			})),
			upsertTeamTreeDx: vi.fn(async () => ({})),
			upsertProjectTreeDxLibrary,
		};
		await ensureProjectKnowledgeBinding({
			store,
			projectId: 'project-a',
			teamId: 'team-a',
			projectSlug: 'market',
			dependencyState: {
				repositoryCatalog: Promise.resolve([{
					name: 'treeseed-market',
					repoId: 'repo-a',
					defaultRef: 'refs/heads/main',
				}]),
			},
		});
		expect(upsertProjectTreeDxLibrary).toHaveBeenCalledWith('project-a', expect.objectContaining({
			contentRepositoryDefaultBranch: 'refs/heads/main',
			contentRepositoryRef: 'refs/heads/staging',
		}));
	});

	it('replaces a stale content repository URL with the seed-owned repository', async () => {
		const upsertProjectTreeDxLibrary = vi.fn(async () => ({}));
		const store = {
			getProjectTreeDxLibrary: vi.fn(async () => ({
				contentRepositoryUrl: 'https://github.com/knowledge-coop/market.git',
				contentRepositoryDefaultBranch: 'main',
				contentRepositoryRef: 'refs/heads/staging',
			})),
			upsertTeamTreeDx: vi.fn(async () => ({})),
			upsertProjectTreeDxLibrary,
		};
		await ensureProjectKnowledgeBinding({
			store,
			projectId: 'project-market',
			teamId: 'team-a',
			projectSlug: 'market',
			contentRepositoryUrl: 'https://github.com/treeseed-ai/market-content.git',
			contentRepositoryDefaultBranch: 'main',
			dependencyState: { repositoryCatalog: Promise.resolve([{
				name: 'treeseed-market', repoId: 'repo-market', defaultRef: 'refs/heads/main',
			}]) },
		});
		expect(upsertProjectTreeDxLibrary).toHaveBeenCalledWith('project-market', expect.objectContaining({
			contentRepositoryUrl: 'https://github.com/treeseed-ai/market-content.git',
			contentRepositoryDefaultBranch: 'main',
		}));
	});
});

import { describe, expect, it, vi } from 'vitest';
import { ensureProjectKnowledgeBinding } from '../../../../src/control-plane/seeds/apply-support/projects/projects-core/project-knowledge-binding.ts';

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
			projectSlug: 'api',
			dependencyState: {
				repositoryCatalog: Promise.resolve([{
					name: 'treeseed-api',
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
				contentRepositoryUrl: 'https://github.com/knowledge-coop/api.git',
				contentRepositoryDefaultBranch: 'main',
				contentRepositoryRef: 'refs/heads/staging',
			})),
			upsertTeamTreeDx: vi.fn(async () => ({})),
			upsertProjectTreeDxLibrary,
		};
		await ensureProjectKnowledgeBinding({
			store,
			projectId: 'project-api',
			teamId: 'team-a',
			projectSlug: 'api',
			contentRepositoryUrl: 'https://github.com/treeseed-ai/api-content.git',
			contentRepositoryDefaultBranch: 'main',
			dependencyState: { repositoryCatalog: Promise.resolve([{
				name: 'treeseed-api', repoId: 'repo-api', defaultRef: 'refs/heads/main',
			}]) },
		});
		expect(upsertProjectTreeDxLibrary).toHaveBeenCalledWith('project-api', expect.objectContaining({
			contentRepositoryUrl: 'https://github.com/treeseed-ai/api-content.git',
			contentRepositoryDefaultBranch: 'main',
		}));
	});
});

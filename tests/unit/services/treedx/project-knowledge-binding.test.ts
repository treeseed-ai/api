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
});

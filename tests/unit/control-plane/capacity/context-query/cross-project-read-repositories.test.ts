import { describe, expect, it, vi } from 'vitest';
import { resolveCrossProjectReadRepositories } from '../../../../../src/api/capacity/services/capacity/assignments/planning/context/cross-project-read-repositories.ts';

describe('assignment cross-project TreeDX authority', () => {
	it('intersects direct shares with activity content permissions and ignores expired grants', async () => {
		const projects = new Map([
			['team-library', { id: 'team-library', slug: 'team', teamId: 'team-a' }],
			['same-team', { id: 'same-team', slug: 'other', teamId: 'team-a' }],
			['shared', { id: 'shared', slug: 'shared-project', teamId: 'team-b' }],
		]);
		const store = {
			listTeamProjects: vi.fn(async () => [projects.get('team-library'), projects.get('same-team')]),
			getProject: vi.fn(async (id:string) => projects.get(id) ?? null),
			getProjectTreeDxLibrary: vi.fn(async (id:string) => ({ repositoryId: `repo-${id}`, contentRepositoryRef: `ref-${id}` })),
			listTreeDxSharesForRecipient: vi.fn(async () => [
				{ teamId: 'team-b', status: 'active', expiresAt: null, trustGrant: {
					projectIds: ['shared'], operations: ['read'], contentModels: ['knowledge','objective'], paths: ['knowledge/**'],
				} },
				{ teamId: 'team-c', status: 'active', expiresAt: '2020-01-01T00:00:00Z', trustGrant: {
					projectIds: ['expired'], operations: ['read'], contentModels: ['knowledge'], paths: ['**'],
				} },
			]),
		};
		const repositories = await resolveCrossProjectReadRepositories({
			store: store as never, teamId: 'team-a', projectId: 'current', teamLibraryProject: projects.get('team-library')!,
			payload: { permissions: { content: {
				knowledge: { operations: ['read'], filters: { paths: ['knowledge/**'] } },
				question: { operations: ['write'] },
			} } },
		});
		expect(repositories).toEqual([
			expect.objectContaining({ projectId: 'team-library', source: 'team-library', allowedModels: ['knowledge'] }),
			expect.objectContaining({ projectId: 'same-team', source: 'same-team', allowedPaths: ['knowledge/**'] }),
			expect.objectContaining({ projectId: 'shared', source: 'shared-team', allowedModels: ['knowledge'], allowedPaths: ['knowledge/**'] }),
		]);
	});
});

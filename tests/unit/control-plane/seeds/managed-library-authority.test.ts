import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ team: vi.fn(), authority: vi.fn(), provider: vi.fn(), binding: vi.fn() }));
vi.mock('../../../../src/api/teams/managed-team-library-service.ts', () => ({ reconcileManagedTeamLibrary: mocks.team }));
vi.mock('../../../../src/security/provider-credential-authority.ts', () => ({ resolveGitHubRepositoryCreationAuthority: mocks.authority }));
vi.mock('../../../../src/control-plane/seeds/apply-support/projects/projects-core/library-provider-reconciliation.ts', () => ({ reconcileLibraryProvider: mocks.provider }));
vi.mock('../../../../src/control-plane/seeds/apply-support/projects/projects-core/project-knowledge-binding.ts', () => ({ ensureProjectKnowledgeBinding: mocks.binding }));
import { ensureProjectSeedDependencies } from '../../../../src/control-plane/seeds/apply-support/projects/projects-core/project-dependencies.ts';

const authority = { token: 'synthetic-pat', authorityId: 'authority-1', serviceConnectionId: 'connection-1', capabilityBindingId: 'binding-1' };
function request() {
	const library = { role: 'library', owner: 'example', name: 'project-library', gitUrl: 'https://github.com/example/project-library.git', defaultBranch: 'main', repositoryPolicy: { visibility: 'private', lifecycle: 'create-or-adopt' } };
	return { action: { kind: 'project', key: 'project:test', payload: { teamKey: 'team:test', slug: 'test', library }, existing: null },
		store: { listHubRepositories: vi.fn(async () => []), upsertHubRepository: vi.fn() },
		ids: { projects: new Map([['project:test', 'project-1']]), teams: new Map([['team:test', 'team-1']]) },
		manifestHash: 'a'.repeat(64), appliedAt: '2026-09-05T00:00:00.000Z', env: {}, localOnly: true, dependencyState: {}, plan: {} };
}
beforeEach(() => {
	vi.resetAllMocks(); mocks.team.mockResolvedValue({ state: 'replicating' }); mocks.authority.mockResolvedValue(authority);
	mocks.provider.mockResolvedValue({ heads: { staging: 'a'.repeat(40) }, credentialId: 'delivery-1' }); mocks.binding.mockResolvedValue({ kind: 'projectKnowledgeBinding' });
});
describe('managed seed authority and shared context ordering', () => {
	it('provisions shared context once and passes managed PAT authority before project verification', async () => {
		const input = request(); await ensureProjectSeedDependencies(input); await ensureProjectSeedDependencies(input);
		expect(mocks.team).toHaveBeenCalledTimes(1);
		expect(mocks.provider).toHaveBeenCalledWith(expect.objectContaining({ repositoryAuthority: authority, teamId: 'team-1', visibility: 'private' }));
		expect(mocks.team.mock.invocationCallOrder[0]).toBeLessThan(mocks.binding.mock.invocationCallOrder[0]!);
		expect(mocks.authority.mock.invocationCallOrder[0]).toBeLessThan(mocks.provider.mock.invocationCallOrder[0]!);
	});
	it('does not validate project context when shared context fails', async () => {
		mocks.team.mockRejectedValue(new Error('managed team authority required'));
		await expect(ensureProjectSeedDependencies(request())).rejects.toThrow('managed team authority required');
		expect(mocks.provider).not.toHaveBeenCalled(); expect(mocks.binding).not.toHaveBeenCalled();
	});
	it('does not anonymously provision a private library when authority is missing', async () => {
		mocks.authority.mockRejectedValue(new Error('repository authority unavailable'));
		await expect(ensureProjectSeedDependencies(request())).rejects.toThrow('repository authority unavailable');
		expect(mocks.provider).not.toHaveBeenCalled(); expect(mocks.binding).not.toHaveBeenCalled();
	});
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ authority: vi.fn(), provider: vi.fn(), binding: vi.fn(), replication: vi.fn() }));
vi.mock('../../../../src/security/provider-credential-authority.ts', () => ({ resolveGitHubRepositoryCreationAuthority: mocks.authority }));
vi.mock('../../../../src/control-plane/seeds/apply-support/projects/projects-core/library-provider-reconciliation.ts', () => ({ reconcileLibraryProvider: mocks.provider }));
vi.mock('../../../../src/control-plane/seeds/apply-support/projects/projects-core/project-knowledge-binding.ts', () => ({ ensureProjectKnowledgeBinding: mocks.binding }));
vi.mock('../../../../src/api/capacity/services/treedx/repositories/treedx-commit-replication.ts', () => ({ enqueueTreeDxCommitReplication: mocks.replication }));
import { reconcileManagedTeamLibrary } from '../../../../src/api/teams/managed-team-library-service.ts';
import { managedTeamLibraryRepositoryName } from '../../../../src/api/store/teams/contracts/managed-library/ensure-managed-team-library-project.ts';

const authority = { token: 'synthetic-pat', authorityId: 'authority-1', serviceConnectionId: 'connection-1', capabilityBindingId: 'binding-1' };
function store() { return { getTeam: vi.fn(async () => ({ metadata: { githubOwner: 'example' } })),
	ensureManagedTeamLibraryProject: vi.fn(async () => ({ id: 'project-1', metadata: { library: { repositoryName: managedTeamLibraryRepositoryName('team-1') } } })),
	first: vi.fn(async () => null), run: vi.fn() }; }
beforeEach(() => {
	vi.resetAllMocks(); mocks.authority.mockResolvedValue(authority); mocks.provider.mockResolvedValue({ heads: {}, credentialId: 'delivery-1' });
	mocks.binding.mockResolvedValue({ resolvedRef: 'a'.repeat(40), sourceRef: 'refs/remotes/origin/staging', repositoryId: 'repository-1' });
});
describe('Team Library managed credential custody', () => {
	it('passes resolved team authority without an environment token and remains replicating until R2 is verified', async () => {
		const result = await reconcileManagedTeamLibrary(store(), 'team-1', {});
		expect(mocks.authority).toHaveBeenCalledWith(expect.objectContaining({ teamId: 'team-1', owner: 'example', env: {} }));
		expect(mocks.provider).toHaveBeenCalledWith(expect.objectContaining({ repositoryAuthority: authority, visibility: 'private' }));
		expect(result.state).toBe('replicating'); expect(JSON.stringify(result)).not.toContain(authority.token);
	});
	it('fails closed before remote provisioning if managed authority is unavailable', async () => {
		mocks.authority.mockRejectedValue(new Error('managed authority unavailable'));
		await expect(reconcileManagedTeamLibrary(store(), 'team-1', {})).rejects.toThrow('managed authority unavailable');
		expect(mocks.provider).not.toHaveBeenCalled(); expect(mocks.binding).not.toHaveBeenCalled();
	});
});

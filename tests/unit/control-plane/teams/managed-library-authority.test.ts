import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ authority: vi.fn(), provider: vi.fn(), binding: vi.fn(), replication: vi.fn() }));
vi.mock('../../../../src/security/provider-credential-authority.ts', () => ({ resolveGitHubRepositoryCreationAuthority: mocks.authority }));
vi.mock('../../../../src/control-plane/seeds/apply-support/projects/projects-core/library-provider-reconciliation.ts', () => ({ reconcileLibraryProvider: mocks.provider }));
vi.mock('../../../../src/control-plane/seeds/apply-support/projects/projects-core/project-knowledge-binding.ts', () => ({ ensureProjectKnowledgeBinding: mocks.binding }));
vi.mock('../../../../src/api/capacity/services/treedx/repositories/treedx-commit-replication.ts', () => ({ enqueueTreeDxCommitReplication: mocks.replication }));
import { reconcileManagedTeamLibrary } from '../../../../src/api/teams/managed-team-library-service.ts';
import { managedTeamLibraryRepositoryName } from '../../../../src/api/store/teams/contracts/managed-library/ensure-managed-team-library-project.ts';
import { ControlPlaneStore } from '../../../../src/api/persistence/store.ts';
import { postgresGraph } from '../capacity/execution/graph/architecture/living/living-postgres-fixture.ts';

const authority = { token: 'synthetic-pat', authorityId: 'authority-1', serviceConnectionId: 'connection-1', capabilityBindingId: 'binding-1' };
function store() { return { getTeam: vi.fn(async () => ({ metadata: { githubOwner: 'example' } })),
	ensureManagedTeamLibraryProject: vi.fn(async () => ({ id: 'project-1', metadata: { library: { repositoryName: managedTeamLibraryRepositoryName('team-1') } } })),
	first: vi.fn(async () => null), run: vi.fn() }; }
beforeEach(() => {
	vi.resetAllMocks(); mocks.authority.mockResolvedValue(authority); mocks.provider.mockResolvedValue({ heads: {}, credentialId: 'delivery-1' });
	mocks.binding.mockResolvedValue({ resolvedRef: 'a'.repeat(40), sourceRef: 'refs/remotes/origin/staging', repositoryId: 'repository-1' });
});
describe('Team Library managed credential custody', () => {
	it('managed execution context denies malformed repository visibility or lifecycle before resolving credentials',async()=>{
		for(const policy of [{visibility:'preview'},{visibility:null},{visibility:[]},{lifecycle:'overwrite'},{lifecycle:null},{lifecycle:7}]){
			mocks.authority.mockClear();mocks.provider.mockClear();mocks.binding.mockClear();
			const input=store();input.ensureManagedTeamLibraryProject.mockResolvedValue({id:'project-1',metadata:{library:Object.assign({repositoryName:managedTeamLibraryRepositoryName('team-1')},{repositoryPolicy:policy})}});
			await expect(reconcileManagedTeamLibrary(input,'team-1',{})).rejects.toThrow('Managed Team Library repository policy is invalid.');
			expect(mocks.authority).not.toHaveBeenCalled();expect(mocks.provider).not.toHaveBeenCalled();expect(mocks.binding).not.toHaveBeenCalled();
		}
	});
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

it('retains canonical public adopt authority without creating or seeding a replacement repository',async()=>{
 const input=store(),policy={visibility:'public',lifecycle:'adopt'};
 input.ensureManagedTeamLibraryProject.mockResolvedValue({id:'project-1',metadata:{library:Object.assign({repositoryName:managedTeamLibraryRepositoryName('team-1')},{repositoryPolicy:policy})}});
 const before=structuredClone(policy);
 const result=await reconcileManagedTeamLibrary(input,'team-1',{});
 expect(mocks.provider).toHaveBeenCalledWith(expect.objectContaining({visibility:'public',lifecycle:'adopt',seedFiles:undefined,repositoryAuthority:authority}));
 expect(result.state).toBe('replicating');expect(policy).toEqual(before);
});

it('native managed repository metadata keeps canonical adopt authority through credential denial and a measured independent readback',async()=>{
 const f=await postgresGraph();
 try{
  const store=new ControlPlaneStore({TREESEED_ENVIRONMENT:'test'},f.left);store.initializationPromise=Promise.resolve();
  const project=await store.ensureManagedTeamLibraryProject('team');
  const metadata={...project.metadata,library:{...project.metadata.library,owner:'example',repositoryName:managedTeamLibraryRepositoryName('team'),repositoryPolicy:{visibility:'public',lifecycle:'adopt'}}};
  await f.left.pool.query('UPDATE projects SET metadata_json=$1 WHERE id=$2',[JSON.stringify(metadata),project.id]);
  const snapshot=async()=>({projects:(await f.right.pool.query('SELECT * FROM projects ORDER BY id')).rows,teams:(await f.right.pool.query('SELECT * FROM teams ORDER BY id')).rows});
  const before=await snapshot();mocks.authority.mockRejectedValueOnce(new Error('controlled credential denial'));
  await expect(reconcileManagedTeamLibrary(store,'team',{})).rejects.toThrow('controlled credential denial');expect(await snapshot()).toEqual(before);
  const result=await reconcileManagedTeamLibrary(store,'team',{});
  expect(result.state).toBe('replicating');expect(mocks.provider).toHaveBeenLastCalledWith(expect.objectContaining({visibility:'public',lifecycle:'adopt',seedFiles:undefined}));
  const observed=JSON.parse((await f.right.pool.query('SELECT metadata_json FROM projects WHERE id=$1',[project.id])).rows[0].metadata_json);
  expect(observed.library.repositoryPolicy).toEqual({visibility:'public',lifecycle:'adopt'});
  expect(observed.library.status).toBe('replicating');expect(observed.provisioning.state).toBe('replicating');
  expect(await f.snapshot()).toEqual({nodes:[],edges:[],revisions:[],assignments:[],reservations:[]});
 }finally{await f.close();}
});

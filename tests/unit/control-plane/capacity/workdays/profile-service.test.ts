import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ reconcile: vi.fn(), credential: vi.fn(), fetch: vi.fn() }));
vi.mock('../../../../../src/security/provider-credential-authority.ts', () => ({ resolveGitHubCredentialAuthority: mocks.credential, resolveGitHubSourceAuthority: mocks.credential }));
vi.mock('../../../../../src/api/capacity/services/capacity/workdays/policy/repository-workday-profile-service.ts', () => ({
	REPOSITORY_WORKDAY_PROFILE_PATH: '.treeseed/workdays/allocation-profile.json',
	RepositoryWorkdayProfileService: class { reconcile = mocks.reconcile; },
}));
import { createWorkdayProfileService } from '../../../../../src/api/control-plane/repositories/capacity/workdays/profile-service.ts';

const commit = 'a'.repeat(40);
const binding = { id: 'binding', team_id: 'team', owning_team_id: 'team', hub_id: 'project', role: 'software', provider: 'github', owner: 'example', name: 'source', current_branch: 'refs/heads/staging' };
const check = { id: 12, name: 'verify', head_sha: commit, status: 'completed', conclusion: 'success', app: { slug: 'github-actions' }, check_suite: { id: 24 } };
const principal = { id: 'operator' };
function store() {
	return { principalCanAccessTeam: vi.fn(async () => true), getTeamAccessSummary: vi.fn(async () => ({ permissions: ['teams:manage:team', 'projects:read:team'] })),
		first: vi.fn(async () => ({ id: 'project' })),
		listHubRepositories: vi.fn(async () => [{ ...binding, currentBranch: binding.current_branch }]),
		all: vi.fn(async (query: string) => query.includes('hub_repositories') ? [binding] : []) };
}
describe('operator repository profile reconciliation', () => {
	beforeEach(() => {
		vi.clearAllMocks(); vi.stubGlobal('fetch', mocks.fetch);
		mocks.credential.mockResolvedValue({ token: 'test-only-provider-credential' });
		mocks.reconcile.mockResolvedValue([{ status: 'unchanged', generation: { commit } }]);
		mocks.fetch.mockImplementation(async (url: string) => {
			if (url.includes('/git/ref/')) return Response.json({ object: { sha: commit } });
			if (url.includes('/commits/')) return Response.json({ check_runs: [check] });
			if (url.includes('/check-runs/')) return Response.json(check);
			if (url.includes('/check-suites/')) return Response.json({ head_branch: 'staging', head_sha: commit, app: { slug: 'github-actions' }, repository: { full_name: 'example/source', id: 42 } });
			if (url.includes('/contents/')) return new Response('{"profiles":[]}');
			throw new Error('Unexpected provider endpoint');
		});
	});
	afterEach(() => vi.unstubAllGlobals());
	it('uses scoped credentials and exact trusted check/ref/content read-back without a webhook', async () => {
		const db = store(); const result = await createWorkdayProfileService(db).profilesReconcile(principal, 'team', 'project');
		expect(db.first).toHaveBeenNthCalledWith(1, expect.stringContaining('team_id=?'), ['team', 'project', 'project']);
		expect(mocks.credential).toHaveBeenCalledWith(expect.objectContaining({ teamId: 'team', owner: 'example', repository: 'source' }));
		expect(mocks.reconcile).toHaveBeenCalledWith({ teamId: 'team', projectId: 'project', repository: 'example/source', ref: 'refs/heads/staging', commit,
			path: '.treeseed/workdays/allocation-profile.json', content: '{"profiles":[]}' });
		expect(result).toMatchObject({ commit, receipts: [{ status: 'unchanged' }] });
		expect(JSON.stringify(result)).not.toContain('test-only-provider-credential');
	});
	it('denies members without policy-management authority before provider access', async () => {
		const db = store(); db.getTeamAccessSummary.mockResolvedValue({ permissions: ['projects:read:team'] });
		await expect(createWorkdayProfileService(db).profilesReconcile(principal, 'team', 'project')).rejects.toMatchObject({ code: 'capacity_permission_denied' });
		expect(mocks.credential).not.toHaveBeenCalled();
	});
	it('never resolves credentials for an unbound or other-team project', async () => {
		const db = store(); db.first.mockResolvedValue(null as never);
		await expect(createWorkdayProfileService(db).profilesReconcile(principal, 'team', 'other-project')).rejects.toMatchObject({ code: 'workday_repository_binding_missing' });
		expect(mocks.credential).not.toHaveBeenCalled();
	});
	it('never substitutes the library repository for software', async () => {
		const db = store(); db.listHubRepositories.mockResolvedValue([{ ...binding, role: 'library', currentBranch: binding.current_branch }]);
		await expect(createWorkdayProfileService(db).profilesReconcile(principal, 'team', 'project')).rejects.toMatchObject({ code: 'assignment_source_repository_required' });
		expect(mocks.credential).not.toHaveBeenCalled();
	});
	it.each([{ conclusion: 'failure' }, { head_sha: 'b'.repeat(40) }, { app: { slug: 'untrusted' } }])('rejects ineligible check %j', async (change) => {
		mocks.fetch.mockResolvedValueOnce(Response.json({ object: { sha: commit } })).mockResolvedValueOnce(Response.json({ check_runs: [{ ...check, ...change }] }));
		await expect(createWorkdayProfileService(store()).profilesReconcile(principal, 'team', 'project')).rejects.toMatchObject({ code: 'workday_repository_check_required' });
		expect(mocks.reconcile).not.toHaveBeenCalled();
	});
	it('denies a head moved while content is being read', async () => {
		let reads = 0; const original = mocks.fetch.getMockImplementation()!;
		mocks.fetch.mockImplementation(async (url: string) => url.includes('/git/ref/') && ++reads === 3
			? Response.json({ object: { sha: 'b'.repeat(40) } }) : original(url));
		await expect(createWorkdayProfileService(store()).profilesReconcile(principal, 'team', 'project')).rejects.toMatchObject({ code: 'workday_profile_not_reconciled' });
		expect(mocks.reconcile).not.toHaveBeenCalled();
	});
	it('requires authoritative suite branch and repository instead of nonexistent embedded check fields', async () => {
		const original = mocks.fetch.getMockImplementation()!;
		mocks.fetch.mockImplementation(async (url: string) => url.includes('/check-suites/')
			? Response.json({ head_branch: 'main', head_sha: commit, app: { slug: 'github-actions' }, repository: { full_name: 'example/source', id: 42 } }) : original(url));
		await expect(createWorkdayProfileService(store()).profilesReconcile(principal, 'team', 'project')).rejects.toMatchObject({ code: 'workday_profile_not_reconciled' });
		expect(mocks.reconcile).not.toHaveBeenCalled();
	});
	it('lists only bounded team-owned repository generations', async () => {
		const db = store(); await createWorkdayProfileService(db).profilesList(principal, 'team', { limit: 2 });
		expect(db.all).toHaveBeenCalledWith(expect.stringContaining('jsonb_exists'), ['team', 'active', 3]);
	});
});

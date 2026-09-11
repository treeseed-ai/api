import { beforeEach, describe, expect, it, vi } from 'vitest';
import { candidateFixture } from './fixture.ts';
import { authorizeSourceCandidate } from '../../../../../../src/api/control-plane/repositories/providers/source/candidate-authority.ts';
const mocks = vi.hoisted(() => ({ credential: vi.fn(), authority: vi.fn() }));
vi.mock('../../../../../../src/security/provider-credential-authority.ts', () => ({ resolveGitHubSourceAuthority: mocks.credential }));
vi.mock('../../../../../../src/api/capacity/services/accounts/lease-authority-service.ts', () => ({ evaluateProviderAssignmentLeaseAuthority: mocks.authority }));
beforeEach(() => { vi.clearAllMocks(); mocks.credential.mockImplementation(async () => ({ token: 'host-only-git-secret' })); mocks.authority.mockResolvedValue({ eligible: true }); });
function fixture() {
  const f = candidateFixture(), actor = { teamId: 'team', capacityProviderId: 'provider', membershipId: 'membership', scopes: ['provider:assignments:write'] };
  const row = { id: 'assignment', team_id: 'team', project_id: 'project', capacity_provider_id: 'provider', membership_id: 'membership', runner_id: 'runner',
    lease_token: 'test-lease', status: 'running', lease_state: 'leased', lease_expires_at: '2026-09-10T01:00:00.000Z', attempt_count: 0,
    execution_kind: 'workday', mode: 'acting', allowed_outputs_json: JSON.stringify({ artifactKinds: ['source-candidate'] }),
    workspace_context_json: JSON.stringify({ sourceWorkspace: { schemaVersion: 'treeseed.assignment-source-pin/v1', exactCommit: 'a'.repeat(40), credentialBindingId: 'binding',
      repository: { id: 'repo', provider: 'github', owner: 'example', name: 'project', ref: 'staging', cloneUrl: 'https://github.com/example/project.git' } } }) };
  const db = { first: vi.fn(async (sql: string) => sql.includes('FROM capacity_providers WHERE') ? { public_jwk_json: f.publicJwk } : row) };
  const check = () => authorizeSourceCandidate(db as never, {}, actor, 'assignment', f.request, 'control', new Date('2026-09-10T00:10:00.000Z'));
  return { ...f, actor, row, check };
}
describe('candidate Identity and Vault authority', () => {
  it('requires both registered-provider evidence and the current pinned Vault binding', async () => {
    const f = fixture(); await f.check();
    expect(mocks.credential).toHaveBeenCalledWith(expect.objectContaining({ teamId: 'team', bindingId: 'binding', owner: 'example', repository: 'project' }));
    expect(mocks.authority).toHaveBeenCalledOnce();
  });
  it.each(['team', 'attempt', 'analysis', 'permission', 'lease', 'source'] as const)('denies %s mismatch before opening custody', async invalid => {
    const f = fixture();
    if (invalid === 'team') f.row.team_id = 'other';
    if (invalid === 'attempt') f.row.attempt_count = 1;
    if (invalid === 'analysis') f.row.execution_kind = 'conversation';
    if (invalid === 'permission') f.row.allowed_outputs_json = '{}';
    if (invalid === 'lease') f.row.lease_expires_at = '2026-09-09T00:00:00.000Z';
    if (invalid === 'source') f.candidate.attestation.source.commit = 'f'.repeat(40);
    await expect(f.check()).rejects.toThrow(); expect(mocks.credential).not.toHaveBeenCalled();
  });
  it('denies revoked assignments and unavailable credential bindings', async () => {
    const f = fixture(); mocks.authority.mockResolvedValueOnce({ eligible: false });
    await expect(f.check()).rejects.toThrow('no longer active');
    mocks.credential.mockRejectedValueOnce(new Error('credential revoked'));
    await expect(f.check()).rejects.toThrow('credential revoked');
  });
});

import { beforeEach, expect, it, vi } from 'vitest';
import { candidateFixture } from './fixture.ts';
import { createSourceChunkService } from '../../../../../../src/api/control-plane/repositories/providers/source/source-chunk-service.ts';
import { candidateChunkKey } from '../../../../../../src/api/control-plane/repositories/providers/source/candidate-storage.ts';
const mocks = vi.hoisted(() => ({ credential: vi.fn(), authority: vi.fn(), predecessor: vi.fn() }));
vi.mock('../../../../../../src/security/provider-credential-authority.ts', () => ({ resolveGitHubSourceAuthority: mocks.credential }));
vi.mock('../../../../../../src/api/capacity/services/accounts/lease-authority-service.ts', () => ({ evaluateProviderAssignmentLeaseAuthority: mocks.authority }));
vi.mock('../../../../../../src/api/control-plane/repositories/providers/source/candidate-handoff.ts', () => ({ assignmentPredecessorCandidate: mocks.predecessor }));
beforeEach(() => { vi.clearAllMocks(); mocks.credential.mockResolvedValue({ token: 'host-only' }); mocks.authority.mockResolvedValue({ eligible: true }); });
function fixture() {
  const f = candidateFixture(), artifactId = `source-candidate-${'c'.repeat(64)}`;
  const pin = { schemaVersion: 'treeseed.assignment-source-pin/v1', candidateId: artifactId, exactCommit: f.candidate.attestation.commit,
    credentialBindingId: 'binding', repository: { id: 'repo', provider: 'github', owner: 'example', name: 'project', ref: 'staging', cloneUrl: 'https://github.com/example/project.git' } };
  const row = { id: 'child', team_id: 'team', capacity_provider_id: 'provider', membership_id: 'membership', runner_id: 'runner',
    lease_token: 'test-lease', status: 'running', lease_state: 'leased', lease_expires_at: '2026-09-10T01:00:00.000Z', attempt_count: 1,
    workspace_context_json: { sourceWorkspace: pin } };
  mocks.predecessor.mockResolvedValue({ id: artifactId, attestation: f.candidate.attestation });
  const key = candidateChunkKey(artifactId, f.candidate.attestation, 0); f.chunks.set(key, f.bytes);
  const read = vi.spyOn(f.client, 'getBytes');
  const service = createSourceChunkService({ first: async () => row } as never, {}, { controlPlaneId: 'control', now: () => new Date('2026-09-10T00:10:00.000Z'), withStorage: run => run(f.client) });
  const auth = { principal: { teamId: 'team', capacityProviderId: 'provider', membershipId: 'membership', scopes: ['provider:assignments:read'] } };
  const request = { artifactId, index: 0, runnerId: 'runner', leaseToken: 'test-lease' };
  return { ...f, row, pin, read, key, request, auth, run: () => service(auth, 'child', request) };
}
it('returns only the pinned chunk, bounds storage reads and rechecks authority', async () => {
  const f = fixture(); expect(await f.run()).toMatchObject({ artifactId: f.request.artifactId, index: 0, content: f.bytes.toString('base64') });
  expect(f.read).toHaveBeenCalledWith(f.key, 524288);
  expect(mocks.credential).toHaveBeenCalledTimes(2); expect(mocks.authority).toHaveBeenCalledTimes(2);
});
it.each(['team', 'lease', 'scope', 'artifact', 'index'] as const)('denies %s mismatch without returning source', async type => {
  const f = fixture();
  if (type === 'team') f.row.team_id = 'other';
  if (type === 'lease') f.request.leaseToken = 'wrong';
  if (type === 'scope') f.auth.principal.scopes = [];
  if (type === 'artifact') f.request.artifactId = `source-candidate-${'d'.repeat(64)}`;
  if (type === 'index') f.request.index = 1;
  await expect(f.run()).rejects.toThrow(); expect(f.read).not.toHaveBeenCalled();
});
it('denies revocation occurring during storage IO', async () => {
  const f = fixture(); mocks.authority.mockResolvedValueOnce({ eligible: true }).mockResolvedValueOnce({ eligible: false });
  await expect(f.run()).rejects.toThrow('no longer active'); expect(f.read).toHaveBeenCalledOnce();
});
it('fails closed on missing or corrupt bytes without substituting source', async () => {
  const f = fixture(); f.chunks.delete(f.key); await expect(f.run()).rejects.toThrow('unavailable');
  f.chunks.set(f.key, Buffer.from('corrupt')); await expect(f.run()).rejects.toThrow('signed manifest');
});

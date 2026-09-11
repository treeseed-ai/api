import { beforeEach, describe, expect, it, vi } from 'vitest';
import { candidateFixture } from './fixture.ts';
import { createSourceCandidateService } from '../../../../../../src/api/control-plane/repositories/providers/source/candidate-service.ts';
import { canonicalJson } from '../../../../../../src/api/capacity/security.ts';
const mocks = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock('../../../../../../src/api/control-plane/repositories/providers/source/candidate-authority.ts', async original => ({
  ...await original<object>(), authorizeSourceCandidate: mocks.authorize,
}));
beforeEach(() => { vi.clearAllMocks(); mocks.authorize.mockResolvedValue({}); });
function serviceFixture() {
  const f = candidateFixture(); let row: Record<string, unknown> | null = null;
  const database = {
    first: vi.fn(async () => row),
    run: vi.fn(async (sql: string, args: unknown[]) => {
      if (sql.startsWith('INSERT') && !row) row = { id: args[0], team_id: args[1], project_id: args[2], assignment_id: args[3], provider_id: args[4], attempt: args[5],
        state: 'uploading', attestation_json: args[6], signature_json: args[7], created_at: args[8] };
      if (sql.startsWith('UPDATE') && row) row = { ...row, state: 'accepted', receipt_json: args[0] };
    }),
  };
  const service = createSourceCandidateService(database as never, {}, { controlPlaneId: 'control', now: () => new Date('2026-09-10T00:01:00.000Z'), withStorage: run => run(f.client) });
  const auth = { principal: { teamId: 'team', capacityProviderId: 'provider', membershipId: 'membership', scopes: ['provider:assignments:write'] } };
  const commit = { action: 'commit', runnerId: 'runner', leaseToken: 'test-lease', candidate: f.candidate };
  return { ...f, database, service, auth, commit, row: () => row };
}
describe('source candidate durable acceptance', () => {
  it('accepts only after storage read-back and reauthorization; exact replay is noop', async () => {
    const f = serviceFixture();
    await f.service(f.auth, 'assignment', f.request);
    expect(f.row()?.state).toBe('uploading');
    const receipt = await f.service(f.auth, 'assignment', f.commit);
    expect(receipt).toMatchObject({ commit: f.candidate.attestation.commit, bundle: { digest: f.candidate.attestation.bundle.digest } });
    expect(f.row()?.state).toBe('accepted');
    expect(await f.service(f.auth, 'assignment', f.commit)).toEqual(receipt);
    expect(f.database.run.mock.calls.filter(([sql]) => sql.startsWith('UPDATE'))).toHaveLength(1);
    const update = f.database.run.mock.calls.find(([sql]) => sql.startsWith('UPDATE'))!;
    expect(update[0]).toContain('assignment.attempt_count+1=?');
    expect(update[1].at(-2)).toBe(1);
    expect([...f.texts.values()]).toEqual([canonicalJson(f.candidate)]);
    expect(mocks.authorize).toHaveBeenCalledTimes(5);
  });
  it('does not accept incomplete or corrupted storage', async () => {
    const f = serviceFixture();
    await expect(f.service(f.auth, 'assignment', f.commit)).rejects.toThrow('incomplete');
    expect(f.row()?.state).toBe('uploading');
    expect(f.database.run.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
  });
  it('does not accept a candidate after authority is revoked during storage IO', async () => {
    const f = serviceFixture(); await f.service(f.auth, 'assignment', f.request);
    mocks.authorize.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('revoked'));
    await expect(f.service(f.auth, 'assignment', f.commit)).rejects.toThrow('revoked');
    expect(f.row()?.state).toBe('uploading');
  });
  it('cannot replace a candidate or supply different bytes even on accepted replay', async () => {
    const f = serviceFixture(); await f.service(f.auth, 'assignment', f.request); await f.service(f.auth, 'assignment', f.commit);
    await expect(f.service(f.auth, 'assignment', { ...f.request, content: Buffer.from('wrong').toString('base64') })).rejects.toThrow('signed manifest');
    f.candidate.attestation.commit = 'd'.repeat(40);
    await expect(f.service(f.auth, 'assignment', f.commit)).rejects.toThrow('different or quarantined');
  });
});

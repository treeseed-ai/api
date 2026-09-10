import { describe, expect, it, vi } from 'vitest';
import { persistAssignmentSourcePin, readAssignmentSourcePin, resolveAuthorizedSourceCommit, type AssignmentSourcePin } from '../../../../../src/api/control-plane/repositories/providers/source/source-pin.ts';

const repository = { id: 'repository', provider: 'github' as const, owner: 'example', name: 'project', ref: 'staging', cloneUrl: 'https://github.com/example/project.git' };
const pin: AssignmentSourcePin = { schemaVersion: 'treeseed.assignment-source-pin/v1', repository, exactCommit: 'a'.repeat(40), credentialBindingId: 'binding' };
const input = { assignmentId: 'assignment', teamId: 'team', providerId: 'provider', membershipId: 'membership', runnerId: 'runner', leaseToken: 'synthetic-lease', stateVersion: 7, context: { project: { id: 'project' } }, pin, now: '2026-09-10T23:00:00.000Z' };

describe('exact assignment source pins', () => {
  it('resolves a ref through authorized GitHub transport without redirects or arbitrary URLs', async () => {
    const fetchImpl = vi.fn(async () => new Response(`${pin.exactCommit}\n`));
    expect(await resolveAuthorizedSourceCommit({ ...repository, cloneUrl: 'https://attacker.invalid' }, 'synthetic-token', fetchImpl)).toBe(pin.exactCommit);
    expect(fetchImpl).toHaveBeenCalledWith('https://api.github.com/repos/example/project/commits/staging', expect.objectContaining({
      redirect: 'error', headers: expect.objectContaining({ authorization: 'Bearer synthetic-token', accept: 'application/vnd.github.sha' }),
    }));
  });

  it.each([{ body: 'untrusted', status: 200 }, { body: 'x'.repeat(129), status: 200 }, { body: 'private-error', status: 403 }, { body: '', status: 302 }])('rejects invalid, oversized, and denied responses without reflecting provider bodies', async ({ body, status }) => {
    const operation = resolveAuthorizedSourceCommit(repository, 'synthetic-token', async () => new Response(body, { status }));
    await expect(operation).rejects.toThrow(/repository|connection/i);
    await expect(operation).rejects.not.toThrow(body || 'private-error');
  });

  it('rejects a response that substitutes another exact revision', async () => {
    await expect(resolveAuthorizedSourceCommit({ ...repository, ref: pin.exactCommit }, 'synthetic-token', async () => new Response('b'.repeat(40)))).rejects.toMatchObject({ code: 'assignment_source_revision_changed' });
  });

  it('keeps existing context and uses a current lease/version compare-and-swap', async () => {
    const store = { run: vi.fn(async (_sql: string, _parameters: unknown[]) => {}), first: vi.fn(async () => ({ workspace_context_json: JSON.stringify({ ...input.context, sourceWorkspace: pin }) })) };
    expect(await persistAssignmentSourcePin(store, input)).toEqual(pin);
    expect(JSON.parse(store.run.mock.calls[0]![1]![0] as string)).toEqual({ ...input.context, sourceWorkspace: pin });
    expect(store.run.mock.calls[0]![0]).toContain('AND lease_token=? AND state_version=?');
    expect(store.run.mock.calls[0]![0]).toContain('lease_expires_at>?');
  });

  it('returns the first concurrent winner instead of replacing its commit with a newer branch head', async () => {
    const winner = { ...pin, exactCommit: 'b'.repeat(40) };
    const store = { run: vi.fn(async () => {}), first: vi.fn(async () => ({ workspace_context_json: JSON.stringify({ sourceWorkspace: winner }) })) };
    expect(await persistAssignmentSourcePin(store, input)).toEqual(winner);
  });

  it('fails closed after lease loss or a conflicting unpinned update', async () => {
    const store = { run: vi.fn(async () => {}), first: vi.fn(async () => null) };
    await expect(persistAssignmentSourcePin(store, input)).rejects.toMatchObject({ code: 'assignment_source_pin_conflict' });
  });

  it('does not replace malformed or existing pins', async () => {
    expect(readAssignmentSourcePin({})).toBeNull();
    expect(() => readAssignmentSourcePin({ sourceWorkspace: {} })).toThrow('pin is invalid');
    const store = { run: vi.fn(), first: vi.fn() };
    await expect(persistAssignmentSourcePin(store, { ...input, context: { sourceWorkspace: pin } })).rejects.toMatchObject({ code: 'assignment_source_already_pinned' });
    expect(store.run).not.toHaveBeenCalled();
  });
});

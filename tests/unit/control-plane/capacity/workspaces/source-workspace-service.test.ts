import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSourceCredentialRecipient, openSourceCredential } from '@treeseed/deployment/security/source';
import { createSourceWorkspaceService, assertSourceAssignmentLease, assignmentSourceMode } from '../../../../../src/api/control-plane/repositories/providers/source/source-workspace-service.ts';

const mocks = vi.hoisted(() => ({ credential: vi.fn(), authority: vi.fn() }));
vi.mock('../../../../../src/security/provider-credential-authority.ts', () => ({ resolveGitHubSourceAuthority: mocks.credential }));
vi.mock('../../../../../src/api/capacity/services/accounts/lease-authority-service.ts', () => ({ evaluateProviderAssignmentLeaseAuthority: mocks.authority }));
const now = new Date('2026-09-10T23:00:00.000Z'), commit = 'a'.repeat(40);
const principal = { teamId: 'team', capacityProviderId: 'provider', membershipId: 'membership', scopes: ['provider:assignments:read'] };
const row = { id: 'assignment', team_id: 'team', project_id: 'project', capacity_provider_id: 'provider', membership_id: 'membership', runner_id: 'runner',
  lease_token: 'synthetic-lease', status: 'leased', lease_state: 'leased', lease_expires_at: '2026-09-10T23:05:00.000Z', attempt_count: 1, state_version: 7,
  execution_kind: 'conversation', mode: 'planning', allowed_outputs_json: '{}', workspace_context_json: '{}' };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.credential.mockResolvedValue({ bindingId: 'binding', token: 'synthetic-git-token', username: 'x-access-token', expiresAt: '2026-09-10T23:04:00.000Z' });
  mocks.authority.mockResolvedValue({ eligible: true });
});

function fixture(overrides: Record<string, unknown> = {}) {
  const current = { ...row, ...overrides };
  const store = { first: vi.fn(async () => current), run: vi.fn(async (_sql: string, args: unknown[]) => { current.workspace_context_json = String(args[0]); current.state_version++; }) };
  const content = { getProject: vi.fn(async () => ({ id: 'project', teamId: 'team' })), listHubRepositories: vi.fn(async () => [{ id: 'repository', role: 'software', provider: 'github', owner: 'example', name: 'project', defaultBranch: 'staging' }]) };
  const fetchImpl = vi.fn(async () => new Response(commit));
  const service = createSourceWorkspaceService(store as never, content, { controlPlaneId: 'https://api.example.test', now: () => now, fetchImpl });
  const recipient = createSourceCredentialRecipient();
  const request = { runnerId: 'runner', leaseToken: 'synthetic-lease', recipientPublicKey: recipient.publicKey };
  return { current, store, content, fetchImpl, service, recipient, request };
}

describe('provider source workspace authorization', () => {
  it('pins a revision and seals the credential to the exact current assignment and host key', async () => {
    const f = fixture();
    const response = await f.service({ principal }, 'assignment', f.request);
    expect(response.authorization).toMatchObject({ providerId: 'provider', assignmentId: 'assignment', attempt: 1, mode: 'analysis', publication: 'denied', source: { teamId: 'team', projectId: 'project', commit } });
    expect(openSourceCredential({ authorization: response.authorization, delivery: response.credential, privateKey: f.recipient.privateKey }, now).token).toBe('synthetic-git-token');
    expect(JSON.stringify(response)).not.toContain('synthetic-git-token');
    expect(f.current.workspace_context_json).not.toMatch(/synthetic|ciphertext|privateKey/u);
    expect(f.store.run).toHaveBeenCalledTimes(1);
    expect(mocks.authority).toHaveBeenCalledTimes(2);
    f.fetchImpl.mockClear();
    const retry = await f.service({ principal }, 'assignment', f.request);
    expect(retry.authorization.source.commit).toBe(commit);
    expect(f.fetchImpl).toHaveBeenCalledWith(`https://api.github.com/repos/example/project/commits/${commit}`, expect.anything());
    expect(f.store.run).toHaveBeenCalledTimes(1);
  });

  it.each([{ team_id: 'other' }, { capacity_provider_id: 'other' }, { membership_id: 'other' }, { runner_id: 'other' }, { lease_token: 'other' },
    { lease_expires_at: '2026-09-10T22:59:59Z' }, { lease_expires_at: 'invalid' }, { status: 'completed' }, { lease_state: 'released' }, { attempt_count: 0 }])('denies invalid provider/lease identity before Vault lookup', async override => {
    const f = fixture(override);
    await expect(f.service({ principal }, 'assignment', f.request)).rejects.toMatchObject({ code: 'assignment_source_lease_invalid' });
    expect(mocks.credential).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it('denies revoked capacity authority and wrong-project ownership', async () => {
    const f = fixture(); mocks.authority.mockResolvedValueOnce({ eligible: false });
    await expect(f.service({ principal }, 'assignment', f.request)).rejects.toMatchObject({ code: 'assignment_source_authority_revoked' });
    f.content.getProject.mockResolvedValue({ id: 'project', teamId: 'other' });
    await expect(f.service({ principal }, 'assignment', f.request)).rejects.toMatchObject({ code: 'assignment_source_project_forbidden' });
    expect(mocks.credential).not.toHaveBeenCalled();
  });

  it('denies authority revoked during network acquisition before sealing', async () => {
    const f = fixture(); mocks.authority.mockResolvedValueOnce({ eligible: true }).mockResolvedValueOnce({ eligible: false });
    await expect(f.service({ principal }, 'assignment', f.request)).rejects.toMatchObject({ code: 'assignment_source_authority_revoked' });
  });

  it('requires a provider principal and a validated ephemeral recipient', async () => {
    const f = fixture();
    await expect(f.service({}, 'assignment', f.request)).rejects.toMatchObject({ code: 'provider_access_token_required' });
    await expect(f.service({ principal }, 'assignment', { ...f.request, recipientPublicKey: 'invalid' })).rejects.toMatchObject({ code: 'assignment_source_request_invalid' });
    expect(f.store.first).not.toHaveBeenCalled();
  });

  it('allows writable work without implying publication, and conversations cannot publish', () => {
    expect(assignmentSourceMode({ ...row, mode: 'acting', execution_kind: 'workday' })).toEqual({ mode: 'work', publication: 'denied' });
    expect(assignmentSourceMode({ ...row, mode: 'acting', execution_kind: 'workday', allowed_outputs_json: '{"artifactKinds":["source-candidate"]}' })).toEqual({ mode: 'work', publication: 'candidate-only' });
    expect(assignmentSourceMode({ ...row, mode: 'acting', allowed_outputs_json: '{"artifactKinds":["source-candidate"]}' })).toEqual({ mode: 'analysis', publication: 'denied' });
    expect(() => assertSourceAssignmentLease(null, principal, 'assignment', 'runner', 'synthetic-lease', now)).toThrow();
  });
});

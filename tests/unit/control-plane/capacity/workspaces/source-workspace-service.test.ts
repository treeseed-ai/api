import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSourceCredentialRecipient, openSourceCredential } from '@treeseed/deployment/security/source';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { createSourceWorkspaceService, assertSourceAssignmentLease, assignmentSourceMode, assignmentPredecessorSourceCommits } from '../../../../../src/api/control-plane/repositories/providers/source/source-workspace-service.ts';

const mocks = vi.hoisted(() => ({ credential: vi.fn(), authority: vi.fn() }));
vi.mock('../../../../../src/security/provider-credential-authority.ts', () => ({ resolveGitHubSourceAuthority: mocks.credential }));
vi.mock('../../../../../src/api/capacity/services/accounts/lease-authority-service.ts', () => ({ evaluateProviderAssignmentLeaseAuthority: mocks.authority }));
const now = new Date('2026-09-10T23:00:00.000Z'), commit = 'a'.repeat(40);
const principal = { teamId: 'team', capacityProviderId: 'provider', membershipId: 'membership', scopes: ['provider:assignments:read'] };
const row = { id: 'assignment', team_id: 'team', project_id: 'project', capacity_provider_id: 'provider', membership_id: 'membership', runner_id: 'runner',
  lease_token: 'synthetic-lease', status: 'leased', lease_state: 'leased', lease_expires_at: '2026-09-10T23:05:00.000Z', attempt_count: 0, state_version: 7,
  execution_kind: 'conversation', workday_execution_mode: 'production', workday_parameters_json: '{}', mode: 'planning', allowed_outputs_json: '{}', workspace_context_json: '{}' };
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

const canonicalAttempt = {
	schemaVersion: 'treeseed.assignment-attempt/v1', id: 'assignment', idempotencyKey: 'assignment', teamId: 'team', projectId: 'project',
	workdayId: 'workday', nodeId: 'node', agentClass: 'tester', workItemId: 'tests-first', nodeRevision: 1, graphRevision: 1,
	sourceRef: { store: 'treedx', model: 'proposal', id: 'proposal', revision: 1, digest: `sha256:${'1'.repeat(64)}` },
	authorityRefs: [{ store: 'postgresql', model: 'decision', id: 'decision', revision: 1, digest: `sha256:${'4'.repeat(64)}` }],
	effectiveProfile: { profileRef: { store: 'treedx', model: 'agent', id: 'sdk/tester', revision: 1, digest: `sha256:${'2'.repeat(64)}` },
		activity: 'acting', handler: 'actor', handlerOrigin: 'agent-package', prompt: { system: 'Author exact failing tests first.' },
		permissionCeiling: { content: { read: [], write: [] }, tools: ['source.read', 'source.write'] } },
	requiredCapabilities: [], grant: { contentRead: [], contentWrite: [], sourceRead: ['repository'], sourceWrite: ['repository'], tools: ['source.read', 'source.write'] },
	provider: { providerId: 'provider', offerId: 'offer', executionProviderId: 'codex', modelConfigurationId: 'terra-medium', executionCapabilityId: 'code-change', offerRevision: 1, runtimeBuild: `sha256:${'3'.repeat(64)}` },
	contextRefs: [{ store: 'git', model: 'repository', id: 'repository', repository: 'repository', commit }], predecessorResultIds: [],
	acceptanceCriteria: ['Tests fail first.'], workspace: { mode: 'git', repository: 'repository', baseCommit: commit,
		branch: 'treeseed/assignments/assignment', writablePaths: ['.'] },
	estimate: { minimumSeconds: 1, expectedSeconds: 2, maximumSeconds: 3 },
	limits: { maximumSeconds: 3, maximumContextBytes: 1, maximumContextTokens: 1, maximumContextItems: 1 },
	deadline: '2026-09-11T00:00:00.000Z', leaseId: 'lease', reservationId: 'reservation', attempt: 1,
	status: 'created', createdAt: now.toISOString(),
} as const;

it('authorizes only exact same-repository Git predecessors from the immutable attempt', () => {
	const approved = 'b'.repeat(40);
	const attempt = { ...canonicalAttempt, predecessorResultIds: ['approved'] };
	const result = { schemaVersion: 'treeseed.assignment-result/v1', id: 'approved', assignmentId: 'earlier',
		status: 'completed', summary: 'Candidate committed.', references: [
			{ kind: 'git', repository: 'repository', commit: approved },
			{ kind: 'git', repository: 'other-repository', commit: 'c'.repeat(40) }],
		verification: [], usage: { elapsedSeconds: 1 }, diagnostics: [], completedAt: now.toISOString() };
	const row = { assignment_attempt_json: JSON.stringify(attempt), workspace_context_json: JSON.stringify({ predecessorResults: [result] }) };
	expect(assignmentPredecessorSourceCommits(row, ['repository', 'example/project'], commit)).toEqual([approved]);
	expect(() => assignmentPredecessorSourceCommits({ ...row, workspace_context_json: JSON.stringify({ predecessorResults: [] }) },
		['repository'], commit)).toThrow('do not match');
	expect(() => assignmentPredecessorSourceCommits({ ...row, workspace_context_json: JSON.stringify({ predecessorResults: [{ ...result, id: 'different' }] }) },
		['repository'], commit)).toThrow('invalid predecessor');
});

describe('provider source workspace authorization', () => {
  it('pins a revision and seals the credential to the exact current assignment and host key', async () => {
    const f = fixture();
    const response = await f.service({ principal }, 'assignment', f.request);
    expect(response.authorization).toMatchObject({ providerId: 'provider', assignmentId: 'assignment', attempt: 1, mode: 'analysis', acquisition: 'upstream-authorized', publication: 'denied', source: { teamId: 'team', projectId: 'project', commit } });
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
    { lease_expires_at: '2026-09-10T22:59:59Z' }, { lease_expires_at: 'invalid' }, { status: 'completed' }, { lease_state: 'released' }, { attempt_count: -1 }, { attempt_count: null }, { attempt_count: 0.5 }])('denies invalid provider/lease identity before Vault lookup', async override => {
    const f = fixture(override);
    await expect(f.service({ principal }, 'assignment', f.request)).rejects.toMatchObject({ code: 'assignment_source_lease_invalid' });
    expect(mocks.credential).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it.each([0, 1, 2])('maps lifecycle counter %i to a distinct current sandbox attempt', async attempt_count => {
    const f = fixture({ attempt_count });
    expect((await f.service({ principal }, 'assignment', f.request)).authorization.attempt).toBe(attempt_count + 1);
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

  it.each(['planning', 'estimating', 'reviewing', 'reporting', 'acting'])('keeps legacy %s source access read-only', mode => {
		expect(assignmentSourceMode({ ...row, mode, execution_kind: 'workday' })).toEqual({ mode: 'analysis', acquisition: 'upstream-authorized', publication: 'denied' });
	});

	it('does not infer publication authority from retired output metadata', () => {
		expect(assignmentSourceMode({ ...row, mode: 'acting', execution_kind: 'workday', allowed_outputs_json: '{"artifactKinds":["source"]}' })).toEqual({ mode: 'analysis', acquisition: 'upstream-authorized', publication: 'denied' });
		expect(() => assertSourceAssignmentLease(null, principal, 'assignment', 'runner', 'synthetic-lease', now)).toThrow();
	});

	it('uses anonymous upstream custody for a frozen simulation base and local custody for its approved predecessor', () => {
		const parsedAttempt = assignmentAttemptSchema.safeParse(canonicalAttempt);
		if (!parsedAttempt.success) throw new Error(parsedAttempt.error.message);
		const base = { ...row, workday_execution_mode: 'simulation', work_day_id: 'workday',
			workday_parameters_json: '{"acceptanceCampaignId":"campaign"}', assignment_attempt_json: JSON.stringify(canonicalAttempt) };
		expect(assignmentSourceMode(base)).toMatchObject({ mode: 'work', acquisition: 'upstream-public', publication: 'simulation-branch',
			publicationRef: 'simulation/campaign/workday/assignment' });
		const dependent = structuredClone(canonicalAttempt);
		dependent.workspace.baseCommit = '9'.repeat(40);
		expect(assignmentSourceMode({ ...base, assignment_attempt_json: JSON.stringify(dependent) })).toMatchObject({
			mode: 'work', acquisition: 'simulation-local', publication: 'simulation-branch' });
		const integration = structuredClone(canonicalAttempt);
		integration.predecessorResultIds = ['approved-actor-1', 'approved-actor-2'];
		expect(assignmentSourceMode({ ...base, assignment_attempt_json: JSON.stringify(integration) })).toMatchObject({
			mode: 'work', acquisition: 'simulation-local', publication: 'simulation-branch' });
	});
});

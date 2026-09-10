import { generateKeyPairSync } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveGitHubSourceAuthority } from '../../../../../src/security/provider-credential-authority.ts';
import { readServiceCredentials } from '../../../../../src/security/managed-secrets.ts';

vi.mock('../../../../../src/security/managed-secrets.ts', () => ({ readServiceCredentials: vi.fn() }));
const row = {
  id: 'authority', source_binding_id: 'binding', team_id: 'team', connection_id: 'connection',
  scheme: 'openbao', version: 7, credential_profile_id: 'github-repository-token',
  capabilities_json: '["repository-hosting"]', non_secret_config_json: '{"organization":"example"}',
};
const input = { teamId: 'team', owner: 'example', repository: 'project', env: {} };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readServiceCredentials).mockResolvedValue({ version: 7, values: { accessToken: 'synthetic-source-token' } } as never);
});

describe('assignment source credential custody', () => {
  it('reads the current pinned credential through managed custody', async () => {
    const store = { all: vi.fn(async (_sql: string, _parameters: unknown[]) => [row]) };
    await expect(resolveGitHubSourceAuthority({ ...input, store, bindingId: 'binding' }))
      .resolves.toMatchObject({ token: 'synthetic-source-token', username: 'x-access-token', bindingId: 'binding' });
    expect(store.all).toHaveBeenCalledWith(expect.stringContaining('AND b.id=?'), ['team', 'binding']);
    expect(readServiceCredentials).toHaveBeenCalledWith(store, 'team', 'connection', 'github-repository-token');
    const sql = store.all.mock.calls[0]?.[0];
    expect(sql).toContain("c.status='active'");
    expect(sql).toContain('a.team_id=c.team_id');
    expect(sql).toContain('b.team_id=c.team_id');
  });

  it.each([[], [row, { ...row, source_binding_id: 'another' }], [{ ...row, non_secret_config_json: '{"organization":"other"}' }]].map(rows => ({ rows })))(
    'rejects absent, ambiguous, or wrong-owner authority before reading secrets', async ({ rows }) => {
      await expect(resolveGitHubSourceAuthority({ ...input, store: { all: vi.fn(async () => rows) } })).rejects.toThrow('unambiguous');
      expect(readServiceCredentials).not.toHaveBeenCalled();
    },
  );

  it('does not fall back when the pinned binding disappears', async () => {
    const store = { all: vi.fn(async () => []) };
    await expect(resolveGitHubSourceAuthority({ ...input, store, bindingId: 'revoked' })).rejects.toThrow('pinned');
    expect(store.all).toHaveBeenCalledTimes(1);
    expect(readServiceCredentials).not.toHaveBeenCalled();
  });

  it('rejects stale credential versions and missing capability', async () => {
    await expect(resolveGitHubSourceAuthority({ ...input, store: { all: async () => [{ ...row, version: 6 }] } })).rejects.toThrow('stale');
    vi.clearAllMocks();
    await expect(resolveGitHubSourceAuthority({ ...input, store: { all: async () => [{ ...row, capabilities_json: '[]' }] } })).rejects.toThrow('capability');
    expect(readServiceCredentials).not.toHaveBeenCalled();
  });

  it('mints only read access to the exact repository for an App installation', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ token: 'synthetic-scoped-token', expires_at: '2030-01-01T00:00:00Z' })));
    const appRow = { ...row, scheme: 'app-installation', credential_profile_id: 'github-repository-app',
      non_secret_config_json: JSON.stringify({ githubConnectors: { repository: { accountLogin: 'example', installationId: '123', repositorySelection: 'selected' } } }) };
    await resolveGitHubSourceAuthority({ ...input, store: { all: async () => [appRow] }, fetchImpl,
      env: { TREESEED_GITHUB_REPOSITORY_APP_ID: '42', TREESEED_GITHUB_REPOSITORY_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() } });
    expect(fetchImpl).toHaveBeenCalledWith('https://api.github.com/app/installations/123/access_tokens', expect.objectContaining({
      body: JSON.stringify({ repositories: ['project'], permissions: { contents: 'read' } }),
    }));
    expect(readServiceCredentials).not.toHaveBeenCalled();
  });

  it('rejects malformed repository identities before querying custody', async () => {
    const store = { all: vi.fn() };
    await expect(resolveGitHubSourceAuthority({ ...input, store, repository: '../escape' })).rejects.toThrow('identity');
    expect(store.all).not.toHaveBeenCalled();
  });
});

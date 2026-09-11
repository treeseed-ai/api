import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserOidcOptions } from '@treeseed/identity';
import { createBrowserIdentityService, type BrowserCaller } from '../../../../../src/api/auth/browser/service.ts';
import { BROWSER_SESSION_PERMISSION, BROWSER_SESSION_SCOPE } from '@treeseed/sdk/identity';
import type { BrowserSessionStore, BrowserSessionTokens } from '../../../../../src/api/auth/browser/session-store.ts';

const mocked = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@treeseed/identity', () => ({ createBrowserOidcClient: mocked.create }));
beforeEach(() => vi.resetAllMocks());

describe('workload-authenticated browser session orchestration', () => {
  async function setup(expired = false) {
    const identity = { issuer: 'https://identity.example.test', subject: 'subject' };
    const principal = { identity, principalId: 'preserved-user', kind: 'human', audience: 'https://api.example.test', scopes: ['treeseed:read'] };
    const returned = { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 60 };
    const client = { begin: vi.fn(async () => 'https://identity.example.test/authorize'),
      finish: vi.fn(async () => ({ identity, principal, tokens: returned })),
      refresh: vi.fn(async () => ({ identity, principal, tokens: returned })),
      verifyAccessToken: vi.fn(async () => principal), revoke: vi.fn(async () => {}) };
    mocked.create.mockResolvedValue(client);
    let tokens: BrowserSessionTokens | undefined = { accessToken: 'existing-access', refreshToken: 'existing-refresh',
      resource: principal.audience, accessExpiresAt: Date.now() + (expired ? -1000 : 60000) };
    const sessions = { clientId: 'admin', create: vi.fn(async () => ({ handle: 'opaque-handle', expiresAt: new Date() })),
      use: vi.fn(async (_handle: string, run: Parameters<BrowserSessionStore['use']>[1]) => {
        if (!tokens) return null;
        const next = await run(tokens, { ...identity, userId: principal.principalId });
        if (next.tokens) tokens = next.tokens;
        if (next.remove) tokens = undefined;
        return next.result;
      }) };
    const oidc = { clientId: 'admin', resource: principal.audience } as BrowserOidcOptions;
    const service = await createBrowserIdentityService({ workloadPrincipalId: 'registered-app', oidc, sessions: sessions as unknown as BrowserSessionStore });
    const caller: BrowserCaller = { credential: { type: 'service_token', id: 'registered-app' },
      principal: { id: 'registered-app', roles: [], permissions: [BROWSER_SESSION_PERMISSION], scopes: [BROWSER_SESSION_SCOPE], metadata: { serviceId: 'registered-app' } } };
    return { service, caller, client, sessions, identity, principal, oidc };
  }
  it('denies ordinary users, another workload, missing permission and missing OAuth scope before execution', async () => {
    const f = await setup();
    const denied = [
      { ...f.caller, credential: { ...f.caller.credential, type: 'access_token' as const } },
      { ...f.caller, principal: { ...f.caller.principal, id: 'other-app' } },
      { ...f.caller, principal: { ...f.caller.principal, permissions: [] } },
      { ...f.caller, principal: { ...f.caller.principal, scopes: [] } },
    ];
    for (const caller of denied) {
      await expect(f.service.begin(caller, 'binding')).rejects.toThrow('authority');
      await expect(f.service.credentials(caller, 'handle')).rejects.toThrow('authority');
      await expect(f.service.logout(caller, 'handle')).rejects.toThrow('authority');
    }
    expect(f.client.begin).not.toHaveBeenCalled(); expect(f.sessions.use).not.toHaveBeenCalled();
  });
  it('returns only an opaque session handle after storing the verified preserved principal', async () => {
    const f = await setup();
    const result = await f.service.finish(f.caller, 'binding', new URL('https://admin.example.test/callback'));
    expect(result.handle).toBe('opaque-handle'); expect(JSON.stringify(result)).not.toContain('access');
    expect(f.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ ...f.identity, userId: 'preserved-user', tokens: expect.objectContaining({ accessToken: 'new-access' }) }));
  });
  it('revalidates current tokens, refreshing only under the supplied session transaction', async () => {
    const f = await setup(); await f.service.credentials(f.caller, 'handle');
    expect(f.client.verifyAccessToken).toHaveBeenCalled(); expect(f.client.refresh).not.toHaveBeenCalled();
    const expired = await setup(true), result = await expired.service.credentials(expired.caller, 'handle');
    expect(result?.accessToken).toBe('new-access'); expect(JSON.stringify(result)).not.toContain('new-refresh');
    expect(expired.client.refresh).toHaveBeenCalledWith('existing-refresh', expect.objectContaining(expired.identity));
  });
  it('removes the locked record even when upstream revocation is unavailable', async () => {
    const f = await setup(); f.client.revoke.mockRejectedValue(new Error('provider unavailable'));
    expect(await f.service.logout(f.caller, 'handle')).toEqual({ loggedOut: true, upstreamRevoked: false });
    expect(await f.service.credentials(f.caller, 'handle')).toBeNull();
  });
  it('denies incorrectly paired app/session namespaces before discovering credentials', async () => {
    const f = await setup();
    await expect(createBrowserIdentityService({ workloadPrincipalId: 'registered-app', oidc: f.oidc,
      sessions: { ...f.sessions, clientId: 'market' } as unknown as BrowserSessionStore })).rejects.toThrow('namespace');
  });
});

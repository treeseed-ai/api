import { describe, it, expect, vi } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';
import { createIdentityAuthenticator } from '../../../../src/api/auth/identity-authenticator.ts';

describe('external identity mapping', () => {
  async function setup({ mapped = true, active = true } = {}) {
    const keys = await generateKeyPair('RS256');
    const principal = { userId: 'preserved-user', principal: { id: 'preserved-user', roles: ['reader'], permissions: ['project:read'], scopes: ['read', 'write'], metadata: {} } };
    const first = vi.fn(async (sql: string, _params: unknown[]) => sql.includes('identity_workloads') ? null : sql.includes('user_identities') ? mapped ? { user_id: principal.userId, status: 'active' } : null : active ? { id: principal.userId } : null);
    const principalForUser = vi.fn(async () => principal);
    const authenticate = createIdentityAuthenticator({ issuer: 'https://identity.example.test', audience: 'https://api.example.test', verificationKey: keys.publicKey, store: { first, principalForUser } as any });
    const token = (issuer = 'https://identity.example.test', audience = 'https://api.example.test') => new SignJWT({ typ: 'Bearer', azp: 'admin', scope: 'read admin', email: 'owner@example.test', roles: ['owner'] })
      .setProtectedHeader({ alg: 'RS256' }).setIssuer(issuer).setAudience(audience).setSubject('exact-subject').setIssuedAt().setExpirationTime('1m').sign(keys.privateKey);
    return { authenticate, token, first, principalForUser };
  }
  it('preserves the local user and database roles while intersecting OAuth scopes', async () => {
    const f = await setup(); const result = await f.authenticate(await f.token());
    expect(result.userId).toBe('preserved-user');
    expect(result.principal.roles).toEqual(['reader']);
    expect(result.principal.scopes).toEqual(['read']);
    expect(result.credential.oauthClientId).toBe('admin');
    expect(result.credential.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(f.first.mock.calls[0][1]).toEqual(['https://identity.example.test', 'exact-subject']);
    expect(f.principalForUser).toHaveBeenCalledWith('preserved-user');
  });
  it('never falls back to matching email for an unmapped identity', async () => {
    const f = await setup({ mapped: false }); await expect(f.authenticate(await f.token())).rejects.toMatchObject({ code: 'identity_authentication_failed' });
    expect(f.first).toHaveBeenCalledTimes(2); expect(f.principalForUser).not.toHaveBeenCalled();
    expect(f.first.mock.calls[0][0]).not.toMatch(/email|username/);
  });
  it('denies a disabled local user before authorization lookup', async () => {
    const f = await setup({ active: false }); await expect(f.authenticate(await f.token())).rejects.toMatchObject({ code: 'identity_authentication_failed' });
    expect(f.principalForUser).not.toHaveBeenCalled();
  });
  it('rejects other issuers and audiences before any database lookup', async () => {
    const f = await setup();
    await expect(f.authenticate(await f.token('https://other.example.test'))).rejects.toThrow();
    await expect(f.authenticate(await f.token(undefined, 'https://market.example.test'))).rejects.toThrow();
    expect(f.first).not.toHaveBeenCalled();
  });
});

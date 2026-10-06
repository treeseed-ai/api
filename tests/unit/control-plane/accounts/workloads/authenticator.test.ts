import { describe, expect, it, vi } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';
import { createIdentityAuthenticator } from '../../../../../src/api/auth/identity-authenticator.ts';

describe('registered workload identity', () => {
  async function setup() {
    const keys = await generateKeyPair('RS256');
    let service: Record<string, unknown> | null = { id: 'preserved-service', client_id: 'registered-client', status: 'active',
      display_name: 'Admin BFF', permissions: ['auth:read:self'], scopes: ['treeseed:read'] };
    let human: Record<string, unknown> | null = null;
    const first = vi.fn(async (sql: string) => sql.includes('identity_workloads') ? service : human);
    const principalForUser = vi.fn();
    const authenticate = createIdentityAuthenticator({ issuer: 'https://identity.example.test', audience: 'https://api.example.test',
      verificationKey: keys.publicKey, store: { first, principalForUser } as any });
    const token = (client: string | undefined = 'registered-client', scope = 'treeseed:read treeseed:execution') => new SignJWT({
      typ: 'Bearer', scope, azp: client, roles: ['platform_admin'], permissions: ['*:*:*'], email: 'owner@example.test',
    }).setProtectedHeader({ alg: 'RS256' }).setIssuer('https://identity.example.test').setAudience('https://api.example.test')
      .setSubject('registered-subject').setIssuedAt().setExpirationTime('1m').sign(keys.privateKey);
    return { authenticate, token, first, principalForUser,
      service: (value: Record<string, unknown> | null) => { service = value; }, human: (value: Record<string, unknown> | null) => { human = value; } };
  }
  it('uses the preserved local service ID and only explicit database permissions/scopes', async () => {
    const f = await setup(), result = await f.authenticate(await f.token());
    expect(result.userId).toBeUndefined(); expect(result.principal.id).toBe('preserved-service');
    expect(result.credential.type).toBe('service_token'); expect(result.principal.roles).toEqual([]);
    expect(result.principal.permissions).toEqual(['auth:read:self']); expect(result.principal.scopes).toEqual(['treeseed:read']);
    expect(f.principalForUser).not.toHaveBeenCalled();
    expect((await f.authenticate(await f.token('registered-client', ''))).principal.scopes).toEqual([]);
  });
  it('denies the wrong registered client even with the same signed subject', async () => {
    const f = await setup(); await expect(f.authenticate(await f.token('different-client'))).rejects.toThrow();
  });
  it('denies missing, revoked and malformed registrations on each request', async () => {
    const f = await setup(), token = await f.token(); await f.authenticate(token);
    for (const record of [null, { id: 'preserved-service', status: 'revoked' }, { id: 'preserved-service', status: 'active', permissions: '*' }]) {
      f.service(record); await expect(f.authenticate(token)).rejects.toThrow();
    }
  });
  it('denies collisions with active or disabled human mappings rather than choosing an identity kind', async () => {
    const f = await setup();
    for (const status of ['active', 'disabled']) {
      f.human({ user_id: 'another-user', status }); await expect(f.authenticate(await f.token())).rejects.toThrow();
    }
    expect(f.principalForUser).not.toHaveBeenCalled();
  });
});

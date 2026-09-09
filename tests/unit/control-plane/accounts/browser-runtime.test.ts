import { generateKeyPair } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { EncryptedEnvelopeCodec, StaticEnvelopeKeyProvider } from '@treeseed/sdk/security';
import { randomBytes } from 'node:crypto';
import { createApiIdentityRuntime } from '../../../../src/api/auth/browser/runtime.ts';

async function setup() {
  const key = await generateKeyPair('RS256');
  const issuer = 'https://identity.test/realms/local';
  const transport = vi.fn(async () => Response.json({ issuer,
    authorization_endpoint: `${issuer}/protocol/openid-connect/auth`, token_endpoint: `${issuer}/protocol/openid-connect/token`,
    jwks_uri: `${issuer}/protocol/openid-connect/certs`, revocation_endpoint: `${issuer}/protocol/openid-connect/revoke`,
    response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
    code_challenge_methods_supported: ['S256'],
  }));
  return { issuer, resource: 'https://api.test', scopes: ['read'], transport,
    applications: [{ clientId: 'admin-browser', workloadPrincipalId: 'admin-bff', redirectUri: 'https://admin.test/auth/callback',
      privateKey: key.privateKey as CryptoKey, scopes: ['read'] }],
    database: { transaction: vi.fn() },
    codec: new EncryptedEnvelopeCodec(new StaticEnvelopeKeyProvider('systemd-credential', { id: 'test', version: 1, key: randomBytes(32) })),
    store: { first: vi.fn(), principalForUser: vi.fn() },
  };
}
describe('API Identity runtime composition', () => {
  it('composes opaque stores and publishes exact resource metadata without enrolling users', async () => {
    const options = await setup(), runtime = await createApiIdentityRuntime(options);
    expect([...runtime.services.keys()]).toEqual(['admin-bff']);
    expect(runtime.metadata).toEqual({ resource: 'https://api.test', authorization_servers: [options.issuer],
      scopes_supported: ['read'], bearer_methods_supported: ['header'] });
    expect(options.store.first).not.toHaveBeenCalled();
    expect(options.database.transaction).not.toHaveBeenCalled();
    expect(JSON.stringify(runtime.metadata)).not.toContain('privateKey');
  });
  it.each(['http', 'duplicate-client', 'duplicate-workload', 'duplicate-callback', 'unsupported-scope', 'public-key', 'mixed-client-role'])('rejects %s before any network or database access', async fault => {
    const options = await setup(), second = { ...options.applications[0], clientId: 'market-browser', workloadPrincipalId: 'market-bff',
      redirectUri: 'https://market.test/auth/callback', privateKey: (await generateKeyPair('RS256')).privateKey as CryptoKey };
    options.applications.push(second);
    if (fault === 'http') options.issuer = 'http://identity.test';
    if (fault === 'duplicate-client') second.clientId = 'admin-browser';
    if (fault === 'duplicate-workload') second.workloadPrincipalId = 'admin-bff';
    if (fault === 'duplicate-callback') second.redirectUri = options.applications[0].redirectUri;
    if (fault === 'unsupported-scope') second.scopes = ['admin'];
    if (fault === 'public-key') second.privateKey = (await generateKeyPair('RS256')).publicKey as CryptoKey;
    if (fault === 'mixed-client-role') second.clientId = 'admin-bff';
    await expect(createApiIdentityRuntime(options)).rejects.toThrow();
    expect(options.transport).not.toHaveBeenCalled(); expect(options.database.transaction).not.toHaveBeenCalled();
  });
});

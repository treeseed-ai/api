import { exportPKCS8, generateKeyPair } from 'jose';
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createConfiguredApiIdentityRuntime } from '../../../../../src/api/auth/browser/configured-runtime.ts';

async function fixture() {
  const issuer = 'https://identity.test/realms/local';
  const material = new Map<string, string>([
    ['session-key-two', randomBytes(32).toString('base64url')],
    ['session-key-one', randomBytes(32).toString('base64url')],
    ['admin-key', await exportPKCS8((await generateKeyPair('RS256', { extractable: true })).privateKey)],
  ]);
  const returned: Buffer[] = [];
  const resolveCredential = vi.fn(async (reference: string) => {
    const value = material.get(reference); if (!value) throw new Error('private provider diagnostic');
    const buffer = Buffer.from(value); returned.push(buffer); return buffer;
  });
  const input = { schemaVersion: 'treeseed.identity-api-runtime/v1', issuer, resource: 'https://api.test', scopes: ['read'],
    sessionKeys: { id: 'browser-sessions', active: { version: 2, credentialReference: 'session-key-two' }, historical: [{ version: 1, credentialReference: 'session-key-one' }] },
    applications: [{ clientId: 'admin-browser', workloadPrincipalId: 'admin-bff', redirectUri: 'https://admin.test/auth/callback', scopes: ['read'], signingKeyReference: 'admin-key' }] };
  const transport = vi.fn(async () => Response.json({ issuer,
    authorization_endpoint: `${issuer}/protocol/openid-connect/auth`, token_endpoint: `${issuer}/protocol/openid-connect/token`,
    jwks_uri: `${issuer}/protocol/openid-connect/certs`, revocation_endpoint: `${issuer}/protocol/openid-connect/revoke`,
    response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'],
  }));
  const database = { transaction: vi.fn() };
  return { input, material, returned, options: { database, resolveCredential, transport } };
}
describe('API runtime protected-reference composition', () => {
  it('uses declared bootstrap keys without DB writes or credential output', async () => {
    const f = await fixture(); const runtime = await createConfiguredApiIdentityRuntime(f.input, f.options);
    expect([...runtime.services.keys()]).toEqual(['admin-bff']);
    expect(runtime.metadata.resource).toBe(f.input.resource);
    expect(f.options.resolveCredential.mock.calls.map(call => call[0])).toEqual(['session-key-two', 'session-key-one', 'admin-key']);
    expect(f.options.database.transaction).not.toHaveBeenCalled();
    expect(f.returned.every(buffer => buffer.every(byte => byte === 0))).toBe(true);
    expect(JSON.stringify(runtime.metadata)).not.toMatch(/credentialReference|PRIVATE KEY|session-key/);
  });
  it('rejects invalid descriptors before reading any custody reference', async () => {
    const f = await fixture(); f.input.applications[0]!.signingKeyReference = f.input.sessionKeys.active.credentialReference;
    await expect(createConfiguredApiIdentityRuntime(f.input, f.options)).rejects.toThrow('verify protected bootstrap bindings');
    expect(f.options.resolveCredential).not.toHaveBeenCalled(); expect(f.options.transport).not.toHaveBeenCalled();
  });
  it.each(['missing', 'invalid-session', 'reused-session', 'invalid-signer'])('fails closed and clears read buffers for %s', async fault => {
    const f = await fixture();
    if (fault === 'missing') f.material.delete('session-key-one');
    if (fault === 'invalid-session') f.material.set('session-key-two', 'private invalid key');
    if (fault === 'reused-session') f.material.set('session-key-one', f.material.get('session-key-two')!);
    if (fault === 'invalid-signer') f.material.set('admin-key', 'private invalid PEM');
    await expect(createConfiguredApiIdentityRuntime(f.input, f.options)).rejects.toThrow('Configured Identity runtime is unavailable; verify protected bootstrap bindings');
    expect(f.options.transport).not.toHaveBeenCalled();
    expect(f.returned.every(buffer => buffer.every(byte => byte === 0))).toBe(true);
  });
});

import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';
import { BROWSER_SESSION_BRIDGE_PATH } from '@treeseed/sdk/identity';
import { installApiIdentityRoutes } from '../../../../../src/api/auth/browser/api-routes.ts';
import { createIdentityAuthenticator } from '../../../../../src/api/auth/identity-authenticator.ts';
import { controlPlaneOperations } from '../../../../../src/api/control-plane/catalog/index.ts';
import { OperationRegistry } from '../../../../../src/api/control-plane/catalog/operation-registry.ts';

const issuer = 'https://identity.example/realms/treeseed', resource = 'https://api.example';
async function fixture() {
  const keys = await generateKeyPair('RS256');
  const first = vi.fn(async (sql: string) => sql.includes('identity_workloads') ? null
    : sql.includes('user_identities') ? { user_id: 'preserved-user', status: 'active' } : { id: 'preserved-user' });
  const principalForUser = vi.fn(async () => ({ userId: 'preserved-user', principal: { id: 'preserved-user', roles: ['reader'],
    permissions: [], scopes: ['treeseed:read'], metadata: {} } }));
  const authenticate = createIdentityAuthenticator({ issuer, audience: resource, verificationKey: keys.publicKey,
    store: { first, principalForUser } as never });
  const app = new Hono();
  installApiIdentityRoutes(app, { authenticate, services: new Map(), metadata: {
    resource, authorization_servers: [issuer], bearer_methods_supported: ['header'], scopes_supported: ['treeseed:read'],
  } }, { registry: new OperationRegistry([controlPlaneOperations.require('status.show')]) });
  const token = (audience = resource, scope = 'treeseed:read') => new SignJWT({ typ: 'Bearer', scope })
    .setProtectedHeader({ alg: 'RS256' }).setIssuer(issuer).setAudience(audience).setSubject('exact-subject')
    .setIssuedAt().setExpirationTime('1m').sign(keys.privateKey);
  return { app, token, first };
}

it('publishes configured resource metadata, never the incoming Host or an API-local issuer', async () => {
  const { app } = await fixture();
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const response = await app.request(`https://attacker.example${path}`, { headers: { host: 'attacker.example' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resource, authorization_servers: [issuer] });
  }
  for (const path of ['/.well-known/oauth-authorization-server', '/oauth/token', '/oauth/device_authorization', '/oauth/authorize', '/oauth/revoke']) {
    for (const method of ['GET', 'POST']) expect((await app.request(path, { method })).status).toBe(404);
  }
});

it('uses verified Identity tokens for existing resource operations and denies wrong audiences without database reads', async () => {
  const { app, token, first } = await fixture();
  expect((await app.request('/v1/status', { headers: { authorization: `Bearer ${await token()}` } })).status).toBe(200);
  first.mockClear();
  const response = await app.request('/v1/status', { headers: { authorization: `Bearer ${await token('https://market.example')}` } });
  expect(response.status).toBe(401); expect(first).not.toHaveBeenCalled();
  expect(await response.text()).not.toContain('IdentityAuthenticationError');
});

it('does not grant REST authority from roles when the token omits the delegated scope', async () => {
  const { app, token } = await fixture();
  expect((await app.request('/v1/status', { headers: { authorization: `Bearer ${await token(resource, '')}` } })).status).toBe(403);
});

it('rejects invalid tokens with an authentication challenge, not a leaked verifier error', async () => {
  const { app } = await fixture();
  for (const path of ['/v1/status', '/mcp']) {
    const response = await app.request(`https://api.example${path}`, { method: path === '/mcp' ? 'POST' : 'GET',
      headers: { host: 'api.example', authorization: 'Bearer invalid' } });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('oauth-protected-resource/mcp');
    expect(await response.text()).not.toContain('IdentityAuthenticationError');
  }
});

it('installs the workload-only bridge but denies an ordinary user token and browser origins', async () => {
  const { app, token } = await fixture();
  const headers = { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' };
  expect((await app.request(`${BROWSER_SESSION_BRIDGE_PATH}/begin`, { method: 'POST', headers, body: '{}' })).status).toBe(403);
  expect((await app.request(`${BROWSER_SESSION_BRIDGE_PATH}/begin`, { method: 'POST',
    headers: { ...headers, origin: 'https://admin.example' }, body: '{}' })).status).toBe(403);
});

it('keeps MCP DNS-rebinding and untrusted-browser protections with the configured public host', async () => {
  const { app, token } = await fixture();
  const authorization = `Bearer ${await token()}`;
  for (const headers of [{ host: 'attacker.example', authorization },
    { host: 'api.example', origin: 'https://attacker.example', authorization }]) {
    expect((await app.request('https://api.example/mcp', { method: 'POST', headers })).status).toBe(403);
  }
});

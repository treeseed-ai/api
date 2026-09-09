import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { installIdentityBrowserRoutes } from '../../../../../src/api/auth/browser/routes.ts';
import type { BrowserCaller, createBrowserIdentityService } from '../../../../../src/api/auth/browser/service.ts';

describe('server-only Identity browser bridge', () => {
  function setup() {
    const credentials = { accessToken: 'synthetic-api-token', resource: 'https://api.example.test', expiresAt: Date.now() + 60000,
      principal: { principalId: 'mapped-user', kind: 'human', audience: 'https://api.example.test', scopes: ['treeseed:read'], identity: { issuer: 'https://identity.example.test', subject: 'subject' } } };
    const caller: BrowserCaller = { credential: { type: 'service_token', id: 'app' },
      principal: { id: 'app', roles: [], permissions: [], scopes: [], metadata: {} } };
    const service = { assertCaller: vi.fn(), begin: vi.fn(async () => ({ authorizationUrl: 'https://identity.example.test/auth' })),
      finish: vi.fn(async () => ({ handle: 'h'.repeat(43), expiresAt: new Date(Date.now() + 60000).toISOString() })), credentials: vi.fn(async () => credentials),
      logout: vi.fn(async () => ({ loggedOut: true, upstreamRevoked: true })) };
    const authenticate = vi.fn(async (token: string) => token === 'verified-workload' ? caller : null);
    const app = new Hono(); installIdentityBrowserRoutes(app, { authenticate, services: new Map([['app', service as unknown as Awaited<ReturnType<typeof createBrowserIdentityService>>]]) });
    const request = (body: unknown, headers: Record<string, string> = { authorization: 'Bearer verified-workload' }, operation = 'credentials') => app.request(`/internal/identity/browser/v1/${operation}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    return { request, service, authenticate, caller, credentials };
  }
  it('requires workload authentication; browser cookies, origins and bad credentials grant nothing', async () => {
    const f = setup();
    for (const headers of [{ cookie: 'session=anything' }, { authorization: 'Bearer bad' }, { authorization: 'Bearer verified-workload', origin: 'https://admin.example.test' }]) {
      const result = await f.request({ handle: 'h'.repeat(43) }, headers);
      expect([401, 403]).toContain(result.status); expect(result.headers.get('cache-control')).toBe('no-store');
      expect(await result.text()).not.toContain('synthetic-api-token');
    }
    expect(f.service.credentials).not.toHaveBeenCalled();
  });
  it('cannot select another application, issuer or audience through request fields', async () => {
    const f = setup();
    const result = await f.request({ handle: 'h'.repeat(43), clientId: 'market', resource: 'https://other-api.example.test' });
    expect(result.status).toBe(400); expect(f.service.credentials).not.toHaveBeenCalled();
    f.caller.principal.id = 'unknown-app';
    expect((await f.request({ handle: 'h'.repeat(43) })).status).toBe(403);
  });
  it('returns credentials only to the permitted server and redacts provider failures', async () => {
    const f = setup();
    const result = await f.request({ handle: 'h'.repeat(43) });
    expect(result.status).toBe(200); expect(result.headers.get('cache-control')).toBe('no-store');
    expect(await result.json()).toEqual({ data: f.credentials });
    f.service.credentials.mockRejectedValue(new Error('private-token-and-provider-details'));
    const failure = await f.request({ handle: 'h'.repeat(43) });
    expect(failure.status).toBe(400); expect(await failure.text()).not.toContain('private-token');
  });
  it('enforces application permissions and body bounds before session operations', async () => {
    const f = setup(); f.service.assertCaller.mockImplementation(() => { throw new Error('denied'); });
    expect((await f.request({ handle: 'h'.repeat(43) })).status).toBe(403);
    expect((await f.request({ handle: 'x'.repeat(17000) })).status).toBe(413);
    expect(f.service.credentials).not.toHaveBeenCalled();
  });
});

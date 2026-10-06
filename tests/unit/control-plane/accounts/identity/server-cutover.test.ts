import { expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { request as nativeRequest } from 'node:http';
const mocks = vi.hoisted(() => ({ load: vi.fn(), app: vi.fn(), close: vi.fn(), migrate: vi.fn(), credentials: vi.fn() }));
vi.mock('../../../../../src/api/configuration/identity-runtime.ts', () => ({ loadManagedApiIdentityRuntime: mocks.load }));
vi.mock('../../../../../src/api/configuration/runtime-config.ts', () => ({ resolveApiConfig: () => ({ baseUrl: 'https://api.test', port: 0, host: '127.0.0.1' }) }));
vi.mock('../../../../../src/api/support/app.ts', () => ({ createPlatformApiApp: mocks.app }));
vi.mock('../../../../../src/api/support/control-plane-postgres.js', () => ({ createControlPlanePostgresDatabase: () => ({ migrate: mocks.migrate, close: mocks.close }) }));
vi.mock('../../../../../src/api/app/support/runtime/foundation-runtime-utilities.ts', async (original) => ({
  ...await original<typeof import('../../../../../src/api/app/support/runtime/foundation-runtime-utilities.ts')>(),
  ensureControlPlaneCredentialSchema: mocks.credentials,
}));
import { createApiServer, hasRequestBody } from '../../../../../src/api/support/server.ts';

it('classifies execution transport methods without inventing a body for GET or HEAD', () => {
  for (const method of ['GET', 'HEAD']) expect(hasRequestBody(method)).toBe(false);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'get', 'head', '', undefined])
    expect(hasRequestBody(method)).toBe(true);
});

it('refuses to create a listener or legacy app when managed Identity bootstrap is unavailable', async () => {
  mocks.load.mockRejectedValue(new Error('Managed API Identity bootstrap is unavailable'));
  await expect(createApiServer()).rejects.toMatchObject({ code: 'IDENTITY_FAILED', cause: expect.objectContaining({ message: 'Managed API Identity bootstrap is unavailable' }) });
  expect(mocks.app).not.toHaveBeenCalled();
  expect(mocks.close).toHaveBeenCalledOnce();
});

it('native API listener preserves exact execution request bytes and headers through bodyless methods and retained downstream failure', async () => {
  // Identity/database bootstrap are supplied inputs here. The owning Node HTTP
  // listener, IncomingMessage bridge and Hono request/response are real; this
  // case does not claim authenticated provider admission or database closure.
  const observations: Array<{ method: string; path: string; body: string; scope: string | undefined }> = [];
  const app = new Hono();
  app.all('/v1/providers/assignments/native', async c => {
    observations.push({ method: c.req.method, path: c.req.path,
      body: Buffer.from(await c.req.arrayBuffer()).toString('utf8'), scope: c.req.header('x-execution-scope') });
    if (c.req.header('x-controlled-failure') === 'yes') throw new Error('retained downstream execution failure');
    return c.json({ received: true }, 202, { 'x-execution-receipt': 'native-receipt' });
  });
  app.onError((_error, c) => c.json({ ok: false, code: 'controlled_execution_failure' }, 503));
  mocks.load.mockResolvedValue({}); mocks.app.mockReturnValue(app);
  mocks.migrate.mockResolvedValue(undefined); mocks.credentials.mockResolvedValue(undefined);
  const instance = await createApiServer();
  const address = instance.server.address();
  if (!address || typeof address === 'string') throw new Error('Native API listener address is unavailable.');
  const body = '{"assignmentId":"native-assignment","decisionIds":["exact-decision"],"text":"e\u0301"}\n';
  const send = (method: string, failure = false) => new Promise<{ status: number | undefined; body: string; receipt: string | string[] | undefined }>((resolve, reject) => {
    const request = nativeRequest({ host: '127.0.0.1', port: address.port, method,
      path: '/v1/providers/assignments/native', headers: { 'content-type': 'application/json',
        'x-execution-scope': ['read', 'write'],
        ...(method === 'GET' || method === 'HEAD' ? {} : { 'content-length': String(Buffer.byteLength(body)) }),
        ...(failure ? { 'x-controlled-failure': 'yes' } : {}) } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'), receipt: response.headers['x-execution-receipt'] }));
    });
    request.once('error', reject);
    request.end(method === 'GET' || method === 'HEAD' ? undefined : Buffer.from(body));
  });
  try {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'GET', 'HEAD']) {
      expect(await send(method), method).toEqual({ status: 202, body: method === 'HEAD' ? '' : '{"received":true}', receipt: 'native-receipt' });
    }
    expect(await send('POST', true)).toEqual({ status: 503, body: '{"ok":false,"code":"controlled_execution_failure"}', receipt: undefined });
    expect(await send('POST')).toEqual({ status: 202, body: '{"received":true}', receipt: 'native-receipt' });
    expect(observations).toEqual([...['POST', 'PUT', 'PATCH', 'DELETE', 'GET', 'HEAD'], 'POST', 'POST'].map(method => ({
      method, path: '/v1/providers/assignments/native', body: method === 'GET' || method === 'HEAD' ? '' : body, scope: 'read, write',
    })));
  } finally { await instance.close(); }
  expect(instance.server.listening).toBe(false);
  expect(instance.server.address()).toBeNull();
});

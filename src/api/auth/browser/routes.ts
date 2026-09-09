import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { BROWSER_SESSION_BRIDGE_PATH, browserSessionRequests as schemas, browserSessionResponses } from '@treeseed/sdk/identity';
import type { BrowserCaller, createBrowserIdentityService } from './service.ts';

type Service = Awaited<ReturnType<typeof createBrowserIdentityService>>;

/** Server-to-server only, never a browser-cookie auth surface. App selection
 * comes exclusively from the verified workload principal and configured map.
 * Do not register these routes before coordinated Identity activation. */
export function installIdentityBrowserRoutes(app: Hono, options: {
  authenticate(token: string): Promise<BrowserCaller | null>;
  services: ReadonlyMap<string, Service>;
}) {
  const prefix = BROWSER_SESSION_BRIDGE_PATH;
  app.use(`${prefix}/*`, async (c, next) => {
    c.header('cache-control', 'no-store'); c.header('pragma', 'no-cache');
    // No browser origin/cookie authentication or CORS exchange on this bridge.
    if (c.req.header('origin')) return c.json({ error: 'application_authentication_required' }, 403);
    await next();
  });
  app.use(`${prefix}/*`, bodyLimit({ maxSize: 16384, onError: c => c.json({ error: 'request_too_large' }, 413) }));
  app.post(`${prefix}/:operation`, async c => {
    const token = c.req.header('authorization')?.match(/^Bearer ([^\s]+)$/u)?.[1];
    let caller: BrowserCaller | null = null;
    try { if (token && token.length <= 16384) caller = await options.authenticate(token); } catch { /* Redacted auth failure. */ }
    if (!caller) return c.json({ error: 'application_authentication_required' }, 401);
    const service = options.services.get(caller.principal.id);
    try { if (!service) throw new Error(); service.assertCaller(caller); }
    catch { return c.json({ error: 'application_session_access_denied' }, 403); }
    if (!c.req.header('content-type')?.startsWith('application/json')) return c.json({ error: 'json_required' }, 415);
    const operation = c.req.param('operation');
    if (!Object.hasOwn(schemas, operation)) return c.json({ error: 'operation_not_found' }, 404);
    const body: unknown = await c.req.json().catch(() => null);
    try {
      let result: unknown;
      if (operation === 'begin') result = await service!.begin(caller, schemas.begin.parse(body).browserBinding);
      else if (operation === 'finish') {
        const input = schemas.finish.parse(body);
        result = await service!.finish(caller, input.browserBinding, new URL(input.callback));
      } else if (operation === 'credentials') result = await service!.credentials(caller, schemas.credentials.parse(body).handle);
      else result = await service!.logout(caller, schemas.logout.parse(body).handle);
      if (result === null) return c.json({ error: 'browser_session_unavailable' }, 401);
      return c.json({ data: browserSessionResponses[operation as keyof typeof browserSessionResponses].parse(result) });
    } catch { return c.json({ error: 'browser_session_operation_failed' }, 400); }
  });
}

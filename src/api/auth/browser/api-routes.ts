import type { Hono } from 'hono';
import { protectedResourceMetadataSchema } from '@treeseed/sdk/identity';
import type { createApiIdentityRuntime } from './runtime.ts';
import { installIdentityBrowserRoutes } from './routes.ts';
import { installControlPlaneResourceRoutes } from '../../control-plane/http/resource-routes.ts';

/** One resource server plus the workload-authenticated BFF bridge. It cannot
 * issue passwords, API tokens or OAuth grants. The approved issuer does that.
 */
export function installApiIdentityRoutes(app: Hono, runtime: Awaited<ReturnType<typeof createApiIdentityRuntime>>, options: {
  registry: Parameters<typeof installControlPlaneResourceRoutes>[2];
  confirmations?: Parameters<typeof installControlPlaneResourceRoutes>[3];
  mcpBusForPrincipal?: Parameters<typeof installControlPlaneResourceRoutes>[4];
}) {
  const metadata = protectedResourceMetadataSchema.parse(runtime.metadata);
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    app.get(path, c => c.json(metadata, 200, { 'cache-control': 'public, max-age=60' }));
  }
  installIdentityBrowserRoutes(app, runtime);
  return installControlPlaneResourceRoutes(app, runtime.authenticate, options.registry, options.confirmations,
    options.mcpBusForPrincipal, metadata.resource);
}

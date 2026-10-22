import type { Env, Hono } from 'hono';
import { protectedResourceMetadataSchema } from '@treeseed/sdk/identity';
import type { createApiIdentityRuntime } from './runtime.ts';
import { installIdentityBrowserRoutes } from './routes.ts';
import { installControlPlaneResourceRoutes } from '../../control-plane/http/resource-routes.ts';
import { controlPlaneOperations } from '../../control-plane/catalog/index.ts';

/** One resource server plus the workload-authenticated BFF bridge. It cannot
 * issue passwords, API tokens or OAuth grants. The approved issuer does that.
 */
export function installApiIdentityRoutes<E extends Env>(app: Hono<E>, runtime: Awaited<ReturnType<typeof createApiIdentityRuntime>>, options: {
  registry: Parameters<typeof installControlPlaneResourceRoutes>[2];
  confirmations?: Parameters<typeof installControlPlaneResourceRoutes>[3];
  mcpBusForPrincipal?: Parameters<typeof installControlPlaneResourceRoutes>[4];
}) {
  const metadata = protectedResourceMetadataSchema.parse(runtime.metadata);
  const registry = options.registry ?? controlPlaneOperations;
  const mcpScopes = new Set<string>(registry.catalog.operations
    .filter(operation => operation.surfaces.includes('mcp_tool') || operation.surfaces.includes('mcp_resource'))
    .flatMap(operation => operation.oauthScopes));
  const mcpMetadata = { ...metadata, scopes_supported: (metadata.scopes_supported ?? []).filter(scope => mcpScopes.has(scope)) };
  app.get('/.well-known/oauth-protected-resource', c => c.json(metadata, 200, { 'cache-control': 'public, max-age=60' }));
  app.get('/.well-known/oauth-protected-resource/mcp', c => c.json(mcpMetadata, 200, { 'cache-control': 'public, max-age=60' }));
  installIdentityBrowserRoutes(app, runtime);
  return installControlPlaneResourceRoutes(app, runtime.authenticate, registry, options.confirmations,
    options.mcpBusForPrincipal, metadata.resource);
}

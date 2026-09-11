import type { Hono } from 'hono';
import type { ServerEventBus } from '@modelcontextprotocol/server';
import { controlPlaneOperations } from '../catalog/index.ts';
import type { OperationRegistry } from '../catalog/operation-registry.ts';
import type { ConfirmationService } from '../confirmation/confirmation-service.ts';
import { installOAuthProtocolRoutes, type OAuthRuntimeProvider } from '../oauth/oauth-routes.ts';
import { installControlPlaneResourceRoutes, type AuthenticatedPrincipal } from './resource-routes.ts';

/** Existing app composition only, removed with the coordinated issuer cutover.
 * The Identity composition never calls this or installs a fallback issuer. */
export function installControlPlaneProtocolRoutes(
  app: Hono,
  authenticateBearerToken: (token: string) => Promise<AuthenticatedPrincipal | null>,
  oauthProvider?: OAuthRuntimeProvider,
  registry: OperationRegistry = controlPlaneOperations,
  confirmations?: ConfirmationService,
  mcpBusForPrincipal?: (principal: AuthenticatedPrincipal['principal']) => Promise<ServerEventBus | undefined>,
  publicBaseUrl = process.env.TREESEED_API_BASE_URL ?? 'http://127.0.0.1:3002',
  presentationBaseUrl = process.env.TREESEED_API_AUTH_APPROVAL_BASE_URL ?? process.env.TREESEED_SITE_URL ?? publicBaseUrl,
  allowAdminLoopback = ['1', 'true', 'yes', 'on', 'live', 'development', 'local'].includes(
    (process.env.TREESEED_DEVELOPMENT_MODE ?? process.env.TREESEED_LOCAL_DEV_MODE ?? process.env.LOCAL_DEV_MODE ?? '').trim().toLowerCase()),
) {
  installOAuthProtocolRoutes(app, oauthProvider, authenticateBearerToken, presentationBaseUrl, allowAdminLoopback);
  return installControlPlaneResourceRoutes(app, authenticateBearerToken, registry, confirmations, mcpBusForPrincipal, publicBaseUrl);
}

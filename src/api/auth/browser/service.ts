import { createBrowserOidcClient, type BrowserOidcOptions } from '@treeseed/identity';
import type { ApiCredential, ApiPrincipal } from '../../types.ts';
import { BrowserSessionStore, type BrowserSessionTokens } from './session-store.ts';

export interface BrowserCaller { principal: ApiPrincipal; credential: ApiCredential }
export const BROWSER_SESSION_PERMISSION = 'identity:sessions:manage';
export const BROWSER_SESSION_SCOPE = 'treeseed:identity:sessions';

/** Internal application bridge. HTTP handlers derive the caller from verified
 * workload authentication and select a preconfigured service, never a body ID.
 * App cookies contain only random handles; refresh/ID tokens stay in this API.
 */
export async function createBrowserIdentityService(options: {
  workloadPrincipalId: string; oidc: BrowserOidcOptions; sessions: BrowserSessionStore;
}) {
  if (!options.workloadPrincipalId || options.sessions.clientId !== options.oidc.clientId) throw new Error('Registered application workload and matching session namespace required');
  const client = await createBrowserOidcClient(options.oidc);
  const authorize = (caller: BrowserCaller) => {
    if (caller.credential.type !== 'service_token' || caller.credential.id !== options.workloadPrincipalId
      || caller.principal.id !== options.workloadPrincipalId || caller.principal.metadata?.serviceId !== options.workloadPrincipalId
      || !caller.principal.permissions?.includes(BROWSER_SESSION_PERMISSION) || !caller.principal.scopes.includes(BROWSER_SESSION_SCOPE))
      throw new Error('Application session authority required');
  };
  const stored = (tokens: { access_token: string; refresh_token?: string; id_token?: string; expires_in?: number }, previous?: BrowserSessionTokens): BrowserSessionTokens => {
    if (!Number.isInteger(tokens.expires_in) || tokens.expires_in! < 1 || tokens.expires_in! > 300) throw new Error('Bounded Identity token lifetime required');
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? previous?.refreshToken,
      idToken: tokens.id_token ?? previous?.idToken, resource: options.oidc.resource, accessExpiresAt: Date.now() + tokens.expires_in! * 1000 };
  };
  return {
    assertCaller: authorize,
    async begin(caller: BrowserCaller, browserBinding: string) {
      authorize(caller); return { authorizationUrl: await client.begin(browserBinding) };
    },
    async finish(caller: BrowserCaller, browserBinding: string, callback: URL) {
      authorize(caller);
      const result = await client.finish(browserBinding, callback);
      return options.sessions.create({ ...result.identity, userId: result.principal.principalId,
        expiresAt: new Date(Date.now() + 8 * 3600_000), tokens: stored(result.tokens) });
    },
    /** Server-only result. The BFF may use this one API token for its own
     * server requests; it must never serialize it into a browser response. */
    async credentials(caller: BrowserCaller, handle: string) {
      authorize(caller);
      return options.sessions.use(handle, async (tokens, identity) => {
        if (tokens.resource !== options.oidc.resource) throw new Error('Browser session resource mismatch');
        if (tokens.accessExpiresAt <= Date.now() + 30_000) {
          if (!tokens.refreshToken) throw new Error('Sign in again');
          const renewed = await client.refresh(tokens.refreshToken, identity), next = stored(renewed.tokens, tokens);
          if (renewed.principal.principalId !== identity.userId) throw new Error('Browser principal mapping changed');
          return { tokens: next, result: { accessToken: next.accessToken, resource: next.resource, expiresAt: next.accessExpiresAt, principal: renewed.principal } };
        }
        const principal = await client.verifyAccessToken(tokens.accessToken, identity);
        if (principal.principalId !== identity.userId) throw new Error('Browser principal mapping changed');
        return { result: { accessToken: tokens.accessToken, resource: tokens.resource, expiresAt: tokens.accessExpiresAt, principal } };
      });
    },
    async logout(caller: BrowserCaller, handle: string) {
      authorize(caller);
      return options.sessions.use(handle, async tokens => {
        let upstreamRevoked = false;
        try { await client.revoke(tokens.refreshToken ?? tokens.accessToken); upstreamRevoked = true; } catch { /* Always remove the local session. */ }
        // Delete while still holding the session lock: no concurrent refresh
        // can resurrect a new token between revocation and local removal.
        return { remove: true, result: { loggedOut: true, upstreamRevoked } };
      });
    },
  };
}

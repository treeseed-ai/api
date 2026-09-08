import { createAccessTokenVerifier, IdentityAuthenticationError, type AccessTokenVerifierOptions } from '@treeseed/identity';
import type { PostgresAuthStore, PrincipalRecord } from './postgres-store.ts';

type IdentityStore = Pick<PostgresAuthStore, 'first' | 'principalForUser'>;

/** Replacement auth adapter. Not installed into live middleware until coordinated migration. */
export function createIdentityAuthenticator(options: Pick<AccessTokenVerifierOptions, 'issuer' | 'audience' | 'verificationKey'> & { store: IdentityStore }) {
  const { store } = options;
  // This path deliberately never calls syncUser: email, username and token roles grant nothing.
  const verify = createAccessTokenVerifier({ ...options, profile: 'keycloak', resolvePrincipal: async identity => {
    const mapping = await store.first<{ user_id: string }>(
      `SELECT identities.user_id FROM user_identities identities
       JOIN users ON users.id = identities.user_id
       WHERE identities.provider = ? AND identities.provider_subject = ? AND users.status = 'active'`,
      [identity.issuer, identity.subject]);
    return mapping ? { principalId: mapping.user_id, kind: 'human' } : null;
  } });
  return async (token: string): Promise<PrincipalRecord> => {
    const authenticated = await verify(token);
    // Recheck active status before loading database-owned authorization.
    const active = await store.first<{ id: string }>(`SELECT id FROM users WHERE id = ? AND status = 'active'`, [authenticated.principalId]);
    if (!active) throw new IdentityAuthenticationError();
    const principal = await store.principalForUser(authenticated.principalId);
    // OAuth scope restricts, never expands, locally authorized scopes.
    return { ...principal, principal: { ...principal.principal,
      scopes: principal.principal.scopes.filter(scope => authenticated.scopes.includes(scope)) } };
  };
}

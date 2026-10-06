import { createAccessTokenVerifier, IdentityAuthenticationError, type AccessTokenVerifierOptions } from '@treeseed/identity';
import { z } from 'zod';
import { decodeJwt } from 'jose';
import type { ApiCredential, ApiPrincipal } from '../types.ts';
import type { IdentityPrincipalStore } from './identity/principal-store.ts';

const workloadSchema = z.object({ id: z.string().min(1), client_id: z.string().min(1), display_name: z.string(),
  status: z.literal('active'), permissions: z.array(z.string().min(1)), scopes: z.array(z.string().min(1)) });
type Workload = z.infer<typeof workloadSchema>;

/** One human/workload identity boundary. Not installed into live middleware
 * until coordinated migration. The API, never the issuer's roles, owns grants. */
export function createIdentityAuthenticator(options: Pick<AccessTokenVerifierOptions, 'issuer' | 'audience' | 'verificationKey'> & { store: IdentityPrincipalStore }) {
  const { store } = options;
  return async (token: string): Promise<{ userId?: string; principal: ApiPrincipal;
    credential: ApiCredential & { oauthClientId: string; expiresAt: number } }> => {
    // Registration state belongs to this request only, never a shared mutable
    // resolver/cache. An inactive human mapping still prevents workload reuse.
    let workload: Workload | undefined;
    const verify = createAccessTokenVerifier({ ...options, profile: 'keycloak', resolvePrincipal: async identity => {
      const [human, service] = await Promise.all([
        store.first<{ user_id: string; status: string }>(
          `SELECT identities.user_id, users.status FROM user_identities identities
           JOIN users ON users.id = identities.user_id
           WHERE identities.provider = ? AND identities.provider_subject = ?`, [identity.issuer, identity.subject]),
        store.first<Workload>('SELECT id, client_id, display_name, status, permissions, scopes FROM identity_workloads WHERE issuer = ? AND subject = ?', [identity.issuer, identity.subject]),
      ]);
      if (human && service) throw new IdentityAuthenticationError();
      if (human?.status === 'active') return { principalId: human.user_id, kind: 'human' };
      if (!service) return null;
      workload = workloadSchema.parse(service);
      return { principalId: workload.id, kind: 'service', clientId: workload.client_id };
    } });
    const authenticated = await verify(token);
    // Read only after signature/issuer/audience validation. Keep transport
    // authority separate from local user metadata and credential identifiers.
    const claims = decodeJwt(token);
    if (typeof claims.azp !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(claims.azp)
      || !Number.isSafeInteger(claims.exp) || claims.exp! <= Math.floor(Date.now() / 1000)) throw new IdentityAuthenticationError();
    const transport = { oauthClientId: claims.azp, expiresAt: claims.exp! };
    if (authenticated.kind === 'service' && workload) {
      return { principal: { id: workload.id, displayName: workload.display_name, roles: [],
        permissions: [...workload.permissions], scopes: workload.scopes.filter(scope => authenticated.scopes.includes(scope)),
        metadata: { serviceId: workload.id, identity: authenticated.identity, clientId: workload.client_id } },
        credential: { type: 'service_token', id: workload.id, label: workload.display_name, ...transport } };
    }
    // Recheck active status before loading database-owned authorization.
    const active = await store.first<{ id: string }>(`SELECT id FROM users WHERE id = ? AND status = 'active'`, [authenticated.principalId]);
    if (!active) throw new IdentityAuthenticationError();
    const principal = await store.principalForUser(authenticated.principalId);
    // OAuth scope restricts, never expands, locally authorized scopes.
    return { ...principal, principal: { ...principal.principal,
      scopes: principal.principal.scopes.filter(scope => authenticated.scopes.includes(scope)) },
      credential: { type: 'access_token', id: authenticated.principalId, ...transport } };
  };
}

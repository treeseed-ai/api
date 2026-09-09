import { discoverSigningKeys } from '@treeseed/identity';
import { protectedResourceMetadataSchema, identityEndpointSchema, resourceTokenRequestSchema, type ExternalIdentity } from '@treeseed/sdk/identity';
import type { EncryptedEnvelopeCodec } from '@treeseed/sdk/security';
import { createIdentityAuthenticator } from '../identity-authenticator.ts';
import { BrowserLoginStore } from './login-store.ts';
import { BrowserSessionStore } from './session-store.ts';
import { createBrowserIdentityService } from './service.ts';

type Store = Parameters<typeof createIdentityAuthenticator>[0]['store'];
export interface BrowserApplicationRegistration {
  clientId: string;
  workloadPrincipalId: string;
  redirectUri: string;
  scopes: string[];
  privateKey: CryptoKey;
}

/** API-owned composition of Identity verification and encrypted session stores.
 * Deployment supplies approved transport and protected keys; database mappings
 * must already exist. This factory never creates or adopts user identities.
 * The live server switches to it only with the coordinated auth migration.
 */
export async function createApiIdentityRuntime(options: {
  issuer: string; resource: string; scopes: string[];
  applications: readonly BrowserApplicationRegistration[];
  database: ConstructorParameters<typeof BrowserSessionStore>[0];
  codec: EncryptedEnvelopeCodec;
  store: Store;
  transport: typeof fetch;
}) {
  const issuer = identityEndpointSchema.parse(options.issuer);
  const metadata = protectedResourceMetadataSchema.parse({ resource: options.resource,
    authorization_servers: [issuer], scopes_supported: options.scopes, bearer_methods_supported: ['header'] });
  const ids = new Set<string>(), workloads = new Set<string>(), callbacks = new Set<string>(), keys = new Set<CryptoKey>();
  for (const application of options.applications) {
    const { clientId, workloadPrincipalId, privateKey } = application;
    const redirect = identityEndpointSchema.parse(application.redirectUri);
    resourceTokenRequestSchema.parse({ resource: options.resource, scopes: application.scopes });
    if (![clientId, workloadPrincipalId].every(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value))
      || clientId === workloadPrincipalId || ids.has(clientId) || workloads.has(workloadPrincipalId) || callbacks.has(redirect)
      || ids.has(workloadPrincipalId) || workloads.has(clientId)
      || keys.has(privateKey) || privateKey?.type !== 'private' || privateKey.algorithm.name !== 'RSASSA-PKCS1-v1_5'
      || !privateKey.usages.includes('sign') || application.scopes.some(scope => !options.scopes.includes(scope)))
      throw new Error('Independent registered application clients, keys, callbacks and supported scopes required');
    ids.add(clientId); workloads.add(workloadPrincipalId); callbacks.add(redirect); keys.add(privateKey);
  }
  // Validate every registration before discovery: invalid configuration cannot
  // partially create a runtime or send credentials to an unapproved authority.
  const verificationKey = await discoverSigningKeys({ issuer, transport: options.transport });
  const authenticate = createIdentityAuthenticator({ issuer, audience: metadata.resource, verificationKey, store: options.store });
  const resolvePrincipal = async (identity: ExternalIdentity) => {
    if (identity.issuer !== issuer) return null;
    const [human, service] = await Promise.all([
      options.store.first<{ user_id: string; status: string }>(`SELECT identities.user_id, users.status FROM user_identities identities
        JOIN users ON users.id=identities.user_id WHERE identities.provider=? AND identities.provider_subject=?`, [identity.issuer, identity.subject]),
      options.store.first<{ id: string }>('SELECT id FROM identity_workloads WHERE issuer=? AND subject=?', [identity.issuer, identity.subject]),
    ]);
    if (service || !human || human.status !== 'active') return null;
    return { principalId: human.user_id, kind: 'human' as const };
  };
  const services = new Map<string, Awaited<ReturnType<typeof createBrowserIdentityService>>>();
  for (const application of options.applications) {
    services.set(application.workloadPrincipalId, await createBrowserIdentityService({
      workloadPrincipalId: application.workloadPrincipalId,
      sessions: new BrowserSessionStore(options.database, options.codec, application.clientId),
      oidc: { issuer, clientId: application.clientId, redirectUri: application.redirectUri,
        privateKey: application.privateKey, resource: metadata.resource, scopes: [...application.scopes],
        profile: 'keycloak', verificationKey, resolvePrincipal, transport: options.transport,
        store: new BrowserLoginStore(options.database, options.codec, application.clientId) },
    }));
  }
  return { metadata, authenticate, services };
}

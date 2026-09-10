import { readOsCredentialFile } from '@treeseed/deployment/security/custody';
import { createKeycloakAccountImporter, createWorkloadCredentials, discoverSigningKeys } from '@treeseed/identity';
import { importPKCS8 } from 'jose';
import { z } from 'zod/v3';
import { identityEndpointSchema } from '@treeseed/sdk/identity';
import { migrateLiveIdentity } from '../auth/identity/live-migration.ts';

const root = '/run/treeseed/identity/api-migration';
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
export const identityMigrationConfigurationSchema = z.object({ schemaVersion: z.literal('treeseed.identity-api-migration/v1'),
  issuer: identityEndpointSchema, resource: identityEndpointSchema, backupGeneration: z.number().int().positive().optional(),
  workloads: z.array(z.object({ id, issuer: identityEndpointSchema, subject: id, clientId: id,
    displayName: z.string().min(1).max(256), permissions: z.array(z.string()), scopes: z.array(z.string()) }).strict()).max(128),
}).strict();

/** Mounted only into the stopped-writer migration job, never the API service.
 * The supervisor withdraws this short-lived maintenance mount after the job.
 */
export async function migrateManagedApiIdentity(database: Parameters<typeof migrateLiveIdentity>[0], transport: typeof fetch = fetch) {
  let descriptor: Buffer | undefined, key: Buffer | undefined;
  let phase = 'descriptor-custody';
  try {
    descriptor = readOsCredentialFile(`${root}/runtime.json`);
    phase = 'descriptor-validation';
    const config = identityMigrationConfigurationSchema.parse(JSON.parse(descriptor.toString('utf8')));
    if (config.workloads.some(workload => workload.issuer !== config.issuer)) throw new Error();
    phase = 'signing-key';
    key = readOsCredentialFile(`${root}/reconciler.pem`);
    const signingKey = await importPKCS8(key.toString('utf8'), 'RS256');
    key.fill(0);
    const url = new URL(config.issuer), match = url.pathname.match(/^(.*)\/realms\/([A-Za-z0-9_-]+)$/u);
    if (!match) throw new Error();
    const resource = `${url.origin}${match[1]}/admin/realms/${match[2]}`;
    phase = 'issuer-discovery';
    const credentials = await createWorkloadCredentials({ issuer: config.issuer, clientId: 'treeseed-identity-reconciler',
      privateKey: signingKey as CryptoKey, resources: [resource], profile: 'keycloak', transport,
      verificationKey: await discoverSigningKeys({ issuer: config.issuer, transport }),
      resolvePrincipal: async identity => ({ principalId: identity.subject, kind: 'service', clientId: 'treeseed-identity-reconciler' }) });
    const importer = createKeycloakAccountImporter({ issuer: config.issuer, transport,
      credentials: { token: async input => (await credentials.credentials(input)).accessToken } });
    phase = 'account-mapping';
    return await migrateLiveIdentity(database, { ...config, importAccount: account => importer.importAccount(account) });
  } catch { throw new Error(`Managed Identity account migration failed (${phase}); API writers must remain stopped`); }
  finally { descriptor?.fill(0); key?.fill(0); }
}

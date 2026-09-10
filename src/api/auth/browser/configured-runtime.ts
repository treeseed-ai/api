import { createHash } from 'node:crypto';
import { importPKCS8 } from 'jose';
import { identityApiRuntimeSchema } from '@treeseed/sdk/identity';
import { EncryptedEnvelopeCodec, StaticEnvelopeKeyProvider } from '@treeseed/sdk/security';
import { createIdentityPrincipalStore } from '../identity/principal-store.ts';
import { createApiIdentityRuntime } from './runtime.ts';

/** Trusted startup composition, never an API operation. Deployment resolves
 * bootstrap references into fresh buffers; this function clears those buffers.
 * Operational service/vault credentials are deliberately outside this scope.
 */
export async function createConfiguredApiIdentityRuntime(input: unknown, options: {
  database: Parameters<typeof createApiIdentityRuntime>[0]['database'];
  resolveCredential(reference: string): Promise<Buffer>;
  transport: typeof fetch;
}) {
  const parsed = identityApiRuntimeSchema.safeParse(input);
  if (!parsed.success) throw new Error('Configured Identity runtime is unavailable; verify protected bootstrap bindings');
  const config = parsed.data;
  const sessionKeys: Array<{ id: string; version: number; key: Buffer }> = [];
  const fingerprints = new Set<string>();
  try {
    for (const binding of [config.sessionKeys.active, ...config.sessionKeys.historical]) {
      const material = await options.resolveCredential(binding.credentialReference);
      try {
        const encoded = material.toString('utf8').trim();
        if (material.length > 256 || !/^[A-Za-z0-9_-]{43}$/u.test(encoded)) throw new Error();
        const key = Buffer.from(encoded, 'base64url');
        if (key.length !== 32 || key.toString('base64url') !== encoded) { key.fill(0); throw new Error(); }
        const fingerprint = createHash('sha256').update(key).digest('hex');
        if (fingerprints.has(fingerprint)) { key.fill(0); throw new Error(); }
        fingerprints.add(fingerprint);
        sessionKeys.push({ id: config.sessionKeys.id, version: binding.version, key });
      } finally { material.fill(0); }
    }
    const applications = [];
    for (const application of config.applications) {
      const material = await options.resolveCredential(application.signingKeyReference);
      try {
        if (material.length < 1 || material.length > 16384) throw new Error();
        applications.push({ clientId: application.clientId, workloadPrincipalId: application.workloadPrincipalId,
          redirectUri: application.redirectUri, scopes: application.scopes,
          privateKey: await importPKCS8(material.toString('utf8'), 'RS256', { extractable: false }) as CryptoKey });
      } finally { material.fill(0); }
    }
    const codec = new EncryptedEnvelopeCodec(new StaticEnvelopeKeyProvider('deployment-bootstrap', sessionKeys[0]!, sessionKeys.slice(1)));
    return await createApiIdentityRuntime({ issuer: config.issuer, resource: config.resource, scopes: config.scopes,
      registration: config.registration,
      applications, database: options.database, codec, store: createIdentityPrincipalStore(options.database), transport: options.transport });
  } catch {
    for (const item of sessionKeys) item.key.fill(0);
    throw new Error('Configured Identity runtime is unavailable; verify protected bootstrap bindings');
  }
}

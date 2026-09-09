import { readOsCredentialFile } from '@treeseed/deployment/security/custody';
import { createConfiguredApiIdentityRuntime } from '../auth/browser/configured-runtime.ts';

const root = '/run/treeseed/identity/api';

/** Deployment mounts only this API's protected bootstrap configuration and
 * keys. No environment-secret fallback or arbitrary credential file selector.
 */
export async function loadManagedApiIdentityRuntime(
  database: Parameters<typeof createConfiguredApiIdentityRuntime>[1]['database'], transport: typeof fetch,
) {
  let descriptor: Buffer | undefined;
  try {
    descriptor = readOsCredentialFile(`${root}/runtime.json`);
    if (descriptor.length > 262144) throw new Error();
    const input: unknown = JSON.parse(descriptor.toString('utf8'));
    return await createConfiguredApiIdentityRuntime(input, { database, transport,
      resolveCredential: async reference => {
        if (!/^[a-z][a-z0-9-]{0,62}$/u.test(reference)) throw new Error();
        return readOsCredentialFile(`${root}/credentials/${reference}`);
      },
    });
  } catch { throw new Error('Managed API Identity bootstrap is unavailable'); }
  finally { descriptor?.fill(0); }
}

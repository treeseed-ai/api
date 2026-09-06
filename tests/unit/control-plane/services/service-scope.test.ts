import {expect,it,vi} from 'vitest';
import {canonicalSecretPath} from '@treeseed/sdk/secrets-capability';
import {serviceSecretScope,serviceCredentialScope} from '../../../../src/security/managed-secrets.ts';
const connection={id:'connection-1',teamId:'team-1',providerId:'cloudflare',nonSecretConfig:{}};
it.each(['cloudflare-storage','cloudflare-dns'])('uses account-scoped custody for %s without an environment form field',profile=>{
  expect(serviceSecretScope('team-1',connection,profile).environment).toBe('shared');
});
it('preserves the exact existing storage reference without trying multiple vault paths',async()=>{
  const scope={...serviceSecretScope('team-1',connection,'cloudflare-storage'),environment:'staging'};
  const store={first:vi.fn(async()=>({reference:canonicalSecretPath(scope)}))};
  expect(await serviceCredentialScope(store,'team-1',connection,'cloudflare-storage')).toEqual(scope);
  expect(store.first).toHaveBeenCalledTimes(1);
  store.first.mockResolvedValue({reference:canonicalSecretPath({...scope,team:'other-team'})});
  await expect(serviceCredentialScope(store,'team-1',connection,'cloudflare-storage')).rejects.toThrow('scope mismatch');
});
it('still requires an environment for app publishing',()=>{
  expect(()=>serviceSecretScope('team-1',connection,'cloudflare-runtime')).toThrow('environment');
});

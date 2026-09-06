import {expect,it,vi} from 'vitest';
import {canonicalSecretPath} from '@treeseed/sdk/secrets-capability';
import {serviceSecretScope,serviceCredentialScope} from '../../../../src/security/managed-secrets.ts';
const connection={id:'connection-1',teamId:'team-1',providerId:'cloudflare',nonSecretConfig:{}};
it.each(['cloudflare-runtime','cloudflare-storage','cloudflare-dns'])('uses account-scoped custody for %s without an environment form field',profile=>{
  expect(serviceSecretScope('team-1',connection,profile).environment).toBe('shared');
});
it.each(['cloudflare-storage','cloudflare-runtime'])('preserves the exact existing %s reference without trying multiple vault paths',async profile=>{
  const scope={...serviceSecretScope('team-1',connection,profile),environment:'staging'};
  const store={first:vi.fn(async()=>({reference:canonicalSecretPath(scope)}))};
  expect(await serviceCredentialScope(store,'team-1',connection,profile)).toEqual(scope);
  expect(store.first).toHaveBeenCalledTimes(1);
  store.first.mockResolvedValue({reference:canonicalSecretPath({...scope,team:'other-team'})});
  await expect(serviceCredentialScope(store,'team-1',connection,profile)).rejects.toThrow('scope mismatch');
});
it('still requires an environment for Railway',()=>{
  expect(()=>serviceSecretScope('team-1',{...connection,providerId:'railway'},'railway-workspace')).toThrow('environment');
});

import {expect,it,vi} from 'vitest';
import {canonicalSecretPath,SERVICE_PROVIDER_CATALOG} from '@treeseed/sdk/secrets-capability';
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
for (const provider of SERVICE_PROVIDER_CATALOG) {
  for (const profile of provider.credentialProfiles.filter(profile=>profile.authoritySchemes?.includes('openbao'))) {
    it(`keeps ${provider.id}/${profile.id} custody consistent with its connection contract`,()=>{
      const scoped=provider.connectionFields.some(field=>field.key==='deploymentEnvironment');
      const candidate={...connection,providerId:provider.id,nonSecretConfig:scoped?{deploymentEnvironment:'staging'}:{}};
      expect(serviceSecretScope('team-1',candidate,profile.id).environment).toBe(scoped?'staging':'shared');
      expect(()=>serviceSecretScope('another-team',candidate,profile.id)).toThrow('team mismatch');
    });
  }
}
it('supports Hyperstack before any account credentials have been saved',async()=>{
  const store={first:vi.fn(async()=>null)};
  const scope=await serviceCredentialScope(store,'team-1',{...connection,providerId:'hyperstack'},'hyperstack-runtime');
  expect(scope.environment).toBe('shared');
  expect(store.first).toHaveBeenCalledTimes(1);
});

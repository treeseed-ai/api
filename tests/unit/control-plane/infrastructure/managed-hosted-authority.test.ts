import { expect, it, vi } from 'vitest';
import { canonicalSecretPath } from '@treeseed/sdk/secrets-capability';
import { serviceSecretScope } from '../../../../src/security/managed-secrets.ts';
import { resolveHostedVaultMaterial } from '../../../../src/operations-runner/infrastructure/hosted-provider-authority.ts';
function fixture(purpose:'provider'|'state-backend'|'state-encryption'='provider') {
  const profile=purpose==='provider'?'railway-workspace':purpose==='state-backend'?'s3-state-session':'opentofu-state-encryption';
  const capability=purpose==='provider'?'backend-hosting':purpose==='state-backend'?'object-storage':'state-encryption';
  const request:any={requestId:'request-1',teamId:'team-1',deploymentId:'deployment',stackId:'stack',environment:'staging',
    backendBindingDigest:`sha256:${'a'.repeat(64)}`,provider:purpose==='provider'?'railway':'treeseed',connectionRef:'connection-1',credentialProfileId:profile,capabilities:[capability],purpose,
    ...(purpose==='state-encryption'?{secretRef:'state-key'}:{})};
  const connection={id:'connection-1',teamId:'team-1',providerId:purpose==='provider'?'railway':'cloudflare',status:'active',
    nonSecretConfig:{deploymentEnvironment:'staging',stateEncryptionKeyRef:'state-key'},
    capabilities:[{capabilityType:capability,credentialProfileId:profile,status:'configured'}]};
  const scope=serviceSecretScope('team-1',connection,profile),row={id:'authority',connection_id:connection.id,version:3,reference:canonicalSecretPath(scope),capabilities_json:JSON.stringify([capability])};
  const record={version:3,values:purpose==='provider'?{apiToken:'synthetic-token'}:purpose==='state-backend'?{accessKeyId:'id',secretAccessKey:'synthetic-secret',sessionToken:'session'}:{stateEncryptionKey:'b'.repeat(64)}};
  const session=vi.fn(async(s:any,run:any)=>{expect(s).toEqual(scope);return run({read:async()=>record});});
  const store={first:vi.fn(async()=>row),getTeamServiceConnection:vi.fn(async()=>connection)};
  return {request,connection,row,record,session,store,run:()=>resolveHostedVaultMaterial({request,session,store})};
}
it.each(['provider','state-backend','state-encryption'] as const)('resolves %s through the exact managed scope',async purpose=>{
  const f=fixture(purpose),material=await f.run();
  expect(material).toMatchObject({scheme:'openbao',authorityVersion:3,teamId:'team-1',purpose});
  expect(f.store.first.mock.calls[0]![0]).toContain("a.scheme='openbao'");
  if(purpose==='state-encryption')expect(material.values).toEqual({key:'b'.repeat(64)});
});
it('rejects cross-team and environment confusion before opening a secret session',async()=>{
  const f=fixture();f.connection.teamId='team-2';await expect(f.run()).rejects.toThrow();
  f.connection.teamId='team-1';f.connection.nonSecretConfig.deploymentEnvironment='production';await expect(f.run()).rejects.toThrow('environment mismatch');
  expect(f.session).not.toHaveBeenCalled();
});
it('rejects ungranted capabilities, wrong paths, stale metadata, and state-key references',async()=>{
  const f=fixture();f.row.capabilities_json='[]';await expect(f.run()).rejects.toThrow('capability denied');
  f.row.capabilities_json='["backend-hosting"]';f.row.reference='teams/other';await expect(f.run()).rejects.toThrow('scope mismatch');
  const stale=fixture();stale.record.version=4;await expect(stale.run()).rejects.toThrow('stale');
  const state=fixture('state-encryption');state.request.secretRef='other';await expect(state.run()).rejects.toThrow('reference mismatch');
});

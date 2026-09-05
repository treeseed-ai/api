import { describe, expect, it, vi } from 'vitest';
import { createServiceCredentials } from '../../../../src/api/control-plane/repositories/services/service-credentials.ts';
import { canonicalSecretPath } from '@treeseed/sdk/secrets-capability';
import { CustodyError } from '@treeseed/deployment/security/custody';
function fixture() {
  const connection = {id:'connection-1',teamId:'team-1',providerId:'cloudflare',status:'active',
    nonSecretConfig:{deploymentEnvironment:'staging'},capabilities:[{capabilityType:'object-storage',credentialProfileId:'s3-state-session',status:'configured'}]};
  let version = 0, values: Record<string,string> | null = null;
  const custody = {read:vi.fn(async()=>values?{version,values}:null), version:vi.fn(async()=>version),
    write:vi.fn(async (_scope:any,next:any,expected:number)=>{if(expected!==version)throw new CustodyError('version_conflict');values=next;return ++version;}),
    tombstone:vi.fn(async()=>{values=null;})};
  const session = vi.fn(async (scope:any,run:any)=>{expect(canonicalSecretPath(scope)).toBe('teams/team-1/projects/team/environments/staging/purposes/s3-state-session/secrets/connection-1');return run(custody);});
  const store = {principalCanAccessTeam:vi.fn(async()=>true),principalCanManageServices:vi.fn(async()=>true),
    getTeamServiceConnection:vi.fn(async()=>connection),run:vi.fn(),recordAuditEvent:vi.fn()};
  return {connection,custody,session,store,service:createServiceCredentials(store,session)};
}
const principal={id:'user-1'}, args=['team-1','connection-1','s3-state-session'] as const;
describe('managed service credentials',()=>{
  it('returns only metadata, including optional fields; rotates with CAS and supports tombstone then recreation',async()=>{
    const {service,store}=fixture();
    const values={accessKeyId:'synthetic-id',secretAccessKey:'synthetic-secret',sessionToken:'synthetic-session'};
    const receipt=await service.putCredentials(principal,...args,{expectedVersion:0,values});
    expect(receipt).toMatchObject({custody:'openbao',version:1,configured:true,fields:['accessKeyId','secretAccessKey','sessionToken']});
    expect(JSON.stringify([receipt,store.run.mock.calls,store.recordAuditEvent.mock.calls])).not.toContain('synthetic-secret');
    await expect(service.putCredentials(principal,...args,{expectedVersion:0,values})).rejects.toMatchObject({status:409});
    await service.deleteCredentials(principal,...args,{expectedVersion:1});
    expect(await service.credentialStatus(principal,...args)).toMatchObject({configured:false,version:1});
    expect(await service.putCredentials(principal,...args,{expectedVersion:1,values:{accessKeyId:'id',secretAccessKey:'secret'}})).toMatchObject({version:2});
  });
  it('requires authentication and team credential permission before touching custody',async()=>{
    const {service,store,session}=fixture();
    await expect(service.credentialStatus(undefined,...args)).rejects.toMatchObject({status:401});
    store.principalCanManageServices.mockResolvedValue(false);
    await expect(service.credentialStatus(principal,...args)).rejects.toMatchObject({status:403});
    expect(session).not.toHaveBeenCalled();
  });
  it('rejects wrong team, missing capability, omitted fields and unrelated fields before any secret write',async()=>{
    const f=fixture();
    await expect(f.service.putCredentials(principal,...args,{expectedVersion:0,values:{accessKeyId:'id'}})).rejects.toMatchObject({status:400});
    await expect(f.service.putCredentials(principal,...args,{expectedVersion:0,values:{accessKeyId:'id',secretAccessKey:'secret',unexpected:'no'}})).rejects.toMatchObject({status:400});
    f.connection.teamId='team-2'; await expect(f.service.credentialStatus(principal,...args)).rejects.toMatchObject({status:400});
    f.connection.teamId='team-1'; f.connection.capabilities=[];
    await expect(f.service.credentialStatus(principal,...args)).rejects.toMatchObject({status:409});
    expect(f.session).not.toHaveBeenCalled();
  });
  it('redacts provider and transport errors',async()=>{
    const f=fixture(); f.custody.read.mockRejectedValue(new Error('private-provider-diagnostic'));
    await expect(f.service.credentialStatus(principal,...args)).rejects.toMatchObject({status:503,message:'Managed credential custody is unavailable.'});
  });
});

import {expect,it,vi} from 'vitest';
import {createServiceCredentials} from '../../../../src/api/control-plane/repositories/services/service-credentials.ts';
vi.mock('@treeseed/deployment/security/services',()=>({validateManagedServiceCredentials:vi.fn(async()=>({domain:'example.com',zoneId:'b'.repeat(32)}))}));
it('persists only verified identity with a conditional revision update and rejects concurrent edits',async()=>{
  const connection={id:'c',teamId:'t',providerId:'cloudflare',version:3,nonSecretConfig:{accountId:'a'.repeat(32),domain:'example.com'},capabilities:[{capabilityType:'dns-management',credentialProfileId:'cloudflare-dns',status:'configured'}]};
  let save=true;
  const store={getTeamServiceConnection:async()=>connection,first:vi.fn(async(sql:string)=>sql.startsWith('UPDATE')&&save?{id:'c'}:null),recordAuditEvent:vi.fn()};
  const session:any=async(_scope:any,run:any)=>run({read:async()=>({version:1,values:{apiToken:'synthetic-token'}})});
  const service=createServiceCredentials(store,session);
  const args=[{id:'u',roles:['platform_admin']},'t','c','cloudflare-dns',{expectedVersion:1}] as const;
  expect(await service.validateCredentials(...args)).toEqual({ok:true});
  const call=store.first.mock.calls.find(([sql])=>sql.startsWith('UPDATE'))!;
  expect(call[0]).toContain('AND version=? RETURNING id');
  expect(JSON.stringify(store.first.mock.calls)).not.toContain('synthetic-token');
  save=false;await expect(service.validateCredentials(...args)).rejects.toMatchObject({status:409});
});

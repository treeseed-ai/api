import {expect,it,vi} from 'vitest';
import {createAiInstanceService} from '../../../../src/api/control-plane/repositories/infrastructure/ai-instance-service';
const draft={name:'AI',projectId:'project',purpose:'inference',hostingConnectionId:'host',storageConnectionId:null,model:'model',schedule:'always',timeZone:'UTC'};
function fixture(){let current:any=null;
const store={ensureInitialized:vi.fn(),principalCanAccessTeam:vi.fn(async()=>true),principalCanManageServices:vi.fn(async()=>true),
getTeamServiceConnection:vi.fn(async()=>({teamId:'team',providerId:'hyperstack',status:'active',capabilities:[{capabilityType:'ai-inference-hosting',status:'configured'}]})),
all:vi.fn(async()=>current?[current]:[]),
first:vi.fn(async(sql:string,args:any[])=>{if(sql.startsWith('SELECT id FROM projects'))return {id:'project'};if(sql.startsWith('SELECT'))return current;
if(sql.startsWith('INSERT')){current={id:args[0],team_id:args[1],configuration_json:args[2],version:1,created_at:args[3],updated_at:args[4]};return current;}
if(sql.startsWith('UPDATE')){current={...current,configuration_json:args[0],version:current.version+1,updated_at:args[1]};return current;}
if(sql.startsWith('DELETE')){current=null;return {id:'instance'};}return null;})};return {store,service:createAiInstanceService(store)};}
it('saves only drafts, reloads them, and rejects stale writes/deletes',async()=>{const {service}=fixture(),p={id:'user'};
expect(await service.put(p,'team','instance',draft,'new')).toMatchObject({status:'draft',version:1,activation:{ready:false}});
expect(await service.show(p,'team','instance')).toMatchObject({configuration:draft});
expect(await service.put(p,'team','instance',{...draft,name:'Changed'},'1')).toMatchObject({version:2});
await expect(service.put(p,'team','instance',draft,'1')).rejects.toMatchObject({status:412});
await expect(service.remove(p,'team','instance','1')).rejects.toMatchObject({status:412});
expect(await service.remove(p,'team','instance','2')).toMatchObject({removed:true});});
it('denies unauthenticated and unauthorized writes before touching connections',async()=>{const {service,store}=fixture();
await expect(service.put(null,'team','instance',draft,'new')).rejects.toMatchObject({status:401});store.principalCanManageServices.mockResolvedValue(false);
await expect(service.put({id:'u'},'team','instance',draft,'new')).rejects.toMatchObject({status:403});expect(store.getTeamServiceConnection).not.toHaveBeenCalled();});
it('rejects cross-team connections and unsupported tasks',async()=>{const {service,store}=fixture();store.getTeamServiceConnection.mockResolvedValue({teamId:'other'} as any);
await expect(service.put({id:'u'},'team','instance',draft,'new')).rejects.toMatchObject({status:409});});
it('rejects a project outside the team',async()=>{const {service,store}=fixture();store.first.mockResolvedValue(null);
await expect(service.put({id:'u'},'team','instance',draft,'new')).rejects.toMatchObject({status:403});});

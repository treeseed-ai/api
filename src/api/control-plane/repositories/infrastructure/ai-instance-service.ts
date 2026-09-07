import {aiInstanceDraftSchema} from '@treeseed/sdk/deployment';
import {CapacityOperationError} from '../capacity/capacity-operation-error.ts';
const fail=(status:number,code:string,message:string)=>{throw new CapacityOperationError(status,code,message);};
const view=(row:any)=>({id:row.id,teamId:row.team_id,configuration:JSON.parse(row.configuration_json),version:Number(row.version),status:'draft',createdAt:row.created_at,updatedAt:row.updated_at,activation:{ready:false,blockers:['Hyperstack deployment qualification and exact release/storage grants are required.']}});
export function createAiInstanceService(store:any){
 const authorize=async(principal:any,teamId:string,write=false)=>{
  if(!principal)fail(401,'authentication_required','Sign in first.');
  const admin=principal.roles?.includes('platform_admin')||principal.permissions?.includes('*:*:*');
  if(!admin&&!await store.principalCanAccessTeam(principal,teamId))fail(403,'team_access_denied','Team access is required.');
  if(write&&!admin&&!await store.principalCanManageServices(principal,teamId))fail(403,'services_management_required','Team service management permission is required.');
  await store.ensureInitialized();
 };
 const row=(teamId:string,id:string)=>store.first('SELECT * FROM team_ai_instances WHERE team_id=? AND id=?',[teamId,id]);
 const selectedConnection=async(teamId:string,id:string,capabilities:string[])=>{
  const connection=await store.getTeamServiceConnection(teamId,id);
  if(!connection||connection.teamId!==teamId||connection.status!=='active'||capabilities.some(cap=>!connection.capabilities?.some((binding:any)=>binding.capabilityType===cap&&binding.status==='configured')))fail(409,'ai_connection_unavailable','The selected connection is unavailable or does not support the requested tasks.');
  return connection;
 };
 return {
  async list(principal:any,teamId:string,query:any){await authorize(principal,teamId);const limit=Math.min(100,Math.max(1,Number(query.limit)||50));const rows=await store.all('SELECT * FROM team_ai_instances WHERE team_id=? AND id>? ORDER BY id LIMIT ?',[teamId,query.cursor??'',limit+1]);return {items:rows.slice(0,limit).map(view),cursor:rows.length>limit?rows[limit-1].id:null};},
  async show(principal:any,teamId:string,id:string){await authorize(principal,teamId);const current=await row(teamId,id);if(!current)fail(404,'ai_instance_not_found','AI instance not found.');return view(current);},
  async put(principal:any,teamId:string,id:string,body:any,ifMatch?:string){
   await authorize(principal,teamId,true);const configuration=aiInstanceDraftSchema.parse(body);
   if(!await store.first('SELECT id FROM projects WHERE id=? AND team_id=?',[configuration.projectId,teamId]))fail(403,'ai_project_scope_invalid','Select a project owned by this team.');
   const capabilities=configuration.purpose==='both'?['ai-inference-hosting','ai-training-hosting']:[configuration.purpose==='inference'?'ai-inference-hosting':'ai-training-hosting'];
   const hosting=await selectedConnection(teamId,configuration.hostingConnectionId,capabilities);
   if(hosting.providerId!=='hyperstack')fail(409,'ai_provider_unsupported','Select a Hyperstack hosting connection.');
   if(configuration.storageConnectionId)await selectedConnection(teamId,configuration.storageConnectionId,['object-storage']);
   const current=await row(teamId,id);if(ifMatch!==(current?String(current.version):'new'))fail(412,'ai_version_conflict','This draft changed. Reload before saving.');
   const now=new Date().toISOString();let saved;
   if(current)saved=await store.first('UPDATE team_ai_instances SET configuration_json=?,version=version+1,updated_at=? WHERE team_id=? AND id=? AND version=? RETURNING *',[JSON.stringify(configuration),now,teamId,id,current.version]);
   else saved=await store.first('INSERT INTO team_ai_instances (id,team_id,configuration_json,version,created_at,updated_at) VALUES (?,?,?,1,?,?) ON CONFLICT (team_id,id) DO NOTHING RETURNING *',[id,teamId,JSON.stringify(configuration),now,now]);
   if(!saved)fail(412,'ai_version_conflict','This draft changed. Reload before saving.');return view(saved);
  },
  async remove(principal:any,teamId:string,id:string,ifMatch?:string){await authorize(principal,teamId,true);const current=await row(teamId,id);if(!current)fail(404,'ai_instance_not_found','AI instance not found.');if(ifMatch!==String(current.version))fail(412,'ai_version_conflict','This draft changed. Reload before deleting.');const removed=await store.first('DELETE FROM team_ai_instances WHERE team_id=? AND id=? AND version=? RETURNING id',[teamId,id,current.version]);if(!removed)fail(412,'ai_version_conflict','This draft changed.');return {id,removed:true};},
 };
}

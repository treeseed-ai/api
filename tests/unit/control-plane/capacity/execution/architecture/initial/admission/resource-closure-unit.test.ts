import {describe,expect,it} from 'vitest';
import {verifyNativeResourceClosure} from '../../../../../../../acceptance/execution-resource-closure.ts';
type Row=Record<string,unknown>;
describe('native exact workday resource closure',()=>{
 it('denies omitted foreign duplicated live or substituted native session and proxy records without changing retained observations',()=>{
  const clock='2026-10-15T12:00:00.000Z',proxy={id:'handle',teamId:'team',projectId:'project',assignmentId:'assignment',repositoryId:'library',workspaceId:'workspace',status:'revoked',revokedAt:clock};
  const owner:Row={id:'assignment',team_id:'team',project_id:'project',work_day_id:'workday',membership_id:'membership',capacity_provider_id:'provider',provider_session_id:'session',status:'completed',completed_at:clock,treedx_proxy_handle_json:JSON.stringify(proxy),workspace_context_json:JSON.stringify({treedxProxyHandle:proxy})};
  const session:Row={id:'session',team_id:'team',membership_id:'membership',capacity_provider_id:'provider',status:'closed',closed_at:clock};
  const handle:Row={id:'handle',assignment_id:'assignment',team_id:'team',project_id:'project',repository_id:'library',workspace_id:'workspace',status:'revoked',revoked_at:clock};
  const exact={assignments:[owner],sessions:[session,{...session,id:'unrelated',status:'open',closed_at:null}],proxies:[handle],run:{id:'workday',teamId:'team'}};
  const inspect=(value:typeof exact)=>verifyNativeResourceClosure(value.assignments,value.sessions,value.proxies,value.run);const held=structuredClone(exact);inspect(exact);expect(exact).toEqual(held);
  const changes:Array<(value:typeof exact)=>void>=[value=>{value.assignments=[];},value=>{value.sessions=[];},value=>{value.proxies=[];},value=>{value.assignments.push(owner);},value=>{value.sessions.push(session);},value=>{value.proxies.push(handle);},value=>{value.assignments[0]!.status='running';},value=>{value.assignments[0]!.provider_session_id='foreign';},value=>{value.assignments[0]!.treedx_proxy_handle_json='{}';},value=>{value.assignments[0]!.workspace_context_json='{}';},value=>{value.assignments[0]!.treedx_proxy_handle_json='null';}];
  for(const field of['team_id','membership_id','capacity_provider_id','status','closed_at'])changes.push(value=>{value.sessions[0]![field]='foreign';});
  for(const field of['id','assignment_id','team_id','project_id','repository_id','workspace_id','status','revoked_at'])changes.push(value=>{value.proxies[0]![field]='foreign';});
  changes.push(value=>{value.sessions[0]!.closed_at='2026-10-15T11:59:59.999Z';},value=>{value.proxies[0]!.revoked_at='2026-10-15T12:00:00.001Z';});
  for(const change of changes){const failed=structuredClone(exact);change(failed);const before=structuredClone(failed);expect(()=>inspect(failed)).toThrow('ACCEPTANCE_NATIVE_RESOURCE');expect(failed).toEqual(before);}inspect(exact);expect(exact).toEqual(held);
 });
});

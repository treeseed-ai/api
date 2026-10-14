import { expect, it } from 'vitest';
import * as inventory from '../../../../../../../acceptance/execution-inventory.ts';
import { assignment } from '../../../fixtures/assignment.ts';
type Row=Record<string,unknown>;
it('requires each original native lease exactly once in scoped durable history without repairing missing foreign duplicated malformed or secret-bearing observations',()=>{
 const check=(inventory as unknown as Record<string,(assignments:Row[],events:Row[],run:Row)=>void>).verifyNativeLeaseHistory;
 expect(check).toBeTypeOf('function');
 const at=new Date(Date.parse(assignment.createdAt)+1000).toISOString(),run={id:assignment.workdayId,teamId:assignment.teamId};
 const native={id:assignment.id,team_id:assignment.teamId,project_id:assignment.projectId,work_day_id:assignment.workdayId,claimed_at:at,created_at:assignment.createdAt,updated_at:at,runner_id:'observed-runner',assignment_attempt_json:JSON.stringify(assignment)};
 const context={nodeId:assignment.nodeId,nodeRevision:assignment.nodeRevision,graphRevision:assignment.graphRevision,status:'leased',leaseId:assignment.leaseId,reservationId:assignment.reservationId,runnerId:native.runner_id};
 const event={id:'original-lease',event_type:'assignment.leased',status:'recorded',team_id:run.teamId,run_id:run.id,workday_id:run.id,project_id:native.project_id,assignment_id:native.id,created_at:at,context_json:JSON.stringify(context),parameters_json:'{}',metadata_json:'{}',refs_json:'{}'};
 const held=structuredClone({native,event,run}); check!([native],[event],run);
 for(const mode of ['missing','duplicate','orphan','team','run','workday','project','clock','invalid-clock','unclaimed','context','node','revision','graph','status','lease','reservation','runner','secret','metadata-secret','parameters-secret','refs-secret','missing-attempt','malformed-attempt']) {
  const owner:Row=structuredClone(native), value:Row=structuredClone(event), events=[value], details:Row=structuredClone(context);
  if(mode==='missing') events.pop(); if(mode==='duplicate') events.push({...value,id:'second-lease'});
  if(mode==='orphan') value.assignment_id='foreign'; if(mode==='team') value.team_id='foreign'; if(mode==='run') value.run_id='foreign';
  if(mode==='workday') value.workday_id='foreign'; if(mode==='project') value.project_id='foreign';
  if(mode==='clock') value.created_at=assignment.createdAt; if(mode==='invalid-clock') owner.claimed_at='invalid'; if(mode==='unclaimed') owner.claimed_at=null;
  if(mode==='node') details.nodeId='foreign'; if(mode==='revision') details.nodeRevision=99; if(mode==='graph') details.graphRevision=99;
  if(mode==='status') details.status='running'; if(mode==='lease') details.leaseId='foreign'; if(mode==='reservation') details.reservationId='foreign';
  if(mode==='runner') details.runnerId='foreign'; if(mode==='secret') details.leaseToken='not-permitted'; value.context_json=mode==='context'?'{':JSON.stringify(details);
  if(mode==='metadata-secret') value.metadata_json='{"leaseToken":"not-permitted"}'; if(mode==='parameters-secret') value.parameters_json='{"leaseToken":"not-permitted"}';
  if(mode==='refs-secret') value.refs_json='{"leaseToken":"not-permitted"}'; if(mode==='missing-attempt') Reflect.deleteProperty(owner,'assignment_attempt_json'); if(mode==='malformed-attempt') owner.assignment_attempt_json='{';
  const failed=structuredClone({owner,events,run}); expect(()=>check!([owner],events,run),mode).toThrow(); expect({owner,events,run}).toEqual(failed);
 }
 check!([{...native,claimed_at:null}],[],run); expect({native,event,run}).toEqual(held); check!([native],[event],run);
});

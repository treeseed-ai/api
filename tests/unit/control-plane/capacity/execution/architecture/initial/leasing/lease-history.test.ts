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
 for(const mode of ['missing','duplicate','orphan','team','run','workday','project','clock','invalid-clock','unclaimed','context','node','revision','graph','status','lease','reservation','runner','secret','metadata-secret','parameters-secret','refs-secret','missing-attempt','malformed-attempt','early-claim','deadline-claim','late-update','missing-event-id']) {
  const owner:Row=structuredClone(native), value:Row=structuredClone(event), events=[value], details:Row=structuredClone(context);
  if(mode==='missing') events.pop(); if(mode==='duplicate') events.push({...value,id:'second-lease'});
  if(mode==='orphan') value.assignment_id='foreign'; if(mode==='team') value.team_id='foreign'; if(mode==='run') value.run_id='foreign';
  if(mode==='workday') value.workday_id='foreign'; if(mode==='project') value.project_id='foreign';

  if(mode==='early-claim') {owner.claimed_at=new Date(Date.parse(assignment.createdAt)-1).toISOString(); value.created_at=owner.claimed_at;}
  if(mode==='deadline-claim') {owner.claimed_at=assignment.deadline; owner.updated_at=assignment.deadline; value.created_at=owner.claimed_at;}
  if(mode==='late-update') owner.updated_at=assignment.createdAt;
  if(mode==='missing-event-id') Reflect.deleteProperty(value,'id');
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
it('matches whole original lease event payload through independent public readback and denies changed omitted or foreign context without repairing either view',()=>{
 const check=(inventory as unknown as Record<string,(native:Row,visible:unknown)=>void>).verifyNativeLeaseEventReadback; expect(check).toBeTypeOf('function');
 const context={nodeId:'original-node',nodeRevision:1,graphRevision:1,status:'leased',leaseId:'original-lease',reservationId:'original-reservation',runnerId:'original-runner'};
 const native={id:'original-event',run_id:'original-workday',team_id:'original-team',project_id:'original-project',workday_id:'original-workday',assignment_id:'original-assignment',event_index:3,event_type:'assignment.leased',status:'recorded',title:'Assignment leased',message:null,created_at:'2026-10-14T12:00:01.000Z',context_json:JSON.stringify(context),parameters_json:'{}',metadata_json:'{}',refs_json:'{}'};
 const visible:Row={id:native.id,runId:native.run_id,teamId:native.team_id,projectId:native.project_id,workdayId:native.workday_id,assignmentId:native.assignment_id,eventIndex:native.event_index,eventType:native.event_type,status:native.status,title:native.title,message:native.message,createdAt:native.created_at,context,parameters:{},metadata:{},refs:{}};
 const before=structuredClone({native,visible}); check!(native,visible);
 for(const field of Object.keys(visible))for(const value of [undefined,null,'changed',{},[]]) {
  const changed=structuredClone(visible);changed[field]=value;if(JSON.stringify(changed)===JSON.stringify(visible))continue;
  const failed=structuredClone(changed); expect(()=>check!(native,changed),field).toThrow(); expect(changed).toEqual(failed);expect(native).toEqual(before.native);
 }
 for(const supplied of[undefined,null,[],false,''])expect(()=>check!(native,supplied)).toThrow();
 expect({native,visible}).toEqual(before);check!(native,visible);
});


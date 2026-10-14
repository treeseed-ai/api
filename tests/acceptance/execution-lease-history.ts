import assert from 'node:assert/strict';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
type Row=Record<string,unknown>;
/** Original native lease state bounds durable observations; public agreement
 * alone cannot prove that a fast transition was ever published. */
export function verifyNativeLeaseHistory(assignments: Row[], events: Row[], run: Row): void {
 const label='ACCEPTANCE_NATIVE_LEASE_HISTORY';
 assert.ok(Array.isArray(assignments)&&assignments.length>0&&Array.isArray(events),label);
 assert.ok(typeof run.id==='string'&&run.id&&typeof run.teamId==='string'&&run.teamId,label);
 const owners=new Map<string,Row>();
 for(const owner of assignments){assert.ok(typeof owner.id==='string'&&owner.id&&!owners.has(owner.id),label);assert.equal(owner.team_id,run.teamId,label);assert.equal(owner.work_day_id,run.id,label);owners.set(owner.id,owner);}
 const leases=events.filter(event=>event.event_type==='assignment.leased');
 assert.equal(new Set(leases.map(event=>event.id)).size,leases.length,label);
 for(const event of leases){assert.ok(typeof event.id==='string'&&event.id&&event.id.trim()===event.id,label);assert.ok(typeof event.assignment_id==='string'&&owners.has(event.assignment_id),label+': Orphan lease observation');}
 for(const owner of assignments){
  const supplied=JSON.parse(String(owner.assignment_attempt_json)),attempt=assignmentAttemptSchema.parse(supplied);assert.deepEqual(attempt,supplied,label);
  assert.equal(attempt.id,owner.id,label);assert.equal(attempt.teamId,run.teamId,label);assert.equal(attempt.workdayId,run.id,label);assert.equal(attempt.projectId,owner.project_id,label);
  const observations=leases.filter(event=>event.assignment_id===owner.id);
  if(owner.claimed_at===null||owner.claimed_at===undefined){assert.equal(observations.length,0,label);continue;}
  assert.ok(typeof owner.claimed_at==='string'&&Number.isFinite(Date.parse(owner.claimed_at)),label);
  const claimed=Date.parse(owner.claimed_at);assert.ok(claimed>=Date.parse(attempt.createdAt)&&claimed<Date.parse(attempt.deadline)&&typeof owner.updated_at==='string'&&claimed<=Date.parse(owner.updated_at),label+': Original issued productive clock bounds required');
  assert.equal(observations.length,1,label+': Every original claim needs one durable observation');const event=observations[0]!;
  for(const[key,value]of Object.entries({team_id:run.teamId,run_id:run.id,workday_id:run.id,project_id:owner.project_id,assignment_id:owner.id,status:'recorded',created_at:owner.claimed_at}))assert.equal(event[key],value,label);
  const context=JSON.parse(String(event.context_json));assert.deepEqual(context,{nodeId:attempt.nodeId,nodeRevision:attempt.nodeRevision,graphRevision:attempt.graphRevision,status:'leased',leaseId:attempt.leaseId,reservationId:attempt.reservationId,runnerId:owner.runner_id??null},label);
  for(const field of['parameters_json','metadata_json','refs_json'])assert.deepEqual(JSON.parse(String(event[field])),{},label+': Lease observations must not carry credentials or caller payloads');
 }
}
/** Check the original public event projection independently of its serializer. */
export function verifyNativeLeaseEventReadback(native: Row, returned: unknown): void {
 const label='ACCEPTANCE_NATIVE_LEASE_READBACK';
 assert.ok(native.event_type==='assignment.leased'&&returned&&typeof returned==='object'&&!Array.isArray(returned),label);
 const visible=returned as Row;
 const columns={id:'id',runId:'run_id',teamId:'team_id',projectId:'project_id',workdayId:'workday_id',assignmentId:'assignment_id',eventIndex:'event_index',eventType:'event_type',status:'status',title:'title',message:'message',createdAt:'created_at'};
 const objects=['parameters','context','refs','metadata'];assert.deepEqual(Object.keys(visible).sort(),[...Object.keys(columns),...objects].sort(),label);
 for(const[field,column]of Object.entries(columns))assert.deepEqual(visible[field],native[column],label+': Original '+field+' changed');
 for(const field of objects)assert.deepEqual(visible[field],JSON.parse(String(native[field+'_json'])),label+': Original '+field+' changed');
}


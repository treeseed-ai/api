import assert from 'node:assert/strict';
import { serializeAvailabilitySessionRow } from '../../dist/api/capacity/repositories/accounts/availability-session.js';
import { verifyNativeInventory } from './execution-inventory.ts';
type Row=Record<string,unknown>;
const object=(value:unknown):Row=>{assert.ok(value&&typeof value==='object'&&!Array.isArray(value),'ACCEPTANCE_NATIVE_RESOURCE');return value as Row;};
const json=(value:unknown)=>{assert.equal(typeof value,'string','ACCEPTANCE_NATIVE_RESOURCE');return object(JSON.parse(value as string));};

/** Complete owning assignment references bind every retired session and proxy; unrelated sessions remain visible. */
export function verifyNativeResourceClosure(assignments:Row[],sessions:Row[],proxies:Row[],run:Row):void {
 const code='ACCEPTANCE_NATIVE_RESOURCE';assert.ok(assignments.length>0,code);
 for(const rows of[assignments,sessions,proxies])assert.equal(new Set(rows.map(value=>value.id)).size,rows.length,code);
 assert.equal(proxies.length,assignments.length,code);
 for(const owner of assignments){
  assert.equal(owner.team_id,run.teamId,code);assert.equal(owner.work_day_id,run.id,code);
  assert.ok(['completed','failed','cancelled','returned','expired'].includes(String(owner.status)),code);
  assert.ok(typeof owner.id==='string'&&owner.id,code);
  const session=sessions.filter(value=>value.id===owner.provider_session_id);assert.equal(session.length,1,code);const availability=session[0]!;
  assert.equal(availability.team_id,owner.team_id,code);assert.equal(availability.membership_id,owner.membership_id,code);assert.equal(availability.capacity_provider_id,owner.capacity_provider_id,code);
  assert.equal(availability.status,'closed',code);const closed=Date.parse(String(availability.closed_at));
  const terminal=Date.parse(String(owner.completed_at??owner.failed_at??owner.returned_at));assert.ok(Number.isFinite(closed)&&Number.isFinite(terminal)&&Number.isFinite(Date.parse(String(availability.opened_at)))&&closed>=Date.parse(String(availability.opened_at)),code);
  const handles=proxies.filter(value=>value.assignment_id===owner.id);assert.equal(handles.length,1,code);const handle=handles[0]!,snapshot=json(owner.treedx_proxy_handle_json);
  assert.equal(handle.id,snapshot.id,code);assert.equal(handle.team_id,owner.team_id,code);assert.equal(handle.project_id,owner.project_id,code);
  assert.equal(snapshot.teamId,owner.team_id,code);assert.equal(snapshot.projectId,owner.project_id,code);assert.equal(snapshot.assignmentId,owner.id,code);
  assert.equal(handle.status,'revoked',code);assert.equal(snapshot.status,'revoked',code);assert.equal(snapshot.revokedAt,handle.revoked_at,code);
  assert.ok([handle.revoked_at,owner.created_at,owner.updated_at].every(value=>Number.isFinite(Date.parse(String(value))))&&Date.parse(String(handle.revoked_at))>=Date.parse(String(owner.created_at))&&Date.parse(String(handle.revoked_at))<=Date.parse(String(owner.updated_at)),code);
  assert.equal(handle.repository_id,snapshot.repositoryId,code);assert.equal(handle.workspace_id,snapshot.workspaceId,code);
  assert.deepEqual(json(owner.workspace_context_json).treedxProxyHandle,snapshot,code);
 }
}

/** Existing read-only native snapshot and supported CLI; no private route or reconstructed public record. */
export async function verifyManagedResourceClosure(native:(sql:string,parameters:unknown[])=>Promise<Row[]>,read:(args:string[])=>Row,assignments:Row[],run:Row){
 const sessions=await native('SELECT * FROM capacity_provider_availability_sessions WHERE team_id=$1 ORDER BY id',[run.teamId]);
 const visible=await verifyNativeInventory(sessions,cursor=>read(['capacity','status','--limit','200',...(cursor?['--cursor',cursor]:[])]),200,'descending','openedAt');
 const proxies=await native(`SELECT handle.* FROM treedx_proxy_handles handle JOIN capacity_provider_assignments assignment ON assignment.id=handle.assignment_id WHERE assignment.team_id=$1 AND assignment.work_day_id=$2 ORDER BY handle.id`,[run.teamId,run.id]);
 verifyNativeResourceClosure(assignments,sessions,proxies,run);
 const owned=new Set(assignments.map(value=>value.provider_session_id));
 for(const session of sessions)if(owned.has(session.id))assert.deepEqual(visible.find(value=>value.id===session.id),serializeAvailabilitySessionRow(session),'ACCEPTANCE_NATIVE_RESOURCE');
}

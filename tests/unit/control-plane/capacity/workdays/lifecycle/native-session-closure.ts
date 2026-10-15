import { CapacityWorkdayRunWriteRepository } from '../../../../../../src/api/capacity/repositories/capacity/workdays/workday-run-write.ts';
import { verifyNativeResourceClosure } from '../../../../../acceptance/execution-resource-closure.ts';
import { verifyNativeInventory } from '../../../../../acceptance/execution-inventory.ts';
import { decodeCapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import { serializeAvailabilitySessionRow } from '../../../../../../src/api/capacity/repositories/accounts/availability-session.ts';
import { expect } from 'vitest';
import type pg from 'pg';
import type { createControlPlanePostgresDatabase } from '../../../../../../src/api/support/control-plane-postgres.ts';
import { ControlPlaneStore } from '../../../../../../src/api/persistence/store.ts';
import { CapacityWorkdayRunRepository } from '../../../../../../src/api/capacity/repositories/capacity/workdays/workday-run.ts';
import { AvailabilitySessionRepository } from '../../../../../../src/api/capacity/repositories/accounts/availability-session.ts';
import { advanceLivingWorkday } from '../../../../../../src/api/capacity/services/capacity/workdays/lifecycle/living-workday-lifecycle.ts';
import { appliedWorkdaySchema } from '@treeseed/sdk/agent-capacity';
import { eventObserved } from '../../../realtime/architecture/session-postgres-fixture.ts';
import { reportRef, reportResult } from '../../execution/graph/architecture/closeout-sql-fixture.ts';

/** Original complete native schema and independent connections; controlled SQL closeout inputs, never managed Reporter evidence. */
export async function proveNativeSessionClosure(database: ReturnType<typeof createControlPlanePostgresDatabase>, observer: pg.Pool, deadline: number) {
 const store = new ControlPlaneStore({ TREESEED_ENVIRONMENT: 'test' }, database);
 store.initializationPromise = Promise.resolve();
 const runs = new CapacityWorkdayRunRepository(store), sessions = new AvailabilitySessionRepository(store);
 const writes=new CapacityWorkdayRunWriteRepository(store);
 const lifecycle=Object.assign(store,{updateCapacityWorkdayRun:async(teamId:string,id:string,input:Record<string,unknown>)=>{const current=await runs.get(teamId,id);return current?writes.update({...current,...input},current.status):null;}});

 const original = (await runs.get('team', 'sdk'))!, now = new Date().toISOString();
 const plan = appliedWorkdaySchema.parse(original.parameters.appliedPlan);
 await database.pool.query("UPDATE capacity_workday_runs SET parameters_json=$1 WHERE id='sdk'", [JSON.stringify({ ...original.parameters, appliedPlan: { ...plan, state: 'closing', closingAt: now } })]);
 await database.pool.query(`INSERT INTO capacity_provider_team_memberships (id,team_id,capacity_provider_id,approved_at,approved_by_id,created_at,updated_at) VALUES ('closure-membership','team','provider',$1,'test',$1,$1)`, [now]);
 await database.pool.query(`INSERT INTO project_agent_classes (id,team_id,project_id,slug,name,created_at,updated_at) VALUES ('closure-class','team','project','configured-closeout','Configured Closeout',$1,$1)`, [now]);
 for (const id of ['closure-owned','closure-unrelated']) await database.pool.query(`INSERT INTO capacity_provider_availability_sessions (id,membership_id,team_id,capacity_provider_id,opened_at,refreshed_at,expires_at,available_from,created_at,updated_at) VALUES ($1,'closure-membership','team','provider',$2,$2,$3,$2,$2,$2)`, [id, now, new Date(Date.parse(now)+60_000).toISOString()]);
 await database.pool.query(`INSERT INTO execution_nodes (id,team_id,project_id,workday_id,kind,source_ref_json,rule_revision,node_revision,agent_class,status,graph_revision_created,graph_revision_updated,created_at,updated_at) VALUES ('closure-report','team','project','sdk','reporting','{}',1,1,'configured-closeout','completed',1,1,$1,$1)`, [now]);
 const result = { ...reportResult, id: 'closure-result', assignmentId: 'closure-assignment', completedAt: now };
 await database.pool.query(`INSERT INTO capacity_provider_assignments (id,membership_id,team_id,project_id,capacity_provider_id,provider_session_id,project_agent_class_id,work_day_id,mode,status,execution_node_id,assignment_result_json,completed_at,created_at,updated_at) VALUES ('closure-assignment','closure-membership','team','project','provider','closure-owned','closure-class','sdk','acting','completed','closure-report',$1,$2,$2,$2)`, [JSON.stringify(result), now]);
 await database.pool.query(`INSERT INTO audit_events (id,actor_type,event_type,target_type,target_id,data_json,created_at) VALUES ('closure-integrated','service','assignment.content.integrated','capacity_provider_assignment','closure-assignment',$1,$2)`, [JSON.stringify({ resultId: result.id, references: result.references, publication: false }), now]);
 const unrelated = await sessions.get('team','closure-unrelated');
 const closing = (await runs.get('team','sdk'))!;
 const retained = async () => ({ assignments: (await observer.query("SELECT * FROM capacity_provider_assignments WHERE id LIKE 'closure-%' ORDER BY id")).rows, audit: (await observer.query("SELECT * FROM audit_events WHERE id='closure-integrated'")).rows });
 const lock = await observer.connect();
 let pending: Promise<unknown> | undefined;
 try {
  await lock.query('BEGIN');
  await lock.query("SELECT id FROM capacity_provider_availability_sessions WHERE id='closure-owned' FOR NO KEY UPDATE");
  pending = advanceLivingWorkday(lifecycle,closing,now);
  await eventObserved(async () => (await observer.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%capacity_provider_availability_sessions%'")).rows.length > 0, deadline);
  // A different workday acquires this same session while closure waits. Its active work must survive.
  await lock.query(`INSERT INTO capacity_provider_assignments (id,membership_id,team_id,project_id,capacity_provider_id,provider_session_id,project_agent_class_id,work_day_id,mode,status,created_at,updated_at) VALUES ('closure-other-active','closure-membership','team','project','provider','closure-owned','closure-class','production','acting','running',$1,$1)`, [now]);
  await lock.query('COMMIT');
  await pending; pending = undefined;
  expect(await sessions.get('team','closure-owned')).toMatchObject({ status: 'open', closedAt: null });
  expect(await sessions.get('team','closure-unrelated')).toEqual(unrelated);
  const ended = (await runs.get('team','sdk'))!;
  expect(ended).toMatchObject({ status: 'completed', parameters: { appliedPlan: { state:'ended', reportRef } } });
  // Controlled other-workday terminal input; no result, usage or successful managed work is manufactured.
  await observer.query("UPDATE capacity_provider_assignments SET status='cancelled',failed_at=$1 WHERE id='closure-other-active'", [now]);
  const held = await retained();
  await database.pool.query(`CREATE FUNCTION closure_interrupt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'retained native session closure interruption'; END $$`);
  await database.pool.query(`CREATE TRIGGER closure_interrupt BEFORE UPDATE ON capacity_provider_availability_sessions FOR EACH ROW EXECUTE FUNCTION closure_interrupt()`);
  try { await expect(advanceLivingWorkday(lifecycle,ended,now)).rejects.toThrow('retained native session closure interruption'); }
  finally { await database.pool.query('DROP TRIGGER closure_interrupt ON capacity_provider_availability_sessions'); await database.pool.query('DROP FUNCTION closure_interrupt()'); }
  expect(await sessions.get('team','closure-owned')).toMatchObject({ status:'open',closedAt:null });
  expect(await retained()).toEqual(held); expect(await runs.get('team','sdk')).toEqual(ended);
  await Promise.all([advanceLivingWorkday(lifecycle,ended,now),advanceLivingWorkday(lifecycle,ended,now)]);
  const closed = await sessions.get('team','closure-owned');
  expect(closed).toMatchObject({ status:'closed',closedAt:now });
  await advanceLivingWorkday(lifecycle,(await runs.get('team','sdk'))!,now);
  expect(await sessions.get('team','closure-owned')).toEqual(closed);
  expect(await sessions.get('team','closure-unrelated')).toEqual(unrelated);
  expect(await retained()).toEqual(held); expect(await runs.get('team','sdk')).toEqual(ended);
  // Controlled original native proxy rows prove inventory reconciliation, not a TreeDX/model execution.
  const proxy={id:'closure-handle',teamId:'team',projectId:'project',assignmentId:'closure-assignment',repositoryId:'library',workspaceId:null,status:'revoked',revokedAt:now};
  await database.pool.query(`INSERT INTO treedx_proxy_handles (id,team_id,project_id,assignment_id,repository_id,status,issued_at,revoked_at,created_at,updated_at) VALUES ('closure-handle','team','project','closure-assignment','library','revoked',$1,$1,$1,$1)`,[now]);
  await database.pool.query("UPDATE capacity_provider_assignments SET treedx_proxy_handle_json=$1,workspace_context_json=$2 WHERE id='closure-assignment'",[JSON.stringify(proxy),JSON.stringify({treedxProxyHandle:proxy})]);
  const originals={assignments:(await observer.query("SELECT * FROM capacity_provider_assignments WHERE work_day_id='sdk' ORDER BY id")).rows,sessions:(await observer.query("SELECT * FROM capacity_provider_availability_sessions WHERE team_id='team' ORDER BY id")).rows,proxies:(await observer.query("SELECT * FROM treedx_proxy_handles WHERE assignment_id='closure-assignment' ORDER BY id")).rows};
  verifyNativeResourceClosure(originals.assignments,originals.sessions,originals.proxies,ended);
  const publicSessions=await verifyNativeInventory(originals.sessions,cursor=>sessions.listPage('team',{limit:1,cursor:decodeCapacityPageCursor(cursor)}),1,'descending','openedAt');
  for(const session of originals.sessions)expect(publicSessions.find(value=>value.id===session.id)).toEqual(serializeAvailabilitySessionRow(session));
  const observed=structuredClone(originals);for(const field of['status','assignment_id','workspace_id']){const changed=structuredClone(originals);changed.proxies[0]![field]='foreign';expect(()=>verifyNativeResourceClosure(changed.assignments,changed.sessions,changed.proxies,ended)).toThrow('ACCEPTANCE_NATIVE_RESOURCE');}
  expect((await observer.query("SELECT * FROM treedx_proxy_handles WHERE assignment_id='closure-assignment' ORDER BY id")).rows).toEqual(observed.proxies);
 } finally {
  await lock.query('ROLLBACK'); lock.release();
  if (pending) await pending.catch(() => undefined);
 }
}

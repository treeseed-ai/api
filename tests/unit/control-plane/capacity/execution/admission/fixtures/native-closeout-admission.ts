import {ControlPlaneStore} from '../../../../../../../src/api/persistence/store.ts';
import {CapacityWorkdayRunRepository} from '../../../../../../../src/api/capacity/repositories/capacity/workdays/workday-run.ts';
import {CapacityWorkdayRunWriteRepository} from '../../../../../../../src/api/capacity/repositories/capacity/workdays/workday-run-write.ts';
import {CapacityWorkdayEventRepository} from '../../../../../../../src/api/capacity/repositories/capacity/workdays/workday-event.ts';
import {expect} from 'vitest';
import {assignmentAttemptSchema, type AssignmentAttempt} from '@treeseed/sdk/agent-capacity';
import type {createControlPlanePostgresDatabase} from '../../../../../../../src/api/support/control-plane-postgres.ts';
import type {DurableProviderAssignment} from '../../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';
import {eventObserved} from '../../../../realtime/architecture/session-postgres-fixture.ts';

/** Real independent PostgreSQL transactions and original admission. All authority inputs are controlled fixtures, not model/Reporter output. */
export async function proveNativeCloseoutAdmission(database:ReturnType<typeof createControlPlanePostgresDatabase>,peer:ReturnType<typeof createControlPlanePostgresDatabase>,attempt:AssignmentAttempt,admit:(value:AssignmentAttempt)=>Promise<DurableProviderAssignment>){
 const original=(await peer.pool.query('SELECT * FROM capacity_workday_runs WHERE team_id=$1 AND id=$2',[attempt.teamId,attempt.workdayId])).rows;
 expect(original).toHaveLength(1);const parameters=JSON.parse(String(original[0]!.parameters_json)),held=structuredClone(attempt);
 const closing=JSON.stringify({...parameters,appliedPlan:{...parameters.appliedPlan,state:'closing',closingAt:attempt.createdAt}});
 const state=async()=>Object.fromEntries(await Promise.all(['capacity_provider_assignments','capacity_reservations','execution_nodes','treedx_proxy_handles','capacity_workday_events','capacity_admission_counters','capacity_reservation_counter_claims'].map(async table=>[table,(await peer.pool.query('SELECT * FROM '+table+' ORDER BY 1')).rows])));
 const before=await state();expect(before.capacity_admission_counters).toEqual([]);expect(before.capacity_reservation_counter_claims).toEqual([]);const lock=await peer.pool.connect();let closingEventId:string|undefined;let pending:Promise<{value:DurableProviderAssignment}|{error:unknown}>|undefined;
 try {
  await peer.pool.query('UPDATE capacity_workday_runs SET parameters_json=$1 WHERE id=$2',[closing,attempt.workdayId]);
  await expect(admit(attempt)).rejects.toMatchObject({code:'workday_admission_closed',status:409});
  expect(await state()).toEqual(before);expect(attempt).toEqual(held);
  await peer.pool.query("UPDATE capacity_workday_runs SET execution_kind='conversation' WHERE id=$1",[attempt.workdayId]);
  await expect(admit(attempt)).rejects.toMatchObject({code:'workday_admission_closed',status:409});expect(await state()).toEqual(before);
  await peer.pool.query("UPDATE capacity_workday_runs SET execution_kind='workday' WHERE id=$1",[attempt.workdayId]);

  await peer.pool.query('UPDATE capacity_workday_runs SET parameters_json=$1 WHERE id=$2',[original[0]!.parameters_json,attempt.workdayId]);
  await lock.query('BEGIN');await lock.query('SELECT id FROM capacity_workday_runs WHERE team_id=$1 AND id=$2 FOR UPDATE',[attempt.teamId,attempt.workdayId]);
  pending=admit(attempt).then(value=>({value}),error=>({error}));
  await eventObserved(async()=> (await peer.pool.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%capacity_workday_runs%' ")).rows.length>0,Date.now()+5_000);
  await lock.query('UPDATE capacity_workday_runs SET parameters_json=$1 WHERE id=$2',[closing,attempt.workdayId]);await lock.query('COMMIT');
  expect(await pending).toMatchObject({error:{code:'workday_admission_closed',status:409}});pending=undefined;
  expect(await state()).toEqual(before);expect(attempt).toEqual(held);
  // Establish closing through its actual owner before asking for immutable Reporter input.
  const owner=new ControlPlaneStore({TREESEED_ENVIRONMENT:'test'},database);owner.initializationPromise=Promise.resolve();
  await peer.pool.query('UPDATE capacity_workday_runs SET parameters_json=$1 WHERE id=$2',[original[0]!.parameters_json,attempt.workdayId]);
  const prior=(await new CapacityWorkdayRunRepository(owner).get(attempt.teamId,attempt.workdayId))!;
  await new CapacityWorkdayRunWriteRepository(owner).update({...prior,parameters:JSON.parse(closing),updatedAt:attempt.createdAt},prior.status);
  const originalClosing=(await new CapacityWorkdayEventRepository(owner).list(attempt.teamId,attempt.workdayId,{limit:50})).items.filter(event=>event.eventType==='workday.lifecycle.changed');expect(originalClosing).toHaveLength(1);closingEventId=originalClosing[0]!.id;
  // The same canonical provider supply is still available for the chosen closing Reporter.
  const reporter=assignmentAttemptSchema.parse({...attempt,id:'closing-reporter',idempotencyKey:'closing-reporter',nodeId:'closing-reporter-node',leaseId:'closing-reporter-lease',reservationId:'closing-reporter-reservation',
   sourceRef:{store:'postgresql',model:'workday',id:attempt.workdayId,revision:1,digest:'sha256:'+'a'.repeat(64)},predecessorResultIds:[],
   effectiveProfile:{...attempt.effectiveProfile,activity:'reporting',handler:'configured-reporting-handler'}});
  await database.pool.query(`INSERT INTO execution_nodes (id,team_id,project_id,workday_id,kind,source_ref_json,authority_refs_json,rule_revision,node_revision,agent_class,status,graph_revision_created,graph_revision_updated,created_at,updated_at)
   VALUES ($1,$2,$3,$4,'reporting',$5,$6,1,$7,$8,'ready',1,$9,$10,$10)`,[reporter.nodeId,reporter.teamId,reporter.projectId,reporter.workdayId,JSON.stringify(reporter.sourceRef),JSON.stringify(reporter.authorityRefs),reporter.nodeRevision,reporter.agentClass,reporter.graphRevision,reporter.createdAt]);
  const observed=await admit(reporter);expect(observed.assignmentAttempt).toEqual(reporter);
  const reserved=(await peer.pool.query('SELECT * FROM capacity_reservations WHERE assignment_id=$1',[reporter.id])).rows;
  expect(reserved).toHaveLength(1);expect(Number(reserved[0]!.reserved_seconds)).toBe(reporter.limits.maximumSeconds);
  const admitted=await state();expect(await admit(reporter)).toEqual(observed);expect(await state()).toEqual(admitted);
  expect((await peer.pool.query('SELECT id FROM capacity_provider_assignments ORDER BY id')).rows).toEqual([{id:reporter.id}]);
  console.log(JSON.stringify({nativeCloseoutAdmission:{deniedPreparedActor:attempt.id,deniedConcurrentActor:attempt.id,reporter:reporter.id,reservation:reporter.reservationId,reservedSeconds:Number(reserved[0]!.reserved_seconds),controlledAuthority:true,managedProof:false}}));
 } finally {
  await lock.query('ROLLBACK');lock.release();if(pending)await pending;
  // Remove only this helper's disposable test rows, retaining the original test's complete admission/settlement coverage.
  if(closingEventId)await database.pool.query('DELETE FROM capacity_workday_events WHERE id=$1 AND team_id=$2 AND run_id=$3',[closingEventId,attempt.teamId,attempt.workdayId]);
  await database.pool.query("DELETE FROM capacity_workday_events WHERE assignment_id='closing-reporter' OR context_json::jsonb->>'nodeId'='closing-reporter-node'");
  await database.pool.query("DELETE FROM capacity_reservation_counter_claims WHERE reservation_id='closing-reporter-reservation'");
  await database.pool.query("DELETE FROM treedx_proxy_handles WHERE assignment_id='closing-reporter'");
  await database.pool.query("DELETE FROM capacity_provider_assignments WHERE id='closing-reporter'");
  await database.pool.query("DELETE FROM capacity_reservations WHERE id='closing-reporter-reservation'");
  await database.pool.query("DELETE FROM execution_nodes WHERE id='closing-reporter-node'");
  await database.pool.query('DELETE FROM capacity_admission_counters');
  await database.pool.query('UPDATE capacity_workday_runs SET parameters_json=$1,execution_kind=$3,next_event_index=$4 WHERE id=$2',[original[0]!.parameters_json,attempt.workdayId,original[0]!.execution_kind,original[0]!.next_event_index]);
 }
 expect(await state()).toEqual(before);expect(attempt).toEqual(held);
}

import { createHash } from 'node:crypto';
import { expect } from 'vitest';
import type { AssignmentAttempt } from '@treeseed/sdk/agent-capacity';
import type { createControlPlanePostgresDatabase } from '../../../../../../../src/api/support/control-plane-postgres.ts';
import type { ControlPlaneStore } from '../../../../../../../src/api/persistence/store.ts';
import { ProviderAssignmentRepository } from '../../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';
import { CapacityWorkdayEventRepository } from '../../../../../../../src/api/capacity/repositories/capacity/workdays/workday-event.ts';
import { startAssignmentExecutionWindow, startAssignmentCloseoutWindow } from '../../../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-execution-window-service.ts';

/** Extend the original admitted/leased PostgreSQL fixture. No allocation,
 * productive allowance, deadline or usage input is changed for this proof. */
export async function proveNativeAssignmentWindows(
 database:ReturnType<typeof createControlPlanePostgresDatabase>,peer:ReturnType<typeof createControlPlanePostgresDatabase>,
 accounting:ControlPlaneStore,peerAccounting:ControlPlaneStore,attempt:AssignmentAttempt,
) {
 const principal={teamId:attempt.teamId,membershipId:'membership',capacityProviderId:attempt.provider.providerId,scopes:['provider:assignments:write']};
 const stores=[accounting,peerAccounting],failedObservations:unknown[]=[];
 const state=async()=>({
  attempts:(await peer.pool.query('SELECT * FROM capacity_provider_assignments ORDER BY id')).rows,
  workdays:(await peer.pool.query('SELECT * FROM capacity_workday_runs ORDER BY id')).rows,
  events:(await peer.pool.query('SELECT * FROM capacity_workday_events ORDER BY event_index')).rows,
  reservations:(await peer.pool.query('SELECT * FROM capacity_reservations ORDER BY id')).rows,
  counters:(await peer.pool.query('SELECT * FROM capacity_admission_counters ORDER BY id')).rows,
  usage:(await peer.pool.query('SELECT * FROM capacity_usage_actuals ORDER BY id')).rows,
  ledger:(await peer.pool.query('SELECT * FROM capacity_ledger_entries ORDER BY id')).rows,
 });
 let executionStartedAt='';
 for(const phase of ['execution','closeout']as const){
  const issued=await new ProviderAssignmentRepository(peerAccounting).get(attempt.teamId,attempt.id);
  if(!issued?.leaseToken)throw new Error('Original native winning lease is required for phase proof');
  const input={leaseToken:issued.leaseToken,expectedStateVersion:issued.stateVersion,idempotencyKey:'native-'+phase+':'+attempt.id};
  const original=structuredClone({input,principal,attempt}),before=await state();
  const start=phase==='execution'?startAssignmentExecutionWindow:startAssignmentCloseoutWindow;
  await database.pool.query(`CREATE FUNCTION native_window_observation_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
   IF NEW.event_type='assignment.${phase}.started' THEN RAISE EXCEPTION 'retained native phase observation interruption'; END IF; RETURN NEW;END $$`);
  await database.pool.query('CREATE TRIGGER native_window_observation_failure BEFORE INSERT ON capacity_workday_events FOR EACH ROW EXECUTE FUNCTION native_window_observation_failure()');
  let failed:unknown;
  try{await start(accounting,principal,attempt.id,input);}
  catch(error){failed={message:String(error),custody:await state()};}
  finally{await database.pool.query('DROP TRIGGER native_window_observation_failure ON capacity_workday_events');await database.pool.query('DROP FUNCTION native_window_observation_failure()');}
  expect(failed).toMatchObject({message:expect.stringContaining('retained native phase observation interruption'),custody:before});failedObservations.push(structuredClone(failed));
  const records=await Promise.all(stores.map(store=>start(store,principal,attempt.id,input)));
  expect(records[0]).toEqual(records[1]);const committed=records[0]!,window=committed.metadata[phase+'Window'] as {startedAt:string};
  expect(typeof window.startedAt).toBe('string');expect(Number.isFinite(Date.parse(window.startedAt))).toBe(true);
  const native=(await peer.pool.query('SELECT * FROM capacity_workday_events WHERE assignment_id=$1 AND event_type=$2 ORDER BY event_index',[attempt.id,'assignment.'+phase+'.started'])).rows;
  expect(native).toHaveLength(1);const event=native[0]!;
  const context={nodeId:attempt.nodeId,nodeRevision:attempt.nodeRevision,graphRevision:attempt.graphRevision,status:phase==='execution'?'running':'closeout',leaseId:attempt.leaseId,reservationId:attempt.reservationId,runnerId:issued.runnerId??null};
  expect(event).toMatchObject({id:'assignment-'+phase+':'+attempt.id,team_id:attempt.teamId,run_id:attempt.workdayId,assignment_id:attempt.id,created_at:window.startedAt});
  expect(JSON.parse(String(event.context_json))).toEqual(context);expect(JSON.stringify(event)).not.toContain(issued.leaseToken);
  const publicEvents=await new CapacityWorkdayEventRepository(peerAccounting).list(attempt.teamId,attempt.workdayId,{limit:200});
  expect(publicEvents.page).toEqual({limit:200,hasMore:false,nextCursor:null});
  expect(publicEvents.items.find(value=>value.id===event.id)).toMatchObject({eventType:event.event_type,createdAt:window.startedAt,context,parameters:{},metadata:{},refs:{}});
  const after=await state();expect(await start(peerAccounting,principal,attempt.id,input)).toEqual(committed);expect(await state()).toEqual(after);
  expect({input,principal,attempt}).toEqual(original);expect(failed).toEqual(failedObservations.at(-1));
  if(phase==='execution'){executionStartedAt=window.startedAt;expect(committed.assignmentAttempt).toEqual({...attempt,status:'running',startedAt:executionStartedAt});}
  else expect(committed.assignmentAttempt).toEqual({...attempt,status:'running',startedAt:executionStartedAt});
 }
 expect(failedObservations).toHaveLength(2);console.log(JSON.stringify({nativeAssignmentPhaseFailures:failedObservations.map(value=>{const failure=value as {message:string;custody:unknown};return{message:failure.message,custodySha256:createHash('sha256').update(JSON.stringify(failure.custody)).digest('hex')};}),assignmentId:attempt.id,executionStartedAt}));
 return{executionStartedAt};
}


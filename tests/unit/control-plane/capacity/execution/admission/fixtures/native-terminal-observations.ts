import {createHash} from 'node:crypto';
import {expect} from 'vitest';
import type {AssignmentAttempt} from '@treeseed/sdk/agent-capacity';
import type {createControlPlanePostgresDatabase} from '../../../../../../../src/api/support/control-plane-postgres.ts';
import type {ControlPlaneStore} from '../../../../../../../src/api/persistence/store.ts';
import type {settleCapacityReservationExactlyOnce} from '../../../../../../../src/api/capacity/services/capacity/accounting/settlement-service.ts';
import {createCapacityControlPlane} from '../../../../../../../src/api/capacity/control-plane.ts';
import {ProviderAssignmentRepository} from '../../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';
import {CapacityWorkdayEventRepository} from '../../../../../../../src/api/capacity/repositories/capacity/workdays/workday-event.ts';

/** Uses the original admitted, leased, executed and settled native attempt.
 * Timeout reporting never extends its productive authority or watchdog. */
export async function proveNativeTerminalObservation(
 database:ReturnType<typeof createControlPlanePostgresDatabase>,peer:ReturnType<typeof createControlPlanePostgresDatabase>,
 accounting:ControlPlaneStore,peerAccounting:ControlPlaneStore,attempt:AssignmentAttempt,
 settlement:Parameters<typeof settleCapacityReservationExactlyOnce>[1],
){
 const principal={teamId:attempt.teamId,membershipId:'membership',capacityProviderId:attempt.provider.providerId};
 const issued=await new ProviderAssignmentRepository(peerAccounting).get(attempt.teamId,attempt.id);if(!issued?.leaseToken)throw new Error('Original native winning lease required');
 const input={leaseToken:issued.leaseToken,code:'assignment_timeout',retryable:false,activeSeconds:settlement.activeSeconds,
  elapsedSeconds:settlement.elapsedSeconds,providerUnits:settlement.providerUnits,actualUsd:settlement.usd,usage:{...settlement.usageActual}};
 const held=structuredClone({input,principal,attempt,settlement}),owners=[accounting,peerAccounting].map(store=>createCapacityControlPlane(store));
 const state=async()=>Object.fromEntries(await Promise.all(['capacity_provider_assignments','capacity_workday_runs','capacity_workday_events',
  'execution_nodes','execution_graph_revisions','capacity_reservations','capacity_admission_counters','capacity_usage_actuals','capacity_ledger_entries']
  .map(async table=>[table,(await peer.pool.query('SELECT * FROM '+table+' ORDER BY 1')).rows])));
 const before=await state(),failures:unknown[]=[];
 for(const mode of ['zero-write','event-insert']as const){
  const sql=mode==='zero-write'?"IF NEW.status='failed' THEN RETURN NULL; END IF;":"IF NEW.event_type='assignment.failed' THEN RAISE EXCEPTION 'retained native terminal observation interruption'; END IF;";
  await database.pool.query('CREATE FUNCTION native_terminal_observation_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN '+sql+' RETURN NEW;END $$');
  await database.pool.query(mode==='zero-write'?'CREATE TRIGGER native_terminal_observation_failure BEFORE UPDATE ON capacity_provider_assignments FOR EACH ROW EXECUTE FUNCTION native_terminal_observation_failure()':'CREATE TRIGGER native_terminal_observation_failure BEFORE INSERT ON capacity_workday_events FOR EACH ROW EXECUTE FUNCTION native_terminal_observation_failure()');
  let failure:unknown;try{await owners[0]!.failProviderAssignment(principal,attempt.id,input);}catch(error){failure={message:String(error),state:await state()};}
  finally{await database.pool.query('DROP TRIGGER native_terminal_observation_failure ON '+(mode==='zero-write'?'capacity_provider_assignments':'capacity_workday_events'));await database.pool.query('DROP FUNCTION native_terminal_observation_failure()');}
  expect(failure).toMatchObject({message:expect.stringContaining(mode==='zero-write'?'assignment_terminal_observation_state_mismatch':'retained native terminal observation interruption'),state:before});
  failures.push(structuredClone(failure));expect(await state()).toEqual(before);
 }
 const results=await Promise.all(owners.map(owner=>owner.failProviderAssignment(principal,attempt.id,input)));expect(results.filter(Boolean)).toHaveLength(1);
 const terminal=await new ProviderAssignmentRepository(peerAccounting).get(attempt.teamId,attempt.id);
 expect(terminal).toMatchObject({status:'failed',stateVersion:issued.stateVersion+1,assignmentAttempt:{...issued.assignmentAttempt,status:'failed',finishedAt:terminal?.updatedAt}});
 const raw=(await peer.pool.query("SELECT * FROM capacity_workday_events WHERE assignment_id=$1 AND event_type='assignment.failed' ORDER BY event_index",[attempt.id])).rows;
 expect(raw).toHaveLength(1);const event=raw[0]!,context={nodeId:attempt.nodeId,nodeRevision:attempt.nodeRevision,graphRevision:attempt.graphRevision,
  status:'failed',leaseId:attempt.leaseId,reservationId:attempt.reservationId,runnerId:issued.runnerId??null,resultId:null};
 expect(event).toMatchObject({team_id:attempt.teamId,run_id:attempt.workdayId,workday_id:attempt.workdayId,project_id:attempt.projectId,assignment_id:attempt.id,created_at:terminal?.updatedAt});
 expect(JSON.parse(String(event.context_json))).toEqual(context);expect(JSON.stringify(event)).not.toContain(issued.leaseToken);
 expect(await new CapacityWorkdayEventRepository(peerAccounting).get(attempt.teamId,attempt.workdayId,String(event.id))).toMatchObject({eventType:'assignment.failed',context,createdAt:terminal?.updatedAt});
 const after=await state();for(const table of ['capacity_reservations','capacity_admission_counters','capacity_usage_actuals','capacity_ledger_entries'])expect(after[table]).toEqual(before[table]);
 expect(await owners[1]!.failProviderAssignment(principal,attempt.id,input)).toBeNull();expect(await state()).toEqual(after);expect({input,principal,attempt,settlement}).toEqual(held);
 expect(failures).toHaveLength(2);console.log(JSON.stringify({nativeTerminalObservationFailures:failures.map(value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')),assignmentId:attempt.id,eventId:event.id}));
}

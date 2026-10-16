import {proveNativeCloseoutAdmission} from './native-closeout-admission.ts';
import {serializeCapacityReservationRow} from '../../../../../../../src/api/capacity/repositories/capacity/accounting/reservation.ts';
import { proveNativeClosedSessionAdmission } from './native-admission-session.ts';
import {createHash} from 'node:crypto';
import {expect} from 'vitest';
import type {AssignmentAttempt} from '@treeseed/sdk/agent-capacity';
import type {createControlPlanePostgresDatabase} from '../../../../../../../src/api/support/control-plane-postgres.ts';
import type {DurableProviderAssignment} from '../../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';
import type {ControlPlaneStore} from '../../../../../../../src/api/persistence/store.ts';
import {CapacityWorkdayEventRepository} from '../../../../../../../src/api/capacity/repositories/capacity/workdays/workday-event.ts';

/** Reuse the original native admission and independent peer; no clocks or limits change. */
export async function proveNativeCreationRollback(database:ReturnType<typeof createControlPlanePostgresDatabase>,peer:ReturnType<typeof createControlPlanePostgresDatabase>,attempt:AssignmentAttempt,admit:(value:AssignmentAttempt)=>Promise<DurableProviderAssignment>){
 await proveNativeCloseoutAdmission(database,peer,attempt,admit);
 await proveNativeClosedSessionAdmission(database,peer,attempt,admit);
 const state=async()=>Object.fromEntries(await Promise.all(['capacity_provider_assignments','capacity_reservations','execution_nodes','treedx_proxy_handles','capacity_workday_runs','capacity_workday_events','capacity_admission_counters','capacity_reservation_counter_claims'].map(async table=>[table,(await peer.pool.query('SELECT * FROM '+table+' ORDER BY 1')).rows])));
 const before=await state(),held=structuredClone(attempt),failures:unknown[]=[];
 for(const mode of ['missing','interrupted','node-missing','node-interrupted','node-state-missing','accounting-missing','accounting-interrupted','accounting-altered','counter-state-missing']as const){
  await database.pool.query('CREATE FUNCTION native_creation_observation_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN '+(mode==='counter-state-missing'?'RETURN NULL;':mode==='accounting-missing'?"IF NEW.event_type='capacity.accounting.updated' THEN RETURN NULL; END IF; RETURN NEW;":mode==='accounting-interrupted'?"IF NEW.event_type='capacity.accounting.updated' THEN RAISE EXCEPTION 'retained native accounting interruption'; END IF; RETURN NEW;":mode==='accounting-altered'?"IF NEW.event_type='capacity.accounting.updated' THEN NEW.context_json='{}'; END IF; RETURN NEW;":mode==='node-state-missing'?"IF NEW.status='assigned' THEN RETURN NULL; END IF; RETURN NEW;":mode==='node-missing'?"IF NEW.event_type='execution.node.state' THEN RETURN NULL; END IF; RETURN NEW;":mode==='node-interrupted'?"IF NEW.event_type='execution.node.state' THEN RAISE EXCEPTION 'retained native node interruption'; END IF; RETURN NEW;":mode==='missing'?'RETURN NULL;':"RAISE EXCEPTION 'retained native creation observation interruption';")+' END $$');
  const table=mode==='counter-state-missing'?'capacity_admission_counters':mode==='node-state-missing'?'execution_nodes':'capacity_workday_events';
  await database.pool.query('CREATE TRIGGER native_creation_observation_failure BEFORE '+(['node-state-missing','counter-state-missing'].includes(mode)?'UPDATE':'INSERT')+' ON '+table+' FOR EACH ROW EXECUTE FUNCTION native_creation_observation_failure()');
  let failure:unknown;try{await admit(attempt);}catch(error){failure={message:String(error),state:await state()};}
  finally{await database.pool.query('DROP TRIGGER native_creation_observation_failure ON '+table);await database.pool.query('DROP FUNCTION native_creation_observation_failure()');}
  expect(failure).toMatchObject({message:expect.stringContaining(mode==='counter-state-missing'?'Admission requires every exact reservation and scoped counter commit.':mode==='accounting-interrupted'?'retained native accounting interruption':['accounting-missing','accounting-altered'].includes(mode)?'Accounting requires its exact durable public observation.':mode==='node-state-missing'?'execution_node_observation_state_mismatch':mode==='node-missing'?'execution_node_observation_missing':mode==='node-interrupted'?'retained native node interruption':mode==='missing'?'Assignment creation requires its exact durable owning observation.':'retained native creation observation interruption'),state:before});failures.push(structuredClone(failure));expect(await state()).toEqual(before);expect(attempt).toEqual(held);
 }
 console.log(JSON.stringify({nativeCreationObservationFailures:failures.map(value=>createHash('sha256').update(JSON.stringify(value)).digest('hex'))}));
}
export async function verifyNativeCreationObservation(peer:ReturnType<typeof createControlPlanePostgresDatabase>,owner:ControlPlaneStore,attempt:AssignmentAttempt){
 const rows=(await peer.pool.query("SELECT * FROM capacity_workday_events WHERE assignment_id=$1 AND event_type='assignment.created' ORDER BY event_index",[attempt.id])).rows;expect(rows).toHaveLength(1);const event=rows[0]!;
 const assignment=(await peer.pool.query('SELECT * FROM capacity_provider_assignments WHERE id=$1 AND team_id=$2',[attempt.id,attempt.teamId])).rows;expect(assignment).toHaveLength(1);
 expect(event).toMatchObject({team_id:attempt.teamId,run_id:attempt.workdayId,workday_id:attempt.workdayId,project_id:attempt.projectId,assignment_id:attempt.id,status:'recorded',created_at:assignment[0]!.created_at});
 expect(JSON.parse(String(event.context_json))).toEqual({nodeId:attempt.nodeId,nodeRevision:attempt.nodeRevision,graphRevision:attempt.graphRevision,status:'created',leaseId:attempt.leaseId,reservationId:attempt.reservationId,runnerId:null});
 expect(await new CapacityWorkdayEventRepository(owner).get(attempt.teamId,attempt.workdayId,String(event.id))).toMatchObject({eventType:'assignment.created',createdAt:event.created_at,context:JSON.parse(String(event.context_json)),parameters:{},metadata:{},refs:{}});
 const nodeRows=(await peer.pool.query("SELECT * FROM capacity_workday_events WHERE run_id=$1 AND event_type='execution.node.state' AND context_json::jsonb->>'nodeId'=$2 ORDER BY event_index",[attempt.workdayId,attempt.nodeId])).rows;expect(nodeRows).toHaveLength(1);
 expect(JSON.parse(String(nodeRows[0]!.context_json))).toMatchObject({nodeId:attempt.nodeId,nodeRevision:attempt.nodeRevision,status:'assigned',previousStatus:'ready'});
 expect(await new CapacityWorkdayEventRepository(owner).get(attempt.teamId,attempt.workdayId,String(nodeRows[0]!.id))).toMatchObject({eventType:'execution.node.state',context:JSON.parse(String(nodeRows[0]!.context_json))});

 const accounting=(await peer.pool.query("SELECT * FROM capacity_workday_events WHERE assignment_id=$1 AND event_type='capacity.accounting.updated' ORDER BY event_index",[attempt.id])).rows;expect(accounting).toHaveLength(1);
 const context=JSON.parse(String(accounting[0]!.context_json)),reservation=(await peer.pool.query('SELECT * FROM capacity_reservations WHERE id=$1',[attempt.reservationId])).rows;expect(reservation).toHaveLength(1);
 expect(context.reservation).toEqual(serializeCapacityReservationRow(reservation[0]!));expect(context.reservation.state).toBe('reserved');expect(context.usageActual).toBeNull();expect(context.ledgerEntry).toBeNull();
 const claims=(await peer.pool.query('SELECT * FROM capacity_reservation_counter_claims WHERE reservation_id=$1 ORDER BY counter_id',[attempt.reservationId])).rows;
 const counters=(await peer.pool.query('SELECT * FROM capacity_admission_counters ORDER BY id')).rows;expect(claims).toHaveLength(2);
 expect(context.remainingSupply).toEqual(claims.map(claim=>{const counter=counters.find(value=>value.id===claim.counter_id);expect(counter).toBeDefined();return{id:counter!.id,teamId:counter!.team_id,scope:counter!.scope,scopeId:counter!.scope_id,periodKey:counter!.period_key,hardLimit:Number(counter!.hard_limit),committedAmount:Number(counter!.committed_amount),stateVersion:Number(counter!.state_version),reservedAmount:Number(claim.reserved_amount),releasedAmount:Number(claim.released_amount),releasePolicy:claim.release_policy,remainingAmount:Math.max(0,Number(counter!.hard_limit)-Number(counter!.committed_amount))};}));
 expect(await new CapacityWorkdayEventRepository(owner).get(attempt.teamId,attempt.workdayId,String(accounting[0]!.id))).toMatchObject({eventType:'capacity.accounting.updated',context});

}

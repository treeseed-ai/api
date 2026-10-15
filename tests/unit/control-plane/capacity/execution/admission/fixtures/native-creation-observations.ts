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
 await proveNativeClosedSessionAdmission(database,peer,attempt,admit);
 const state=async()=>Object.fromEntries(await Promise.all(['capacity_provider_assignments','capacity_reservations','execution_nodes','treedx_proxy_handles','capacity_workday_runs','capacity_workday_events','capacity_admission_counters','capacity_reservation_counter_claims'].map(async table=>[table,(await peer.pool.query('SELECT * FROM '+table+' ORDER BY 1')).rows])));
 const before=await state(),held=structuredClone(attempt),failures:unknown[]=[];
 for(const mode of ['missing','interrupted']as const){
  await database.pool.query('CREATE FUNCTION native_creation_observation_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN '+(mode==='missing'?'RETURN NULL;':"RAISE EXCEPTION 'retained native creation observation interruption';")+' END $$');
  await database.pool.query('CREATE TRIGGER native_creation_observation_failure BEFORE INSERT ON capacity_workday_events FOR EACH ROW EXECUTE FUNCTION native_creation_observation_failure()');
  let failure:unknown;try{await admit(attempt);}catch(error){failure={message:String(error),state:await state()};}
  finally{await database.pool.query('DROP TRIGGER native_creation_observation_failure ON capacity_workday_events');await database.pool.query('DROP FUNCTION native_creation_observation_failure()');}
  expect(failure).toMatchObject({message:expect.stringContaining(mode==='missing'?'Assignment creation requires its exact durable owning observation.':'retained native creation observation interruption'),state:before});failures.push(structuredClone(failure));expect(await state()).toEqual(before);expect(attempt).toEqual(held);
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

}

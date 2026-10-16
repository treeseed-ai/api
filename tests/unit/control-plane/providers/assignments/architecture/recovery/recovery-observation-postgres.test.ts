import{encodeCapacityPageCursor}from'@treeseed/sdk/capacity-pagination';
import {settleCapacityReservationExactlyOnce} from '../../../../../../../src/api/capacity/services/capacity/accounting/settlement-service.ts';
import {terminalUsage} from '../../../../capacity/accounting/architecture/settlement-fixture.ts';
import {describe,expect,it} from 'vitest';
import {postgresGraph} from '../../../../capacity/execution/graph/architecture/living/living-postgres-fixture.ts';
import {copyNativeAssignmentCustody} from '../native-assignment-custody.ts';
import {cancellationDatabase,cancelNow} from '../cancellation-fixture.ts';
import {ControlPlaneStore} from '../../../../../../../src/api/persistence/store.ts';
import {createCapacityControlPlane} from '../../../../../../../src/api/capacity/control-plane.ts';
import {createAssignmentService} from '../../../../../../../src/api/control-plane/repositories/capacity/assignment-service.ts';
import {createWorkdayService} from '../../../../../../../src/api/control-plane/repositories/capacity/workday-service.ts';
import {ProviderAssignmentRepository,advanceAssignmentAttemptLifecycle} from '../../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';

// Controlled original SQL inputs and reporting clocks; no provider/model usage
// or physical teardown is inferred. Native migrations and connections are real.
async function exerciseNativeRecovery(started:boolean,stop=false){
 const native=await postgresGraph();try{
  const supplied=await cancellationDatabase(stop?'returned':'leased',started),original=supplied.assignment,attempt=supplied.attempt;
  try{if(stop&&started)await settleCapacityReservationExactlyOnce(supplied.owner,terminalUsage);await copyNativeAssignmentCustody(native.left,supplied,['capacity_workday_runs','execution_nodes','capacity_reservations','capacity_provider_assignments','capacity_admission_counters','capacity_reservation_counter_claims','capacity_workday_events','capacity_usage_actuals','capacity_ledger_entries']);}
  finally{await supplied.db.close();}
  const owners=[native.left,native.right].map(db=>{const host=new ControlPlaneStore({TREESEED_ENVIRONMENT:'test'},db);host.initializationPromise=Promise.resolve();return createCapacityControlPlane(host);});
  const now=started&&!stop?new Date(Date.parse(original.leaseExpiresAt!)+90_001).toISOString():cancelNow,input={now,teamId:attempt.teamId,providerId:'provider'},held=structuredClone(input);
  const call=(owner:(typeof owners)[number])=>stop?owner.terminalizeCapacityWorkdayAssignments(attempt.teamId,attempt.workdayId,{now}):owner.recoverExpiredProviderAssignments(input);
  const status=started&&!stop?'expired':'failed',snapshot=async()=>Object.fromEntries(await Promise.all(['capacity_provider_assignments','capacity_workday_runs','capacity_workday_events','execution_nodes','capacity_reservations','capacity_admission_counters','capacity_reservation_counter_claims','capacity_workday_events','capacity_usage_actuals','capacity_ledger_entries','capacity_audit_events'].map(async table=>[table,(await native.right.pool.query('SELECT * FROM '+table+' ORDER BY 1,2')).rows]))),before=await snapshot(),failures:unknown[]=[];
  for(const mode of ['zero-write','missing','interrupted','node-missing','node-interrupted']as const){
   const table=mode==='zero-write'?'capacity_provider_assignments':'capacity_workday_events',statement=mode==='node-missing'?"IF NEW.event_type='execution.node.state' THEN RETURN NULL; END IF; RETURN NEW;":mode==='node-interrupted'?"IF NEW.event_type='execution.node.state' THEN RAISE EXCEPTION 'retained native node interruption'; END IF; RETURN NEW;":mode==='zero-write'?"IF NEW.status='"+status+"' THEN RETURN NULL;END IF;RETURN NEW;":mode==='missing'?'RETURN NULL;':"RAISE EXCEPTION 'retained native recovery interruption';";
   await native.left.pool.query('CREATE FUNCTION native_recovery_observation_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN '+statement+' END $$');
   await native.left.pool.query('CREATE TRIGGER native_recovery_observation_fault BEFORE '+(mode==='zero-write'?'UPDATE':'INSERT')+' ON '+table+' FOR EACH ROW EXECUTE FUNCTION native_recovery_observation_fault()');
   let failure:unknown;try{await call(owners[0]!);}catch(error){failure=error;}
   finally{await native.left.pool.query('DROP TRIGGER native_recovery_observation_fault ON '+table);await native.left.pool.query('DROP FUNCTION native_recovery_observation_fault()');}
   expect(failure).toMatchObject({message:expect.stringContaining(mode==='node-missing'?'execution_node_observation_missing':mode==='node-interrupted'?'retained native node interruption':mode==='zero-write'?(stop?'workday_assignment_observation_state_mismatch':'assignment_recovery_observation_state_mismatch'):mode==='missing'?(stop?'workday_assignment_observation_conflict':'assignment_recovery_observation_conflict'):'retained native recovery interruption')});expect(await snapshot()).toEqual(before);failures.push({mode,message:String(failure)});
  }
  const results=await Promise.all(owners.map(call));if(stop){for(const result of results)expect(result).toMatchObject({failedAssignments:1,unfinishedAssignmentCount:0});}else expect(results.reduce((sum,result)=>sum+('recovered' in result?result.recovered:0),0)).toBe(1);
  const terminal=await new ProviderAssignmentRepository(owners[1]!).get(attempt.teamId,attempt.id);expect(terminal).toMatchObject({status,stateVersion:original.stateVersion+1,updatedAt:now,assignmentAttempt:advanceAssignmentAttemptLifecycle(attempt,status,now)});
  const raw=(await native.right.pool.query('SELECT * FROM capacity_workday_events WHERE assignment_id=$1 ORDER BY event_index',[attempt.id])).rows;expect(raw).toHaveLength(1);
  expect(raw[0]).toMatchObject({event_type:'assignment.'+status,team_id:attempt.teamId,project_id:attempt.projectId,run_id:attempt.workdayId,workday_id:attempt.workdayId,created_at:now});expect(JSON.stringify(raw)).not.toContain('lease-token');
  const service=createWorkdayService(owners[1]!),events=await service.events(native.principal,attempt.teamId,attempt.workdayId,{limit:1});expect(events.items).toHaveLength(1);expect(events.page.hasMore).toBe(true);expect(events.items[0]).toMatchObject({id:raw[0]!.id,eventType:'assignment.'+status,createdAt:now});
  const second=await service.events(native.principal,attempt.teamId,attempt.workdayId,{limit:1,cursor:events.page.nextCursor});expect(second.items).toHaveLength(1);expect(second.page.hasMore).toBe(false);expect(second.items[0]).toMatchObject({eventType:'execution.node.state',assignmentId:null,context:{nodeId:attempt.nodeId,nodeRevision:attempt.nodeRevision,status:stop?'cancelled':'failed',previousStatus:'running'}});
  const last=second.items[0]!,empty=await service.events(native.principal,attempt.teamId,attempt.workdayId,{limit:1,cursor:encodeCapacityPageCursor({createdAt:last.createdAt,id:last.id})});expect(empty.items).toEqual([]);expect(empty.page.hasMore).toBe(false);
  const nativeEvents=(await native.right.pool.query('SELECT * FROM capacity_workday_events WHERE team_id=$1 AND run_id=$2 ORDER BY created_at,id',[attempt.teamId,attempt.workdayId])).rows;expect(nativeEvents).toHaveLength(2);expect([...events.items,...second.items].map(event=>event.id)).toEqual(nativeEvents.map(event=>event.id));
  expect(await createAssignmentService(owners[1]!).show(native.principal,attempt.teamId,attempt.id)).toMatchObject(terminal!);
  const after=await snapshot();if(started){for(const table of ['capacity_reservations','capacity_admission_counters','capacity_reservation_counter_claims','capacity_workday_events','capacity_usage_actuals','capacity_ledger_entries'])expect(after[table]).toEqual(before[table]);}
  else{expect(after.capacity_ledger_entries).toHaveLength(1);expect(after.capacity_usage_actuals).toHaveLength(1);expect(after.capacity_usage_actuals![0]).toMatchObject({active_seconds:0,elapsed_seconds:0});}
  if(stop)expect(await call(owners[1]!)).toMatchObject({failedAssignments:1,unfinishedAssignmentCount:0});else expect(await call(owners[1]!)).toMatchObject({scanned:0,recovered:0,results:[]});expect(await snapshot()).toEqual(after);expect(input).toEqual(held);expect(failures).toHaveLength(5);console.log(JSON.stringify({nativeRecoveryObservationFailures:failures}));
 }finally{await native.close();}
}
describe('native recovery observation and settlement custody',()=>{
 it('native PostgreSQL unknown executed recovery retains all usage holds through suppressed state and missing or interrupted observations before independent replay',async()=>exerciseNativeRecovery(true));
 it('native PostgreSQL pre-execution recovery settles once only with its original terminal observation after atomic rollback and independent replay',async()=>exerciseNativeRecovery(false));
});

it('native PostgreSQL workday stop preserves measured settlement and exact terminal observation through suppressed state interrupted writes and independent calls',async()=>exerciseNativeRecovery(true,true));
it('native PostgreSQL unstarted workday stop settles once with original terminal observation only after atomic rollback and independent calls',async()=>exerciseNativeRecovery(false,true));

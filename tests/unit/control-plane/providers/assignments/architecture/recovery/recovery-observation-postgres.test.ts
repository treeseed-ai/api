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
async function exerciseNativeRecovery(started:boolean){
 const native=await postgresGraph();try{
  const supplied=await cancellationDatabase('leased',started),original=supplied.assignment,attempt=supplied.attempt;
  try{await copyNativeAssignmentCustody(native.left,supplied,['capacity_workday_runs','execution_nodes','capacity_reservations','capacity_provider_assignments','capacity_admission_counters','capacity_reservation_counter_claims','capacity_usage_actuals','capacity_ledger_entries']);}
  finally{await supplied.db.close();}
  const owners=[native.left,native.right].map(db=>{const host=new ControlPlaneStore({TREESEED_ENVIRONMENT:'test'},db);host.initializationPromise=Promise.resolve();return createCapacityControlPlane(host);});
  const now=started?new Date(Date.parse(original.leaseExpiresAt!)+90_001).toISOString():cancelNow,input={now,teamId:attempt.teamId,providerId:'provider'},held=structuredClone(input);
  const status=started?'expired':'failed',snapshot=async()=>Object.fromEntries(await Promise.all(['capacity_provider_assignments','capacity_workday_runs','capacity_workday_events','execution_nodes','capacity_reservations','capacity_admission_counters','capacity_reservation_counter_claims','capacity_usage_actuals','capacity_ledger_entries','capacity_audit_events'].map(async table=>[table,(await native.right.pool.query('SELECT * FROM '+table+' ORDER BY 1,2')).rows]))),before=await snapshot(),failures:unknown[]=[];
  for(const mode of ['zero-write','missing','interrupted']as const){
   const table=mode==='zero-write'?'capacity_provider_assignments':'capacity_workday_events',statement=mode==='zero-write'?"IF NEW.status='"+status+"' THEN RETURN NULL;END IF;RETURN NEW;":mode==='missing'?'RETURN NULL;':"RAISE EXCEPTION 'retained native recovery interruption';";
   await native.left.pool.query('CREATE FUNCTION native_recovery_observation_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN '+statement+' END $$');
   await native.left.pool.query('CREATE TRIGGER native_recovery_observation_fault BEFORE '+(mode==='zero-write'?'UPDATE':'INSERT')+' ON '+table+' FOR EACH ROW EXECUTE FUNCTION native_recovery_observation_fault()');
   let failure:unknown;try{await owners[0]!.recoverExpiredProviderAssignments(input);}catch(error){failure=error;}
   finally{await native.left.pool.query('DROP TRIGGER native_recovery_observation_fault ON '+table);await native.left.pool.query('DROP FUNCTION native_recovery_observation_fault()');}
   expect(failure).toMatchObject({message:expect.stringContaining(mode==='zero-write'?'assignment_recovery_observation_state_mismatch':mode==='missing'?'assignment_recovery_observation_conflict':'retained native recovery interruption')});expect(await snapshot()).toEqual(before);failures.push({mode,message:String(failure)});
  }
  const results=await Promise.all(owners.map(owner=>owner.recoverExpiredProviderAssignments(input)));expect(results.reduce((sum,result)=>sum+result.recovered,0)).toBe(1);
  const terminal=await new ProviderAssignmentRepository(owners[1]!).get(attempt.teamId,attempt.id);expect(terminal).toMatchObject({status,stateVersion:original.stateVersion+1,updatedAt:now,assignmentAttempt:advanceAssignmentAttemptLifecycle(attempt,status,now)});
  const raw=(await native.right.pool.query('SELECT * FROM capacity_workday_events WHERE assignment_id=$1 ORDER BY event_index',[attempt.id])).rows;expect(raw).toHaveLength(1);
  expect(raw[0]).toMatchObject({event_type:'assignment.'+status,team_id:attempt.teamId,project_id:attempt.projectId,run_id:attempt.workdayId,workday_id:attempt.workdayId,created_at:now});expect(JSON.stringify(raw)).not.toContain('lease-token');
  const events=await createWorkdayService(owners[1]!).events(native.principal,attempt.teamId,attempt.workdayId,{limit:1});expect(events.items).toHaveLength(1);expect(events.page.hasMore).toBe(false);expect(events.items[0]).toMatchObject({id:raw[0]!.id,eventType:'assignment.'+status,createdAt:now});
  expect(await createAssignmentService(owners[1]!).show(native.principal,attempt.teamId,attempt.id)).toMatchObject(terminal!);
  const after=await snapshot();if(started){for(const table of ['capacity_reservations','capacity_admission_counters','capacity_reservation_counter_claims','capacity_usage_actuals','capacity_ledger_entries'])expect(after[table]).toEqual(before[table]);}
  else{expect(after.capacity_ledger_entries).toHaveLength(1);expect(after.capacity_usage_actuals).toHaveLength(1);expect(after.capacity_usage_actuals![0]).toMatchObject({active_seconds:0,elapsed_seconds:0});}
  expect(await owners[1]!.recoverExpiredProviderAssignments(input)).toMatchObject({scanned:0,recovered:0,results:[]});expect(await snapshot()).toEqual(after);expect(input).toEqual(held);expect(failures).toHaveLength(3);console.log(JSON.stringify({nativeRecoveryObservationFailures:failures}));
 }finally{await native.close();}
}
describe('native recovery observation and settlement custody',()=>{
 it('native PostgreSQL unknown executed recovery retains all usage holds through suppressed state and missing or interrupted observations before independent replay',async()=>exerciseNativeRecovery(true));
 it('native PostgreSQL pre-execution recovery settles once only with its original terminal observation after atomic rollback and independent replay',async()=>exerciseNativeRecovery(false));
});

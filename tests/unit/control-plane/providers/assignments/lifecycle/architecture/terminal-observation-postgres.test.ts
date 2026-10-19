import {describe,expect,it,vi} from 'vitest';
import {postgresGraph} from '../../../../capacity/execution/graph/architecture/living/living-postgres-fixture.ts';
import {copyNativeAssignmentCustody} from '../../architecture/native-assignment-custody.ts';
import {completionFixture,expiredCloseoutFixture,principal} from './terminal-report-fixture.ts';
import {terminalUsage} from '../../../../capacity/accounting/architecture/settlement-fixture.ts';
import {ControlPlaneStore} from '../../../../../../../src/api/persistence/store.ts';
import {proveNativeTerminalObservation} from '../../../../capacity/execution/admission/fixtures/native-terminal-observations.ts';
import {createCapacityControlPlane} from '../../../../../../../src/api/capacity/control-plane.ts';

describe('terminal observation through independent native PostgreSQL owners',()=>{
 it('independent native owners acknowledge expired measured closeout once without new settlement completion or graph history',async()=>{
  const native=await postgresGraph();try{
   const supplied=await expiredCloseoutFixture();const {attempt,input}=supplied;
   try{await copyNativeAssignmentCustody(native.left,supplied,['capacity_workday_runs','execution_nodes','capacity_reservations','capacity_provider_assignments','capacity_admission_counters','capacity_reservation_counter_claims','capacity_usage_actuals','capacity_ledger_entries','capacity_workday_events','capacity_audit_events']);}
   finally{await supplied.close();vi.useRealTimers();}
   const stores=[native.left,native.right].map(db=>new ControlPlaneStore({TREESEED_ENVIRONMENT:'test'},db));for(const store of stores)store.initializationPromise=Promise.resolve();
   const owners=stores.map(store=>createCapacityControlPlane(store));
   const before=await owners[0]!.getProviderAssignment('team',attempt.id), held=structuredClone(input);
   const financial=async()=>Promise.all(['capacity_reservations','capacity_usage_actuals','capacity_ledger_entries','capacity_admission_counters','capacity_reservation_counter_claims','execution_graph_revisions'].map(table=>native.left.pool.query(`SELECT * FROM ${table} ORDER BY 1`).then(result=>result.rows)));
   const original=await financial();
   const results=await Promise.all(owners.map(owner=>owner.failProviderAssignment(principal,attempt.id,input)));
   expect(results.every(result=>result?.assignment.status==='expired'&&result.assignment.leaseState==='released')).toBe(true);
   const actual=await owners[1]!.getProviderAssignment('team',attempt.id);
   expect(actual).toMatchObject({assignmentResult:null,assignmentAttempt:before!.assignmentAttempt,lifecycleCode:before!.lifecycleCode,
    failedAt:before!.failedAt,metadata:before!.metadata,stateVersion:before!.stateVersion+1,lifecycleOutput:{...input.output,completion:null,performance:{disposition:'failed'}}});
   expect(await financial()).toEqual(original);expect(input).toEqual(held);
   const events=await native.right.pool.query("SELECT * FROM capacity_workday_events WHERE assignment_id=$1 AND event_type='assignment.expired' ORDER BY id",[attempt.id]);
   expect(events.rows).toHaveLength(2);
   await expect(owners[1]!.failProviderAssignment(principal,attempt.id,{...input,output:{...input.output,sandboxId:'substituted'}})).rejects.toMatchObject({code:'provider_expired_closeout_conflict'});
   expect(await financial()).toEqual(original);expect(await owners[0]!.getProviderAssignment('team',attempt.id)).toEqual(actual);
  }finally{vi.useRealTimers();await native.close();}
 });
 it('native terminal observation rolls back suppressed state and event writes then serializes matching public reports without changing prior settlement',async()=>{
  const native=await postgresGraph();try{
   const supplied=await completionFixture();const attempt=supplied.attempt;
   try{await copyNativeAssignmentCustody(native.left,supplied,['capacity_workday_runs','execution_nodes','capacity_reservations','capacity_provider_assignments','capacity_admission_counters','capacity_reservation_counter_claims','capacity_usage_actuals','capacity_ledger_entries','capacity_workday_events']);}
   finally{await supplied.close();vi.useRealTimers();}
   const owners=[native.left,native.right].map(db=>new ControlPlaneStore({TREESEED_ENVIRONMENT:'test'},db));for(const owner of owners)owner.initializationPromise=Promise.resolve();
   await proveNativeTerminalObservation(native.left,native.right,owners[0]!,owners[1]!,attempt,{...terminalUsage,activeSeconds:1,elapsedSeconds:2,usageActual:{...terminalUsage.usageActual,nativeUsage:{activeSeconds:1,tokens:7}}});
  }finally{vi.useRealTimers();await native.close();}
 });
});

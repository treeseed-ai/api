import {describe,it,vi} from 'vitest';
import {postgresGraph} from '../../../../capacity/execution/graph/architecture/living/living-postgres-fixture.ts';
import {copyNativeAssignmentCustody} from '../../architecture/native-assignment-custody.ts';
import {completionFixture} from './terminal-report-fixture.ts';
import {terminalUsage} from '../../../../capacity/accounting/architecture/settlement-fixture.ts';
import {ControlPlaneStore} from '../../../../../../../src/api/persistence/store.ts';
import {proveNativeTerminalObservation} from '../../../../capacity/execution/admission/fixtures/native-terminal-observations.ts';

describe('terminal observation through independent native PostgreSQL owners',()=>{
 it('native terminal observation rolls back suppressed state and event writes then serializes matching public reports without changing prior settlement',async()=>{
  const native=await postgresGraph();try{
   const supplied=await completionFixture();const attempt=supplied.attempt;
   try{await copyNativeAssignmentCustody(native.left,supplied,['capacity_workday_runs','execution_nodes','capacity_reservations','capacity_provider_assignments','capacity_admission_counters','capacity_reservation_counter_claims','capacity_usage_actuals','capacity_ledger_entries']);}
   finally{await supplied.close();vi.useRealTimers();}
   const owners=[native.left,native.right].map(db=>new ControlPlaneStore({TREESEED_ENVIRONMENT:'test'},db));for(const owner of owners)owner.initializationPromise=Promise.resolve();
   await proveNativeTerminalObservation(native.left,native.right,owners[0]!,owners[1]!,attempt,{...terminalUsage,activeSeconds:1,elapsedSeconds:2,usageActual:{...terminalUsage.usageActual,nativeUsage:{activeSeconds:1,tokens:7}}});
  }finally{vi.useRealTimers();await native.close();}
 });
});

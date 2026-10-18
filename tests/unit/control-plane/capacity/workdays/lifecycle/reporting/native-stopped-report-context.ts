import {expect} from 'vitest';
import type pg from 'pg';
import {compileWorkday,DEFAULT_WORKDAY_POLICY} from '@treeseed/sdk/agent-capacity';
import type {CapacityGovernanceDatabase} from '../../../../../../../src/api/capacity/database.ts';
import {CapacityWorkdayRunRepository} from '../../../../../../../src/api/capacity/repositories/capacity/workdays/workday-run.ts';
import {CapacityWorkdayRunWriteRepository} from '../../../../../../../src/api/capacity/repositories/capacity/workdays/workday-run-write.ts';
import {workdayReportContext} from '../../../../../../../src/api/capacity/services/capacity/assignments/admission/workday-report-context.ts';
import {frozenAttempt} from '../../../accounting/architecture/settlement-fixture.ts';

/** Owning native repositories, independent connection and controlled stopped planning input; no model outcome is fabricated. */
export async function proveNativeStoppedReportContext(owner:CapacityGovernanceDatabase,observer:pg.Pool){
 const id='native-stopped-report-context',turn=id+':turn',at=new Date().toISOString();
 const reads=new CapacityWorkdayRunRepository(owner),writes=new CapacityWorkdayRunWriteRepository(owner),original=(await reads.get('team','sdk'))!;
 const plan={...compileWorkday({id,teamId:'team',policyId:'default',policyRevision:1,executionMode:'simulation',startsAt:at,agentIds:[],policy:DEFAULT_WORKDAY_POLICY}),state:'active' as const,activatedAt:at,
  planningRounds:[{round:1,state:'active' as const,assignmentIds:[turn],startedAt:at}]};
 const run={...original,id,status:'running' as const,startedAt:at,completedAt:null,createdAt:at,updatedAt:at,parameters:{...original.parameters,appliedPlan:plan},summary:{},error:{},reportRefs:{}};
 const reporter={...frozenAttempt,workdayId:id,effectiveProfile:{...frozenAttempt.effectiveProfile,activity:'reporting' as const},sourceRef:{store:'postgresql' as const,model:'workday',id,revision:1,digest:'sha256:'+'a'.repeat(64)}};
 const financial=async()=>Object.fromEntries(await Promise.all(['capacity_provider_assignments','capacity_reservations','capacity_usage_actuals','capacity_ledger_entries'].map(async table=>[table,(await observer.query('SELECT * FROM '+table+' ORDER BY id')).rows])));
 const held=await financial();
 try{
  await writes.create(run);
  const closingAt=new Date().toISOString(),closing={...run,updatedAt:closingAt,parameters:{...run.parameters,appliedPlan:{...plan,state:'closing' as const,closingAt}}};
  await writes.update(closing,'running');
  await expect(workdayReportContext(owner,reporter)).rejects.toMatchObject({code:'reporter_workday_authority_required'});
  await observer.query(`INSERT INTO execution_nodes (id,team_id,project_id,workday_id,kind,source_ref_json,rule_revision,node_revision,status,graph_revision_created,graph_revision_updated,created_at,updated_at)
   VALUES ($1,'team','project',$2,'estimating','{}',1,1,'cancelled',1,1,$3,$3)`,[turn,id,closingAt]);
  const completedAt=new Date().toISOString(),complete={...closing,updatedAt:completedAt,parameters:{...closing.parameters,appliedPlan:{...closing.parameters.appliedPlan,planningRounds:[{...plan.planningRounds[0]!,state:'complete' as const,completedAt}]}}};
  await writes.update(complete,'running');
  const events=(await observer.query('SELECT * FROM capacity_workday_events WHERE run_id=$1 ORDER BY event_index',[id])).rows;expect(events).toHaveLength(2);
  const [context]=await workdayReportContext(owner,reporter);expect(context!.value).toMatchObject({closingEvent:{id:events[0]!.id,context:{plan:closing.parameters.appliedPlan}}});
  expect(await workdayReportContext(owner,reporter)).toEqual([context]);expect(await financial()).toEqual(held);
  for(const failure of ['missing','altered','unfinished-node']){
   const latest=events[1]!;
   if(failure==='unfinished-node')await observer.query("UPDATE execution_nodes SET status='running' WHERE id=$1",[turn]);
   else await observer.query('UPDATE capacity_workday_events SET event_type=$1,context_json=$2 WHERE id=$3',[failure==='missing'?'controlled-excluded':latest.event_type,failure==='altered'?'{}':latest.context_json,latest.id]);
   try{await expect(workdayReportContext(owner,reporter)).rejects.toMatchObject({code:'reporter_workday_authority_required'});expect(await financial()).toEqual(held);}
   finally{await observer.query("UPDATE execution_nodes SET status='cancelled' WHERE id=$1",[turn]);await observer.query('UPDATE capacity_workday_events SET event_type=$1,context_json=$2 WHERE id=$3',[latest.event_type,latest.context_json,latest.id]);}
  }
  expect((await observer.query('SELECT * FROM capacity_workday_events WHERE run_id=$1 ORDER BY event_index',[id])).rows).toEqual(events);
 }finally{
  await observer.query('DELETE FROM capacity_workday_events WHERE run_id=$1',[id]);await observer.query('DELETE FROM execution_nodes WHERE id=$1',[turn]);await observer.query('DELETE FROM capacity_workday_runs WHERE id=$1',[id]);
 }
 expect(await financial()).toEqual(held);
}

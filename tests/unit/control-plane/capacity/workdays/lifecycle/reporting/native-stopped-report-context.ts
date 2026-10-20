import {expect} from 'vitest';
import {compileWorkday,DEFAULT_WORKDAY_POLICY,validateAgentDefinitionModel} from '@treeseed/sdk/agent-capacity';
import {projectActiveWorkdays} from '../../../../../../../src/api/capacity/policy/execution/workday-execution-projector.ts';
import {workdayParticipants} from '../../../../../../../src/api/capacity/policy/execution/workday-participants.ts';
import {advanceLivingWorkday} from '../../../../../../../src/api/capacity/services/capacity/workdays/lifecycle/living-workday-lifecycle.ts';
import {createCapacityControlPlane} from '../../../../../../../src/api/capacity/control-plane.ts';
import type {CapacityGovernanceDatabase} from '../../../../../../../src/api/capacity/database.ts';
import {CapacityWorkdayRunRepository} from '../../../../../../../src/api/capacity/repositories/capacity/workdays/workday-run.ts';
import {CapacityWorkdayRunWriteRepository} from '../../../../../../../src/api/capacity/repositories/capacity/workdays/workday-run-write.ts';
import {workdayReportContext} from '../../../../../../../src/api/capacity/services/capacity/assignments/admission/workday-report-context.ts';
import {frozenAttempt} from '../../../accounting/architecture/settlement-fixture.ts';

/** Owning native repositories, independent connection and controlled stopped planning input; no model outcome is fabricated. */
export async function proveNativeStoppedReportContext(owner:CapacityGovernanceDatabase,observer:{query(sql:string,params?:unknown[]):Promise<{rows:Record<string,unknown>[]}>},originalId='sdk'){
 const id='native-stopped-report-context',at=new Date().toISOString(),proposalId='controlled-original-proposal';
 const checked=validateAgentDefinitionModel({schemaVersion:'treeseed.agent/v1',id:'native/configured-estimator',name:'Configured estimator',agentClass:'configured-owner',purpose:'Estimate exact governed work.',responsibilities:['Return truthful estimates.'],capabilities:['reasoning'],context:{include:['assignment-subject']},activityProfiles:{estimating:{handler:'estimate',permissions:{content:{read:['proposal'],write:['proposal']},tools:[]},prompt:{system:'Estimate only the exact governed work item.'}}}});
 if(!checked.ok||!checked.data)throw new Error('Exact controlled profile required: '+JSON.stringify(checked.diagnostics));expect(checked.ok).toBe(true);
 const snapshot={project:{agents:[{definition:checked.data,activities:['estimating']}]}};
 const draft={id:proposalId,executionPlan:{workItems:[{id:'controlled-work',agentClass:'configured-owner',review:'none',acceptanceCriteria:['Preserve exact source.']}]}};
 const participants=workdayParticipants({agentProfilesByProjectId:snapshot,proposalsByProjectId:{project:[draft]}});expect(participants).toHaveLength(1);
 const turn=`planning:${id}:1:${participants[0]!.id}`;
 const reference={store:'treedx',model:'proposal',id:proposalId,revision:6,digest:'sha256:'+'a'.repeat(64),repository:'controlled-native-library',commit:'b'.repeat(40),path:'proposals/controlled-work.mdx'};
 const estimated={...draft,executionPlan:{workItems:[{...draft.executionPlan.workItems[0]!,estimate:{expectedSeconds:10,maximumSeconds:20,rationale:'Controlled original source input; no model result claimed.'}}]}};
 const reads=new CapacityWorkdayRunRepository(owner),writes=new CapacityWorkdayRunWriteRepository(owner),original=(await reads.get('team',originalId))!;
 const plan={...compileWorkday({id,teamId:'team',policyId:'default',policyRevision:1,executionMode:'simulation',startsAt:at,agentIds:[],policy:DEFAULT_WORKDAY_POLICY}),state:'active' as const,activatedAt:at,
  planningRounds:[{round:1,state:'active' as const,assignmentIds:[turn],startedAt:at}]};
 const run={...original,id,status:'running' as const,startedAt:at,completedAt:null,createdAt:at,updatedAt:at,parameters:{...original.parameters,durationSeconds:plan.policySnapshot.durationSeconds,deadlineAt:plan.endsAt,appliedPlan:plan,scheduledProjectIds:['project'],agentProfilesByProjectId:snapshot,planningSourceByProposalId:{[proposalId]:reference}},summary:{},error:{},reportRefs:{}};
 const reporter={...frozenAttempt,workdayId:id,effectiveProfile:{...frozenAttempt.effectiveProfile,activity:'reporting' as const},sourceRef:{store:'postgresql' as const,model:'workday',id,revision:1,digest:'sha256:'+'a'.repeat(64)}};
 const financial=async()=>Object.fromEntries(await Promise.all(['capacity_provider_assignments','capacity_reservations','capacity_usage_actuals','capacity_ledger_entries'].map(async table=>[table,(await observer.query('SELECT * FROM '+table+' ORDER BY id')).rows])));
 const held=await financial();
 try{
  await writes.create(run);
  const closingAt=new Date().toISOString(),closing={...run,updatedAt:closingAt,parameters:{...run.parameters,appliedPlan:{...plan,state:'closing' as const,closingAt}}};
  await writes.update(closing,'running');
  await expect(workdayReportContext(owner,reporter)).rejects.toMatchObject({code:'reporter_workday_authority_required'});
  const projectionInput={teamId:'team',revision:1,profiles:{},sources:[{id,teamId:'team',parameters:closing.parameters,proposalsByProjectId:{project:[estimated]}}]};
  const projected=projectActiveWorkdays(projectionInput);expect(projected.nodes).toHaveLength(1);const cancelled=projected.nodes[0]!;
  expect(cancelled).toMatchObject({id:turn,kind:'estimating',status:'cancelled',sourceRef:reference});expect(projectActiveWorkdays(projectionInput)).toEqual(projected);
  // Controlled source/profile and native node input, not a fabricated attempt.
  // Actual owning projection, lifecycle persistence and Reporter guard execute.
  await observer.query(`INSERT INTO execution_nodes (id,team_id,project_id,workday_id,kind,source_ref_json,authority_refs_json,rule_revision,node_revision,agent_class,status,graph_revision_created,graph_revision_updated,created_at,updated_at)
   VALUES ($1,'team','project',$2,$4,$5,$6,1,1,$7,$8,1,1,$3,$3)`,[turn,id,closingAt,cancelled.kind,JSON.stringify(cancelled.sourceRef),JSON.stringify(cancelled.authorityRefs),cancelled.agentClass,cancelled.status]);
  const completedAt=new Date().toISOString(),capacity=createCapacityControlPlane(owner),advanced=await advanceLivingWorkday(capacity,closing,completedAt);
  expect(advanced.plan.planningRounds).toEqual([{...plan.planningRounds[0]!,state:'complete',completedAt}]);expect(advanced.plan.state).toBe('closing');expect(advanced.plan.endsAt).toBe(plan.endsAt);expect(advanced.plan).not.toHaveProperty('endedAt');
  const complete=(await reads.get('team',id))!;expect(complete.parameters.appliedPlan).toEqual(advanced.plan);expect(await advanceLivingWorkday(capacity,complete,completedAt)).toMatchObject({changed:false});
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

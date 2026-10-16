import {livingAllocationInputs} from '../../../../../../../src/api/capacity/services/capacity/assignments/admission/living-allocation-inputs.ts';
import {provider,executionCapability} from '../../fixtures/assignment-attempt-fixtures.ts';
import {expect,it} from 'vitest';
import {compileWorkday,DEFAULT_WORKDAY_POLICY,executionNodeSchema} from '@treeseed/sdk/agent-capacity';
import {postgresGraph} from '../../graph/architecture/living/living-postgres-fixture.ts';
import {runtimeWorkdayPhase} from '../../../../../../../src/api/capacity/services/build/ready-execution-node.ts';
import {advanceLivingWorkday} from '../../../../../../../src/api/capacity/services/capacity/workdays/lifecycle/living-workday-lifecycle.ts';
import {compileCapacityWorkdayRunRecord} from '../../../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-run-service.ts';
import {ControlPlaneStore} from '../../../../../../../src/api/persistence/store.ts';

it('native PostgreSQL preserves the initial planning floor derives acting from only current ready work and resumes ordinary planning without extending authority',async()=>{
 const f=await postgresGraph();
 try{
  const startsAt='2026-10-03T12:00:00.000Z',floor='2026-10-03T12:20:00.000Z',after='2026-10-03T12:20:01.000Z';
  const plan={...compileWorkday({id:'native-fluid-workday',teamId:'team',policyId:'default',policyRevision:1,executionMode:'simulation',startsAt,agentIds:['project/configured:planning'],policy:{...DEFAULT_WORKDAY_POLICY,durationSeconds:3600,planningPercent:100/3,maximumConcurrency:5,communicationConcurrency:5}}),state:'active' as const,activatedAt:startsAt};
  const run=compileCapacityWorkdayRunRecord('team',{id:plan.id,status:'running',executionMode:'simulation',startedAt:startsAt,parameters:{appliedPlan:plan,scheduledProjectIds:['project']}},{now:startsAt});
  const stores=[new ControlPlaneStore({},f.left),new ControlPlaneStore({},f.right)];for(const store of stores)store.initializationPromise=Promise.resolve();
  for(const project of ['project','foreign-project'])await f.left.pool.query('INSERT INTO projects (id,team_id,slug,name,metadata_json,created_at,updated_at) VALUES ($1,$2,$1,$1,$3,$4,$4)',[project,'team','{}',startsAt]);
  for(const id of [run.id,'other-workday'])await f.left.pool.query('INSERT INTO capacity_workday_runs (id,team_id,execution_kind,execution_mode,status,parameters_json,started_at,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$7)',[id,'team','workday','simulation','running',JSON.stringify(id===run.id?run.parameters:{...run.parameters,appliedPlan:{...plan,id,planningRounds:[]}}),startsAt]);
  const node=async(id:string,kind:'planning'|'acting'|'reviewing',status:string,projectId='project',workdayId=run.id)=>{
   const value=executionNodeSchema.parse({schemaVersion:'treeseed.execution-node/v1',id,teamId:'team',projectId,workdayId,kind,pairRole:kind==='acting'?'actor':kind==='reviewing'?'reviewer':null,sourceRef:{store:'postgresql',model:'workday',id:workdayId},authorityRefs:[],ruleRevision:1,nodeRevision:1,agentClass:'configured-arbitrary',status,estimate:{expectedSeconds:1,maximumSeconds:2},requiredCapabilities:[executionCapability],requestedPermissions:{content:{read:[],write:[]},tools:[]},workspace:'read-only',maximumReviewCycles:2,graphRevisionCreated:1,graphRevisionUpdated:1});
   await f.left.pool.query('INSERT INTO execution_nodes (id,team_id,project_id,workday_id,kind,pair_role,source_ref_json,authority_refs_json,rule_revision,node_revision,agent_class,status,estimate_json,required_capabilities_json,requested_permissions_json,workspace,maximum_review_cycles,graph_revision_created,graph_revision_updated,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$20)',[value.id,value.teamId,value.projectId,value.workdayId,value.kind,value.pairRole,JSON.stringify(value.sourceRef),JSON.stringify(value.authorityRefs),1,1,value.agentClass,value.status,JSON.stringify(value.estimate),JSON.stringify(value.requiredCapabilities),JSON.stringify(value.requestedPermissions),'read-only',2,1,1,startsAt]);
   return value;
  };
  for(const id of plan.planningRounds.flatMap(round=>round.assignmentIds))await node(id,'planning','ready');
  await node('current-actor','acting','ready');await node('foreign-project-actor','acting','ready','foreign-project');await node('foreign-workday-actor','acting','ready','project','other-workday');
  const phase=(index:number,now:string,value=run)=>runtimeWorkdayPhase(stores[index]!,value,now);
  const allocation=async(index:number,now:string,activity:string)=>{
   const observation={day:now.slice(0,10),observedAt:now,healthy:true,activeSeconds:0,reservedSeconds:0};
   const providers:Parameters<typeof livingAllocationInputs>[1]['providers']=[{...structuredClone(provider),maxConcurrentRunners:5,accountingObservation:{modelUsage:observation,capabilityUsage:{[executionCapability]:observation}}}];
   const input={run,runs:[run],providers,capacityProviderId:'provider',capabilityId:executionCapability,agentClass:'configured-arbitrary',activity,now},heldInput=structuredClone(input);
   const result=(await livingAllocationInputs(stores[index]!,input))[provider.id]!;expect(input).toEqual(heldInput);expect(result.measurements).toEqual([]);expect(result.constraints).toEqual([{id:'workday-phase-share',remainingSeconds:result.opportunity.availableSeconds}]);return result.opportunity;
  };

  const before=await f.snapshot(),held=structuredClone({plan,run});
  expect(await Promise.all([phase(0,'2026-10-03T12:19:59.999Z'),phase(1,'2026-10-03T12:19:59.999Z')])).toEqual(['planning','planning']);
  expect(await Promise.all([phase(0,floor),phase(1,floor)])).toEqual(['acting','acting']);expect(await f.snapshot()).toEqual(before);
  const initialPool=await allocation(0,'2026-10-03T12:19:59.999Z','planning'),handedOff=await allocation(1,floor,'acting');
  expect(initialPool).toMatchObject({phase:'planning',availableSeconds:12000,shareSeconds:12000,committedSeconds:0,planningCommittedSeconds:0,remainingSupplySeconds:28800,weight:plan.policySnapshot.allocationWeight,totalEligibleWeight:plan.policySnapshot.allocationWeight});
  expect(handedOff).toEqual({...initialPool,phase:'acting'});expect(await f.snapshot()).toEqual(before);

  for(const status of ['assigned','running']){await f.left.pool.query("UPDATE execution_nodes SET status=$1 WHERE id='current-actor'",[status]);const heldRows=await f.snapshot();expect(await Promise.all([phase(0,after),phase(1,after)])).toEqual(['acting','acting']);expect(await f.snapshot()).toEqual(heldRows);}
  for(const status of ['blocked','completed','failed','cancelled','exhausted']){await f.left.pool.query("UPDATE execution_nodes SET status=$1 WHERE id='current-actor'",[status]);const heldRows=await f.snapshot();expect(await Promise.all([phase(0,after),phase(1,after)])).toEqual(['planning','planning']);expect(await f.snapshot()).toEqual(heldRows);}
  await f.left.pool.query("UPDATE execution_nodes SET status='completed' WHERE id='current-actor'");await node('current-review','reviewing','ready');expect(await Promise.all([phase(0,after),phase(1,after)])).toEqual(['acting','acting']);
  await f.left.pool.query("UPDATE execution_nodes SET status='completed' WHERE id='current-review'");
  const terminal=await f.snapshot();expect(await phase(0,plan.endsAt)).toBe('ended');expect(await phase(1,plan.endsAt)).toBe('ended');expect(await f.snapshot()).toEqual(terminal);

  expect(await allocation(1,after,'planning')).toMatchObject({phase:'planning',availableSeconds:11995,committedSeconds:0,planningCommittedSeconds:0});
  await f.left.pool.query("UPDATE execution_nodes SET status='completed' WHERE workday_id=$1 AND kind='planning'",[run.id]);
  const resumed=await advanceLivingWorkday(stores[0]!,run,after);expect(resumed.changed).toBe(true);expect(resumed.plan.planningRounds).toHaveLength(2);expect(resumed.plan.planningRounds[0]!.state).toBe('complete');expect(resumed.plan.planningRounds[1]).toMatchObject({round:2,state:'active',startedAt:after});
  expect(resumed.plan).toMatchObject({startsAt:plan.startsAt,endsAt:plan.endsAt,policySnapshot:plan.policySnapshot});
  const persisted=(await f.right.pool.query('SELECT * FROM capacity_workday_runs WHERE id=$1',[run.id])).rows[0]!;expect(JSON.parse(String(persisted.parameters_json)).appliedPlan).toEqual(resumed.plan);
  const next={...run,parameters:{...run.parameters,appliedPlan:resumed.plan}},snapshot=await f.snapshot();expect(await advanceLivingWorkday(stores[1]!,next,after)).toMatchObject({changed:false,plan:resumed.plan});expect(await f.snapshot()).toEqual(snapshot);
  for(const value of [snapshot.assignments,snapshot.reservations])expect(value).toEqual([]);expect({plan,run}).toEqual(held);
  // Original controlled canonical graph/run rows; actual independent PostgreSQL
  // phase queries and owning lifecycle persistence, not accepted governance,
  // model planning, admitted assignments, measured usage or managed outcomes.
 }finally{await f.close();}
},30_000);

import {expect,it} from 'vitest';
import {normalizeWorkdayAgentSelection} from '@treeseed/sdk/operator-contracts';
import type {AgentDefinition} from '@treeseed/sdk/agent-capacity';
import {workdayStartDatabase} from '../workday-start-fixture.ts';
function configuredCloseout(definition:AgentDefinition):AgentDefinition{return {...definition,activityProfiles:{...definition.activityProfiles,reporting:{handler:'reporter',prompt:{system:'Commit the deterministic closeout.'},permissions:definition.activityProfiles.planning!.permissions,dependsOn:{events:['workday-closing']}}}};}

it('native public preflight and start retain one configured joint Reporter before activation and preserve exact selection through denial and replay',async()=>{
 const f=await workdayStartDatabase();try{
  const selected=configuredCloseout(f.definition),other={...selected,id:'other/renamed-planner'};
  const selectedBytes=JSON.stringify({agents:[selected]}),now=f.intent.startsAt;
  await f.query('UPDATE project_agent_classes SET handler_refs_json=? WHERE id=?',[selectedBytes,'class']);
  await f.query('INSERT INTO projects (id,team_id,slug,name,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',['other','team','other','Other',JSON.stringify({library:{role:'library'}}),now,now]);
  await f.query('INSERT INTO project_agent_classes (id,team_id,project_id,slug,name,handler_refs_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',['other-class','team','other','boundary-planner','Other configured planner',JSON.stringify({agents:[other]}),now,now]);
  await f.query('INSERT INTO treedx_project_libraries (id,team_id,project_id,instance_id,library_id,repository_id,content_path,content_repository_default_branch,content_repository_ref,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',['other-binding','team','other','instance','other-library','planning-library','.','staging','a'.repeat(40),JSON.stringify({resolvedRef:'a'.repeat(40)}),now,now]);
  const input={...f.intent,projects:['project','other'],reportingAgentId:selected.id},held=structuredClone(input);
  const planned=await f.publicService.preflight(f.principal,'team',input);
  const receiptBefore=await f.snapshot();
  expect(receiptBefore.workdays).toEqual([]);
  const retained=JSON.parse(String(receiptBefore.receipts.find(row=>row.operation==='workday.preflight')!.response_json));
  expect(retained).toMatchObject({intent:{reportingAgentId:selected.id},runInput:{parameters:{reportingAgentId:selected.id}}});
  await f.query('UPDATE project_agent_classes SET handler_refs_json=? WHERE id=?',[JSON.stringify({agents:[{...selected,purpose:'Changed after original preflight.'}]}),'class']);
  await expect(f.start(planned)).rejects.toThrow();expect(await f.snapshot()).toEqual(receiptBefore);
  await f.query('UPDATE project_agent_classes SET handler_refs_json=? WHERE id=?',[selectedBytes,'class']);
  const started=await f.start(planned),after=await f.snapshot();
  expect(after.workdays).toHaveLength(1);
  const parameters=JSON.parse(String(after.workdays[0]!.parameters_json));
  expect.soft(parameters.appliedPlan).toMatchObject({state:'active',reportingAgentId:selected.id});
  expect.soft(after.nodes.filter(row=>row.kind==='reporting').map(row=>row.project_id)).toEqual(['project']);
  expect(after.nodes.filter(row=>row.kind==='planning').map(row=>row.project_id).sort()).toEqual(['other','project']);
  expect(await f.start(planned)).toEqual(started);expect(await f.snapshot()).toEqual(after);
  expect(after.assignments).toEqual([]);expect(after.reservations).toEqual([]);expect(after.usage).toEqual([]);expect(after.ledger).toEqual([]);expect(input).toEqual(held);
  for(const reportingAgentId of [undefined,'foreign/renamed-planner','missing',null,'',' ',false,1,[],{},'é','id?','x'.repeat(201)]){
   const supplied:Record<string,unknown>={...input};delete supplied.reportingAgentId;Object.assign(supplied,reportingAgentId===undefined?{}:{reportingAgentId});
   const before=await f.snapshot();await expect(f.publicService.preflight(f.principal,'team',supplied)).rejects.toThrow();expect(await f.snapshot()).toEqual(before);
  }
  const beforeSchedule=await f.snapshot(),scheduledInput={id:'joint-closeout-selection',intent:input,cadenceSeconds:60,nextRunAt:input.startsAt},scheduledHeld=structuredClone(scheduledInput);
  const scheduled=await f.publicService.createSchedule(f.principal,'team',scheduledInput);
  expect(scheduled.intent.reportingAgentId).toBe(selected.id);expect(scheduled.intent.projects).toEqual(input.projects);expect(scheduledInput).toEqual(scheduledHeld);
  const afterSchedule=await f.snapshot();expect(afterSchedule.schedules).toHaveLength(1);expect(JSON.parse(String(afterSchedule.schedules[0]!.intent_json)).reportingAgentId).toBe(selected.id);
  for(const table of ['workdays','nodes','edges','revisions','events','assignments','reservations','usage','ledger'] as const)expect(afterSchedule[table]).toEqual(beforeSchedule[table]);
 }finally{await f.close();}
},30_000);

it('native public start refuses a different automatic Reporter introduced after fresh preflight instead of silently changing the retained closeout identity',async()=>{
 const f=await workdayStartDatabase();try{
  const selected=configuredCloseout(f.definition),replacement={...selected,id:'configured/replacement-closeout'};
  await f.query('UPDATE project_agent_classes SET handler_refs_json=? WHERE id=?',[JSON.stringify({agents:[selected]}),'class']);
  const planned=await f.preflight(),original=f.store.createCapacityWorkdayRun.bind(f.store);let calls=0;
  const before=await f.snapshot(),retained=JSON.parse(String(before.receipts.find(row=>row.operation==='workday.preflight')!.response_json));
  expect(before.workdays).toEqual([]);expect(retained.runInput.parameters.reportingAgentId).toBe(selected.id);expect(Object.hasOwn(retained.intent,'reportingAgentId')).toBe(false);
  f.store.createCapacityWorkdayRun=async(teamId,input)=>{
   calls++;await f.query('UPDATE project_agent_classes SET handler_refs_json=? WHERE id=?',[JSON.stringify({agents:[replacement]}),'class']);
   return original(teamId,input);
  };
  await expect(f.start(planned)).rejects.toThrow();expect(calls).toBe(1);
  const after=await f.snapshot();expect(after.workdays.filter(row=>row.status==='running')).toEqual([]);
  expect(after.receipts.filter(row=>row.operation==='workday.preflight')).toEqual(before.receipts);expect(after.receipts.filter(row=>row.operation==='workday.start')).toEqual([]);
  expect(after.nodes.filter(row=>row.kind==='reporting')).toEqual([]);expect(after.assignments).toEqual([]);expect(after.reservations).toEqual([]);expect(after.usage).toEqual([]);expect(after.ledger).toEqual([]);
 }finally{await f.close();}
},30_000);

it('native public preflight denies a Workday with no configured closeout Reporter before any admission or receipt mutation',async()=>{
 const f=await workdayStartDatabase();try{
  const onlyPlanning=structuredClone(f.definition);Reflect.deleteProperty(onlyPlanning.activityProfiles,'reporting');
  await f.query('UPDATE project_agent_classes SET handler_refs_json=? WHERE id=?',[JSON.stringify({agents:[onlyPlanning]}),'class']);
  const before=await f.snapshot();await expect(f.preflight()).rejects.toThrow();expect(await f.snapshot()).toEqual(before);
 }finally{await f.close();}
},30_000);

it('native public admission selects the configured closeout Reporter independently of cooperative planning filters without creating extra planning work',async()=>{
 const f=await workdayStartDatabase();try{
  const planner=structuredClone(f.definition);Reflect.deleteProperty(planner.activityProfiles,'reporting');
  const selected={...configuredCloseout(planner),id:'configured/standing-closeout',agentClass:'digest-writer',groupIds:['closeout-occupation'],activityProfiles:{reporting:configuredCloseout(planner).activityProfiles.reporting}};
  await f.query('UPDATE project_agent_classes SET handler_refs_json=? WHERE id=?',[JSON.stringify({agents:[planner]}),'class']);
  await f.query('INSERT INTO project_agent_classes (id,team_id,project_id,slug,name,handler_refs_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',['closeout-class','team','project','digest-writer','Configured closeout',JSON.stringify({agents:[selected]}),f.intent.startsAt,f.intent.startsAt]);
  const input={...f.intent,groupIds:['portfolio-atlas'],agentSelection:{activityTypes:['planning']}},held=structuredClone(input);
  const denied=await f.snapshot();await expect(f.publicService.preflight(f.principal,'team',input)).rejects.toMatchObject({code:'capacity_workday_reporting_selection_invalid'});expect(await f.snapshot()).toEqual(denied);
  const subscribed={...selected,groupIds:['portfolio-atlas']};
  await f.query('UPDATE project_agent_classes SET handler_refs_json=? WHERE id=?',[JSON.stringify({agents:[subscribed]}),'closeout-class']);
  const planned=await f.publicService.preflight(f.principal,'team',input);await f.start(planned);
  const after=await f.snapshot(),parameters=JSON.parse(String(after.workdays[0]!.parameters_json));
  expect(parameters.appliedPlan.reportingAgentId).toBe(selected.id);expect(parameters.agentSelection).toEqual(normalizeWorkdayAgentSelection(input.agentSelection));expect(parameters.agentSelection).not.toHaveProperty('agentSlugs');expect(parameters.groupIds).toEqual(['portfolio-atlas']);expect(parameters.agentSelection.activityTypes).toEqual(input.agentSelection.activityTypes);
  expect(parameters.agentProfilesByProjectId.project.agents.map((entry:{definition:{id:string};activities:string[]})=>({id:entry.definition.id,activities:entry.activities}))).toEqual([{id:planner.id,activities:['planning']},{id:selected.id,activities:['reporting']}]);
  expect(after.nodes.filter(row=>row.kind==='planning').map(row=>row.agent_class)).toEqual([planner.agentClass]);expect(after.nodes.filter(row=>row.kind==='reporting').map(row=>row.agent_class)).toEqual([selected.agentClass]);expect(after.nodes.filter(row=>row.kind==='condition')).toHaveLength(1);
  expect(after.assignments).toEqual([]);expect(after.reservations).toEqual([]);expect(after.usage).toEqual([]);expect(after.ledger).toEqual([]);expect(input).toEqual(held);
 }finally{await f.close();}
},30_000);

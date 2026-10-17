import {expect,it} from 'vitest';
import {workdayStartDatabase} from './workday-start-fixture.ts';

it('native public preflight and start retain one configured joint Reporter before activation and preserve exact selection through denial and replay',async()=>{
 const f=await workdayStartDatabase();try{
  const selected={...f.definition,activityProfiles:{...f.definition.activityProfiles,reporting:{handler:'reporter',prompt:{system:'Commit the deterministic closeout.'},permissions:f.definition.activityProfiles.planning!.permissions,dependsOn:{events:['workday-closing']}}}},other={...selected,id:'other/renamed-planner'};
  const selectedBytes=JSON.stringify({agents:[selected]}),now=f.intent.startsAt;
  await f.query('UPDATE project_agent_classes SET handler_refs_json=? WHERE id=?',[selectedBytes,'class']);
  await f.query('INSERT INTO projects (id,team_id,slug,name,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',['other','team','other','Other',JSON.stringify({library:{role:'library'}}),now,now]);
  await f.query('INSERT INTO project_agent_classes (id,team_id,project_id,slug,name,handler_refs_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',['other-class','team','other','boundary-planner','Other configured planner',JSON.stringify({agents:[other]}),now,now]);
  await f.query('INSERT INTO treedx_project_libraries (id,team_id,project_id,instance_id,library_id,repository_id,content_path,content_repository_default_branch,content_repository_ref,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',['other-binding','team','other','instance','other-library','planning-library','.','staging','a'.repeat(40),JSON.stringify({resolvedRef:'a'.repeat(40)}),now,now]);
  const input={...f.intent,projects:['project','other'],reportingAgentId:selected.id},held=structuredClone(input);
  const planned=await f.publicService.preflight(f.principal,'team',input);
  const receiptBefore=await f.snapshot();
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
  for(const reportingAgentId of [undefined,'foreign/renamed-planner','missing']){
   const supplied={...input};delete supplied.reportingAgentId;Object.assign(supplied,reportingAgentId===undefined?{}:{reportingAgentId});
   const before=await f.snapshot();await expect(f.publicService.preflight(f.principal,'team',supplied)).rejects.toThrow();expect(await f.snapshot()).toEqual(before);
  }
 }finally{await f.close();}
},30_000);

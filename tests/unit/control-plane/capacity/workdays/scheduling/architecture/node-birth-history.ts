import{createHash}from'node:crypto';
import{canonicalStandardsJson}from'@treeseed/sdk/standards';
import{appliedWorkdaySchema,compileWorkday}from'@treeseed/sdk/agent-capacity';
import{expect}from'vitest';

/** Birth is immutable revision one with ready planning or blocked closeout state. Later revisions/statuses are independently asserted by the owning transition cases; direct SQL inputs never rewrite original birth evidence. */
export function expectNodeBirthHistory(snapshot:{nodes:Record<string,unknown>[];events:Record<string,unknown>[]}){
 const births=snapshot.events.filter(event=>event.event_type==='execution.node.state'&&JSON.parse(String(event.context_json)).previousStatus===null);
 expect(births).toHaveLength(snapshot.nodes.length);expect(new Set(births.map(event=>JSON.parse(String(event.context_json)).nodeId)).size).toBe(snapshot.nodes.length);
 for(const node of snapshot.nodes){const expectedStatus=node.kind==='condition'||node.kind==='reporting'?'blocked':'ready';expect(['planning','condition','reporting']).toContain(node.kind);expect(Number.isSafeInteger(node.node_revision)&&Number(node.node_revision)>=1).toBe(true);const events=births.filter(event=>JSON.parse(String(event.context_json)).nodeId===node.id);expect(events).toHaveLength(1);const event=events[0]!;expect(event).toMatchObject({team_id:node.team_id,project_id:node.project_id,run_id:node.workday_id,workday_id:node.workday_id,assignment_id:null,status:'recorded'});expect(JSON.parse(String(event.context_json))).toEqual({nodeId:node.id,nodeRevision:1,graphRevision:node.graph_revision_created,status:expectedStatus,previousStatus:null});}
}
/** Independent native rows must retain the exact old/new canonical plan; no status or exit code substitutes for an observation. */
export function expectWorkdayLifecycleHistory(snapshot:{workdays:Record<string,unknown>[];events:Record<string,unknown>[]}){
 const found:Record<string,unknown>[]=[];
 for(const run of snapshot.workdays){const events=snapshot.events.filter(event=>event.run_id===run.id&&event.event_type==='workday.lifecycle.changed').sort((a,b)=>Number(a.event_index)-Number(b.event_index));if(!events.length)continue;
  let prior:unknown,priorStatus:unknown;
  for(const event of events){const context=JSON.parse(String(event.context_json)),before=context.previousPlan===null?null:appliedWorkdaySchema.parse(context.previousPlan),after=appliedWorkdaySchema.parse(context.plan);expect(context).toEqual({previousStatus:context.previousStatus,status:context.status,previousPlan:before,plan:after});
   expect(event).toMatchObject({id:'workday-lifecycle:'+run.id+':'+createHash('sha256').update(canonicalStandardsJson(context)).digest('hex'),team_id:run.team_id,workday_id:run.id,assignment_id:null,project_id:null,status:'recorded',parameters_json:'{}',metadata_json:'{}',refs_json:'{}'});
   for(const plan of[before,after].filter(value=>value!==null))expect(plan).toMatchObject({id:run.id,teamId:run.team_id,executionMode:run.execution_mode});
   if(before){for(const field of['id','teamId','executionMode','startsAt','endsAt','policyId','policyRevision','policySnapshot','reportingAgentId'])expect(Reflect.get(after,field)).toEqual(Reflect.get(before,field));}else{expect(prior).toBeUndefined();expect(after.state).toBe('active');expect(Date.parse(String(after.activatedAt))).toBe(Date.parse(after.startsAt));const prefix='planning:'+after.id+':1:',agentIds=after.planningRounds.flatMap(round=>round.assignmentIds.map(id=>{expect(id.startsWith(prefix)&&id.length>prefix.length).toBe(true);return id.slice(prefix.length);}));const compiled=compileWorkday({id:after.id,teamId:after.teamId,executionMode:after.executionMode,policyId:after.policyId,policyRevision:after.policyRevision,policy:after.policySnapshot,startsAt:after.startsAt,agentIds,reportingAgentId:after.reportingAgentId});expect({...after,admittedSecondsByProject:{},admittedSecondsByAgentClass:{}}).toEqual({...compiled,state:'active',activatedAt:after.activatedAt});for(const field of ['closingAt','endedAt','reportRef'])expect(Reflect.get(after,field)).toBeUndefined();}
   if(prior!==undefined){expect(before).toEqual(prior);expect(context.previousStatus).toBe(priorStatus);}expect(Number.isFinite(Date.parse(String(event.created_at)))).toBe(true);prior=after;priorStatus=context.status;found.push(event);
  }
  expect(prior).toEqual(appliedWorkdaySchema.parse(JSON.parse(String(run.parameters_json)).appliedPlan));expect(priorStatus).toBe(run.status);
 }
 return found;
}

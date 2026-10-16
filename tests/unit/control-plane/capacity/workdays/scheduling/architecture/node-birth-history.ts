import{createHash}from'node:crypto';
import{canonicalStandardsJson}from'@treeseed/sdk/standards';
import{appliedWorkdaySchema}from'@treeseed/sdk/agent-capacity';
import{expect}from'vitest';

/** These controlled native fixtures create ready planning nodes; direct SQL completion inputs do not manufacture history. */
export function expectNodeBirthHistory(snapshot:{nodes:Record<string,unknown>[];events:Record<string,unknown>[]}){
 const births=snapshot.events.filter(event=>event.event_type==='execution.node.state'&&JSON.parse(String(event.context_json)).previousStatus===null);
 expect(births).toHaveLength(snapshot.nodes.length);expect(new Set(births.map(event=>JSON.parse(String(event.context_json)).nodeId)).size).toBe(snapshot.nodes.length);
 for(const node of snapshot.nodes){const events=births.filter(event=>JSON.parse(String(event.context_json)).nodeId===node.id);expect(events).toHaveLength(1);const event=events[0]!;expect(event).toMatchObject({team_id:node.team_id,project_id:node.project_id,run_id:node.workday_id,workday_id:node.workday_id,assignment_id:null,status:'recorded'});expect(JSON.parse(String(event.context_json))).toEqual({nodeId:node.id,nodeRevision:node.node_revision,graphRevision:node.graph_revision_created,status:'ready',previousStatus:null});}
}
/** Independent native rows must retain the exact old/new canonical plan; no status or exit code substitutes for an observation. */
export function expectWorkdayLifecycleHistory(snapshot:{workdays:Record<string,unknown>[];events:Record<string,unknown>[]}){
 const found:Record<string,unknown>[]=[];
 for(const run of snapshot.workdays){const events=snapshot.events.filter(event=>event.run_id===run.id&&event.event_type==='workday.lifecycle.changed').sort((a,b)=>Number(a.event_index)-Number(b.event_index));if(!events.length)continue;
  let prior:unknown,priorStatus:unknown;
  for(const event of events){const context=JSON.parse(String(event.context_json)),before=appliedWorkdaySchema.parse(context.previousPlan),after=appliedWorkdaySchema.parse(context.plan);expect(context).toEqual({previousStatus:context.previousStatus,status:context.status,previousPlan:before,plan:after});
   expect(event).toMatchObject({id:'workday-lifecycle:'+run.id+':'+createHash('sha256').update(canonicalStandardsJson(context)).digest('hex'),team_id:run.team_id,workday_id:run.id,assignment_id:null,project_id:null,status:'recorded',parameters_json:'{}',metadata_json:'{}',refs_json:'{}'});
   for(const plan of[before,after])expect(plan).toMatchObject({id:run.id,teamId:run.team_id,executionMode:run.execution_mode});
   for(const field of['id','teamId','executionMode','startsAt','endsAt','policyId','policyRevision','policySnapshot'])expect(Reflect.get(after,field)).toEqual(Reflect.get(before,field));
   if(prior!==undefined){expect(before).toEqual(prior);expect(context.previousStatus).toBe(priorStatus);}expect(Number.isFinite(Date.parse(String(event.created_at)))).toBe(true);prior=after;priorStatus=context.status;found.push(event);
  }
  expect(prior).toEqual(appliedWorkdaySchema.parse(JSON.parse(String(run.parameters_json)).appliedPlan));expect(priorStatus).toBe(run.status);
 }
 return found;
}


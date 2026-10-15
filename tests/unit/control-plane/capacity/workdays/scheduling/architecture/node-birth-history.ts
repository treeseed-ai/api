import{expect}from'vitest';

/** These controlled native fixtures create ready planning nodes; direct SQL completion inputs do not manufacture history. */
export function expectNodeBirthHistory(snapshot:{nodes:Record<string,unknown>[];events:Record<string,unknown>[]}){
 const births=snapshot.events.filter(event=>event.event_type==='execution.node.state'&&JSON.parse(String(event.context_json)).previousStatus===null);
 expect(births).toHaveLength(snapshot.nodes.length);expect(new Set(births.map(event=>JSON.parse(String(event.context_json)).nodeId)).size).toBe(snapshot.nodes.length);
 for(const node of snapshot.nodes){const events=births.filter(event=>JSON.parse(String(event.context_json)).nodeId===node.id);expect(events).toHaveLength(1);const event=events[0]!;expect(event).toMatchObject({team_id:node.team_id,project_id:node.project_id,run_id:node.workday_id,workday_id:node.workday_id,assignment_id:null,status:'recorded'});expect(JSON.parse(String(event.context_json))).toEqual({nodeId:node.id,nodeRevision:node.node_revision,graphRevision:node.graph_revision_created,status:'ready',previousStatus:null});}
}

import{expect,it}from'vitest';
import type{ExecutionNode,GraphRevision}from'@treeseed/sdk/agent-capacity';
import{postgresGraph}from'../../graph/architecture/living/living-postgres-fixture.ts';
import{concurrentTerminalNodes}from'../../fixtures/concurrent-terminal.ts';
import{assignment}from'../../fixtures/assignment.ts';
import{ControlPlaneStore}from'../../../../../../../src/api/persistence/store.ts';
import{CapacityWorkdayEventRepository}from'../../../../../../../src/api/capacity/repositories/capacity/workdays/workday-event.ts';
import{persistExecutionGraph}from'../../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-service.ts';
import{digest,type TeamGraph}from'../../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-state.ts';

it('native PostgreSQL competing graph producers retain every node state in independent complete public history and roll back interrupted observation writes',async()=>{
 const f=await postgresGraph();
 try{
  const stamp=new Date().toISOString();await f.left.pool.query("INSERT INTO projects(id,team_id,slug,name,created_at,updated_at) VALUES('project','team','project','Project',$1,$1)",[stamp]);
  await f.left.pool.query("INSERT INTO capacity_workday_runs(id,team_id,status,execution_mode,created_at,updated_at) VALUES('workday','team','running','simulation',$1,$1)",[stamp]);
  const reader=new ControlPlaneStore({TREESEED_ENVIRONMENT:'test'},f.right);reader.initializationPromise=Promise.resolve();
  const events=new CapacityWorkdayEventRepository(reader),node={...concurrentTerminalNodes(assignment.sourceRef)[0]!,workdayId:'workday',status:'proposed' as const};
  let current:TeamGraph={teamId:'team',revision:0,digest:'sha256:'+'0'.repeat(64),nodes:[],edges:[]};
  const steps:ExecutionNode['status'][]=['proposed','blocked','ready','assigned','running','completed','ready','assigned','running','failed','cancelled','stale'];
  for(const[index,status]of steps.entries()){
   const revision=index+1,nextNode={...node,status,nodeRevision:index>=6?2:1,graphRevisionUpdated:revision},next:TeamGraph={...current,revision,nodes:[nextNode]};next.digest=digest({teamId:next.teamId,nodes:next.nodes,edges:next.edges});
   const receipt:GraphRevision={schemaVersion:'treeseed.graph-revision/v1',teamId:'team',revision,ruleRevision:1,changedSourceRefs:[node.sourceRef],graphDigest:next.digest,createdAt:new Date().toISOString(),changes:{added:index?[]:[node.id],changed:index?[node.id]:[],completed:status==='completed'?[node.id]:[],blocked:status==='blocked'?[node.id]:[],stale:status==='stale'?[node.id]:[],addedEdges:[],removedEdges:[]}};
   await Promise.all(f.stores.map(store=>persistExecutionGraph(store,next,current,receipt)));
   const rows=(await f.right.pool.query('SELECT * FROM capacity_workday_events WHERE team_id=$1 AND run_id=$2 ORDER BY event_index',['team','workday'])).rows;
   const page=await events.list('team','workday',{limit:100,afterEventIndex:-1});
   expect(rows).toHaveLength(index+1);expect(page.items.map(event=>event.id)).toEqual(rows.map(row=>row.id));
   expect(page.items.map(event=>event.eventType)).toEqual(steps.slice(0,index+1).map(()=>'execution.node.state'));
   expect(page.items.map(event=>event.context.status)).toEqual(steps.slice(0,index+1));expect(page.items.map(event=>event.eventIndex)).toEqual(Array.from({length:index+1},(_,n)=>n));expect(page.page.hasMore).toBe(false);
   expect(page.items.at(-1)?.context).toEqual({nodeId:node.id,nodeRevision:nextNode.nodeRevision,graphRevision:revision,status,previousStatus:index?steps[index-1]:null});
   expect(page.items.every(event=>event.runId==='workday'&&event.workdayId==='workday'&&event.teamId==='team'&&event.projectId==='project'&&event.assignmentId===null)).toBe(true);
   const held=await f.snapshot(),history=structuredClone(page);await persistExecutionGraph(f.stores[1],next,current,receipt);expect(await f.snapshot()).toEqual(held);expect(await events.list('team','workday',{limit:100,afterEventIndex:-1})).toEqual(history);current=next;
  }
  // Native operational-state input after an original graph receipt. The
  // writer must replay that receipt without restoring its older node state.
  await f.left.pool.query("UPDATE execution_nodes SET status='assigned' WHERE id=$1",[node.id]);
  const later=await f.snapshot(),retainedHistory=await events.list('team','workday',{limit:100,afterEventIndex:-1}),retainedRevision=(await f.right.pool.query('SELECT * FROM execution_graph_revisions WHERE team_id=$1 AND revision=$2',['team',current.revision])).rows[0]!;
  const replayReceipt:GraphRevision={schemaVersion:'treeseed.graph-revision/v1',teamId:'team',revision:current.revision,ruleRevision:1,changedSourceRefs:[node.sourceRef],graphDigest:current.digest,createdAt:String(retainedRevision.created_at),changes:{added:[],changed:[node.id],completed:[],blocked:[],stale:[node.id],addedEdges:[],removedEdges:[]}};
  await persistExecutionGraph(f.stores[1],current,{...current,revision:current.revision-1,nodes:current.nodes.map(value=>({...value,status:'cancelled',graphRevisionUpdated:current.revision-1}))},replayReceipt);expect(await f.snapshot()).toEqual(later);expect(await events.list('team','workday',{limit:100,afterEventIndex:-1})).toEqual(retainedHistory);
  await f.left.pool.query("UPDATE execution_nodes SET status='stale' WHERE id=$1",[node.id]);
  const before=await f.snapshot(),history=await events.list('team','workday',{limit:100,afterEventIndex:-1});
  // Fault injection only in this disposable native database; production uses no trigger or second writer.
  await f.left.pool.query("CREATE FUNCTION interrupt_node_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='execution.node.state' THEN RAISE EXCEPTION 'controlled_node_observation_interruption'; END IF; RETURN NEW; END $$");
  await f.left.pool.query('CREATE TRIGGER interrupt_node_history BEFORE INSERT ON capacity_workday_events FOR EACH ROW EXECUTE FUNCTION interrupt_node_history()');
  const changed={...current,revision:current.revision+1,nodes:current.nodes.map(value=>({...value,status:'ready' as const,graphRevisionUpdated:current.revision+1}))};changed.digest=digest({teamId:changed.teamId,nodes:changed.nodes,edges:changed.edges});
  const receipt:GraphRevision={schemaVersion:'treeseed.graph-revision/v1',teamId:'team',revision:changed.revision,ruleRevision:1,changedSourceRefs:[node.sourceRef],graphDigest:changed.digest,createdAt:new Date().toISOString(),changes:{added:[],changed:[node.id],completed:[],blocked:[],stale:[],addedEdges:[],removedEdges:[]}};
  await expect(persistExecutionGraph(f.stores[0],changed,current,receipt)).rejects.toThrow('controlled_node_observation_interruption');expect(await f.snapshot()).toEqual(before);expect(await events.list('team','workday',{limit:100,afterEventIndex:-1})).toEqual(history);
  await f.left.pool.query('DROP TRIGGER interrupt_node_history ON capacity_workday_events');await f.left.pool.query('DROP FUNCTION interrupt_node_history()');
  await f.left.pool.query("CREATE FUNCTION suppress_node_state() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='ready' THEN RETURN NULL; END IF; RETURN NEW; END $$");
  await f.left.pool.query('CREATE TRIGGER suppress_node_state BEFORE UPDATE ON execution_nodes FOR EACH ROW EXECUTE FUNCTION suppress_node_state()');
  await expect(persistExecutionGraph(f.stores[0],changed,current,receipt)).rejects.toThrow('execution_node_observation_state_mismatch');expect(await f.snapshot()).toEqual(before);expect(await events.list('team','workday',{limit:100,afterEventIndex:-1})).toEqual(history);
  await f.left.pool.query('DROP TRIGGER suppress_node_state ON execution_nodes');await f.left.pool.query('DROP FUNCTION suppress_node_state()');
  await persistExecutionGraph(f.stores[1],changed,current,receipt);expect((await events.list('team','workday',{limit:100,afterEventIndex:-1})).items).toHaveLength(steps.length+1);
 }finally{await f.close();}
 // Controlled graph inputs exercise the original owning producer and independent native public repository, not model/governance outcomes.
});

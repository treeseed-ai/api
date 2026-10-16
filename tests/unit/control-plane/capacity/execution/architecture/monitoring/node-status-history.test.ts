import{executePostgresBatch}from'../../../../../../../src/api/support/control-plane-postgres.ts';
import{readFileSync}from'node:fs';
import{expect,it}from'vitest';
import type{ExecutionNode,GraphRevision}from'@treeseed/sdk/agent-capacity';
import{closeoutDatabase}from'../../graph/architecture/closeout-sql-fixture.ts';
import{concurrentTerminalNodes}from'../../fixtures/concurrent-terminal.ts';
import{assignment}from'../../fixtures/assignment.ts';
import{splitPostgresSqlStatements}from'../../../../../../../src/api/persistence/postgres-sql-statements.ts';
import{CapacityWorkdayEventRepository}from'../../../../../../../src/api/capacity/repositories/capacity/workdays/workday-event.ts';
import{persistExecutionGraph,createExecutionGraphService}from'../../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-service.ts';
import{digest,type TeamGraph}from'../../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-state.ts';

it('retains each owning graph node state and revision in complete public workday history with exact replay and conflict rollback',async()=>{
 const f=await closeoutDatabase();
 const owner={...f.owner,db:{transaction:<T>(apply:(client:Parameters<typeof executePostgresBatch>[0])=>Promise<T>)=>f.db.transaction(transaction=>apply(transaction as unknown as Parameters<typeof executePostgresBatch>[0]))}};
 try{
  const ddl=splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0000_control_plane.sql','utf8'));
  for(const table of['teams']){const statements=ddl.filter(sql=>sql.startsWith('CREATE TABLE "'+table+'" ('));expect(statements).toHaveLength(1);await f.db.exec(statements[0]!);}
  const stamp='2026-10-02T21:00:00.000Z';await f.query('INSERT INTO teams(id,slug,name,created_at,updated_at) VALUES(?,?,?,?,?)',['team','team','Team',stamp,stamp]);
  await f.db.exec(readFileSync('drizzle/control-plane/0044_execution_priority_dependency_provenance.sql','utf8'));
  const original=(await f.query('SELECT * FROM execution_nodes WHERE id=?',['report-node'])).rows;
  const node={...concurrentTerminalNodes(assignment.sourceRef)[0]!,workdayId:'workday',status:'proposed' as const};
  let current:TeamGraph={teamId:'team',revision:0,digest:'sha256:'+'0'.repeat(64),nodes:[],edges:[]};
  const steps:ExecutionNode['status'][]=['proposed','blocked','ready','assigned','running','completed','ready','assigned','running','failed','cancelled','stale'];
  const events=new CapacityWorkdayEventRepository(owner),service=createExecutionGraphService({...f.owner,principalCanAccessTeam:async()=>true,getTeamAccessSummary:async()=>({permissions:['projects:read:team']})});
  for(const[index,status]of steps.entries()){
   const revision=index+1,nextNode={...node,status,nodeRevision:index>=6?2:1,graphRevisionUpdated:revision},next:TeamGraph={...current,revision,nodes:[nextNode]};next.digest=digest({teamId:next.teamId,nodes:next.nodes,edges:next.edges});
   const receipt:GraphRevision={schemaVersion:'treeseed.graph-revision/v1',teamId:'team',revision,ruleRevision:1,changedSourceRefs:[node.sourceRef],graphDigest:next.digest,createdAt:new Date(Date.parse(stamp)+index).toISOString(),changes:{added:index?[]:[node.id],changed:index?[node.id]:[],completed:status==='completed'?[node.id]:[],blocked:status==='blocked'?[node.id]:[],stale:status==='stale'?[node.id]:[],addedEdges:[],removedEdges:[]}};
   await persistExecutionGraph(owner,next,current,receipt);
   const page=await events.list('team','workday',{limit:100,afterEventIndex:-1});
   expect(page.items.map(event=>event.eventType)).toEqual(steps.slice(0,index+1).map(()=>'execution.node.state'));
   expect(page.items.map(event=>event.eventIndex)).toEqual(Array.from({length:index+1},(_,n)=>n));
   expect(page.items.map(event=>event.context.status)).toEqual(steps.slice(0,index+1));
   expect(page.items.at(-1)?.context).toEqual({nodeId:node.id,nodeRevision:nextNode.nodeRevision,graphRevision:revision,status,previousStatus:index?steps[index-1]:null});
   expect(page.items.every(event=>event.runId==='workday'&&event.workdayId==='workday'&&event.teamId==='team'&&event.projectId==='project'&&event.assignmentId===null)).toBe(true);expect(page.page.hasMore).toBe(false);
   expect(await service.node({id:'reader',roles:[],permissions:[]},'team',node.id)).toEqual(nextNode);
   const retained=structuredClone(page);await persistExecutionGraph(owner,next,current,receipt);expect(await events.list('team','workday',{limit:100,afterEventIndex:-1})).toEqual(retained);
   if(index>0){const stale={...next,revision:revision+1,digest:'sha256:'+'f'.repeat(64)};await expect(persistExecutionGraph(owner,stale,{...current,nodes:[]},{...receipt,revision:revision+1,graphDigest:stale.digest})).rejects.toMatchObject({code:'execution_graph_revision_conflict'});expect(await events.list('team','workday',{limit:100,afterEventIndex:-1})).toEqual(retained);}
   current=next;
  }
  // Controlled native SQL advances operational state after the graph receipt;
  // replay must preserve that later state, without claiming admission proof.
  await f.query("UPDATE execution_nodes SET status='assigned' WHERE id=?",[node.id]);
  const later=(await f.query('SELECT * FROM execution_nodes ORDER BY id')).rows,retainedHistory=await events.list('team','workday',{limit:100,afterEventIndex:-1});
  const replayReceipt:GraphRevision={schemaVersion:'treeseed.graph-revision/v1',teamId:'team',revision:current.revision,ruleRevision:1,changedSourceRefs:[node.sourceRef],graphDigest:current.digest,createdAt:new Date(Date.parse(stamp)+steps.length-1).toISOString(),changes:{added:[],changed:[node.id],completed:[],blocked:[],stale:[node.id],addedEdges:[],removedEdges:[]}};
  await persistExecutionGraph(owner,current,{...current,revision:current.revision-1,nodes:current.nodes.map(value=>({...value,status:'cancelled',graphRevisionUpdated:current.revision-1}))},replayReceipt);expect((await f.query('SELECT * FROM execution_nodes ORDER BY id')).rows).toEqual(later);expect(await events.list('team','workday',{limit:100,afterEventIndex:-1})).toEqual(retainedHistory);
  await f.query("UPDATE execution_nodes SET status='stale' WHERE id=?",[node.id]);
  const snapshot=async()=>({nodes:(await f.query('SELECT * FROM execution_nodes ORDER BY id')).rows,revisions:(await f.query('SELECT * FROM execution_graph_revisions ORDER BY revision')).rows,events:(await f.query('SELECT * FROM capacity_workday_events ORDER BY event_index')).rows,runs:(await f.query('SELECT * FROM capacity_workday_runs ORDER BY id')).rows}),before=await snapshot();
  await f.db.exec("CREATE FUNCTION suppress_node_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='execution.node.state' THEN RETURN NULL; END IF; RETURN NEW; END $$; CREATE TRIGGER suppress_node_history BEFORE INSERT ON capacity_workday_events FOR EACH ROW EXECUTE FUNCTION suppress_node_history();");
  const next={...current,revision:current.revision+1,nodes:current.nodes.map(node=>({...node,status:'ready' as const,graphRevisionUpdated:current.revision+1}))};next.digest=digest({teamId:next.teamId,nodes:next.nodes,edges:next.edges});
  const receipt:GraphRevision={schemaVersion:'treeseed.graph-revision/v1',teamId:'team',revision:next.revision,ruleRevision:1,changedSourceRefs:[node.sourceRef],graphDigest:next.digest,createdAt:'2026-10-02T21:00:01.000Z',changes:{added:[],changed:[node.id],completed:[],blocked:[],stale:[],addedEdges:[],removedEdges:[]}};
  await expect(persistExecutionGraph(owner,next,current,receipt)).rejects.toThrow('execution_node_observation_missing');expect(await snapshot()).toEqual(before);
  await f.db.exec('DROP TRIGGER suppress_node_history ON capacity_workday_events; DROP FUNCTION suppress_node_history();');
  await f.db.exec("CREATE FUNCTION suppress_node_state() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='ready' THEN RETURN NULL; END IF; RETURN NEW; END $$; CREATE TRIGGER suppress_node_state BEFORE UPDATE ON execution_nodes FOR EACH ROW EXECUTE FUNCTION suppress_node_state();");
  await expect(persistExecutionGraph(owner,next,current,receipt)).rejects.toThrow('execution_node_observation_state_mismatch');expect(await snapshot()).toEqual(before);
  await f.db.exec('DROP TRIGGER suppress_node_state ON execution_nodes; DROP FUNCTION suppress_node_state();');await persistExecutionGraph(owner,next,current,receipt);expect((await events.list('team','workday',{limit:100,afterEventIndex:-1})).items).toHaveLength(steps.length+1);
  const priorRunHistory=await events.list('team','workday',{limit:100,afterEventIndex:-1});
  await f.query("INSERT INTO capacity_workday_runs(id,team_id,status,execution_mode,created_at,updated_at) VALUES('workday-next','team','running','simulation',?,?)",[receipt.createdAt,receipt.createdAt]);
  const fresh={...next,revision:next.revision+1,nodes:next.nodes.map(value=>({...value,workdayId:'workday-next',nodeRevision:value.nodeRevision+1,graphRevisionUpdated:next.revision+1}))};fresh.digest=digest({teamId:fresh.teamId,nodes:fresh.nodes,edges:fresh.edges});
  await persistExecutionGraph(owner,fresh,next,{...receipt,revision:fresh.revision,graphDigest:fresh.digest,createdAt:'2026-10-02T21:00:02.000Z'});
  const newRunHistory=await events.list('team','workday-next',{limit:100,afterEventIndex:-1});expect(newRunHistory.items).toHaveLength(1);expect(newRunHistory.items[0]).toMatchObject({runId:'workday-next',workdayId:'workday-next',eventIndex:0,context:{nodeId:node.id,nodeRevision:3,status:'ready',previousStatus:null}});expect(await events.list('team','workday',{limit:100,afterEventIndex:-1})).toEqual(priorRunHistory);
  expect((await f.query('SELECT * FROM execution_nodes WHERE id=?',['report-node'])).rows).toEqual(original);
 }finally{await f.db.close();}
 // Original owning persistence/public reads with controlled graph input; native concurrency is a separate required proof.
});

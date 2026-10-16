import{seedNativeAssignmentCustody}from'../../../../providers/assignments/architecture/native-assignment-custody.ts';
import{expect,it}from'vitest';
import{assignmentAttemptSchema,assignmentResultSchema,type ExecutionEdge}from'@treeseed/sdk/agent-capacity';
import{postgresGraph}from'../../graph/architecture/living/living-postgres-fixture.ts';
import{concurrentTerminalNodes,concurrentTerminalAttempt}from'../../fixtures/concurrent-terminal.ts';
import{assignment as sourceAttempt}from'../../fixtures/assignment.ts';
import{recoveryAssignment}from'../../../../providers/assignments/architecture/cancellation-fixture.ts';
import{ControlPlaneStore}from'../../../../../../../src/api/persistence/store.ts';
import{persistExecutionGraph,createExecutionGraphService}from'../../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-service.ts';
import{digest}from'../../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-state.ts';
import{livingExecutionLifecycleOperations}from'../../../../../../../src/api/capacity/services/capacity/assignments/lifecycle/execution/living-execution-lifecycle.ts';

it('native exhausted review projection retains the exact node revisions written by SQL in its independently read graph digest',async()=>{
 const f=await postgresGraph();try{
  const now=new Date().toISOString();
  const base=concurrentTerminalNodes(sourceAttempt.sourceRef)[0]!,actor={...base,id:'bounded-actor',workItemId:'bounded-work',kind:'acting' as const,pairRole:'actor' as const,status:'completed' as const,nodeRevision:8,maximumReviewCycles:2},peer={...base,id:'bounded-peer',workItemId:'bounded-work',kind:'reviewing' as const,pairRole:'reviewer' as const,agentClass:'reviewer',status:'running' as const,nodeRevision:4,maximumReviewCycles:2};
  const edge:ExecutionEdge={schemaVersion:'treeseed.execution-edge/v1',id:'bounded-pair',teamId:'team',fromNodeId:actor.id,toNodeId:peer.id,provenance:'review-pair',graphRevisionCreated:1},graph={teamId:'team',revision:1,nodes:[actor,peer],edges:[edge],digest:''};graph.digest=digest({teamId:'team',nodes:graph.nodes,edges:graph.edges});
  const attempt=assignmentAttemptSchema.parse({...concurrentTerminalAttempt(peer,now),id:'bounded-assignment',idempotencyKey:'bounded-assignment',nodeRevision:peer.nodeRevision,workItemId:peer.workItemId,agentClass:peer.agentClass,status:'leased',effectiveProfile:{...sourceAttempt.effectiveProfile,activity:'reviewing',handler:'work-review',permissionCeiling:peer.requestedPermissions},workspace:{mode:'read-only'},grant:{...sourceAttempt.grant,contentRead:[peer.sourceRef],contentWrite:[],sourceWrite:[],tools:['source.read']},contextRefs:[peer.sourceRef]});
  await seedNativeAssignmentCustody(f.left,attempt);
  await persistExecutionGraph(f.stores[0],graph,{...graph,revision:0,nodes:[],edges:[]},{schemaVersion:'treeseed.graph-revision/v1',teamId:'team',revision:1,ruleRevision:1,changedSourceRefs:[peer.sourceRef],graphDigest:graph.digest,createdAt:now,changes:{added:[actor.id,peer.id],changed:[],completed:[],blocked:[],stale:[],addedEdges:[edge.id],removedEdges:[]}});
  await f.left.pool.query("INSERT INTO capacity_workday_runs(id,team_id,status,execution_mode,created_at,updated_at) VALUES($1,'team','running','simulation',$2,$2)",[attempt.workdayId,now]);
  const result=(id:string,assignmentId:string)=>assignmentResultSchema.parse({schemaVersion:'treeseed.assignment-result/v1',id,assignmentId,status:'completed',summary:'Controlled native SQL projection input; no model execution or approved review is claimed.',references:[],verification:[],diagnostics:[],usage:{elapsedSeconds:0},completedAt:now});
  const priorAttempt=assignmentAttemptSchema.parse({...attempt,id:'bounded-prior',idempotencyKey:'bounded-prior',nodeRevision:3,status:'completed',finishedAt:now});
  for(const value of[priorAttempt,attempt])await f.left.pool.query("INSERT INTO capacity_provider_assignments(id,membership_id,capacity_provider_id,project_agent_class_id,team_id,project_id,work_day_id,mode,status,execution_node_id,execution_node_revision,graph_revision,assignment_attempt_json,assignment_result_json,lifecycle_output_json,created_at,updated_at) VALUES($1,'membership','provider','isolated-class-row','team','project',$2,'acting',$3,$4,$5,1,$6,$7,$8,$9,$9)",[value.id,value.workdayId,value.status,peer.id,value.nodeRevision,JSON.stringify(value),value.id===priorAttempt.id?JSON.stringify(result('prior-result',value.id)):null,JSON.stringify(value.id===priorAttempt.id?{activityCompletion:{reviewDisposition:'request-changes'}}:{}),now]);
  const owner=new ControlPlaneStore({TREESEED_ENVIRONMENT:'test'},f.left);owner.initializationPromise=Promise.resolve();const supplied={...recoveryAssignment(false),id:attempt.id,teamId:attempt.teamId,projectId:attempt.projectId,workDayId:attempt.workdayId,executionMode:attempt.executionMode,executionNodeId:peer.id,executionNodeRevision:peer.nodeRevision,graphRevision:1,assignmentAttempt:attempt,status:'leased' as const};
  const operations=await livingExecutionLifecycleOperations({store:owner,assignment:supplied,status:'completed',now,result:result('current-result',attempt.id),reviewDisposition:'request-changes'});
  await owner.batch([{query:"UPDATE capacity_provider_assignments SET status='completed' WHERE team_id=? AND id=?",params:[attempt.teamId,attempt.id]},...operations]);
  const reader=createExecutionGraphService(f.stores[1]),observed=await reader.show(f.principal,'team',{}),native=(await f.right.pool.query('SELECT id,node_revision,status,maximum_review_cycles FROM execution_nodes ORDER BY id')).rows;
  expect(native).toEqual([{id:actor.id,node_revision:9,status:'blocked',maximum_review_cycles:2},{id:peer.id,node_revision:5,status:'failed',maximum_review_cycles:2}]);
  expect(observed.digest).toBe(digest({teamId:observed.teamId,nodes:observed.nodes,edges:observed.edges}));expect(await reader.show(f.principal,'team',{})).toEqual(observed);
 }finally{await f.close();}
 // Actual original PostgreSQL writer and independent public graph read. Review count, source and result are controlled inputs; no authenticated review or managed outcome is inferred.
});

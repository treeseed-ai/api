import {randomUUID} from 'node:crypto';
import {expect} from 'vitest';
import {compileWorkday,DEFAULT_WORKDAY_POLICY,validateAgentDefinitionModel} from '@treeseed/sdk/agent-capacity';
import {workdayParticipants} from '../../../../../src/api/capacity/policy/execution/workday-participants.ts';
import {createExecutionGraphService} from '../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-service.ts';
import type {relationAuthoringDatabase} from '../../knowledge/workspaces/architecture/relation-authoring-fixture.ts';
type Row=Record<string,unknown>;

/** Controlled original run inputs; real PostgreSQL, exact native TreeDX reads,
 * owning public graph projection/persistence and independent-connection replay.
 * No public preflight admission, model execution or genuine estimate claimed. */
export async function verifyAutomaticEstimatingGraph(f:Awaited<ReturnType<typeof relationAuthoringDatabase>>,definition:Row,reference:Row):Promise<void>{
 const projectId=String(definition.projectId),now=new Date().toISOString();
 const profiles=['engineer','reviewer','reporter'].map(agentClass=>{
  const permissions={content:{read:['proposal'],write:['proposal']},tools:[]};
  const checked=validateAgentDefinitionModel({schemaVersion:'treeseed.agent/v1',id:'native-renamed/'+agentClass,name:'Configured '+agentClass,agentClass,purpose:'Contribute only to exact governed work.',responsibilities:['Preserve source and predecessor authority.'],capabilities:['planning'],context:{include:['assignment-subject']},activityProfiles:{planning:{handler:'writer',permissions,prompt:{system:'Publish the original planning contribution.'}},estimating:{handler:'writer',permissions,prompt:{system:'Estimate only exact selected proposal work.'}}}});
  expect(checked.ok).toBe(true);if(!checked.ok||!checked.data)throw new Error('Original governed profile required');return checked.data;
 });
 for(const profile of profiles)await f.query('INSERT INTO project_agent_classes (id,team_id,project_id,slug,name,handler_refs_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',['automatic-'+randomUUID(),'team',projectId,profile.agentClass,profile.name,JSON.stringify({agents:[profile]}),now,now]);
 const runs:Array<{id:string;selected:boolean}>=[];
 for(const selected of [false,true]){
  const id='workday-'+randomUUID(),selection=selected?{[projectId]:[definition]}:{},snapshots={[projectId]:{agents:profiles.map(profile=>({definition:profile,activities:['planning','estimating']}))}};
  const participants=workdayParticipants({agentProfilesByProjectId:snapshots,proposalsByProjectId:selection});
  const appliedPlan=compileWorkday({id,teamId:'team',policyId:'default',policyRevision:1,executionMode:'simulation',startsAt:now,agentIds:participants.map(value=>value.id),policy:{...DEFAULT_WORKDAY_POLICY,durationSeconds:3600,maximumConcurrency:5,communicationConcurrency:5}});
  const parameters={appliedPlan:{...appliedPlan,state:'active',activatedAt:now},scheduledProjectIds:[projectId],agentProfilesByProjectId:snapshots,...(selected?{proposalIds:[definition.id],planningSourceByProposalId:{[String(definition.id)]:reference}}:{})};
  expect(Object.hasOwn(parameters,'agentSelection')).toBe(false);
  await f.query('INSERT INTO capacity_workday_runs (id,team_id,execution_kind,execution_mode,status,parameters_json,started_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',[id,'team','workday','simulation','running',JSON.stringify(parameters),now,now,now]);runs.push({id,selected});
 }
 const service=createExecutionGraphService(f.store),reconciled=await service.reconcile(f.principal,'team',{}),graph=await service.show(f.principal,'team',{});
 expect(reconciled).toMatchObject({teamId:graph.teamId,revision:graph.revision,graphDigest:graph.digest});
 const history=await service.watch(f.principal,'team',{cursor:'0'});expect(history.items).toEqual([reconciled]);
 for(const run of runs){
  const nodes=graph.nodes.filter(node=>node.workdayId===run.id),planning=nodes.filter(node=>node.kind==='planning'),estimating=nodes.filter(node=>node.kind==='estimating');
  expect(planning.map(node=>node.agentClass).sort()).toEqual(['engineer','reporter','reviewer']);
  expect(estimating.map(node=>node.agentClass).sort()).toEqual(run.selected?['engineer','reviewer']:[]);
  for(const estimator of estimating){
   expect(estimator.sourceRef).toEqual(reference);expect(estimator.status).toBe('blocked');
   const own=planning.filter(node=>node.agentClass===estimator.agentClass);expect(own).toHaveLength(1);
   const predecessors=graph.edges.filter(edge=>edge.toNodeId===estimator.id).map(edge=>edge.fromNodeId).sort();
   expect(predecessors).toEqual([own[0]!.id,...(estimator.agentClass==='reviewer'?estimating.filter(node=>node.agentClass!=='reviewer').map(node=>node.id):[])].sort());
   const explanation=await service.explain(f.principal,'team',estimator.id);expect(explanation.admission.eligible).toBe(false);expect(explanation.predecessors.map(value=>value.node!.id).sort()).toEqual(predecessors);
   expect(explanation.blockingReasons).toEqual(expect.arrayContaining(['predecessor-incomplete:'+own[0]!.id]));
  }
 }
 const snapshot=async()=>({nodes:await f.store.all('SELECT * FROM execution_nodes ORDER BY id'),edges:await f.store.all('SELECT * FROM execution_edges ORDER BY id'),revisions:await f.store.all('SELECT * FROM execution_graph_revisions ORDER BY team_id,revision'),events:await f.store.all('SELECT * FROM capacity_workday_events ORDER BY run_id,event_index,id'),attempts:await f.store.all('SELECT * FROM capacity_provider_assignments ORDER BY id'),reservations:await f.store.all('SELECT * FROM capacity_reservations ORDER BY id'),usage:await f.store.all('SELECT * FROM capacity_usage_actuals ORDER BY id'),ledger:await f.store.all('SELECT * FROM capacity_ledger_entries ORDER BY id')});
 const held=await snapshot();expect(held.edges.filter(edge=>edge.graph_revision_removed===null)).toHaveLength(graph.edges.length);
 for(const rows of [held.attempts,held.reservations,held.usage,held.ledger])expect(rows).toEqual([]);
 expect(f.peerStore).toBeDefined();if(!f.peerStore)throw new Error('Independent native PostgreSQL connection required');
 const peer=createExecutionGraphService(f.peerStore),replays=await Promise.all([service.reconcile(f.principal,'team',{}),peer.reconcile(f.principal,'team',{})]);expect(replays).toEqual([reconciled,reconciled]);expect(await snapshot()).toEqual(held);expect(await peer.show(f.principal,'team',{})).toEqual(graph);
}

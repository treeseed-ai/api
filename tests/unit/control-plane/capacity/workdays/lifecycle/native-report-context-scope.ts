import {expect} from 'vitest';
import type pg from 'pg';
import type {CapacityGovernanceDatabase} from '../../../../../../src/api/capacity/database.ts';
import {workdayReportContext} from '../../../../../../src/api/capacity/services/capacity/assignments/admission/workday-report-context.ts';
import {frozenAttempt} from '../../accounting/architecture/settlement-fixture.ts';

/** Original native owning queries and independent observer. Graph rows and Reporter input are controlled, not genuine managed work. */
export async function proveNativeReportGraphScope(owner:CapacityGovernanceDatabase,observer:pg.Pool,workdayId:string){
 const prefix='native-report-context-',proposal=prefix+'proposal',at=new Date().toISOString();
 const original=(await observer.query('SELECT parameters_json FROM capacity_workday_runs WHERE team_id=$1 AND id=$2',['team',workdayId])).rows[0]!;
 const parameters=typeof original.parameters_json==='string'?JSON.parse(original.parameters_json):original.parameters_json;
 const snapshot=async()=>({nodes:(await observer.query('SELECT * FROM execution_nodes ORDER BY team_id,id')).rows,edges:(await observer.query('SELECT * FROM execution_edges ORDER BY id')).rows});
 const baseline=await snapshot();
 try{
  await observer.query('UPDATE capacity_workday_runs SET parameters_json=$1 WHERE team_id=$2 AND id=$3',[JSON.stringify({...parameters,proposalIds:[proposal]}),'team',workdayId]);
  for(const[id,team,kind,role,source]of [['actor','team','acting','actor',proposal],['reviewer','team','reviewing','reviewer',proposal],['unrelated','team','acting','actor',prefix+'unrelated-proposal'],['foreign','foreign-team','acting','actor',proposal]]){
   await observer.query(`INSERT INTO execution_nodes (id,team_id,project_id,workday_id,kind,pair_role,source_ref_json,rule_revision,node_revision,agent_class,status,graph_revision_created,graph_revision_updated,created_at,updated_at)
    VALUES ($1,$2,'project',NULL,$3,$4,$5,1,1,'configured-role','completed',1,1,$6,$6)`,[prefix+id,team,kind,role,JSON.stringify({store:'treedx',model:'proposal',id:source}),at]);
  }
  await observer.query(`INSERT INTO execution_edges (id,team_id,from_node_id,to_node_id,provenance,graph_revision_created,created_at)
   VALUES ($1,'team',$2,$3,'review-pair',1,$4)`,[prefix+'pair',prefix+'actor',prefix+'reviewer',at]);
  const before=await snapshot(),reporter={...frozenAttempt,workdayId,effectiveProfile:{...frozenAttempt.effectiveProfile,activity:'reporting' as const},sourceRef:{store:'postgresql' as const,model:'workday',id:workdayId,revision:1,digest:`sha256:${'a'.repeat(64)}`}};
  const [context]=await workdayReportContext(owner,reporter),value=context!.value as {nodes:Array<{id:string}>;edges:Array<{id:string}>};
  expect(value.nodes.map(node=>node.id)).toEqual([prefix+'actor',prefix+'reviewer']);expect(value.edges.map(edge=>edge.id)).toEqual([prefix+'pair']);
  expect(await workdayReportContext(owner,reporter)).toEqual([context]);expect(await snapshot()).toEqual(before);
 }finally{
  await observer.query('DELETE FROM execution_edges WHERE id=$1',[prefix+'pair']);
  for(const[id,team]of [['actor','team'],['reviewer','team'],['unrelated','team'],['foreign','foreign-team']])await observer.query('DELETE FROM execution_nodes WHERE id=$1 AND team_id=$2',[prefix+id,team]);
  await observer.query('UPDATE capacity_workday_runs SET parameters_json=$1 WHERE team_id=$2 AND id=$3',[JSON.stringify(parameters),'team',workdayId]);
 }
 expect(await snapshot()).toEqual(baseline);
}

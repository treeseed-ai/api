import {observeControlledClosing} from '../graph/architecture/closeout-sql-fixture.ts';
import {describe,expect,it} from 'vitest';
import {settlementDatabase} from '../../accounting/architecture/settlement-fixture.ts';
import {workdayReportContext} from '../../../../../../src/api/capacity/services/capacity/assignments/admission/workday-report-context.ts';
import {frozenAttempt} from '../../accounting/architecture/settlement-fixture.ts';

describe('original Reporter complete graph scope',()=>{
 it('retains selected proposal Actor and Reviewer nodes whose shared graph authority has no Workday owner while excluding unrelated proposals and teams',async()=>{
  const f=await settlementDatabase();try{await observeControlledClosing(f);
   const run=(await f.reads.get('team','workday'))!;
   await f.query('UPDATE capacity_workday_runs SET parameters_json=? WHERE id=?',[JSON.stringify({...run.parameters,proposalIds:['selected-proposal']}),run.id]);
   await f.query("UPDATE capacity_reservations SET state='expired' WHERE id='reservation'");
   const at=run.updatedAt,ref=(id:string)=>JSON.stringify({store:'treedx',model:'proposal',id});
   for(const[id,team,kind,role,proposal]of [['selected-actor','team','acting','actor','selected-proposal'],['selected-reviewer','team','reviewing','reviewer','selected-proposal'],['unrelated-actor','team','acting','actor','unrelated-proposal'],['foreign-actor','foreign-team','acting','actor','selected-proposal']]){
    await f.query(`INSERT INTO execution_nodes (id,team_id,project_id,workday_id,kind,pair_role,source_ref_json,rule_revision,node_revision,agent_class,status,graph_revision_created,graph_revision_updated,created_at,updated_at)
     VALUES (?,?,?,NULL,?,?,?,1,1,'configured-role','completed',1,1,?,?)`,[id,team,'project',kind,role,ref(proposal!),at,at]);
   }
   await f.query(`INSERT INTO execution_edges (id,team_id,from_node_id,to_node_id,provenance,graph_revision_created,created_at)
    VALUES ('selected-pair','team','selected-actor','selected-reviewer','review-pair',1,?)`,[at]);
   const before={nodes:(await f.query('SELECT * FROM execution_nodes ORDER BY team_id,id')).rows,edges:(await f.query('SELECT * FROM execution_edges ORDER BY id')).rows,financial:await f.snapshot()};
   const reporter={...frozenAttempt,effectiveProfile:{...frozenAttempt.effectiveProfile,activity:'reporting' as const},sourceRef:{store:'postgresql' as const,model:'workday',id:'workday',revision:1,digest:`sha256:${'a'.repeat(64)}`}};
   const [context]=await workdayReportContext(f.owner,reporter);const value=context!.value as {nodes:Array<{id:string}>;edges:Array<{id:string}>};
   expect(value.nodes.map(node=>node.id)).toEqual(['report-node','selected-actor','selected-reviewer']);expect(value.edges.map(edge=>edge.id)).toEqual(['selected-pair']);
   expect(await workdayReportContext(f.owner,reporter)).toEqual([context]);
   expect({nodes:(await f.query('SELECT * FROM execution_nodes ORDER BY team_id,id')).rows,edges:(await f.query('SELECT * FROM execution_edges ORDER BY id')).rows,financial:await f.snapshot()}).toEqual(before);
  }finally{await f.db.close();}
 });

 it('rejects malformed original selection authority rather than widening a Reporter snapshot to unrelated graph nodes',async()=>{
  const f=await settlementDatabase();try{
   const original=(await f.reads.get('team','workday'))!;await f.query("UPDATE capacity_reservations SET state='expired' WHERE id='reservation'");
   const reporter={...frozenAttempt,effectiveProfile:{...frozenAttempt.effectiveProfile,activity:'reporting' as const},sourceRef:{store:'postgresql' as const,model:'workday',id:'workday',revision:1,digest:'sha256:'+'a'.repeat(64)}};
   const held=await f.snapshot();
   for(const parameters of [null,[],{...original.parameters,proposalIds:'foreign'},{...original.parameters,proposalIds:[12]},{...original.parameters,proposalIds:['']},{...original.parameters,proposalIds:['selected','selected']}]){
    await f.query('UPDATE capacity_workday_runs SET parameters_json=? WHERE id=?',[JSON.stringify(parameters),original.id]);
    await expect(workdayReportContext(f.owner,reporter)).rejects.toMatchObject({code:'reporter_workday_authority_required',status:409});expect(await f.snapshot()).toEqual(held);
   }
   await f.query("UPDATE capacity_workday_runs SET parameters_json=?,execution_kind='conversation' WHERE id=?",[JSON.stringify(original.parameters),original.id]);
   await expect(workdayReportContext(f.owner,reporter)).rejects.toMatchObject({code:'reporter_workday_authority_required',status:409});expect(await f.snapshot()).toEqual(held);
  }finally{await f.db.close();}
 });
});

import {expect,it} from 'vitest';
import {componentContentChange} from './component-content-fixture.ts';
import {postgresGraph} from '../living/living-postgres-fixture.ts';
import {emptyLivingGraph} from '../living/living-graph-fixture.ts';
import {createExecutionGraphService,persistExecutionGraph} from '../../../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-service.ts';

it('native content-component publication retains unrelated SQL bytes original history and public views through interruption and unchanged concurrent replay',async()=>{
 const database=await postgresGraph(),f=componentContentChange(),held=structuredClone(f);
 try {
  const initialReceipt={...f.originalProjection.revision,graphDigest:f.before.digest};
  await persistExecutionGraph(database.stores[0],f.before,emptyLivingGraph(),initialReceipt);
  const before=await database.snapshot(),prior=new Map(f.before.nodes.map(node=>[node.id,node])),priorEdges=new Set(f.before.edges.map(edge=>edge.id)),nextEdges=new Set(f.after.edges.map(edge=>edge.id));
  const receipt={...f.nextProjection.revision,graphDigest:f.after.digest,changes:{
   added:f.after.nodes.filter(node=>!prior.has(node.id)).map(node=>node.id),
   changed:f.after.nodes.filter(node=>prior.has(node.id)&&!f.outsideIds.has(node.id)).map(node=>node.id),
   completed:f.after.nodes.filter(node=>node.status==='completed'&&prior.get(node.id)?.status!=='completed').map(node=>node.id),
   blocked:f.after.nodes.filter(node=>node.status==='blocked'&&prior.get(node.id)?.status!=='blocked').map(node=>node.id),
   stale:f.after.nodes.filter(node=>node.status==='stale'&&prior.get(node.id)?.status!=='stale').map(node=>node.id),
   addedEdges:f.after.edges.filter(edge=>!priorEdges.has(edge.id)).map(edge=>edge.id),removedEdges:f.before.edges.filter(edge=>!nextEdges.has(edge.id)).map(edge=>edge.id),
  }};
  const outsideNodes=(rows:typeof before.nodes)=>rows.filter(row=>f.outsideIds.has(String(row.id)));
  const outsideEdges=(rows:typeof before.edges)=>rows.filter(row=>f.outsideIds.has(String(row.from_node_id))||f.outsideIds.has(String(row.to_node_id)));
  await database.left.pool.query("CREATE FUNCTION reject_component_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled component interruption'; END $$; CREATE TRIGGER reject_component_change BEFORE INSERT OR UPDATE ON execution_nodes FOR EACH ROW EXECUTE FUNCTION reject_component_change();");
  await expect(persistExecutionGraph(database.stores[1],f.after,f.before,receipt)).rejects.toThrow('controlled component interruption');
  expect(await database.snapshot()).toEqual(before);
  for(const store of database.stores)expect(await createExecutionGraphService(store).show(database.principal,'team',{})).toEqual(f.before);
  await database.left.pool.query('DROP TRIGGER reject_component_change ON execution_nodes; DROP FUNCTION reject_component_change();');
  await persistExecutionGraph(database.stores[1],f.after,f.before,receipt);
  const after=await database.snapshot();expect(outsideNodes(after.nodes)).toEqual(outsideNodes(before.nodes));expect(outsideEdges(after.edges)).toEqual(outsideEdges(before.edges));
  expect(after.revisions.slice(0,before.revisions.length)).toEqual(before.revisions);expect(after.revisions).toHaveLength(2);expect(after.assignments).toEqual(before.assignments);expect(after.reservations).toEqual(before.reservations);
  for(const store of database.stores){const service=createExecutionGraphService(store);expect(await service.show(database.principal,'team',{})).toEqual(f.after);const page=await service.watch(database.principal,'team',{cursor:'0'});expect(page.items).toHaveLength(2);expect(await service.watch(database.principal,'team',{cursor:page.nextCursor})).toEqual({items:[],nextCursor:'2'});}
  await Promise.all(database.stores.map(store=>persistExecutionGraph(store,f.after,f.after,receipt)));expect(await database.snapshot()).toEqual(after);expect(f).toEqual(held);
  // Original projector/state/writer and independent PostgreSQL pools/public
  // services are real. Content and Decision inputs are controlled; no native
  // TreeDX governance, model execution, charges or managed golden is claimed.
 } finally {await database.close();}
},30_000);

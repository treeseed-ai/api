import {expect,it} from 'vitest';
import {componentContentChange} from './component-content-fixture.ts';

it('reconciles content and accepted authority changes only within their original connected component while preserving an unrelated proposal using the same configured agents',()=>{
 const f=componentContentChange(),held=structuredClone(f);
 expect(f.outside.length).toBeGreaterThan(0);expect(f.after.digest).not.toBe(f.before.digest);
 const byId=new Map(f.before.nodes.map(node=>[node.id,node]));
 const interProposal=f.before.edges.filter(edge=>{const from=byId.get(edge.fromNodeId),to=byId.get(edge.toNodeId);return from?.pairRole&&to?.pairRole&&from.sourceRef.id!==to.sourceRef.id;});
 expect(interProposal).toEqual([]);
 expect(f.after.nodes.filter(node=>f.outsideIds.has(node.id))).toEqual(f.outside);
 expect(f.after.edges.filter(edge=>f.outsideIds.has(edge.fromNodeId)||f.outsideIds.has(edge.toNodeId)))
  .toEqual(f.before.edges.filter(edge=>f.outsideIds.has(edge.fromNodeId)||f.outsideIds.has(edge.toNodeId)));
 expect(f.after.nodes.some(node=>node.sourceRef.id===f.changed.frontmatter.id&&node.sourceRef.digest===f.source.digest)).toBe(true);
 expect(f).toEqual(held);
});

import {graphSource,graphProjection,graphState} from '../living/living-graph-fixture.ts';

/** Controlled canonical content/Decision inputs; no native governance publication. */
export function componentContentChange(){
 const changed=graphSource(),unrelated=graphSource();
 unrelated.frontmatter.id='unrelated-proposal';unrelated.path='proposals/unrelated.mdx';
 if(!unrelated.decision)throw new Error('Original controlled Decision required');
 unrelated.decision={...unrelated.decision,id:'unrelated-decision',path:'decisions/unrelated.mdx'};
 const originalProjection=graphProjection([changed,unrelated]),before=graphState(originalProjection);
 const source=structuredClone(changed);source.proposalRevision=2;source.digest='sha256:'+'e'.repeat(64);source.commit='f'.repeat(40);
 if(!source.decision)throw new Error('Original controlled Decision required');source.decision={...source.decision,revision:2,digest:'sha256:'+'d'.repeat(64),commit:source.commit};
 const nextProjection=graphProjection([source,unrelated],2),after=graphState(nextProjection,before);
 const outside=before.nodes.filter(node=>node.sourceRef.id===unrelated.frontmatter.id||node.authorityRefs?.some(ref=>ref.id===unrelated.decision!.id)),ids=new Set(outside.map(node=>node.id));
 return{changed,unrelated,source,originalProjection,nextProjection,before,after,outside,outsideIds:ids};
}

import { beforeEach, describe, expect, it, vi } from 'vitest';
const observed=vi.hoisted(()=>({ definition:undefined as unknown,read:vi.fn() }));
vi.mock('../../../../src/api/knowledge/gateway-treedx-connection.ts',()=>({
 projectLibraryPath:(_prefix:string,collection:string,file:string)=>collection+'/'+file,
 resolveKnowledgeGatewayConnection:vi.fn(async()=>({repositoryId:'repository',contentPath:'.',client:{readRepositoryFile:observed.read}})),
}));
vi.mock('../../../../src/api/content/frontmatter.ts',async(importOriginal)=>{
 const actual=await importOriginal<typeof import('../../../../src/api/content/frontmatter.ts')>();
 return {...actual,serializeFrontmatterDocument:vi.fn((value:Record<string,unknown>)=>{observed.definition=structuredClone(value);return actual.serializeFrontmatterDocument(value);})};
});
import { publishProposalDecision } from '../../../../src/api/governance/executable-proposal.ts';
const ref={store:'treedx',model:'proposal',id:'proposal',revision:6,digest:`sha256:${'a'.repeat(64)}`,repository:'repository',commit:'b'.repeat(40),path:'proposals/proposal.mdx'};
const row={id:'decision',project_id:'project',created_by_type:'system',created_by_id:null,created_at:'2026-10-19T09:26:25.873Z',decision_record_json:JSON.stringify({proposalRef:ref,rationale:'Authorize the exact bounded repair.'})};
const proposal={closedReason:'admin_approved'};
const vote={userId:'operator',vote:'support',reason:'Authorize bounded work.',updatedAt:'2026-10-19T09:26:25.859Z'};
describe('canonical proposal Decision disposition custody',()=>{
 beforeEach(()=>{observed.definition=undefined;observed.read.mockReset().mockRejectedValue(new Error('independent publication boundary'));});
 it('retains a recorded administrative support vote as vote authority when automatic evaluation reserved a system-owned Decision',async()=>{
  const original=structuredClone({row,proposal,vote});
  await expect(publishProposalDecision({},proposal,row,[vote])).rejects.toThrow('independent publication boundary');
  expect(observed.definition).toEqual({schemaVersion:'treeseed.decision/v1',id:'decision',projectId:'project',decisionClass:'proposal',decisionMethod:'vote',subjectRef:ref,disposition:'approved',rationale:'Authorize the exact bounded repair.',authorityRefs:[{store:'postgresql',model:'user',id:'operator'}],decidedByRefs:[{store:'postgresql',model:'user',id:'operator'}],positions:[{actorRef:{store:'postgresql',model:'user',id:'operator'},position:'approve',rationale:vote.reason,recordedAt:vote.updatedAt}],decidedAt:row.created_at});
  expect({row,proposal,vote}).toEqual(original);
 });
 it('preserves actual manager authority without inventing a vote or its timestamp',async()=>{
  await expect(publishProposalDecision({},proposal,{...row,created_by_type:'user',created_by_id:'manager'},[])).rejects.toThrow('independent publication boundary');
  expect(observed.definition).toMatchObject({decisionMethod:'authority',decidedByRefs:[{store:'postgresql',model:'user',id:'manager'}],decidedAt:row.created_at});
  expect(observed.definition).not.toHaveProperty('positions');
 });
 it.each([{votes:[]},{votes:[{...vote,userId:''}]},{votes:[{...vote,updatedAt:'not-a-clock'}]}])('denies absent or malformed recorded voters before native publication: $votes',async({votes})=>{
  await expect(publishProposalDecision({},proposal,row,votes)).rejects.toMatchObject({code:'governance_decision_content_invalid'});
  expect(observed.definition).toBeUndefined();expect(observed.read).not.toHaveBeenCalled();
 });
});

import {describe,expect,it,vi} from 'vitest';
import {reconcileCommunicationExecutionGraph} from '../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-service.ts';

const {persist}=vi.hoisted(()=>({persist:vi.fn(async (_store:unknown,_graph:unknown,_current:unknown,receipt:unknown)=>receipt)}));
vi.mock('../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-persistence.ts',()=>({persistExecutionGraph:persist}));

describe('communication-only retirement authority',()=>{
 it.each(['ready','assigned'] as const)('retains the exact source of the last %s communication when no active invocation remains',async status=>{
  const sourceRef={store:'treedx',model:'discussion',id:'retired-invocation',repository:'library',commit:'b'.repeat(40),path:'discussion-messages/topic/request.mdx',digest:`sha256:${'a'.repeat(64)}`};
  const row={id:'communication:retired-invocation:conversation',team_id:'team',project_id:'project',workday_id:'conversation',
   kind:'communication',pair_role:null,source_ref_json:JSON.stringify(sourceRef),authority_refs_json:JSON.stringify([sourceRef]),
   rule_revision:1,node_revision:1,agent_class:'renamed-peer',status,estimate_json:JSON.stringify({expectedSeconds:180,maximumSeconds:180}),
   required_capabilities_json:'[]',requested_permissions_json:JSON.stringify({content:{read:['discussion'],write:['discussion']},tools:['discussion']}),
   workspace:'treedx',acceptance_criteria_json:'["Return one response."]',graph_revision_created:1,graph_revision_updated:1};
  const store={first:async()=>({revision:1,graph_digest:`sha256:${'c'.repeat(64)}`}),
   all:async(sql:string)=>sql.startsWith('SELECT * FROM execution_nodes')?[row]:[]};
  persist.mockClear();
  const receipt=await reconcileCommunicationExecutionGraph(store,'team');
  expect(receipt).toMatchObject({revision:2,changedSourceRefs:[sourceRef],changes:{stale:[row.id]}});
  expect(persist).toHaveBeenCalledOnce();
  expect(persist.mock.calls[0]?.[1]).toMatchObject({nodes:[{id:row.id,status:'stale',sourceRef}]});
 });
});

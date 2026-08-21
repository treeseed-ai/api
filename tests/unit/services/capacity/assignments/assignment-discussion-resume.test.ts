import {describe,expect,it,vi} from 'vitest';
import {admitDiscussionInvocations} from '../../../../../src/api/capacity/services/capacity/invocations/discussion-invocation-service.ts';
import {discussionHandoffPolicyViolation} from '../../../../../src/api/capacity/services/capacity/invocations/discussion-handoff-policy.ts';

describe('assignment Discussion continuation',()=>{
	it('closes the prior demand and admits a new exact continuation after a human discussion response',async()=>{
		let admissionClaim:{executionId:string;blockingState:string}|null=null;
		const run=vi.fn(async(query:string,params:unknown[]=[])=>{
			if(query.includes("SET status='admitted',execution_id=?")) admissionClaim={executionId:String(params[0]),blockingState:String(params[1])};
			return {success:true,meta:{changes:1}};
		});
		const store={
			async first(query:string){
				if(query.includes('FROM capacity_provider_assignments WHERE id'))return {id:'assignment-old',work_day_id:'workday-conversation-old',team_id:'team-a',project_id:'project-a',status:'returned',lease_state:'released',execution_kind:'conversation',lifecycle_code:'discussion_response_required',metadata_json:JSON.stringify({operationalState:'suspended'})};
				if(query.includes('capacity_provider_availability_sessions'))return {execution_providers_json:JSON.stringify([{id:'codex',status:'available',maxConcurrentRunners:2,lanes:[{id:'communication',purpose:'communication'},{id:'operation',purpose:'operation'}]}])};
				if(query.includes("status = 'suspended'"))return {id:'invocation-old',assignment_id:'assignment-old',handoff_root_id:'invocation-old',handoff_depth:0};
				if(query.includes('SELECT status,execution_id,blocking_state_json')&&admissionClaim)return {status:'admitted',execution_id:admissionClaim.executionId,blocking_state_json:admissionClaim.blockingState};
				return null;
			},
			async all(query:string){
				if(query.includes('project_agent_classes'))return [{id:'class-a',handler_refs_json:JSON.stringify({agents:[{slug:'guide-writer',activities:{chat:{enabled:true}}}]}),metadata_json:JSON.stringify({immutableRef:'definition-ref'})}];
				if(query.includes('capacity_provider_team_memberships'))return [{membership_id:'membership-a',capacity_provider_id:'provider-a',execution_provider_id:'codex'}];
				return [];
			},
			run,
			async createCapacityWorkdayRun(_teamId:string,input:Record<string,unknown>){return {id:input.id};},
			async tickCapacityWorkdayRun(){return {};},
			async updateCapacityWorkdayRun(){return null;},
		};
		const result=await admitDiscussionInvocations(store as never,{teamId:'team-a',projectId:'project-a',projectSlug:'api',discussionId:'discussion-a',messageId:'human-reply',messagePath:'src/content/discussion-messages/discussion-a/human-reply.mdx',messageCommit:'a'.repeat(40),contextRefs:[],agentSlugs:['guide-writer'],idempotencyKey:'reply-key',parentAssignmentId:'assignment-old',durationSeconds:900});
		expect(result).toMatchObject([{status:'admitted',parentAssignmentId:'assignment-old',handoffParentId:'invocation-old',handoffDepth:1}]);
		const statements=run.mock.calls.map(([query])=>String(query));
		expect(statements.some((query)=>query.includes('INSERT INTO agent_invocation_requests'))).toBe(true);
		expect(statements.some((query)=>query.includes('capacity_workday_demands')&&query.includes("status = 'pending'"))).toBe(false);
	});
});

describe('assignment Discussion handoff policy',()=>{
	const input={currentAgentId:'writer',recipientAgentIds:['reviewer'],depth:1,maxDepth:2,existingHandoffs:0,maxHandoffsPerRoot:4,priorAgentIds:['writer'],activeDuplicateAgentIds:[]};
	it('accepts a bounded distinct handoff',()=>expect(discussionHandoffPolicyViolation(input)).toBeNull());
	it.each([
		[{...input,recipientAgentIds:['writer']},'assignment_discussion_handoff_self_denied'],
		[{...input,depth:3},'assignment_discussion_handoff_depth_exceeded'],
		[{...input,existingHandoffs:4},'assignment_discussion_handoff_root_limit'],
		[{...input,priorAgentIds:['reviewer']},'assignment_discussion_handoff_cycle_denied'],
		[{...input,activeDuplicateAgentIds:['reviewer']},'assignment_discussion_handoff_duplicate_denied'],
	] as const)('rejects unsafe handoff provenance', (candidate,code)=>expect(discussionHandoffPolicyViolation(candidate)).toMatchObject({code}));
});

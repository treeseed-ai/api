import {describe,expect,it} from 'vitest';
import {closeSuspendedConversationExecution,suspendAssignmentForDiscussionResponse} from '../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-discussion-suspension-service.ts';

describe('required-response assignment suspension',()=>{
	it('releases the exact lease despite a concurrent renewal and converges replay cleanup',async()=>{
		let assignment:Record<string,unknown>={
			id:'assignment-a',teamId:'team-a',status:'leased',leaseState:'leased',leaseToken:'lease-a',stateVersion:8,
			invocationId:'invocation-a',metadata:{},treedxProxyHandle:{id:'handle-a',status:'issued'},
			workspaceContext:{capabilityHandles:{treeDx:[{id:'workspace-a',status:'issued'}]}},
		};
		const statements:string[]=[];
		const store={
			async getProviderAssignment(){return assignment;},
			async run(query:string,params:unknown[]){
				statements.push(query);
				if(query.includes('UPDATE capacity_provider_assignments')) assignment={...assignment,status:'returned',leaseState:'released',leaseToken:null,stateVersion:9,lifecycleCode:'discussion_response_required',metadata:JSON.parse(String(params[2]))};
				return {changes:1};
			},
			async batch(operations:Array<{query:string}>){statements.push(...operations.map(({query})=>query));return [];},
		} as never;
		const input={assignmentId:'assignment-a',teamId:'team-a',leaseToken:'lease-a',discussionId:'discussion-a',messageId:'message-a',message:'Which scope?',messagePath:'src/content/discussion-messages/discussion-a/message-a.mdx',checkpoint:{commitSha:'a'.repeat(40)}};

		await expect(suspendAssignmentForDiscussionResponse(store,input)).resolves.toMatchObject({status:'returned',leaseState:'released',metadata:{operationalState:'suspended',waitingMessageId:'message-a'}});
		expect(statements[0]).toContain("lease_token=?");
		expect(statements[0]).not.toContain('state_version=?');
		expect(statements.some((query)=>query.includes("agent_invocation_requests SET status='suspended'"))).toBe(true);
		expect(statements.some((query)=>query.includes("treedx_proxy_handles SET status='revoked'"))).toBe(true);
		expect(statements.some((query)=>query.includes("capacity_workday_runs SET status='degraded'"))).toBe(false);

		statements.length=0;
		await expect(suspendAssignmentForDiscussionResponse(store,input)).resolves.toMatchObject({status:'returned'});
		expect(statements.some((query)=>query.includes('UPDATE capacity_provider_assignments'))).toBe(false);
		expect(statements.some((query)=>query.includes("agent_invocation_requests SET status='suspended'"))).toBe(true);
		expect(statements.some((query)=>query.includes("capacity_workday_runs SET status='degraded'"))).toBe(false);
	});

	it('closes the hidden execution only after durable final-message and settlement evidence',async()=>{
		const statements:string[]=[];
		const store={
			async first(query:string){statements.push(query);return query.includes('capacity_ledger_entries')?{final_message_ref:'src/content/discussion-messages/d/m.mdx'}:{status:'degraded',completed_at:'2026-08-15T12:00:00.000Z'};},
			async batch(operations:Array<{query:string}>){statements.push(...operations.map(({query})=>query));return [];},
		} as never;
		await expect(closeSuspendedConversationExecution(store,{id:'assignment-a',teamId:'team-a',invocationId:'invocation-a'} as never,'2026-08-15T12:00:00.000Z')).resolves.toMatchObject({status:'degraded'});
		expect(statements[0]).toContain("settlement.phase='task_completed_actual_settlement'");
		expect(statements.some((query)=>query.includes("capacity_workday_runs SET status='degraded'"))).toBe(true);
		expect(statements.some((query)=>query.includes("workday_capacity_envelopes SET status='degraded'"))).toBe(true);
	});
});

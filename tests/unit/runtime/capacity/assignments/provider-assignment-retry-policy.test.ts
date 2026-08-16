import { describe,expect,it,vi } from 'vitest';
import type { CapacityDatabaseOperation } from '../../../../../src/api/capacity/database.ts';
import { providerAssignmentQueuePriority } from '../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-lease-service.ts';
import { selectAssignmentLane } from '../../../../../src/api/capacity/services/capacity/assignments/planning/assignment-lane-selection.ts';
import { ProviderAssignmentLifecycleService } from '../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-lifecycle-service.ts';

describe('provider assignment retry policy', () => {
	it('orders overflow communication ahead of queued operation work on an operation lane', () => {
		const operation = { executionKind: 'workday', communicationOverflow: false } as never;
		const overflow = { executionKind: 'conversation', communicationOverflow: true } as never;
		expect(providerAssignmentQueuePriority(overflow)).toBeLessThan(providerAssignmentQueuePriority(operation));
	});

	it('allows communication overflow but never admits operation work to a communication lane', () => {
		const lanes = [
			{ id: 'communication', purpose: 'communication', maxConcurrentRunners: 1 },
			{ id: 'operation', purpose: 'operation', maxConcurrentRunners: 1 },
		] as never;
		expect(selectAssignmentLane('conversation', lanes, new Map([['communication', 1]]))).toMatchObject({
			lane: { id: 'operation' }, communicationOverflow: true,
		});
		expect(selectAssignmentLane('workday', lanes, new Map([['operation', 1]]))).toMatchObject({
			requestedPurpose: 'operation', lane: undefined, communicationOverflow: false,
		});
	});

	it('renews a lease without invalidating assignment-scoped tool state', async () => {
		let leaseRenewedAt:string|null=null; let leaseExpiresAt:string|null=new Date(Date.now()+60_000).toISOString();
		const assignment=()=>({ id:'assignment-a',membershipId:'membership-a',teamId:'team-a',projectId:'project-a',capacityProviderId:'provider-a',
			status:'leased',leaseState:'leased',leaseToken:'lease-a',leaseExpiresAt,leaseRenewedAt,stateVersion:7,mode:'planning',synthesizedFrom:'workday_demand',
			capacityEnvelope:{ budget:{ deadline:new Date(Date.now()+3_600_000).toISOString() } } });
		const raw=()=>({id:'assignment-a',membership_id:'membership-a',team_id:'team-a',project_id:'project-a',capacity_provider_id:'provider-a',
			reservation_id:'reservation-a',work_day_id:'workday-a',provider_session_id:'session-a',status:'leased',lease_state:'leased',
			lease_token:'lease-a',lease_expires_at:leaseExpiresAt,synthesized_from:'workday_demand'});
		const store={ensureInitialized:vi.fn(async()=>undefined),getProviderAssignment:vi.fn(async()=>assignment()),recordProviderAssignmentExplanation:vi.fn(),
			first:vi.fn(async(query:string)=>query.includes('FROM capacity_provider_assignments')?raw()
				:query.includes('capacity_provider_team_memberships')?{membership_status:'approved',provider_status:'active'}
				:query.includes('FROM capacity_reservations')?{state:'reserved',grant_status:'active',allocation_status:'active'}
				:query.includes('FROM workday_capacity_envelopes')?{status:'active'}
				:query.includes('FROM treedx_proxy_handles')?{status:'issued'}
				:query.includes('FROM capacity_provider_availability_sessions')?{id:'session-a',status:'open',expires_at:new Date(Date.now()+3_600_000).toISOString()}:null),
			run:vi.fn(async(_query:string,params:unknown[])=>{leaseExpiresAt=String(params[0]);leaseRenewedAt=String(params[1]);})};
		const result=await new ProviderAssignmentLifecycleService(store as never).renew(
			{membershipId:'membership-a',teamId:'team-a',capacityProviderId:'provider-a'},'assignment-a',
			{leaseToken:'lease-a',runnerId:'runner-a',leaseSeconds:300},
		);
		expect(result).toMatchObject({assignment:{stateVersion:7,leaseRenewedAt},leaseToken:'lease-a'});
		expect(store.run.mock.calls[0]?.[0]).not.toContain('state_version = state_version + 1');
	});

	it('fails a repeatedly returned assignment when its durable attempt limit is reached', async () => {
		let transitioned = false;
		const batch = vi.fn(async (_operations: CapacityDatabaseOperation[]) => { transitioned = true; });
		const store = {
			ensureInitialized: vi.fn(async () => undefined),
			getProviderAssignment: vi.fn(async () => ({
				id: 'assignment-a',
				membershipId: 'membership-a',
				teamId: 'team-a',
				projectId: 'project-a',
				capacityProviderId: 'provider-a',
				status: transitioned ? 'failed' : 'leased',
				leaseState: transitioned ? 'released' : 'leased',
				leaseToken: transitioned ? null : 'lease-a',
				attemptCount: transitioned ? 3 : 2,
				stateVersion: transitioned ? 2 : 1,
				mode: 'planning',
				metadata: { retryPolicy: { maxAttempts: 3 } },
				lifecycleCode: transitioned ? 'provider_assignment_retry_exhausted' : null,
			})),
			batch,
		};

		const result = await new ProviderAssignmentLifecycleService(store as never).return(
			{ membershipId: 'membership-a', teamId: 'team-a', capacityProviderId: 'provider-a' },
			'assignment-a',
			{ leaseToken: 'lease-a', code: 'transient_failure', reason: 'Temporary failure.', retryable: true },
		);

		expect(result).toMatchObject({ assignment: { status: 'failed', lifecycleCode: 'provider_assignment_retry_exhausted' } });
		expect(batch).toHaveBeenCalledOnce();
		expect(batch.mock.calls[0]?.[0]?.[0]?.params).toContain('provider_assignment_retry_exhausted');
	});

	it('does not release a lease when required fallback evidence cannot be persisted', async () => {
		const persistenceFailure = Object.assign(new Error('fallback storage unavailable'), { code: 'agent_fallback_not_persisted' });
		const run = vi.fn(async () => undefined);
		const store = {
			ensureInitialized: vi.fn(async () => undefined),
			getProviderAssignment: vi.fn(async () => ({
				id: 'assignment-a', membershipId: 'membership-a', teamId: 'team-a', projectId: 'project-a',
				capacityProviderId: 'provider-a', status: 'leased', leaseState: 'leased', leaseToken: 'lease-a',
				attemptCount: 0, stateVersion: 1, metadata: {}, mode: 'planning',
			})),
			recordAgentFallbackOutput: vi.fn(async () => { throw persistenceFailure; }),
			run,
		};

		await expect(new ProviderAssignmentLifecycleService(store as never).return(
			{ membershipId: 'membership-a', teamId: 'team-a', capacityProviderId: 'provider-a' },
			'assignment-a',
			{ leaseToken: 'lease-a', fallbackOutput: { id: 'fallback-a', code: 'input_missing' } },
		)).rejects.toBe(persistenceFailure);
		expect(run).not.toHaveBeenCalled();
	});

	it('attaches exact runner receipts when a required-response suspension already released the lease', async () => {
		let stateVersion = 4;
		let lifecycleOutput: Record<string, unknown> = {};
		const assignment = () => ({
			id: 'assignment-suspended', membershipId: 'membership-a', teamId: 'team-a', projectId: 'project-a',
			capacityProviderId: 'provider-a', status: 'returned', leaseState: 'released', leaseToken: null,
			attemptCount: 0, stateVersion, metadata: { operationalState: 'suspended' }, mode: 'planning',
			lifecycleCode: 'discussion_response_required', invocationId: 'invocation-a', lifecycleOutput,
		});
		const run = vi.fn(async (_query: string, params: unknown[] = []) => {
			lifecycleOutput = JSON.parse(String(params[0])) as Record<string, unknown>;
			stateVersion += 1;
		});
		const store = {
			ensureInitialized: vi.fn(async () => undefined),
			getProviderAssignment: vi.fn(async () => assignment()),
			first: vi.fn(async () => ({ final_message_ref: 'src/content/discussion-messages/final.mdx' })),
			batch: vi.fn(async () => undefined),
			run,
		};
		const result = await new ProviderAssignmentLifecycleService(store as never).return(
			{ membershipId: 'membership-a', teamId: 'team-a', capacityProviderId: 'provider-a' },
			'assignment-suspended',
			{ output: { summary: 'Suspended after durable response.' }, artifactManifest: { id: 'manifest-a', mutationReceipts: [{ id: 'receipt-a' }] } } as never,
		);

		expect(result).toMatchObject({ assignment: { status: 'returned', stateVersion: 5 } });
		expect(lifecycleOutput).toMatchObject({ summary: 'Suspended after durable response.', artifactManifest: { id: 'manifest-a' } });
		expect(run).toHaveBeenCalledOnce();
		expect(store.batch).toHaveBeenCalledOnce();
	});

	it('rejects terminal mutations from an expired lease without mutation', async () => {
		const run = vi.fn(async () => undefined);
		const store = {
			ensureInitialized: vi.fn(async () => undefined),
			getProviderAssignment: vi.fn(async () => ({
				id: 'assignment-a', membershipId: 'membership-a', teamId: 'team-a', projectId: 'project-a',
				capacityProviderId: 'provider-a', status: 'leased', leaseState: 'leased', leaseToken: 'lease-a',
				leaseExpiresAt: '2020-01-01T00:00:00.000Z', attemptCount: 0, stateVersion: 1,
				metadata: {}, mode: 'planning',
			})),
			run,
		};
		const lifecycle = new ProviderAssignmentLifecycleService(store as never);
		for (const operation of ['return', 'complete', 'fail'] as const) {
			await expect(lifecycle[operation](
				{ membershipId: 'membership-a', teamId: 'team-a', capacityProviderId: 'provider-a' },
				'assignment-a',
				{ leaseToken: 'lease-a' },
			)).resolves.toBeNull();
		}
		expect(run).not.toHaveBeenCalled();
	});

	it('records ordinary completion as completed when the provider omits an explicit disposition', async () => {
		let transitioned = false;
		let lifecycleOutput: Record<string, unknown> = {};
		const assignment = () => ({
			id: 'assignment-complete', membershipId: 'membership-a', teamId: 'team-a', projectId: 'project-a',
			capacityProviderId: 'provider-a', projectAgentClassId: 'agent-class-a', agentId: 'agent-a',
			status: transitioned ? 'completed' : 'leased', leaseState: transitioned ? 'released' : 'leased',
			leaseToken: transitioned ? null : 'lease-a', attemptCount: transitioned ? 1 : 0,
			stateVersion: transitioned ? 2 : 1, metadata: {}, mode: 'planning', allowedOutputs: {},
			lifecycleOutput,
		});
		const store = {
			ensureInitialized: vi.fn(async () => undefined),
			getProviderAssignment: vi.fn(async () => assignment()),
			all: vi.fn(async () => []),
			first: vi.fn(async () => null),
			run: vi.fn(async () => undefined),
			batch: vi.fn(async (operations: CapacityDatabaseOperation[]) => {
				lifecycleOutput = JSON.parse(String(operations[0]?.params?.[5] ?? '{}')) as Record<string, unknown>;
				transitioned = true;
			}),
		};

		const result = await new ProviderAssignmentLifecycleService(store as never).complete(
			{ membershipId: 'membership-a', teamId: 'team-a', capacityProviderId: 'provider-a' },
			'assignment-complete',
			{ leaseToken: 'lease-a', output: { summary: 'Exact outcome complete.' } },
		);

		expect(result?.assignment.status).toBe('completed');
		expect(lifecycleOutput).toMatchObject({ completion: { disposition: 'completed' } });
	});

	it('releases a completed communication assignment without reporting invocation success before integration', async () => {
		let transitioned=false;
		const assignment=()=>({ id:'assignment-chat-complete',membershipId:'membership-a',teamId:'team-a',projectId:'project-a',
			capacityProviderId:'provider-a',projectAgentClassId:'agent-class-a',agentId:'agent-a',status:transitioned?'completed':'leased',
			leaseState:transitioned?'released':'leased',leaseToken:transitioned?null:'lease-a',attemptCount:0,stateVersion:transitioned?2:1,
			metadata:{},mode:'planning',executionKind:'conversation',invocationId:'invocation-a',allowedOutputs:{},lifecycleOutput:{}});
		const run=vi.fn(async()=>undefined);
		const store={ensureInitialized:vi.fn(async()=>undefined),getProviderAssignment:vi.fn(async()=>assignment()),all:vi.fn(async()=>[]),
			first:vi.fn(async(query:string)=>query.includes('agent_invocation_requests')
				? {status:'running',assignment_id:'assignment-chat-complete',final_message_ref:'src/content/discussion-messages/final.mdx'}:null),run,
			batch:vi.fn(async()=>{transitioned=true;})};
		const result=await new ProviderAssignmentLifecycleService(store as never).complete(
			{membershipId:'membership-a',teamId:'team-a',capacityProviderId:'provider-a'},'assignment-chat-complete',{leaseToken:'lease-a'});
		expect(result?.assignment.status).toBe('completed');
		expect(run).toHaveBeenCalledWith(expect.stringContaining("status='running'"),expect.arrayContaining(['assignment-chat-complete',expect.stringContaining('content_integration_pending'),'invocation-a','team-a']));
		expect(run).not.toHaveBeenCalledWith(expect.stringContaining("status='completed'"),expect.anything());
	});

	it('terminalizes the exact communication invocation when its assignment fails', async () => {
		let transitioned = false;
		const assignment = () => ({
			id: 'assignment-chat', membershipId: 'membership-a', teamId: 'team-a', projectId: 'project-a',
			capacityProviderId: 'provider-a', status: transitioned ? 'failed' : 'leased',
			leaseState: transitioned ? 'released' : 'leased', leaseToken: transitioned ? null : 'lease-a',
			attemptCount: transitioned ? 1 : 0, stateVersion: transitioned ? 2 : 1, metadata: {}, mode: 'planning',
			executionKind: 'conversation', invocationId: 'invocation-a', allowedOutputs: {},
		});
		const store = {
			ensureInitialized: vi.fn(async () => undefined), getProviderAssignment: vi.fn(async () => assignment()),
			first: vi.fn(async () => null), run: vi.fn(async () => undefined),
			batch: vi.fn(async (operations: CapacityDatabaseOperation[]) => {
				expect(operations).toEqual(expect.arrayContaining([expect.objectContaining({
					query: expect.stringContaining('UPDATE agent_invocation_requests SET status=?'),
					params: expect.arrayContaining(['failed','assignment-chat', 'invocation-a', 'team-a']),
				})]));
				transitioned = true;
			}),
		};

		const result = await new ProviderAssignmentLifecycleService(store as never).fail(
			{ membershipId: 'membership-a', teamId: 'team-a', capacityProviderId: 'provider-a' },
			'assignment-chat', { leaseToken: 'lease-a', code: 'response_invalid', reason: 'No durable final response.' },
		);

		expect(result?.assignment.status).toBe('failed');
	});

	it('terminalizes an archived conversation as cancelled after its provider releases custody',async()=>{
		let transitioned=false;
		const assignment=()=>({
			id:'assignment-chat',membershipId:'membership-a',teamId:'team-a',projectId:'project-a',capacityProviderId:'provider-a',
			status:transitioned?'cancelled':'leased',leaseState:transitioned?'released':'leased',leaseToken:transitioned?null:'lease-a',
			attemptCount:transitioned?1:0,stateVersion:transitioned?2:1,mode:'planning',executionKind:'conversation',invocationId:'invocation-a',allowedOutputs:{},
			metadata:{cancellationRequested:true,cancellationReason:'discussion_archived',discussionId:'topic-a'},
		});
		const store={ensureInitialized:vi.fn(async()=>undefined),getProviderAssignment:vi.fn(async()=>assignment()),first:vi.fn(async()=>null),run:vi.fn(async()=>undefined),
			batch:vi.fn(async(operations:CapacityDatabaseOperation[])=>{
				expect(operations).toEqual(expect.arrayContaining([expect.objectContaining({
					query:expect.stringContaining('UPDATE agent_invocation_requests SET status=?'),
					params:expect.arrayContaining(['cancelled','assignment-chat','invocation-a','team-a']),
				})]));transitioned=true;
			}),
		};
		const result=await new ProviderAssignmentLifecycleService(store as never).fail(
			{membershipId:'membership-a',teamId:'team-a',capacityProviderId:'provider-a'},'assignment-chat',
			{leaseToken:'lease-a',code:'discussion_archived',reason:'The source Discussion was archived.',retryable:false},
		);
		expect(result?.assignment.status).toBe('cancelled');
	});
});

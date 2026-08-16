import { afterEach, describe, expect, it } from 'vitest';
import { admitDiscussionInvocations,reconcileBlockedDiscussionInvocations,resolveDiscussionInvocationAgents,terminalizeCompletedConversationInvocation } from '../../../../../src/api/capacity/services/capacity/invocations/discussion-invocation-service.ts';
import { createTestPostgresDatabase, createTestStore } from '../../../../support/api-harness.ts';

const databases: ReturnType<typeof createTestPostgresDatabase>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

async function harness(withSupply: boolean) {
	const database = createTestPostgresDatabase(); databases.push(database);
	const store = createTestStore(database); await store.ensureInitialized();
	const now = new Date().toISOString();
	await store.run(`INSERT INTO teams (id,slug,name,created_at,updated_at) VALUES ('team-a','team-a','Team A',?,?)`, [now, now]);
	await store.run(`INSERT INTO projects (id,team_id,slug,name,created_at,updated_at) VALUES ('project-a','team-a','project-a','Project A',?,?)`, [now, now]);
	await store.run(`INSERT INTO project_agent_classes (id,team_id,project_id,slug,name,status,handler_refs_json,metadata_json,created_at,updated_at) VALUES ('class-a','team-a','project-a','editorial','Editorial','active',?,?,?,?)`, [JSON.stringify({ agents: [{ slug: 'guide-steward', activities: { chat: { enabled: true } } }] }), JSON.stringify({ immutableRef: 'definition-a' }), now, now]);
	if (withSupply) {
		await store.run(`INSERT INTO capacity_providers (id,fingerprint,public_jwk_json,display_name,status,created_at,updated_at) VALUES ('provider-a','fingerprint-a','{}','Provider A','active',?,?)`, [now, now]);
		await store.run(`INSERT INTO capacity_provider_team_memberships (id,team_id,capacity_provider_id,status,approved_at,approved_by_id,created_at,updated_at) VALUES ('membership-a','team-a','provider-a','approved',?,'owner-a',?,?)`, [now, now, now]);
		await store.run(`INSERT INTO capacity_execution_providers (id,capacity_provider_id,display_name,adapter,status,capabilities_json,native_unit,max_concurrent_runners,created_at,updated_at) VALUES ('codex','provider-a','Codex','codex','active','["communication"]','seconds',2,?,?)`, [now, now]);
		for (const purpose of ['communication', 'operation']) await store.run(`INSERT INTO capacity_provider_lanes (id,capacity_provider_id,execution_provider_id,display_name,purpose,status,capabilities_json,max_concurrent_runners,created_at,updated_at) VALUES (?,?,?,?,?,'active','[]',1,?,?)`, [`codex-${purpose}`, 'provider-a', 'codex', purpose, purpose, now, now]);
		await store.run(`INSERT INTO capacity_provider_availability_sessions (id,membership_id,team_id,capacity_provider_id,status,sequence,opened_at,refreshed_at,expires_at,available_from,execution_providers_json,metadata_json,created_at,updated_at) VALUES ('session-a','membership-a','team-a','provider-a','open',1,?,?,?,?,?,?,?,?)`, [now, now, new Date(Date.now() + 60_000).toISOString(), now, JSON.stringify([{ id: 'codex', status: 'available', maxConcurrentRunners: 2, minimumAssignmentDuration: { amount: 600, unit: 'seconds' }, lanes: [{ id: 'codex-communication', purpose: 'communication', maxConcurrentRunners: 1 }, { id: 'codex-operation', purpose: 'operation', maxConcurrentRunners: 1 }] }]), JSON.stringify({ sourceClosureDigest: 'closure-a' }), now, now]);
	}
	const createdRuns: Record<string, unknown>[] = [];
	const tickedRuns: string[] = [];
	if (withSupply) Object.assign(store, {
		async createCapacityWorkdayRun(_teamId: string, input: Record<string, unknown>) {
			createdRuns.push(input);
			return { id: input.id };
		},
		async tickCapacityWorkdayRun(_teamId: string, runId: string) { tickedRuns.push(runId); return { id: runId }; },
		async updateCapacityWorkdayRun() { return null; },
	});
	return { store, createdRuns, tickedRuns };
}

function request(idempotencyKey: string, discussionId = 'topic-a') {
	return {
		teamId: 'team-a', projectId: 'project-a', projectSlug: 'project-a', discussionId,
		messageId: `message-${idempotencyKey}`, messagePath: `discussions/${discussionId}/messages/${idempotencyKey}.mdx`,
		messageCommit: `commit-${idempotencyKey}`, contextRefs: [], agentSlugs: ['guide-steward'],
		idempotencyKey, durationSeconds: 900, requestedById: 'user-a',
	};
}

describe('Discussion invocation admission', () => {
	it('derives the exact continuation recipient from a suspended parent assignment',async()=>{
		const first=async()=>({agent_id:'guide-steward',status:'returned',lease_state:'released',execution_kind:'conversation',lifecycle_code:'discussion_response_required',metadata_json:JSON.stringify({operationalState:'suspended',waitingDiscussionId:'topic-a'})});
		await expect(resolveDiscussionInvocationAgents({first},{teamId:'team-a',projectId:'project-a',discussionId:'topic-a',parentAssignmentId:'assignment-a',mentionedAgents:[]}))
			.resolves.toEqual(['guide-steward']);
	});

	it('rejects mention-free continuation against an unrelated parent',async()=>{
		const first=async()=>({agent_id:'guide-steward',status:'returned',lease_state:'released',execution_kind:'conversation',lifecycle_code:'discussion_response_required',metadata_json:JSON.stringify({operationalState:'suspended',waitingDiscussionId:'other-topic'})});
		await expect(resolveDiscussionInvocationAgents({first},{teamId:'team-a',projectId:'project-a',discussionId:'topic-a',parentAssignmentId:'assignment-a',mentionedAgents:[]}))
			.rejects.toMatchObject({code:'discussion_continuation_parent_invalid'});
	});

	it('durably blocks without communication-ready supply and coalesces later messages before admission', async () => {
		const { store } = await harness(false);
		const first = await admitDiscussionInvocations(store, request('first'));
		expect(first).toMatchObject([{ status: 'blocked', blocker: 'communication_supply_unavailable' }]);
		const second = await admitDiscussionInvocations(store, request('second'));
		expect(second).toMatchObject([{ status: 'coalesced', coalesced: true, coalescedIntoId: first[0].id }]);
		const rows = await store.all(`SELECT status,content_refs_json FROM agent_invocation_requests ORDER BY requested_at,id`);
		expect(rows.map((row) => row.status).sort()).toEqual(['blocked', 'coalesced']);
		expect(JSON.parse(String(rows.find((row) => row.status === 'blocked')?.content_refs_json))).toContain('discussions/topic-a/messages/second.mdx');
	});

	it('creates one hidden conversation execution and replays the exact request', async () => {
		const { store, createdRuns, tickedRuns } = await harness(true);
		const first = await admitDiscussionInvocations(store, request('ready'));
		expect(first).toMatchObject([{ status: 'admitted', executionId: expect.stringMatching(/^conversation-invocation-/u) }]);
		expect(createdRuns).toEqual([expect.objectContaining({ executionKind: 'conversation', triggerKind: 'discussion', hidden: true, requestedById: 'user-a' })]);
		expect(createdRuns[0].parameters).toEqual(expect.objectContaining({ providerSourceClosureDigest: 'closure-a' }));
		expect(tickedRuns).toEqual([first[0].executionId]);
		expect(await store.first(`SELECT blocking_state_json FROM agent_invocation_requests WHERE id=?`,[first[0].id])).toEqual({blocking_state_json:'{}'});
		const replay = await admitDiscussionInvocations(store, request('ready'));
		expect(replay).toMatchObject([{ status: 'admitted', executionId: first[0].executionId, replayed: true }]);
	});

	it('contains a parent assignment through its exact durable workday-run provenance', async () => {
		const { store, createdRuns, tickedRuns } = await harness(true);
		const storedFirst = store.first.bind(store);
		store.first = async (query: string, params?: unknown[]) => {
			if (query.includes('SELECT id, work_day_id, team_id')) return {
				id: 'assignment-parent', work_day_id: 'workday-run-a-project-a', team_id: 'team-a', project_id: 'project-a',
				status: 'leased', lease_state: 'leased', execution_kind: 'workday', lifecycle_code: null, metadata_json: '{}',
			};
			if (query.includes('SELECT workday_run_id FROM capacity_workday_demands')) return { workday_run_id: 'run-a' };
			if (query.includes('SELECT * FROM capacity_workday_runs WHERE id = ?')) return {
				id: 'run-a', execution_kind: 'workday',
				parameters_json: JSON.stringify({ atlasTopologyByProjectId: { 'project-a': { nodes: [{ kind: 'agent', slug: 'guide-steward' }] } } }),
			};
			return storedFirst(query, params);
		};
		const admitted = await admitDiscussionInvocations(store, {
			...request('contained'), parentWorkdayId: 'run-a', parentAssignmentId: 'assignment-parent',
		});
		expect(admitted).toMatchObject([{ status: 'admitted', executionId: 'run-a', parentAssignmentId: 'assignment-parent' }]);
		expect(createdRuns).toEqual([]);
		expect(tickedRuns).toEqual([]);
		expect(await store.first(`SELECT parent_workday_id,parent_assignment_id FROM agent_invocation_requests WHERE id=?`, [admitted[0].id]))
			.toMatchObject({ parent_workday_id: 'run-a', parent_assignment_id: 'assignment-parent' });
	});

	it('admits concurrent duplicate ingress into one execution', async () => {
		const { store, createdRuns, tickedRuns } = await harness(true);
		const [first, second] = await Promise.all([
			admitDiscussionInvocations(store, request('concurrent')),
			admitDiscussionInvocations(store, request('concurrent')),
		]);
		expect(new Set([first[0].executionId, second[0].executionId]).size).toBe(1);
		expect(createdRuns).toHaveLength(1);
		expect(tickedRuns).toHaveLength(1);
	});

	it('retries a durable blocked invocation after its admission dependency recovers', async () => {
		const { store, createdRuns } = await harness(true);
		Object.assign(store, { async createCapacityWorkdayRun() { throw new Error('control plane unavailable'); } });
		const blocked = await admitDiscussionInvocations(store, request('recover'));
		expect(blocked).toMatchObject([{ status: 'blocked', blocker: 'control plane unavailable' }]);
		Object.assign(store, { async createCapacityWorkdayRun(_teamId: string, input: Record<string, unknown>) {
			createdRuns.push(input); return { id: input.id };
		} });
		const recovered = await admitDiscussionInvocations(store, request('recover'));
		expect(recovered).toMatchObject([{ status: 'admitted', replayed: true, executionId: expect.stringMatching(/^conversation-invocation-/u) }]);
		expect(createdRuns).toHaveLength(1);
	});

	it('recovers an interrupted admission claim that never created its conversation execution', async () => {
		const { store,createdRuns,tickedRuns }=await harness(true);
		const admitted=await admitDiscussionInvocations(store,request('interrupted-claim'));
		const invocationId=admitted[0].id;const executionId=admitted[0].executionId;
		createdRuns.splice(0);tickedRuns.splice(0);
		await store.run(`UPDATE agent_invocation_requests SET status='admitted',assignment_id=NULL,execution_id=?,blocking_state_json=?,updated_at=? WHERE id=?`,[
			executionId,JSON.stringify({code:'communication_admission_claimed',claimToken:'interrupted'}),new Date(Date.now()-120_000).toISOString(),invocationId,
		]);
		await expect(reconcileBlockedDiscussionInvocations(store,'team-a')).resolves.toEqual({admitted:1,blocked:false});
		expect(createdRuns).toEqual([expect.objectContaining({id:executionId,executionKind:'conversation'})]);
		expect(tickedRuns).toEqual([executionId]);
		expect(await store.first(`SELECT status,execution_id,blocking_state_json FROM agent_invocation_requests WHERE id=?`,[invocationId]))
			.toMatchObject({status:'admitted',execution_id:executionId,blocking_state_json:'{}'});
	});

	it('rejects a changed request behind the same idempotency identity', async () => {
		const { store } = await harness(true);
		await admitDiscussionInvocations(store, request('conflict'));
		await expect(admitDiscussionInvocations(store, { ...request('conflict'), messageCommit: 'different-commit' }))
			.rejects.toMatchObject({ code: 'discussion_invocation_idempotency_conflict' });
	});

	it('terminalizes the assignment-backed retry rather than a stale invocation execution pointer', async () => {
		const updateCapacityWorkdayRun = async (_teamId:string,runId:string,input:Record<string,unknown>) => ({ id:runId,...input });
		const first = async (query:string) => {
			if (query.includes('agent_invocation_requests')) return { status:'completed',execution_id:'conversation-stale',assignment_id:'assignment-a',integration_ready:true };
			if (query.includes('capacity_workday_demands')) return { workday_run_id:'conversation-retry' };
			return { status:'running',execution_kind:'conversation' };
		};
		const invocationUpdates: unknown[][] = [];
		const run = async (_query:string,params?:unknown[]) => { invocationUpdates.push(params ?? []); return {}; };
		await expect(terminalizeCompletedConversationInvocation({ first,run,updateCapacityWorkdayRun },'team-a','invocation-a'))
			.resolves.toEqual({terminalized:true,executionId:'conversation-retry'});
		expect(invocationUpdates).toContainEqual(['conversation-retry',expect.any(String),'invocation-a','team-a']);
	});

	it('does not report conversation execution success before exact content integration', async () => {
		let updateCount=0;
		const updateCapacityWorkdayRun = async()=>{updateCount+=1;return null;};
		const first = async (query:string) => query.includes('agent_invocation_requests')
			? { status:'completed',execution_id:'conversation-a',assignment_id:'assignment-a',integration_ready:false }
			: null;
		await expect(terminalizeCompletedConversationInvocation({ first,run:async()=>({}),updateCapacityWorkdayRun },'team-a','invocation-a'))
			.resolves.toEqual({terminalized:false,reason:'content_integration_pending'});
		expect(updateCount).toBe(0);
	});
});

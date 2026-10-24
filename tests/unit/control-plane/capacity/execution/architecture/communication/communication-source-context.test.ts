import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { agentDefinitionSchema } from '@treeseed/sdk/agent-capacity';
import { workItemContext } from '../../../../../../../src/api/capacity/services/build/ready-execution-node.ts';
import { projectCommunicationInvocations } from '../../../../../../../src/api/capacity/policy/execution/communication-execution-projector.ts';
import { ControlPlaneStore } from '../../../../../../../src/api/persistence/store.ts';
import { readyProposal } from '../../../../governance/proposals/architecture/ready-proposal-fixture.ts';
import { postgresGraph } from '../../graph/architecture/living/living-postgres-fixture.ts';
import { reconcileCommunicationExecutionGraph } from '../../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-service.ts';
import { createCapacityControlPlane } from '../../../../../../../src/api/capacity/control-plane.ts';
import { createWorkdayService } from '../../../../../../../src/api/control-plane/repositories/capacity/workday-service.ts';

const gateway = vi.hoisted(() => ({ readRepositoryFile: vi.fn() }));
vi.mock('../../../../../../../src/api/knowledge/gateway-treedx-connection.ts', () => ({
	resolveKnowledgeGatewayConnection: vi.fn(async () => ({ repositoryId: 'proposal-library', client: gateway })),
}));

const commit = 'a'.repeat(40);
const repository = { id: 'software', role: 'software', provider: 'github', owner: 'example', name: 'project', currentBranch: 'staging' };
function communicationProfile(tools = ['discussion', 'source.read']) {
	return agentDefinitionSchema.parse({ schemaVersion: 'treeseed.agent/v1', id: 'configured/renamed-guide',
		name: 'Renamed guide', agentClass: 'configured-guide', purpose: 'Answer bounded questions.',
		responsibilities: ['Use only authorized exact context.'], capabilities: ['reasoning'], context: { include: ['project'] },
		activityProfiles: { chat: { handler: 'writer', permissions: { content: { read: ['discussion'], write: ['discussion'] }, tools },
			prompt: { system: 'Answer the addressed message.' } } } });
}
function communication(tools = ['discussion', 'source.read']) {
	const profile = communicationProfile(tools);
	return projectCommunicationInvocations({ teamId: 'team', revision: 1, profiles: { 'project:configured-guide': profile },
		sources: [{ id: 'invocation', teamId: 'team', projectId: 'project', workdayId: 'conversation', agentId: 'renamed-guide',
			repository: 'library', commit: 'b'.repeat(40), path: 'discussion-messages/smoke/request.mdx', durationSeconds: 180 }] }).nodes[0]!;
}
const sourceRef = { store: 'git', model: 'repository', id: 'software', repository: 'example/project', commit };

describe('standalone communication exact source admission', () => {
	it('native PostgreSQL initial conversation tick projects the exact addressed Chat node without a workday plan and replays only its original event', async () => {
		const f = await postgresGraph(), now = new Date().toISOString();
		try {
			const host = new ControlPlaneStore({}, f.left); host.initializationPromise = Promise.resolve();
			const store = createCapacityControlPlane(host), parameters = { durationSeconds: 180, deadlineAt: new Date(Date.now() + 180_000).toISOString() };
			await f.left.pool.query("INSERT INTO projects (id,team_id,slug,name,created_at,updated_at) VALUES ('project','team','configured','Configured',$1,$1)", [now]);
			await f.left.pool.query("INSERT INTO capacity_providers (id,fingerprint,public_jwk_json,display_name,created_at,updated_at) VALUES ('provider','fingerprint','{}','Provider',$1,$1)", [now]);
			await f.left.pool.query("INSERT INTO capacity_provider_team_memberships (id,team_id,capacity_provider_id,approved_at,approved_by_id,created_at,updated_at) VALUES ('membership','team','provider',$1,'operator',$1,$1)", [now]);
			await f.left.pool.query(`INSERT INTO project_agent_classes (id,team_id,project_id,slug,name,handler_refs_json,created_at,updated_at)
				VALUES ('configured-guide','team','project','configured-guide','Configured guide',$1,$2,$2)`, [JSON.stringify({ agents: [communicationProfile()] }), now]);
			await f.left.pool.query(`INSERT INTO treedx_project_libraries (id,team_id,project_id,instance_id,library_id,repository_id,content_path,created_at,updated_at)
				VALUES ('binding','team','project','instance','library','library','',$1,$1)`, [now]);
			await f.left.pool.query(`INSERT INTO capacity_workday_runs (id,team_id,capacity_provider_id,status,execution_kind,execution_mode,trigger_kind,
				parameters_json,started_at,created_at,updated_at) VALUES ('conversation','team','provider','running','conversation','production','discussion',$1,$2,$2,$2)`, [JSON.stringify(parameters), now]);
			await f.left.pool.query(`INSERT INTO agent_invocation_requests (id,team_id,project_id,agent_id,status,execution_id,execution_kind,trigger_kind,mode,scope_hash,available_at,idempotency_key,request_digest,metadata_json,requested_at)
				VALUES ('invocation','team','project','renamed-guide','admitted','conversation','conversation','discussion','planning','scope',$1,'request','digest',$2,$1)`,
				[now, JSON.stringify({ sourceMessagePath: 'discussion-messages/smoke/request.mdx', sourceCommit: 'b'.repeat(40), productiveSeconds: 180 })]);
			const result = await store.tickCapacityWorkdayRun('team', 'conversation', now, 'initial-conversation');
			expect(result).toMatchObject({ lifecycle: { changed: false, plan: null, status: 'running' },
				executionGraph: { schemaVersion: 'treeseed.graph-revision/v1', revision: 1,
					changes: { added: ['communication:invocation:conversation'], changed: [], completed: [], blocked: [], stale: [], removedEdges: [], addedEdges: [] } } });
			const after = await f.snapshot(), events = (await f.left.pool.query('SELECT * FROM capacity_workday_events ORDER BY id')).rows;
			expect(after.nodes).toHaveLength(1);
			expect(after.nodes[0]).toMatchObject({ id: 'communication:invocation:conversation', team_id: 'team', project_id: 'project', workday_id: 'conversation', kind: 'communication', status: 'ready', agent_class: 'configured-guide' });
			expect(JSON.parse(String(after.nodes[0]!.source_ref_json))).toMatchObject({ store: 'treedx', model: 'discussion', id: 'invocation', repository: 'library', commit: 'b'.repeat(40), path: 'discussion-messages/smoke/request.mdx' });
			const run = await store.getCapacityWorkdayRun('team', 'conversation');
			expect(run?.parameters).toEqual(parameters); expect(run?.parameters).not.toHaveProperty('appliedPlan');
			expect(events.map(event => event.event_type).sort()).toEqual(['execution.node.state', 'workday.tick']);
			expect(JSON.parse(String(events.find(event => event.event_type === 'execution.node.state')!.context_json)))
				.toMatchObject({ nodeId: 'communication:invocation:conversation', status: 'ready', nodeRevision: 1 });
			expect(after.assignments).toEqual([]); expect(after.reservations).toEqual([]);
			expect(await store.tickCapacityWorkdayRun('team', 'conversation', new Date(Date.now() + 1_000).toISOString(), 'initial-conversation')).toEqual(result);
			expect(await f.snapshot()).toEqual(after); expect((await f.left.pool.query('SELECT * FROM capacity_workday_events ORDER BY id')).rows).toEqual(events);
			await f.left.pool.query("UPDATE capacity_provider_team_memberships SET status='suspended'");
			await expect(store.tickCapacityWorkdayRun('team', 'conversation', now, 'denied-conversation')).rejects.toMatchObject({ code: 'capacity_workday_membership_not_approved' });
			expect(await f.snapshot()).toEqual(after); expect((await f.left.pool.query('SELECT * FROM capacity_workday_events ORDER BY id')).rows).toEqual(events);
		} finally { await f.close(); }
	}, 30_000);
	it('reads an attached same-team proposal across topic project streams with contributor source context and the pinned version', async () => {
		const bytes = 'exact attached Admin proposal', digest = createHash('sha256').update(bytes).digest('hex');
		const proposal = readyProposal(), sharedGit = { store: 'git', model: 'repository', id: 'producer', repository: 'example/producer', commit: 'c'.repeat(40) };
		Object.assign(proposal, { id: 'shared', projectId: 'proposal-project', groupIds: ['portfolio-atlas'] });
		Object.assign(proposal.executionPlan.workItems[0]!, { contextRefs: [sharedGit] });
		gateway.readRepositoryFile.mockResolvedValue({ resolvedRef: 'b'.repeat(40), file: { content: bytes, frontmatter: proposal } });
		const frozen = { kind: 'proposal', id: 'shared', projectId: 'proposal-project', immutableRef: 'b'.repeat(40), path: 'proposals/shared.mdx', digest: `sha256:${digest}` };
		for (const [teamId, owner] of [['team', 'proposal-project'], ['foreign', 'proposal-project'], ['team', 'forged-project']]) {
			const node = communication(), held = structuredClone(node), ref = structuredClone(frozen);
			const store = { config: { fetchImpl: vi.fn(async () => new Response(commit)) }, all: async () => [],
				listHubRepositories: async () => [repository], getProjectTreeDxLibrary: async () => ({ repositoryId: 'proposal-library' }),
				getGovernanceProposal: async () => ({ id: 'shared', teamId, projectId: owner, activeVersion: 2,
					metadata: { contentProvenance: { repositoryId: 'proposal-library', commitSha: 'f'.repeat(40), contentPath: frozen.path, digest: 'f'.repeat(64) } } }),
				first: async (sql: string) => sql.includes('governance_proposal_versions') ? { version: 1 }
					: { content_refs_json: [frozen], requested_at: '2026-10-20T12:00:00.000Z' } };
			const read = workItemContext(store, node);
			if (teamId === 'team' && owner === frozen.projectId) expect(await read).toEqual([
				expect.objectContaining({ store: 'treedx', model: 'proposal', id: 'shared', repository: 'proposal-library', commit: frozen.immutableRef, revision: 1 }), sharedGit, sourceRef,
			]);
			else await expect(read).rejects.toMatchObject({ code: 'communication_proposal_context_stale' });
			expect(node).toEqual(held); expect(frozen).toEqual(ref);
		}
	});

	it('freezes configured source-read Git context before issuing an arbitrary configured chat assignment', async () => {
		const node = communication(), before = structuredClone(node);
		const fetchImpl = vi.fn(async () => new Response(commit));
		const store = { config: { fetchImpl }, first: vi.fn(async () => ({ content_refs_json: [] })),
			all: vi.fn(async () => []), listHubRepositories: vi.fn(async () => [repository]) };
		expect(await workItemContext(store, node)).toEqual([sourceRef]);
		expect(fetchImpl).toHaveBeenCalledExactlyOnceWith('https://api.github.com/repos/example/project/commits/staging',
			expect.objectContaining({ method: 'GET', redirect: 'error' }));
		expect(store.listHubRepositories).toHaveBeenCalledExactlyOnceWith('project');
		expect(node).toEqual(before);
		const ungranted = communication(['discussion']);
		expect(await workItemContext(store, ungranted)).toEqual([]);
		expect(fetchImpl).toHaveBeenCalledTimes(1); expect(store.listHubRepositories).toHaveBeenCalledTimes(1);
	});
	it('denies ambiguous source and rejected or malformed upstream revisions without repairing communication input', async () => {
		const node = communication(), held = structuredClone(node);
		for (const [status, body, code] of [[403, '', 'assignment_source_access_denied'], [503, '', 'assignment_source_unavailable'],
			[200, '', 'assignment_source_revision_invalid'], [200, 'staging', 'assignment_source_revision_invalid'],
			[200, 'a'.repeat(129), 'assignment_source_revision_invalid']] as const) {
			const fetchImpl = vi.fn(async () => new Response(body, { status }));
			const store = { config: { fetchImpl }, first: async () => ({ content_refs_json: [] }),
				all: async () => [], listHubRepositories: async () => [repository] };
			await expect(workItemContext(store, node)).rejects.toMatchObject({ code });
			expect(fetchImpl).toHaveBeenCalledTimes(1); expect(node).toEqual(held);
		}
		const fetchImpl = vi.fn(async () => new Response(commit));
		for (const repositories of [[], [repository, { ...repository, id: 'ambiguous' }]]) {
			await expect(workItemContext({ config: { fetchImpl }, first: async () => ({ content_refs_json: [] }),
				all: async () => [], listHubRepositories: async () => repositories }, node))
				.rejects.toMatchObject({ code: 'assignment_source_repository_required' });
		}
		expect(fetchImpl).not.toHaveBeenCalled(); expect(node).toEqual(held);
	});
	it('native PostgreSQL and HTTP freeze standalone chat source while denials and unchanged retry preserve all stored input bytes', async () => {
		const f = await postgresGraph(), calls: string[] = [];
		let status = 200, body = commit;
		const server = createServer((request, response) => { calls.push(`${request.method} ${request.url}`); response.writeHead(status); response.end(body); });
		try {
			await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
			const address = server.address(); if (!address || typeof address === 'string') throw new Error('Native HTTP address required');
			const fetchImpl: typeof fetch = (url, options) => {
				expect(String(url)).toBe('https://api.github.com/repos/example/project/commits/staging');
				expect(options?.headers).not.toHaveProperty('authorization');
				return fetch(`http://127.0.0.1:${address.port}/repos/example/project/commits/staging`, options);
			};
			const store = new ControlPlaneStore({ fetchImpl }, f.left); store.initializationPromise = Promise.resolve();
			const now = new Date().toISOString();
			await f.left.pool.query("INSERT INTO projects (id,team_id,slug,name,created_at,updated_at) VALUES ('project','team','configured','Configured',$1,$1)", [now]);
			await f.left.pool.query(`INSERT INTO hub_repositories (id,hub_id,team_id,role,provider,owner,name,current_branch,created_at,updated_at)
				VALUES ('software','project','team','software','github','example','project','staging',$1,$1)`, [now]);
			await f.left.pool.query(`INSERT INTO agent_invocation_requests (id,team_id,project_id,scope_hash,available_at,idempotency_key,request_digest,requested_at)
				VALUES ('invocation','team','project','scope',$1,'request','digest',$1)`, [now]);
			const snapshot = async () => ({ ...(await f.snapshot()),
				repositories: (await f.left.pool.query('SELECT * FROM hub_repositories ORDER BY id')).rows,
				invocations: (await f.left.pool.query('SELECT * FROM agent_invocation_requests ORDER BY id')).rows });
			const before = await snapshot(), node = communication(), held = structuredClone(node);
			const original = await workItemContext(store, node); expect(original).toEqual([sourceRef]);
			for (const rejected of [403, 503, 200]) {
				status = rejected; body = 'not-an-exact-commit';
				await expect(workItemContext(store, node)).rejects.toThrow();
				expect(await snapshot()).toEqual(before); expect(original).toEqual([sourceRef]); expect(node).toEqual(held);
			}
			status = 200; body = commit;
			expect(await workItemContext(store, node)).toEqual(original);
			body = 'c'.repeat(40);
			expect(await workItemContext(store, node)).toEqual([{ ...sourceRef, commit: body }]);
			expect(original).toEqual([sourceRef]); expect(await snapshot()).toEqual(before); expect(node).toEqual(held);
			expect(calls).toEqual(Array(6).fill('GET /repos/example/project/commits/staging'));
			await f.left.pool.query(`INSERT INTO project_agent_classes (id,team_id,project_id,slug,name,handler_refs_json,created_at,updated_at)
				VALUES ('retained-planning-class','team','project','retained-planning','Retained planning',$1,$2,$2)`,
				[JSON.stringify({ agents: [{ id: 'agent/retained-planner', schemaVersion: 'retired' }] }), now]);
			const classes = (await f.left.pool.query('SELECT * FROM project_agent_classes ORDER BY id')).rows;
			await expect(reconcileCommunicationExecutionGraph(store, 'team')).rejects.toMatchObject({
				code: 'agent_profile_invalid', message: expect.stringContaining('project/retained-planning-class'),
			});
			expect((await f.left.pool.query('SELECT * FROM project_agent_classes ORDER BY id')).rows).toEqual(classes);
			expect(await snapshot()).toEqual(before); expect(calls).toHaveLength(6);
			const parameters = { durationSeconds: 180, deadlineAt: new Date(Date.now() + 180_000).toISOString() };
			await f.left.pool.query(`INSERT INTO capacity_workday_runs (id,team_id,status,execution_kind,execution_mode,trigger_kind,
				parameters_json,started_at,created_at,updated_at) VALUES ('conversation','team','running','conversation','production','discussion',$1,$2,$2,$2)`,
				[JSON.stringify(parameters), now]);
			const stop = createWorkdayService(createCapacityControlPlane(store));
			const stopped = await stop.stop({ id: 'operator', roles: ['platform_admin'] }, 'team', 'conversation', { reason: 'invalid profile prevents admission' });
			expect(stopped).toMatchObject({ run: { status: 'cancelled', parameters }, lifecycle: { plan: null },
				terminalization: { assignmentCount: 0, unfinishedAssignmentCount: 0, settlementErrorCount: 0 },
				reconciliation: { status: 'deferred', code: 'agent_profile_invalid' } });
			expect(stopped.run.parameters).not.toHaveProperty('appliedPlan'); expect(stopped.run.reportRefs).toEqual({});
			await expect(stop.stop({ id: 'operator', roles: ['platform_admin'] }, 'team', 'conversation', {}))
				.rejects.toMatchObject({ code: 'workday_not_active' });
			expect(await snapshot()).toEqual(before); expect(calls).toHaveLength(6);
			expect((await f.left.pool.query('SELECT * FROM project_agent_classes ORDER BY id')).rows).toEqual(classes);
			// Native owning context/SQL/HTTP boundary with controlled upstream source;
			// not authenticated GitHub, issued provider execution, charge or physical closure.
		} finally {
			server.closeAllConnections();
			if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
			await f.close(); expect(server.listening).toBe(false);
		}
	}, 30_000);
});

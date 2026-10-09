import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { agentDefinitionSchema } from '@treeseed/sdk/agent-capacity';
import { workItemContext } from '../../../../../src/api/capacity/services/build/ready-execution-node.ts';
import { projectCommunicationInvocations } from '../../../../../src/api/capacity/policy/execution/communication-execution-projector.ts';
import { ControlPlaneStore } from '../../../../../src/api/persistence/store.ts';
import { postgresGraph } from './graph/architecture/living/living-postgres-fixture.ts';

const commit = 'a'.repeat(40);
const repository = { id: 'software', role: 'software', provider: 'github', owner: 'example', name: 'project', currentBranch: 'staging' };
function communication(tools = ['discussion', 'source.read']) {
	const profile = agentDefinitionSchema.parse({ schemaVersion: 'treeseed.agent/v1', id: 'configured/renamed-guide',
		name: 'Renamed guide', agentClass: 'configured-guide', purpose: 'Answer bounded questions.',
		responsibilities: ['Use only authorized exact context.'], capabilities: ['reasoning'], context: { include: ['project'] },
		activityProfiles: { chat: { handler: 'writer', permissions: { content: { read: ['discussion'], write: ['discussion'] }, tools },
			prompt: { system: 'Answer the addressed message.' } } } });
	return projectCommunicationInvocations({ teamId: 'team', revision: 1, profiles: { 'project:configured-guide': profile },
		sources: [{ id: 'invocation', teamId: 'team', projectId: 'project', workdayId: 'conversation', agentId: 'renamed-guide',
			repository: 'library', commit: 'b'.repeat(40), path: 'discussion-messages/smoke/request.mdx', durationSeconds: 180 }] }).nodes[0]!;
}
const sourceRef = { store: 'git', model: 'repository', id: 'software', repository: 'example/project', commit };

describe('standalone communication exact source admission', () => {
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
			// Native owning context/SQL/HTTP boundary with controlled upstream source;
			// not authenticated GitHub, issued provider execution, charge or physical closure.
		} finally {
			server.closeAllConnections();
			if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
			await f.close(); expect(server.listening).toBe(false);
		}
	}, 30_000);
});

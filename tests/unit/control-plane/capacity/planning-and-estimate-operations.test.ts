import { describe, expect, it, vi } from 'vitest';
import { createCommunicationOperations } from '../../../../src/api/control-plane/catalog/capacity/communications.ts';
import { createResearchOperations } from '../../../../src/api/control-plane/catalog/capacity/research.ts';
import { createCommunicationService } from '../../../../src/api/control-plane/repositories/capacity/communication-service.ts';

const principal = { id: 'user-a', roles: [], permissions: [] };

function store(overrides: Record<string, unknown> = {}) {
	return {
		async getProjectDetails() { return { project: { id: 'project-a', teamId: 'team-a' } }; },
		async listTeamProjects() { return [{ id: 'project-a', slug: 'sdk', status: 'active' }]; },
		async listProjectAgentClassesPage() { return { items: [{ handlerRefs: { agents: [{
			schemaVersion: 'treeseed.agent/v1', id: 'sdk/architect', name: 'SDK Architect', agentClass: 'architect', purpose: 'Review SDK architecture.',
			responsibilities: ['Review architecture.'], capabilities: ['architecture-analysis'], context: { include: ['project-objectives'] },
			activityProfiles: { chat: { handler: 'writer', permissions: { content: { read: ['knowledge', 'discussion'], write: ['discussion'] }, tools: ['discussion', 'source.read'] }, prompt: { system: 'Answer with evidence.' } } },
		}] } }] }; },
		async principalCanAccessTeam() { return true; },
		async getTeamAccessSummary() { return { permissions: ['projects:read:team', 'projects:manage:team'] }; },
		...overrides,
	};
}

describe('communication catalog operations', () => {
	it('retains research independently from the retired assignment-graph catalog', () => {
		const service = new Proxy({}, { get: () => vi.fn() });
		expect(createResearchOperations({ agentGovernance: service as never })
			.map((operation) => operation.binding.descriptor.operationId)).toEqual([
				'research.workflows.create', 'research.workflows.list',
				'research.workflows.show', 'research.workflows.stages.complete',
			]);
	});

	it('binds exactly the retained communication operation classes', () => {
		const service = new Proxy({}, { get: () => vi.fn() });
		expect(createCommunicationOperations({ communications: service as never })
			.map((operation) => operation.binding.descriptor.operationId)).toEqual([
				'communications.send', 'communications.sends.show',
				'communications.topics.list', 'communications.topics.show', 'communications.topics.timeline',
				'communications.topics.subscriptions.put', 'communications.topics.subscriptions.delete',
				'communications.invocations.list', 'communications.invocations.show', 'communications.status.show',
				'communications.handoffs.list', 'communications.client.actions.list', 'communications.invocations.cancel',
			]);
	});

	it('rejects a stale invocation revision before communication mutation', async () => {
		const update = vi.fn();
		const service = createCommunicationService({
			async principalCanAccessTeam() { return true; },
			async getTeamAccessSummary() { return { permissions: ['projects:manage:team'] }; },
			async first() { return { id: 'invocation-a', team_id: 'team-a', status: 'queued', updated_at: 'revision-2' }; },
			run: update,
		});
		await expect(service.cancel(principal, 'team-a', 'invocation-a', {}, 'request-a', 'revision-1'))
			.rejects.toMatchObject({ code: 'agent_invocation_precondition_failed', status: 412 });
		expect(update).not.toHaveBeenCalled();
	});

	it('collapses duplicate addresses and keeps an accepted send durable while capacity reconciles', async () => {
		const create = vi.fn(async () => ({ invocations: [{ blocker: 'communication_supply_unavailable' }] }));
		const writes: Array<{ query: string; parameters: unknown[] }> = [];
		const service = createCommunicationService(store({
			async getProjectDetails() { return { project: { id: 'project-a', slug: 'sdk', teamId: 'team-a' } }; },
			async first(query: string) {
				if (query.includes('communication_discussion_topics')) return { id: 'topic-a', slug: 'agent-chat', status: 'active' };
				if (query.includes('communication_discussion_streams')) return { id: 'stream-a', discussion_id: 'agent-chat' };
				return null;
			},
			async run(query: string, parameters: unknown[]) { writes.push({ query, parameters }); return { meta: { changes: 1 } }; },
			async all() { return []; },
		}), { create });
		await expect(service.send(principal, 'team-a', 'Agent Chat', {
			message: '@sdk/architect\nPlease coordinate with @architect.',
		}, 'request-a')).rejects.toMatchObject({ code: 'communication_send_not_found', status: 404 });
		expect(create).toHaveBeenCalledWith(principal, expect.objectContaining({
			discussionId: 'agent-chat', recipients: ['architect'], addressRequirements: { architect: 'required' },
		}), 'request-a:project-a');
		expect(writes.find(({ query }) => query.includes('communication_discussion_streams'))?.parameters).toContain('agent-chat');
	});

	it('expands a bare handle into one project stream per matching team agent', async () => {
		const create = vi.fn(async () => ({ invocations: [{ blocker: 'communication_supply_unavailable' }] }));
		const service = createCommunicationService(store({
			async listTeamProjects() { return [{ id: 'project-api', slug: 'api', status: 'active' }, { id: 'project-sdk', slug: 'sdk', status: 'active' }]; },
			async first(query: string, parameters: string[]) {
				if (query.includes('communication_discussion_topics')) return { id: 'topic-a', slug: 'agent-chat', status: 'active' };
				if (query.includes('communication_discussion_streams')) return { id: `stream-${parameters[1]}`, discussion_id: `discussion-${parameters[1]}` };
				return null;
			},
			async run() { return { meta: { changes: 1 } }; },
			async all() { return []; },
		}), { create });
		await expect(service.send(principal, 'team-a', 'Agent Chat', { message: '@architect Please coordinate.' }, 'request-a'))
			.rejects.toMatchObject({ code: 'communication_send_not_found', status: 404 });
		expect(create).toHaveBeenCalledTimes(2);
		expect(create.mock.calls.map((call) => call[1].projectId).sort()).toEqual(['project-api', 'project-sdk']);
	});

	it('reads communication send identities from the text-backed JSON column with PostgreSQL JSONB semantics', async () => {
		const queries: string[] = [];
		const service = createCommunicationService(store({
			async all(query: string) { queries.push(query); return []; },
		}));

		await expect(service.sendStatus(principal, 'team-a', 'send-a'))
			.rejects.toMatchObject({ code: 'communication_send_not_found', status: 404 });
		expect(queries).toEqual(expect.arrayContaining([
			expect.stringContaining("execution_kind='conversation' AND status IN ('admitted','running')"),
			expect.stringContaining("metadata_json::jsonb->'communication'->>'sendId'"),
		]));
	});
});

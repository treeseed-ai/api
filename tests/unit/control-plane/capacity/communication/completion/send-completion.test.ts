import { describe, expect, it, vi } from 'vitest';
import { createCommunicationService } from '../../../../../../src/api/control-plane/repositories/capacity/communication-service.ts';

vi.mock('../../../../../../src/api/discussions/content.ts', () => ({
	loadDiscussions: vi.fn(async () => ({ messages: [{ path: 'discussion-messages/topic/reply.mdx', body: 'Published reply.' }] })),
}));
vi.mock('../../../../../../src/api/capacity/services/capacity/invocations/discussion-invocation-service.ts', () => ({
	reconcileBlockedDiscussionInvocations: vi.fn(async () => {}),
}));

async function receipt(statuses: string[], outcome = 'responded') {
	const invocations = statuses.map((status, index) => ({ id: `invocation-${index}`, status, project_id: 'project',
		final_message_ref: 'discussion-messages/topic/reply.mdx', response_json: { outcome },
		metadata_json: { discussionId: 'topic', communication: { topicId: 'topic', streamId: 'stream' } } }));
	const service = createCommunicationService({
		async principalCanAccessTeam() { return true; },
		async getTeamAccessSummary() { return { permissions: ['projects:read:team'] }; },
		async getProjectDetails() { return { project: { slug: 'sdk' } }; },
		async run() { return { meta: { changes: 0 } }; },
		async all(query: string) { return query.includes('SELECT * FROM agent_invocation_requests') ? invocations : []; },
		async first(query: string) {
			if (query.includes('communication_discussion_topics')) return { id: 'topic', slug: 'topic' };
			if (query.includes('communication_discussion_streams')) return { id: 'stream', project_id: 'project' };
			return null;
		},
	});
	return service.sendStatus({ id: 'user', roles: [], permissions: [] }, 'team', 'send');
}

describe('send waits for canonical completion', () => {
	it('does not treat published content as completion while the assignment runs', async () => {
		const value = await receipt(['running']);
		expect(value.responses).toHaveLength(1);
		expect(value.status).toBe('running');
		expect(value.targets[0]?.status).toBe('running');
	});
	it.each(['failed', 'cancelled'])('reports %s even when a reply was already published', async status => {
		const value = await receipt([status]);
		expect(value.status).toBe('failed');
		expect(value.targets[0]?.status).toBe(status);
	});
	it('reports partial rather than complete for a mixed terminal result', async () => {
		expect((await receipt(['completed', 'failed'])).status).toBe('partial');
	});
	it('accepts responses and abstention only after canonical completion', async () => {
		expect((await receipt(['completed'])).status).toBe('complete');
		expect((await receipt(['completed'], 'abstained')).targets[0]?.status).toBe('abstained');
		expect((await receipt(['running'], 'abstained')).targets[0]?.status).toBe('running');
	});
});

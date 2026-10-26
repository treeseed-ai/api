import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ load: vi.fn(), commit: vi.fn(), admit: vi.fn() }));
vi.mock('../../../../src/api/discussions/content.ts', async original => ({
	...await original<typeof import('../../../../src/api/discussions/content.ts')>(),
	loadDiscussions: mocks.load, commitDiscussionMessage: mocks.commit,
}));
vi.mock('../../../../src/api/capacity/services/capacity/invocations/discussion-invocation-service.ts', async original => ({
	...await original<typeof import('../../../../src/api/capacity/services/capacity/invocations/discussion-invocation-service.ts')>(),
	admitDiscussionInvocations: mocks.admit,
}));
import { createDiscussionService } from '../../../../src/api/discussions/discussion-service.ts';
import { discussionMessageId } from '../../../../src/api/discussions/content.ts';

const profile = (name: string) => ({ schemaVersion: 'treeseed.agent/v1', id: `api/${name}`, name, agentClass: `allocation-${name}`,
	groupIds: ['delivery'], purpose: 'Repair the shared context workflow.', responsibilities: ['Contribute through the group.'],
	capabilities: ['discussion'], context: { include: ['assignment-subject'] }, activityProfiles: { chat: {
		handler: 'writer', permissions: { content: { read: ['discussion'], write: ['discussion'] }, tools: ['discussion'] },
		prompt: { system: 'Discuss the authorized context repair.' },
	} } });
const principal = { id: 'operator', roles: ['admin'] };
const message = '@delivery @api/engineer Reconcile the actual context repair.';

function fixture() {
	const store = {
		getProjectDetails: async () => ({ project: { id: 'project', slug: 'api', teamId: 'team' } }),
		listTeamProjects: async () => [{ id: 'project', slug: 'api' }],
		listProjectAgentClassesPage: vi.fn(async () => ({ items: [{ handlerRefs: { agents: [profile('engineer'), profile('tester')] } }],
			page: { hasMore: false, nextCursor: null } })),
		first: vi.fn(async () => null), all: async () => [],
	};
	return { store, service: createDiscussionService({ store, capacity: store, sessionEvents: { publish: async () => undefined } }) };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.load.mockImplementation(async input => ({ messages: input.exactPaths ? [{ path: input.exactPaths[0], body: message }] : [], discussions: [] }));
	mocks.commit.mockImplementation(async input => ({ discussion: { id: 'topic' }, message: { id: 'message', path: 'discussion-messages/topic/message.mdx' },
		mentions: ['delivery', 'engineer'], commitSha: 'a'.repeat(40) }));
	mocks.admit.mockResolvedValue([]);
});

describe('group audience at Discussion admission', () => {
	it.each([undefined, ['engineer'], ['engineer', 'tester']])('expands group mentions and overlapping concrete recipients %j without pruning subscribers', async recipients => {
		const f = fixture();
		await f.service.create(principal, { teamId: 'team', projectId: 'project', discussionId: 'topic', body: message, recipients }, 'group-work');
		expect(mocks.commit).toHaveBeenCalledWith(expect.objectContaining({ recipients: ['engineer', 'tester'] }));
		expect(mocks.admit).toHaveBeenCalledWith(f.store, expect.objectContaining({ agentSlugs: ['engineer', 'tester'] }));
	});
	it('replays the committed concrete audience without re-expanding a group into a changed roster', async () => {
		const f = fixture();
		mocks.load.mockResolvedValue({ messages: [{ id: discussionMessageId('topic', 'group-work'), path: 'discussion-messages/topic/message.mdx', body: message,
			frontmatter: { recipientIds: ['engineer', 'tester'], mentionedAgents: ['delivery', 'engineer', 'tester'], contextRefs: [] } }] });
		await f.service.create(principal, { teamId: 'team', projectId: 'project', discussionId: 'topic', body: message }, 'group-work');
		expect(mocks.commit).not.toHaveBeenCalled(); expect(f.store.listProjectAgentClassesPage).not.toHaveBeenCalled();
		expect(mocks.admit).toHaveBeenCalledWith(f.store, expect.objectContaining({ agentSlugs: ['engineer', 'tester'] }));
	});
	it('rejects an unknown addressed group before authoring or admission', async () => {
		const f = fixture();
		await expect(f.service.create(principal, { teamId: 'team', projectId: 'project', body: '@missing-group Repair the real context path.' }, 'missing'))
			.rejects.toMatchObject({ code: 'communication_agent_not_found', status: 404 });
		expect(mocks.commit).not.toHaveBeenCalled(); expect(mocks.admit).not.toHaveBeenCalled();
	});
});

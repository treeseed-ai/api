import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validateDiscussionContextRefs } from '../../../../../../src/api/discussions/content.ts';
import { createCommunicationService } from '../../../../../../src/api/control-plane/repositories/capacity/communication-service.ts';

const mocks = vi.hoisted(() => ({ history: vi.fn(), exact: vi.fn(), targets: vi.fn() }));
vi.mock('../../../../../../src/api/discussions/content.ts', async original => ({
	...await original<typeof import('../../../../../../src/api/discussions/content.ts')>(), loadDiscussions: mocks.history,
}));
vi.mock('../../../../../../src/api/governance/executable-proposal.ts', () => ({ readExactProposal: mocks.exact }));
vi.mock('../../../../../../src/api/capacity/services/capacity/invocations/communication-target-resolution.ts', () => ({ resolveTeamCommunicationTargets: mocks.targets }));

const originalRef = { kind: 'proposal', id: 'proposal', projectId: 'project', immutableRef: 'a'.repeat(40), path: 'proposals/repair.mdx', digest: `sha256:${'b'.repeat(64)}` };
const message = '@api/researcher Trace the real MCP retry boundary.';
const principal = { id: 'user', roles: ['admin'], permissions: [] };
const key = 'recover-real-project-work';
const messageId = createHash('sha256').update(`mcp-coordination:${key}:project`).digest('hex').slice(0,32);
const source = { id: messageId, path: `discussion-messages/mcp-coordination/${messageId}.mdx`, body: message,
	frontmatter: { contextRefs: [originalRef], recipientIds: ['researcher'], parentWorkdayId: undefined } };

function fixture() {
	const created = vi.fn(async () => ({ message: source, replayed: true }));
	const store = {
		principalCanAccessTeam: async () => true,
		getTeamAccessSummary: async () => ({ permissions: ['projects:manage:team'] }),
		getProjectDetails: async () => ({ project: { id: 'project', slug: 'api', teamId: 'team' } }),
		getGovernanceProposal: vi.fn(async (): Promise<Record<string, unknown> | null> => ({ id: 'proposal', teamId: 'team', projectId: 'project', status: 'open' })),
		run: vi.fn(async () => ({ meta: { changes: 0 } })),
		first: async (sql: string) => sql.includes('communication_discussion_topics') ? { id: 'topic', slug: 'mcp-coordination', status: 'active' }
			: sql.includes('communication_discussion_streams') ? { id: 'stream', project_id: 'project', discussion_id: 'mcp-coordination' } : null,
		all: async (sql: string) => sql.includes('SELECT * FROM agent_invocation_requests') ? [{ id: 'invocation', status: 'blocked', project_id: 'project', agent_id: 'researcher',
			content_refs_json: [source.path, originalRef], metadata_json: { discussionId: 'mcp-coordination', sourceMessageId: messageId, communication: { topicId: 'topic', streamId: 'stream' } } }] : [],
	};
	return { store, created, service: createCommunicationService(store, { create: created }) };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.history.mockResolvedValue({ messages: [source] });
	mocks.exact.mockResolvedValue({ ref: { commit: 'c'.repeat(40), path: originalRef.path, digest: `sha256:${'d'.repeat(64)}` } });
	mocks.targets.mockResolvedValue([{ projectId: 'project', projectSlug: 'api', agentSlug: 'researcher', requirement: 'required' }]);
});

describe('communication recovery after a proposal edit', () => {
	it.each(['project', 'producer-project'])('reuses committed %s context instead of resolving the moved proposal', async owner => {
		const f = fixture(), heldRef = { ...originalRef, projectId: owner };
		mocks.history.mockResolvedValue({ messages: [{ ...source, frontmatter: { ...source.frontmatter, contextRefs: [heldRef] } }] });
		const result = await f.service.send(principal, 'team', 'mcp-coordination', { message, proposalId: 'proposal' }, key);
		expect(result.replayed).toBe(true);
		expect(f.created).toHaveBeenCalledWith(principal, expect.objectContaining({ contextRefs: [heldRef] }), `${key}:project`);
		expect(f.store.getGovernanceProposal).not.toHaveBeenCalled();
		expect(mocks.exact).not.toHaveBeenCalled();
		expect(mocks.history).toHaveBeenCalledWith(expect.objectContaining({ exactMessageIds: [messageId] }));
	});
	it.each([{ proposalId: 'other' }, { proposalId: undefined }, { message: `${message} Changed request.` }, { parentWorkdayId: 'other-workday' }])('rejects changed declared input %j before dispatch', async changed => {
		const f = fixture();
		await expect(f.service.send(principal, 'team', 'mcp-coordination', { message, proposalId: 'proposal', ...changed }, key))
			.rejects.toMatchObject({ status: 409, code: 'discussion_idempotency_conflict' });
		expect(f.created).not.toHaveBeenCalled();
	});
	it('resolves current proposal content for a new send', async () => {
		const f = fixture(); mocks.history.mockResolvedValueOnce({ messages: [] });
		await f.service.send(principal, 'team', 'mcp-coordination', { message, proposalId: 'proposal' }, key);
		expect(f.created).toHaveBeenCalledWith(principal, expect.objectContaining({ contextRefs: [{ ...originalRef, immutableRef: 'c'.repeat(40), digest: `sha256:${'d'.repeat(64)}` }] }), `${key}:project`);
	});
	it.each(['draft', 'accepted', 'rejected', 'superseded', 'withdrawn'])('keeps authorized %s proposal context available for coordinator discussion', async status => {
		const f = fixture(); mocks.history.mockResolvedValueOnce({ messages: [] });
		f.store.getGovernanceProposal.mockResolvedValue({ id: 'proposal', teamId: 'team', projectId: 'project', status });
		await f.service.send(principal, 'team', 'mcp-coordination', { message, proposalId: 'proposal' }, key);
		expect(mocks.exact).toHaveBeenCalledOnce();
		expect(f.created).toHaveBeenCalledWith(principal, expect.objectContaining({ contextRefs: [{ ...originalRef, immutableRef: 'c'.repeat(40), digest: `sha256:${'d'.repeat(64)}` }] }), `${key}:project`);
	});
	it.each([null, { id: 'proposal', teamId: 'foreign', projectId: 'project' }, { id: 'proposal', teamId: 'team' }])('denies unavailable or foreign proposal context %j', async proposal => {
		const f = fixture(); mocks.history.mockResolvedValueOnce({ messages: [] });
		f.store.getGovernanceProposal.mockResolvedValue(proposal);
		await expect(f.service.send(principal, 'team', 'mcp-coordination', { message, proposalId: 'proposal' }, key))
			.rejects.toMatchObject({ code: 'communication_proposal_not_found' });
		expect(mocks.exact).not.toHaveBeenCalled(); expect(f.created).not.toHaveBeenCalled();
	});
	it('does not admit discussion when exact retained proposal content cannot be verified', async () => {
		const f = fixture(); mocks.history.mockResolvedValueOnce({ messages: [] });
		mocks.exact.mockRejectedValueOnce(new Error('Exact source unavailable'));
		await expect(f.service.send(principal, 'team', 'mcp-coordination', { message, proposalId: 'proposal' }, key)).rejects.toThrow('Exact source unavailable');
		expect(f.created).not.toHaveBeenCalled();
	});
});

describe('discussion replay before invocation admission', () => {
	it('validates a shared proposal by its owning project and team while other foreign context remains denied', async () => {
		const ref = { ...originalRef, projectId: 'producer-project' };
		for (const visible of [true, false]) {
			const store = { first: vi.fn(async () => visible ? { id: 'proposal' } : null) };
			const read = validateDiscussionContextRefs({ store, teamId: 'team', projectId: 'project', values: [ref] });
			if (visible) expect(await read).toEqual([ref]);
			else await expect(read).rejects.toMatchObject({ code: 'discussion_context_proposal_stale' });
			expect(store.first).toHaveBeenCalledWith(expect.stringContaining('team_id = ? AND project_id = ?'), ['proposal', 'team', 'producer-project']);
			await expect(validateDiscussionContextRefs({ store, teamId: 'team', projectId: 'project', values: [{ ...ref, kind: 'assignment' }] }))
				.rejects.toMatchObject({ code: 'discussion_context_project_forbidden' });
		}
	});

	it('rejects changed exact context when a concurrent writer already committed the message', async () => {
		const { createDiscussionService } = await import('../../../../../../src/api/discussions/discussion-service.ts');
		const f = fixture();
		const invocation = await import("../../../../../../src/api/capacity/services/capacity/invocations/discussion-invocation-service.ts");
		const admitted = vi.spyOn(invocation, "admitDiscussionInvocations").mockResolvedValue([]);
		const store = { ...f.store, all: async () => [], first: async () => ({ id: 'proposal' }) };
		const service = createDiscussionService({ store, capacity: store, sessionEvents: { publish: vi.fn() } });
		mocks.history.mockResolvedValue({ messages: [{ ...source, frontmatter: { ...source.frontmatter, mentionedAgents: ['researcher'] } }] });
		await expect(service.create(principal, { teamId: 'team', projectId: 'project', discussionId: 'mcp-coordination', body: message,
			contextRefs: [{ ...originalRef, immutableRef: 'c'.repeat(40) }], recipients: ['researcher'] }, `${key}:project`))
			.rejects.toMatchObject({ status: 409, code: 'discussion_idempotency_conflict' });
		expect(admitted).not.toHaveBeenCalled();
	});
});

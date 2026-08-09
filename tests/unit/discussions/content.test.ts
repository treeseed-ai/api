import { beforeEach, describe, expect, it, vi } from 'vitest';

const { applyChangeset, commit, projectSignals } = vi.hoisted(() => ({
	applyChangeset: vi.fn(),
	commit: vi.fn(),
	projectSignals: vi.fn(),
}));

vi.mock('../../../src/api/knowledge/gateway-treedx-connection.ts', () => ({
	resolveKnowledgeGatewayConnection: vi.fn(async () => ({
		contentPath: 'src/content',
		repositoryId: 'repository-1',
		baseRef: 'refs/heads/main',
		authoringBranch: 'main',
		allowedPaths: ['src/content/**'],
		client: {
			createWorkspace: vi.fn(async () => ({ workspaceId: 'workspace-1', baseCommitSha: 'base123', baseRef: 'refs/heads/main' })),
			applyChangeset,
			commit,
			closeWorkspace: vi.fn(),
		},
	})),
}));

vi.mock('../../../src/api/capacity/services/treedx/repositories/treedx-change-projector.ts', () => ({
	projectTreeDxCommitSignals: projectSignals,
}));

import { commitDiscussionMessage, mentionedAgentSlugs, validateDiscussionContextRefs } from '../../../src/api/discussions/content.ts';

describe('TreeDX Discussion content', () => {
	beforeEach(() => {
		applyChangeset.mockReset().mockResolvedValue({ changedPaths: [] });
		commit.mockReset().mockResolvedValue({ commitSha: 'abc123', branchName: 'refs/heads/main', changedPaths: [] });
		projectSignals.mockReset().mockResolvedValue({});
	});

	it('deduplicates agent mentions without interpreting email addresses', () => {
		expect(mentionedAgentSlugs('Ask @architect and @architect, then @reviewer.')).toEqual(['architect', 'reviewer']);
		expect(mentionedAgentSlugs('Mail person@example.com')).toEqual([]);
	});

	it('commits the session, user message, and append-only event through TreeDX before dispatch', async () => {
		const authored = await commitDiscussionMessage({
			store: {}, projectId: 'project-1', teamId: 'team-1',
			principal: { id: 'user-1', displayName: 'Adrian', email: 'adrian@example.com' },
			body: 'Please review src/example.ts with @reviewer.', intent: 'discuss',
			fileRefs: [{ path: 'src/example.ts' }],
			contextRefs: [{ kind: 'event', id: 'event-1', projectId: 'project-1', workdayId: 'run-1', eventSequence: 2 }],
		});

		expect(authored.mentions).toEqual(['reviewer']);
		expect(applyChangeset).toHaveBeenCalledOnce();
		const request = applyChangeset.mock.calls[0]![0];
		expect(request.contract).toBe('treedx.changeset/v1');
		expect(request.patch).toContain('/discussions/');
		expect(request.patch).toContain('/discussion-messages/');
		expect(request.patch).toContain('/discussion-events/');
		expect(request.patch).toContain('contextRefs');
		expect(commit).toHaveBeenCalledOnce();
		expect(projectSignals).toHaveBeenCalledWith({}, expect.objectContaining({ projectId: 'project-1', commitSha: 'abc123' }));
	});

	it('validates historical topology and exact event positions before Discussion attachment', async () => {
		const topology = { projectId: 'project-1', immutableRef: 'commit-1', nodes: [{ id: 'agent:project-1:reviewer', kind: 'agent' }], edges: [] };
		const store = { first: vi.fn(async (query: string) => query.includes('capacity_workday_runs')
			? { id: 'run-1', parameters_json: JSON.stringify({ atlasTopologyByProjectId: { 'project-1': topology } }) }
			: query.includes('capacity_workday_events') ? { id: 'event-1' } : null) };
		const refs = await validateDiscussionContextRefs({ store, teamId: 'team-1', projectId: 'project-1', values: [
			{ kind: 'agent', id: 'agent:project-1:reviewer', projectId: 'project-1', workdayId: 'run-1', immutableRef: 'commit-1' },
			{ kind: 'event', id: 'event-1', projectId: 'project-1', workdayId: 'run-1', eventSequence: 2 },
		] });
		expect(refs).toHaveLength(2);
		await expect(validateDiscussionContextRefs({ store, teamId: 'team-1', projectId: 'project-1', values: [{ kind: 'agent', id: 'agent:other', projectId: 'project-2' }] })).rejects.toMatchObject({ code: 'discussion_context_project_forbidden' });
	});
});

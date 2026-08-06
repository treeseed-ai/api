import { beforeEach, describe, expect, it, vi } from 'vitest';

const { writeFile, commit, projectSignals } = vi.hoisted(() => ({
	writeFile: vi.fn(),
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
			createWorkspace: vi.fn(async () => ({ workspaceId: 'workspace-1' })),
			writeFile,
			commit,
			closeWorkspace: vi.fn(),
		},
	})),
}));

vi.mock('../../../src/api/capacity/services/treedx/repositories/treedx-change-projector.ts', () => ({
	projectTreeDxCommitSignals: projectSignals,
}));

import { commitDiscussionMessage, mentionedAgentSlugs } from '../../../src/api/discussions/content.ts';

describe('TreeDX Discussion content', () => {
	beforeEach(() => {
		writeFile.mockReset().mockResolvedValue({});
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
		});

		expect(authored.mentions).toEqual(['reviewer']);
		expect(writeFile).toHaveBeenCalledTimes(3);
		expect(writeFile.mock.calls.map(([input]) => input.path)).toEqual(expect.arrayContaining([
			expect.stringContaining('/discussions/'),
			expect.stringContaining('/discussion-messages/'),
			expect.stringContaining('/discussion-events/'),
		]));
		expect(commit).toHaveBeenCalledOnce();
		expect(projectSignals).toHaveBeenCalledWith({}, expect.objectContaining({ projectId: 'project-1', commitSha: 'abc123' }));
	});
});

import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { parseFrontmatterDocument } from '../../../../src/api/content/frontmatter.ts';

const mocks = vi.hoisted(() => ({
	changes: [] as Array<{ path: string; after: string }>,
	commit: vi.fn(), readRepositoryFiles: vi.fn(),
}));

vi.mock('../../../../src/api/knowledge/gateway-treedx-connection.ts', async (original) => ({
	...await original<typeof import('../../../../src/api/knowledge/gateway-treedx-connection.ts')>(),
	projectLibraryPath: (...parts: string[]) => parts.filter(Boolean).join('/'),
	resolveKnowledgeGatewayConnection: vi.fn(async () => ({ repositoryId: 'repo-1', contentPath: '', baseRef: 'staging',
		authoringBranch: 'staging', client: { commit: mocks.commit, readRepositoryFiles: mocks.readRepositoryFiles } })),
}));
vi.mock('../../../../src/api/discussions/discussion-workspace.ts', () => ({
	discussionWorkspaceOperationKey: () => 'test-operation',
	openDiscussionWorkspace: vi.fn(async () => ({ workspace: { workspaceId: 'workspace-1' }, close: vi.fn(async () => undefined) })),
}));
vi.mock('../../../../src/api/knowledge/changesets/apply-text-changeset.ts', () => ({
	applyTextChangeset: vi.fn(async ({ changes }) => { mocks.changes = changes; return { applied: true }; }),
}));
vi.mock('../../../../src/api/capacity/services/treedx/repositories/treedx-change-projector.ts', () => ({ projectTreeDxCommitSignals: vi.fn(async () => undefined) }));
vi.mock('../../../../src/api/capacity/services/treedx/repositories/treedx-authoring-journal.ts', () => ({
	recordTreeDxAuthoringState: vi.fn(async () => undefined), listReadableTreeDxAuthoringState: vi.fn(async () => []),
}));
vi.mock('../../../../src/api/realtime/session-events.ts', () => ({ persistSessionEvent: vi.fn(async () => undefined) }));

import { commitDiscussionMessage } from '../../../../src/api/discussions/content.ts';

describe('canonical Discussion authoring', () => {
	it('commits a new thread and message with an exact same-changeset Discussion reference', async () => {
		mocks.commit.mockResolvedValue({ commitSha: 'a'.repeat(40), branchName: 'refs/heads/staging',
			changedPaths: ['discussions/chat-1.mdx', 'discussion-messages/chat-1/message-1.mdx'] });
		mocks.readRepositoryFiles.mockImplementation(async ({ ref, paths }) => ({ resolvedRef: ref,
			files: paths.map((path: string) => ({ path, content: mocks.changes.find((change) => change.path === path)?.after })) }));
		const result = await commitDiscussionMessage({ store: {}, projectId: 'project-1', teamId: 'team-1',
			principal: { id: 'user-1', displayName: 'Test User' }, body: 'Hello team.', intent: 'discuss',
			discussionId: 'chat-1', messageId: 'message-1', createDiscussion: true });
		const threadSource = mocks.changes.find((change) => change.path === 'discussions/chat-1.mdx')?.after ?? '';
		const messageSource = mocks.changes.find((change) => change.path === 'discussion-messages/chat-1/message-1.mdx')?.after ?? '';
		const thread = parseFrontmatterDocument(threadSource).frontmatter;
		const message = parseFrontmatterDocument(messageSource).frontmatter;
		expect(thread).toMatchObject({ schemaVersion: 'treeseed.discussion/v1', id: 'chat-1', projectId: 'project-1', status: 'open' });
		expect(message.discussionRef).toMatchObject({ store: 'treedx', model: 'discussion', id: 'chat-1',
			path: 'discussions/chat-1.mdx', revision: 1,
			digest: `sha256:${createHash('sha256').update(threadSource).digest('hex')}` });
		expect(message.authorRef).toMatchObject({ store: 'postgresql', model: 'user', id: 'user-1' });
		expect(result.commitSha).toBe('a'.repeat(40));
	});
});

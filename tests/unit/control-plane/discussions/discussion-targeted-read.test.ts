import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	listRepositoryPaths: vi.fn(),
	readRepositoryFiles: vi.fn(),
}));

vi.mock('../../../../src/api/knowledge/gateway-treedx-connection.ts', () => ({
	projectLibraryPath: (...parts: string[]) => parts.filter(Boolean).join('/'),
	resolveKnowledgeGatewayConnection: vi.fn(async () => ({
		repositoryId: 'repo-1', contentPath: '', authoringBranch: 'staging',
		client: {
			listRepositoryPaths: mocks.listRepositoryPaths,
			readRepositoryFiles: mocks.readRepositoryFiles,
		},
	})),
}));

import { loadDiscussions } from '../../../../src/api/discussions/content.ts';

describe('targeted Discussion reads', () => {
	beforeEach(() => {
		mocks.listRepositoryPaths.mockReset();
		mocks.readRepositoryFiles.mockReset().mockImplementation(async ({ ref, paths }) => ({
			resolvedRef: ref,
			files: paths.map((path: string) => ({ path, content: `---\ntitle: Direct message\ndiscussionId: discussion-1\nauthorId: user-1\nauthorType: user\nintent: discuss\ncreatedAt: 2026-08-31T12:00:00.000Z\n---\nHello\n` })),
		}));
	});

	it('reads known message identities without enumerating the repository tree', async () => {
		const result = await loadDiscussions({
			store: { all: vi.fn(async () => []) },
			projectId: 'project-1', discussionId: 'discussion-1',
			exactMessageIds: ['message-1'], collection: 'messages',
		});

		expect(mocks.listRepositoryPaths).not.toHaveBeenCalled();
		expect(mocks.readRepositoryFiles).toHaveBeenCalledWith(expect.objectContaining({
			paths: ['discussion-messages/discussion-1/message-1.mdx'],
		}));
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0]?.body).toBe('Hello');
	});
});

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

	it('reads journal-backed messages from their commit without probing an absent branch path', async () => {
		const path = 'discussion-messages/discussion-1/message-2.mdx';
		const commitSha = 'a'.repeat(40);
		const original = mocks.readRepositoryFiles.getMockImplementation()!;
		mocks.readRepositoryFiles.mockImplementation(async (request) => {
			if (request.ref === 'refs/heads/staging' && request.paths.includes(path)) {
				throw Object.assign(new Error('Message is not on staging yet'), { code: 'not_found' });
			}
			return original(request);
		});
		const result = await loadDiscussions({
			store: { all: vi.fn(async () => [{ result_status: 'authoring_unpublished',
				metadata_json: JSON.stringify({ commitSha, changedPaths: [path] }) }]) },
			projectId: 'project-1', discussionId: 'discussion-1',
			exactPaths: ['discussion-messages/discussion-1/message-1.mdx', path], collection: 'messages',
		});
		expect(mocks.listRepositoryPaths).not.toHaveBeenCalled();
		expect(mocks.readRepositoryFiles).toHaveBeenCalledWith(expect.objectContaining({
			ref: 'refs/heads/staging', paths: ['discussion-messages/discussion-1/message-1.mdx'],
		}));
		expect(mocks.readRepositoryFiles).toHaveBeenCalledWith(expect.objectContaining({ ref: commitSha, paths: [path] }));
		expect(result.messages).toHaveLength(2);
		expect(result.messages.find((message) => message.path === path)?.immutableRef).toBe(commitSha);
	});

	it.each(['path', 'identity'])('keeps an exact %s read isolated from more than a page of journal history', async (selection) => {
		const path = 'discussion-messages/discussion-1/requested.mdx';
		const commitSha = 'b'.repeat(40);
		const journal = [path, ...Array.from({ length: 75 }, (_, index) => `discussion-messages/discussion-1/other-${index}.mdx`)]
			.map((changedPath, index) => ({ result_status: 'authoring_integrated',
				metadata_json: JSON.stringify({ commitSha: index === 0 ? commitSha : index.toString(16).padStart(40, '0'), changedPaths: [changedPath] }) }));
		const result = await loadDiscussions({ store: { all: vi.fn(async () => journal) }, projectId: 'project-1',
			discussionId: 'discussion-1', collection: 'messages', limit: 1,
			...(selection === 'path' ? { exactPaths: [path] } : { exactMessageIds: ['requested'] }) });
		expect(result.messages.map((message) => message.path)).toEqual([path]);
		expect(result.messages[0]?.immutableRef).toBe(commitSha);
		expect(mocks.listRepositoryPaths).not.toHaveBeenCalled();
		expect(mocks.readRepositoryFiles).toHaveBeenCalledTimes(1);
		expect(mocks.readRepositoryFiles).toHaveBeenCalledWith(expect.objectContaining({ ref: commitSha, paths: [path] }));
	});
});

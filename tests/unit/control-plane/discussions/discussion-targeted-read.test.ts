import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	listRepositoryPaths: vi.fn(),
	readRepositoryFiles: vi.fn(),
}));

vi.mock('../../../../src/api/knowledge/gateway-treedx-connection.ts', async (importOriginal) => ({
	...await importOriginal<typeof import('../../../../src/api/knowledge/gateway-treedx-connection.ts')>(),
	projectLibraryPath: (...parts: string[]) => parts.filter(Boolean).join('/'),
	resolveKnowledgeGatewayConnection: vi.fn(async () => ({
		repositoryId: 'repo-1', contentPath: '', authoringBranch: 'staging',
		client: {
			listRepositoryPaths: mocks.listRepositoryPaths,
			readRepositoryFiles: mocks.readRepositoryFiles,
		},
	})),
}));

import { discussionAuthoringAuthority, discussionAuthoringWorkspaceRefs, loadDiscussions } from '../../../../src/api/discussions/content.ts';
import { normalizedWorkspaceScopePaths } from '../../../../src/api/knowledge/gateway-treedx-connection.ts';

describe('targeted Discussion reads', () => {
	beforeEach(() => {
		mocks.listRepositoryPaths.mockReset();
		mocks.readRepositoryFiles.mockReset().mockImplementation(async ({ ref, paths }) => ({
			resolvedRef: ref,
			files: paths.map((path: string) => ({ path, content: `---\nschemaVersion: treeseed.discussion-message/v1\nid: ${path.split('/').at(-1)?.replace('.mdx','')}\ndiscussionRef:\n  store: treedx\n  model: discussion\n  id: discussion-1\n  path: discussions/discussion-1.mdx\n  revision: 1\n  digest: sha256:${'a'.repeat(64)}\nauthorRef:\n  store: postgresql\n  model: user\n  id: user-1\ndiscussionId: discussion-1\nauthorId: user-1\nauthorType: user\nintent: discuss\ncreatedAt: 2026-08-31T12:00:00.000Z\n---\nHello\n` })),
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

	it('retains the repository and exact full document digest in targeted history readback', async () => {
		const read = mocks.readRepositoryFiles.getMockImplementation()!;
		mocks.readRepositoryFiles.mockImplementation(async input => ({ ...await read(input), resolvedRef: 'a'.repeat(40) }));
		const result = await loadDiscussions({ store: { all: async () => [] }, projectId: 'project-1',
			discussionId: 'discussion-1', exactMessageIds: ['message-1'], collection: 'messages' });
		const reply = await mocks.readRepositoryFiles.mock.results[0]!.value;
		expect(result).toMatchObject({ repositoryId: 'repo-1', messages: [{ immutableRef: 'a'.repeat(40),
			digest: createHash('sha256').update(reply.files[0].content).digest('hex') }] });
		expect(createHash('sha256').update(reply.files[0].content).digest('hex'))
			.not.toBe(createHash('sha256').update(result.messages[0]!.body).digest('hex'));
	});

	it('returns no original message only for an absent branch file while retaining denied and missing immutable authority', async () => {
		const input = { store: { all: vi.fn(async () => [] as unknown[]) }, projectId: 'project-1',
			discussionId: 'discussion-1', exactMessageIds: ['message-1'], collection: 'messages' as const };
		const missing = () => Object.assign(new Error('File not found.'), { status: 404, code: 'not_found' });
		mocks.readRepositoryFiles.mockRejectedValueOnce(missing());
		await expect(loadDiscussions(input)).resolves.toMatchObject({ messages: [] });
		expect(mocks.listRepositoryPaths).not.toHaveBeenCalled();
		for (const denied of [
			Object.assign(new Error('Repository not found.'), { status: 404, code: 'not_found' }),
			Object.assign(new Error('Ref not found.'), { status: 404, code: 'not_found' }),
			Object.assign(new Error('File not found.'), { status: 403, code: 'not_found' }),
			Object.assign(new Error('File not found.'), { status: 404, code: 'access_denied' }),
			Object.assign(new Error('File not found.'), { status: 401, code: 'authentication_required' }),
			Object.assign(new Error('Unavailable'), { status: 503, code: 'unavailable' }),
			new Error('File not found.'),
		]) {
			mocks.readRepositoryFiles.mockRejectedValueOnce(denied);
			await expect(loadDiscussions(input)).rejects.toBe(denied);
		}
		const path = 'discussion-messages/discussion-1/message-1.mdx';
		for (const selected of [{ ...input, exactMessageIds: undefined, exactPaths: [path] },
			{ ...input, exactMessageIds: ['message-1', 'message-2'] }]) {
			const denied = missing(); mocks.readRepositoryFiles.mockRejectedValueOnce(denied);
			await expect(loadDiscussions(selected)).rejects.toBe(denied);
		}
		input.store.all.mockResolvedValueOnce([{ result_status: 'authoring_unpublished',
			metadata_json: JSON.stringify({ commitSha: 'a'.repeat(40), changedPaths: [path] }) }]);
		const denied = missing(); mocks.readRepositoryFiles.mockRejectedValueOnce(denied);
		await expect(loadDiscussions(input)).rejects.toBe(denied);
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

	it('resolves an exact unpublished reply reference without requiring a separate discussion selector', async () => {
		const path = 'discussion-messages/discussion-1/source.mdx';
		const commitSha = 'c'.repeat(40);
		const original = mocks.readRepositoryFiles.getMockImplementation()!;
		mocks.readRepositoryFiles.mockImplementation(async (request) => {
			if (request.ref === 'refs/heads/staging') throw Object.assign(new Error('Not published'), { code: 'not_found' });
			return original(request);
		});
		const result = await loadDiscussions({
			store: { all: vi.fn(async () => [{ result_status: 'authoring_unpublished',
				metadata_json: JSON.stringify({ commitSha, changedPaths: [path] }) }]) },
			projectId: 'project-1', exactPaths: [path], collection: 'messages', limit: 1,
		});
		expect(mocks.readRepositoryFiles).toHaveBeenCalledTimes(1);
		expect(mocks.readRepositoryFiles).toHaveBeenCalledWith(expect.objectContaining({ ref: commitSha, paths: [path] }));
		expect(result.messages).toMatchObject([{ path, immutableRef: commitSha }]);
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

describe('Discussion assignment authoring authority', () => {
	it('keeps user messages attached to simulation workdays outside the project publication ref', () => {
		expect(discussionAuthoringAuthority({ parentWorkdayId: 'workday-123', executionMode: 'simulation', authorType: 'user' }))
			.toEqual({ ref: 'refs/heads/workday-123', state: 'unpublished' });
		expect(discussionAuthoringAuthority({ parentWorkdayId: 'workday-123', executionMode: 'production', authorType: 'user' }))
			.toEqual({ ref: '', state: 'integrated' });
		expect(discussionAuthoringAuthority({ explicitRef: 'refs/heads/assignment_1', parentWorkdayId: 'workday-123', executionMode: 'simulation', authorType: 'agent' }))
			.toEqual({ ref: 'refs/heads/assignment_1', state: 'unpublished' });
	});

	it('retains the assignment branch and immutable workspace base refs', () => {
		expect(discussionAuthoringWorkspaceRefs('refs/heads/assignment_1', {
			baseCommitSha: 'a'.repeat(40),
			baseRef: 'refs/heads/staging',
		})).toEqual(['refs/heads/assignment_1', 'a'.repeat(40), 'refs/heads/staging']);
	});

	it('deduplicates equivalent immutable workspace refs', () => {
		expect(discussionAuthoringWorkspaceRefs('refs/heads/assignment_1', {
			baseCommitSha: 'a'.repeat(40),
			baseRef: 'a'.repeat(40),
		})).toEqual(['refs/heads/assignment_1', 'a'.repeat(40)]);
	});

	it('retains normalized persisted workspace paths without allowing escapes', () => {
		expect(normalizedWorkspaceScopePaths(['./README.md', 'discussion-messages/**', './README.md']))
			.toEqual(['README.md', 'discussion-messages/**']);
		expect(() => normalizedWorkspaceScopePaths(['../outside'])).toThrow('unsafe path');
	});
});

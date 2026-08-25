import { describe, expect, it, vi } from 'vitest';
import { openDiscussionWorkspace } from '../../../../src/api/discussions/discussion-workspace.ts';

describe('Discussion workspace authoring', () => {
	it('branches the governed authoring ref from the reconciled exact base ref', async () => {
		const createWorkspace = vi.fn(async (input) => ({ ...input }));
		const closeWorkspace = vi.fn(async () => undefined);
		const store = {
			getProject: vi.fn(async () => ({ teamId: 'team-1' })),
			all: vi.fn(async () => []),
			run: vi.fn(async () => undefined),
		};
		const session = await openDiscussionWorkspace({
			store,
			connection: {
				repositoryId: 'repo-1',
				allowedPaths: ['discussions/**'],
				client: { createWorkspace, closeWorkspace },
			},
			projectId: 'project-1',
			baseRef: 'refs/remotes/origin/staging',
			branchName: 'refs/heads/staging',
			operationKey: 'message:one',
		});

		expect(createWorkspace).toHaveBeenCalledWith(expect.objectContaining({
			baseRef: 'refs/remotes/origin/staging',
			branchName: 'refs/heads/staging',
		}));
		await session.close();
		expect(closeWorkspace).toHaveBeenCalledOnce();
	});

	it('continues from the governed authoring branch when seed reconciliation observes an older upstream base', async () => {
		const createWorkspace = vi.fn()
			.mockRejectedValueOnce(Object.assign(new Error('Workspace branch already exists at a different commit.'), { status: 409, code: 'conflict' }))
			.mockResolvedValueOnce({ workspaceId: 'workspace-1' });
		const store = { getProject: vi.fn(async () => ({ teamId: 'team-1' })), all: vi.fn(async () => []), run: vi.fn(async () => undefined) };
		await openDiscussionWorkspace({ store, connection: { repositoryId: 'repo-1', allowedPaths: ['discussions/**'],
			client: { createWorkspace, closeWorkspace: vi.fn(async () => undefined) } }, projectId: 'project-1',
			baseRef: '11a98caca3d0b5a46934078a2a41e966d2098db6', branchName: 'refs/heads/staging', operationKey: 'message:two' });
		expect(createWorkspace).toHaveBeenNthCalledWith(1, expect.objectContaining({ baseRef: '11a98caca3d0b5a46934078a2a41e966d2098db6' }));
		expect(createWorkspace).toHaveBeenNthCalledWith(2, expect.objectContaining({ baseRef: 'refs/heads/staging' }));
	});
});

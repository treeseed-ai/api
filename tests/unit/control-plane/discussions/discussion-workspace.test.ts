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
});

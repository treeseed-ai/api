import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	resolve: vi.fn(),
	openWorkspace: vi.fn(),
	changeset: vi.fn(),
	authoring: vi.fn(),
	project: vi.fn(),
}));

vi.mock('../../../../src/api/knowledge/gateway-treedx-connection.ts', async (original) => ({
	...await original<typeof import('../../../../src/api/knowledge/gateway-treedx-connection.ts')>(),
	resolveKnowledgeGatewayConnection: mocks.resolve,
}));
vi.mock('../../../../src/api/discussions/discussion-workspace.ts', async (original) => ({
	...await original<typeof import('../../../../src/api/discussions/discussion-workspace.ts')>(),
	openDiscussionWorkspace: mocks.openWorkspace,
}));
vi.mock('../../../../src/api/knowledge/changesets/apply-text-changeset.ts', () => ({
	applyTextChangeset: mocks.changeset,
}));
vi.mock('../../../../src/api/capacity/services/treedx/repositories/treedx-authoring-journal.ts', () => ({
	recordTreeDxAuthoringState: mocks.authoring,
	listReadableTreeDxAuthoringState: vi.fn(async () => []),
}));
vi.mock('../../../../src/api/capacity/services/treedx/repositories/treedx-change-projector.ts', () => ({
	projectTreeDxCommitSignals: mocks.project,
}));

import { commitDiscussionMessage } from '../../../../src/api/discussions/content.ts';

describe('Discussion message custody', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		const client = {
			commit: vi.fn(async () => ({ commitSha: 'b'.repeat(40), branchName: 'refs/heads/workday-1',
				changedPaths: ['discussions/discussion-1.mdx'] })),
			readRepositoryFiles: vi.fn(async (request: { ref: string; paths: string[] }) => ({
				resolvedRef: request.ref, files: request.paths.map((path) => ({ path })),
			})),
		};
		mocks.resolve.mockResolvedValue({ client, repositoryId: 'repo-1', contentPath: '.',
			authoringBranch: 'staging', baseRef: 'a'.repeat(40), allowedPaths: ['discussions/**', 'discussion-messages/**', 'discussion-events/**'] });
		mocks.openWorkspace.mockResolvedValue({ workspace: { workspaceId: 'workspace-1', baseCommitSha: 'a'.repeat(40),
			baseRef: 'a'.repeat(40) }, close: vi.fn(async () => undefined) });
		mocks.changeset.mockResolvedValue({ files: [] });
		mocks.authoring.mockResolvedValue({});
		mocks.project.mockResolvedValue([]);
	});

	it('keeps a simulation-bound user message on its workday ref without publishing or replicating it', async () => {
		const store = { getCapacityWorkdayRun: vi.fn(async () => ({ id: 'workday-1', executionMode: 'simulation' })) };
		await commitDiscussionMessage({ store, projectId: 'sdk', teamId: 'team-1', principal: { id: 'user-1' },
			body: 'Review the SDK proposal.', intent: 'discuss', parentWorkdayId: 'workday-1',
			discussionId: 'discussion-1', messageId: 'message-1', createDiscussion: true });
		expect(mocks.openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ branchName: 'refs/heads/workday-1' }));
		expect(mocks.authoring).toHaveBeenCalledWith(store, 'unpublished', expect.objectContaining({ ref: 'refs/heads/workday-1' }));
		expect(mocks.project).not.toHaveBeenCalled();
	});

	it('preserves shared projection for an ordinary production message', async () => {
		const store = { getCapacityWorkdayRun: vi.fn(async () => ({ id: 'workday-1', executionMode: 'production' })) };
		await commitDiscussionMessage({ store, projectId: 'sdk', teamId: 'team-1', principal: { id: 'user-1' },
			body: 'Review the SDK proposal.', intent: 'discuss', parentWorkdayId: 'workday-1',
			discussionId: 'discussion-1', messageId: 'message-1', createDiscussion: true });
		expect(mocks.authoring).toHaveBeenCalledWith(store, 'integrated', expect.anything());
		expect(mocks.project).toHaveBeenCalledOnce();
	});
});

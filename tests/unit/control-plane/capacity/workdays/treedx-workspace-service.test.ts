import { describe, expect, it, vi } from 'vitest';
import { createWorkdayTreeDxWorkspace } from '../../../../../src/api/capacity/services/capacity/workdays/treedx/workday-treedx-workspace-service.ts';

const input = {
	workspaceId: 'ws_exact', repositoryId: 'repo_sdk', assignmentId: 'assignment_exact',
	baseRef: 'a'.repeat(40), branchName: 'refs/heads/assignment_exact', mode: 'writable' as const,
	allowedPaths: ['knowledge/**'], ttlSeconds: 300,
};

describe('workday TreeDX workspace issuance', () => {
	it('adopts the exact ready workspace after an interrupted assignment admission', async () => {
		const existing = { workspaceId: input.workspaceId, repoId: input.repositoryId,
			baseRef: input.baseRef, branchName: input.branchName, mode: input.mode,
			status: 'ready', allowedPaths: input.allowedPaths };
		const client = {
			createWorkspace: vi.fn().mockRejectedValue(Object.assign(new Error('conflict: workspace id already exists with different state'),
				{ code: 'conflict', status: 409 })),
			getWorkspace: vi.fn().mockResolvedValue(existing),
		};
		await expect(createWorkdayTreeDxWorkspace({ client: client as never, ...input })).resolves.toEqual(existing);
		expect(client.getWorkspace).toHaveBeenCalledWith(input.workspaceId);
	});

	it('rejects a conflicting workspace with different authority', async () => {
		const client = {
			createWorkspace: vi.fn().mockRejectedValue(Object.assign(new Error('conflict'), { code: 'conflict', status: 409 })),
			getWorkspace: vi.fn().mockResolvedValue({ workspaceId: input.workspaceId, repoId: input.repositoryId,
				baseRef: input.baseRef, branchName: 'refs/heads/other', mode: input.mode,
				status: 'ready', allowedPaths: input.allowedPaths }),
		};
		await expect(createWorkdayTreeDxWorkspace({ client: client as never, ...input }))
			.rejects.toMatchObject({ code: 'capacity_workday_workspace_create_failed' });
	});
});

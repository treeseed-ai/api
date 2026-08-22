import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { describe, expect, it, vi } from 'vitest';
import { createTreeDxOperations } from '../../../../src/api/control-plane/catalog/treedx/index.ts';

const service = () => ({ library: vi.fn(), bindLibrary: vi.fn(), createRepository: vi.fn(), createWorkspace: vi.fn(), workspace: vi.fn(), repositoryRead: vi.fn() }) as any;

describe('TreeDX proxy operation catalog', () => {
	it('binds the complete retained proxy surface to SDK contracts', () => {
		expect(createTreeDxOperations({ treeDxProxy: service() }).map((operation) => operation.binding)).toEqual([
			CONTROL_PLANE_OPERATIONS.treedx.library, CONTROL_PLANE_OPERATIONS.treedx.bindLibrary,
			CONTROL_PLANE_OPERATIONS.treedx.createRepository, CONTROL_PLANE_OPERATIONS.treedx.createWorkspace,
			CONTROL_PLANE_OPERATIONS.treedx.readWorkspaceFile, CONTROL_PLANE_OPERATIONS.treedx.applyChangeset,
			CONTROL_PLANE_OPERATIONS.treedx.searchWorkspace, CONTROL_PLANE_OPERATIONS.treedx.commitWorkspace,
			CONTROL_PLANE_OPERATIONS.treedx.closeWorkspace, CONTROL_PLANE_OPERATIONS.treedx.readRepositoryFiles,
			CONTROL_PLANE_OPERATIONS.treedx.listRepositoryPaths, CONTROL_PLANE_OPERATIONS.treedx.buildRepositoryContext,
		]);
	});

	it('passes semantic arguments and invocation authority without raw URLs', async () => {
		const treeDxProxy = service(); treeDxProxy.createWorkspace.mockResolvedValue({ payload: { id: 'workspace-1' } });
		const operation = createTreeDxOperations({ treeDxProxy }).find((entry) => entry.binding === CONTROL_PLANE_OPERATIONS.treedx.createWorkspace)!;
		const context = { interface: 'rest' as const, requestId: 'request-1', principal: { id: 'user-1' } };
		await operation.handler({ path: { projectId: 'project-1', repoId: 'repo-1' }, query: {}, body: { branch: 'work' } }, context);
		expect(treeDxProxy.createWorkspace).toHaveBeenCalledWith('project-1', 'repo-1', { branch: 'work' }, {}, context);
	});
});

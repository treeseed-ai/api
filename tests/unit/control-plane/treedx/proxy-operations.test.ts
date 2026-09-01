import { CONTROL_PLANE_OPERATION_LIST, CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { describe, expect, it, vi } from 'vitest';
import { createTreeDxOperations } from '../../../../src/api/control-plane/catalog/treedx/index.ts';
import { bindCurrentLibraryView } from '../../../../src/api/control-plane/repositories/treedx/proxy-operation-service.ts';

const service = () => ({ library: vi.fn(), bindLibrary: vi.fn(), serviceContract: vi.fn(), listWorkspaces: vi.fn(), invoke: vi.fn() }) as any;

describe('TreeDX proxy operation catalog', () => {
	it('binds the complete retained proxy surface to SDK contracts', () => {
		const expected = CONTROL_PLANE_OPERATION_LIST.filter((operation) => operation.descriptor.operationId.startsWith('treedx.'))
			.map((operation) => operation.descriptor.operationId).sort();
		expect(createTreeDxOperations({ treeDxProxy: service() }).map((operation) => operation.binding.descriptor.operationId).sort()).toEqual(expected);
	});

	it('passes semantic arguments and invocation authority without raw URLs', async () => {
		const treeDxProxy = service(); treeDxProxy.invoke.mockResolvedValue({ result: { id: 'workspace-1' }, receipt: {} });
		const operation = createTreeDxOperations({ treeDxProxy }).find((entry) => entry.binding === CONTROL_PLANE_OPERATIONS.treedx.workspaces.create)!;
		const context = { interface: 'rest' as const, requestId: 'request-1', principal: { id: 'user-1' } };
		await operation.handler({ path: { projectId: 'project-1', repoId: 'repo-1' }, query: {}, body: { branch: 'work' } }, context);
		expect(treeDxProxy.invoke).toHaveBeenCalledWith(operation.binding.descriptor,
			{ path: { projectId: 'project-1', repoId: 'repo-1' }, query: {}, body: { branch: 'work' } }, context);
	});

	it('resolves the current project library view without exposing storage revisions to callers', () => {
		const input = { path: { projectId: 'project-1', repoId: 'repo-1' }, query: {}, body: { paths: ['objectives/core'] } };
		expect(bindCurrentLibraryView({ method: 'POST' }, input, { contentRepositoryRef: 'current-library-view' })).toEqual({
			...input, body: { paths: ['objectives/core'], ref: 'current-library-view' },
		});
		expect(input.body).not.toHaveProperty('ref');
	});

});

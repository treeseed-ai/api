import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { CapacityGovernanceError } from '../../../capacity/database.ts';
import type { TreeDxProxyOperationService } from '../../repositories/treedx/proxy-operation-service.ts';
import { ControlPlaneOperationError, type BoundOperation } from '../operation-registry.ts';

export interface TreeDxOperationDependencies { treeDxProxy: TreeDxProxyOperationService; }
function result<T>(call: () => T | Promise<T>) { return Promise.resolve().then(call).catch((error) => {
	if (error instanceof CapacityGovernanceError) throw new ControlPlaneOperationError(error.status as 400, error.code, error.message);
	throw error;
}); }

export function createTreeDxOperations({ treeDxProxy: service }: TreeDxOperationDependencies): BoundOperation[] {
	const operations = CONTROL_PLANE_OPERATIONS.treedx;
	return [
		{ binding: operations.library, handler: (input, context) => result(() => service.library(context.principal, input.path.projectId)) },
		{ binding: operations.bindLibrary, handler: (input, context) => result(() => service.bindLibrary(context.principal, input.path.projectId, input.body as Record<string, unknown>)) },
		{ binding: operations.createRepository, handler: (input, context) => result(() => service.createRepository(input.path.projectId, input.body as Record<string, unknown>, input.query, context)) },
		{ binding: operations.createWorkspace, handler: (input, context) => result(() => service.createWorkspace(input.path.projectId, input.path.repoId, input.body as Record<string, unknown>, input.query, context)) },
		{ binding: operations.readWorkspaceFile, handler: (input, context) => result(() => service.workspace(input.path.projectId, input.path.workspaceId, 'files', undefined, input.query, context)) },
		{ binding: operations.applyChangeset, handler: (input, context) => result(() => service.workspace(input.path.projectId, input.path.workspaceId, 'changesets', input.body as Record<string, unknown>, input.query, context)) },
		{ binding: operations.searchWorkspace, handler: (input, context) => result(() => service.workspace(input.path.projectId, input.path.workspaceId, 'search', input.body as Record<string, unknown>, input.query, context)) },
		{ binding: operations.commitWorkspace, handler: (input, context) => result(() => service.workspace(input.path.projectId, input.path.workspaceId, 'commit', input.body as Record<string, unknown>, input.query, context)) },
		{ binding: operations.closeWorkspace, handler: (input, context) => result(() => service.workspace(input.path.projectId, input.path.workspaceId, 'close', input.body as Record<string, unknown>, input.query, context)) },
		{ binding: operations.readRepositoryFiles, handler: (input, context) => result(() => service.repositoryRead(input.path.projectId, input.path.repoId, 'files/read', input.body as Record<string, unknown>, input.query, context)) },
		{ binding: operations.listRepositoryPaths, handler: (input, context) => result(() => service.repositoryRead(input.path.projectId, input.path.repoId, 'paths/list', input.body as Record<string, unknown>, input.query, context)) },
		{ binding: operations.buildRepositoryContext, handler: (input, context) => result(() => service.repositoryRead(input.path.projectId, input.path.repoId, 'context/build', input.body as Record<string, unknown>, input.query, context)) },
	];
}

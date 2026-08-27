import { TREEAI_CONTROL_PLANE_OPERATION_LIST, type TreeAiOperationId } from '@treeseed/sdk/treeai';
import type { TreeAiProxyService } from '../../treeai/proxy-service.ts';
import { ControlPlaneOperationError, type BoundOperation } from '../operation-registry.ts';

export interface TreeAiOperationDependencies { treeAiProxy: TreeAiProxyService }

export function createTreeAiOperations({ treeAiProxy }: TreeAiOperationDependencies): BoundOperation[] {
	return TREEAI_CONTROL_PLANE_OPERATION_LIST.map((binding) => ({
		binding,
		async handler(input, context) {
			try {
				const { nodeId, ...path } = input.path as Record<string, string>;
				return await treeAiProxy.invoke(String(nodeId), binding.descriptor.upstream!.operationId as TreeAiOperationId,
					{ path, query: input.query as Record<string, string>, body: input.body }, context) as never;
			} catch (error) {
				const failure = error as { status?: number; code?: string; message?: string };
				throw new ControlPlaneOperationError((failure.status && [400, 401, 403, 404, 409, 412, 413, 422, 429, 500, 503].includes(failure.status) ? failure.status : 503) as 503,
					failure.code ?? 'treeai_unavailable', failure.message ?? 'TreeAI is unavailable.');
			}
		},
	}));
}

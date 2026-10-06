import { TREEAI_CONTROL_PLANE_OPERATION_LIST, type TreeAiOperationId } from '@treeseed/sdk/treeai';
import type { TreeAiProxyService } from '../../treeai/proxy-service.ts';
import { ControlPlaneOperationError, controlPlaneErrorStatus, type BoundOperation } from '../operation-registry.ts';

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
				const status = controlPlaneErrorStatus(failure.status);
				throw new ControlPlaneOperationError(status === 500 && failure.status !== 500 ? 503 : status,
					failure.code ?? 'treeai_unavailable', failure.message ?? 'TreeAI is unavailable.');
			}
		},
	}));
}

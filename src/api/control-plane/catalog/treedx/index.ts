import { CONTROL_PLANE_OPERATIONS, type ControlPlaneOperationBinding } from '@treeseed/sdk/operator-contracts';
import { CapacityGovernanceError } from '../../../capacity/database.ts';
import type { TreeDxProxyOperationService } from '../../repositories/treedx/proxy-operation-service.ts';
import { ControlPlaneOperationError, type BoundOperation } from '../operation-registry.ts';

export interface TreeDxOperationDependencies { treeDxProxy: TreeDxProxyOperationService; }

function result<T>(call: () => T | Promise<T>) {
	return Promise.resolve().then(call).catch((error) => {
		if (error instanceof CapacityGovernanceError) throw new ControlPlaneOperationError(error.status as 400, error.code, error.message);
		throw error;
	});
}

function bindings(value: unknown): ControlPlaneOperationBinding<any, any, any, any>[] {
	if (!value || typeof value !== 'object') return [];
	if ('descriptor' in value && 'schema' in value) return [value as ControlPlaneOperationBinding<any, any, any, any>];
	return Object.values(value).flatMap(bindings);
}

export function createTreeDxOperations({ treeDxProxy: service }: TreeDxOperationDependencies): BoundOperation[] {
	return bindings(CONTROL_PLANE_OPERATIONS.treedx).map((binding) => ({
		binding,
		handler: (input, context) => result(() => {
			switch (binding.descriptor.operationId) {
				case 'treedx.library.show': return service.library(context.principal, String(input.path.projectId));
				case 'treedx.library.bind': return service.bindLibrary(context.principal, String(input.path.projectId), input.body as Record<string, unknown>);
				case 'treedx.service.contract': return service.serviceContract(context.principal, String(input.path.projectId));
				case 'treedx.workspaces.list': return service.listWorkspaces(String(input.path.projectId), input.query, context);
				default: return service.invoke(binding.descriptor, input as never, context);
			}
		}),
	}));
}

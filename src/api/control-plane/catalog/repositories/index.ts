import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { RepositoryOperationError } from '../../repositories/repository-operation-error.ts';
import { ControlPlaneOperationError, type BoundOperation, type OperationInvocationContext } from '../operation-registry.ts';

export interface RepositoryOperationDependencies {
	repositories: {
		topology(principal: OperationInvocationContext['principal'], projectId: string): Promise<Record<string, any>>;
		status(principal: OperationInvocationContext['principal'], projectId: string): Promise<Record<string, any>>;
		update(principal: OperationInvocationContext['principal'], projectId: string, body: Record<string, unknown>, ifMatch?: string): Promise<Record<string, any>>;
	};
}

function result<T>(call: () => Promise<T>) {
	return call().catch((error) => {
		if (error instanceof RepositoryOperationError) throw new ControlPlaneOperationError(error.status, error.code, error.message);
		throw error;
	});
}

export function createRepositoryOperations(dependencies: RepositoryOperationDependencies): BoundOperation[] {
	return [
		{ binding: CONTROL_PLANE_OPERATIONS.projects.repositoryTopology,
			handler: (input, context) => result(() => dependencies.repositories.topology(context.principal, input.path.projectId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.projects.repositoryTopologyStatus,
			handler: (input, context) => result(() => dependencies.repositories.status(context.principal, input.path.projectId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.projects.updateRepositoryTopology,
			handler: (input, context) => result(() => dependencies.repositories.update(context.principal, input.path.projectId,
				input.body as Record<string, unknown>, context.ifMatch)) },
	];
}

import { OperationRegistry } from './operation-registry.ts';
import { createDeepHealthOperation, createReadinessOperation, statusOperation, type DeepHealthDependencies } from './core-operations.ts';
import { createProjectsListOperation, type ProjectOperationDependencies } from './project-operations.ts';

export * from './operation-registry.ts';

export const controlPlaneOperations = new OperationRegistry([statusOperation]);

export function createApiControlPlaneOperations(dependencies: DeepHealthDependencies & ProjectOperationDependencies) {
	return new OperationRegistry([statusOperation, createReadinessOperation(dependencies), createDeepHealthOperation(dependencies), createProjectsListOperation(dependencies)]);
}

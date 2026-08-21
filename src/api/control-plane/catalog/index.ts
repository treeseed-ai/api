import { OperationRegistry } from './operation-registry.ts';
import { createDeepHealthOperation, statusOperation, type DeepHealthDependencies } from './core-operations.ts';

export * from './operation-registry.ts';

export const controlPlaneOperations = new OperationRegistry([statusOperation]);

export function createApiControlPlaneOperations(dependencies: DeepHealthDependencies) {
	return new OperationRegistry([statusOperation, createDeepHealthOperation(dependencies)]);
}

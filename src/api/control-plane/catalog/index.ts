import { OperationRegistry } from './operation-registry.ts';
import { statusOperation } from './core-operations.ts';

export * from './operation-registry.ts';

export const controlPlaneOperations = new OperationRegistry([statusOperation]);

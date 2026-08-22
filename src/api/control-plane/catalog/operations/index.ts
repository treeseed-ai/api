import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { CapacityOperationError } from '../../repositories/capacity/capacity-operation-error.ts';
import { ControlPlaneOperationError, type BoundOperation, type OperationInvocationContext } from '../operation-registry.ts';
type Principal = OperationInvocationContext['principal'];
export interface PlatformOperationDependencies { platformOperations: {
	list(principal: Principal, query: Record<string, unknown>): Promise<Record<string, unknown>>;
	create(principal: Principal, body: Record<string, unknown>, idempotencyKey?: string): Promise<Record<string, unknown>>;
	show(principal: Principal, id: string): Promise<Record<string, unknown>>;
	events(principal: Principal, id: string): Promise<Record<string, unknown>>;
	cancel(principal: Principal, id: string): Promise<Record<string, unknown>>;
	retry(principal: Principal, id: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
}; }
function result<T>(call: () => T | Promise<T>) { return Promise.resolve().then(call).catch((error) => {
	if (error instanceof CapacityOperationError) throw new ControlPlaneOperationError(error.status, error.code, error.message);
	throw error;
}); }
export function createPlatformOperations({ platformOperations }: PlatformOperationDependencies): BoundOperation[] { return [
	{ binding: CONTROL_PLANE_OPERATIONS.operations.list, handler: (input, context) => result(() => platformOperations.list(context.principal, input.query as Record<string, unknown>)) },
	{ binding: CONTROL_PLANE_OPERATIONS.operations.create, handler: (input, context) => result(() => platformOperations.create(context.principal, input.body as Record<string, unknown>, context.idempotencyKey)) },
	{ binding: CONTROL_PLANE_OPERATIONS.operations.show, handler: (input, context) => result(() => platformOperations.show(context.principal, input.path.operationId)) },
	{ binding: CONTROL_PLANE_OPERATIONS.operations.events, handler: (input, context) => result(() => platformOperations.events(context.principal, input.path.operationId)) },
	{ binding: CONTROL_PLANE_OPERATIONS.operations.cancel, handler: (input, context) => result(() => platformOperations.cancel(context.principal, input.path.operationId)) },
	{ binding: CONTROL_PLANE_OPERATIONS.operations.retry, handler: (input, context) => result(() => platformOperations.retry(context.principal, input.path.operationId, input.body as Record<string, unknown>)) },
]; }

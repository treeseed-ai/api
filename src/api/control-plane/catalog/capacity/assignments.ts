import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { CapacityOperationError } from '../../repositories/capacity/capacity-operation-error.ts';
import { ControlPlaneOperationError, type BoundOperation, type OperationInvocationContext } from '../operation-registry.ts';
type Principal = OperationInvocationContext['principal'];
export interface AssignmentOperationDependencies { assignments: {
	list(principal: Principal, teamId: string, query: Record<string, unknown>): Promise<Record<string, unknown>>;
	show(principal: Principal, teamId: string, assignmentId: string): Promise<Record<string, unknown>>;
	explain(principal: Principal, teamId: string, assignmentId: string): Promise<Record<string, unknown>>;
	cancel(principal: Principal, teamId: string, assignmentId: string, body: Record<string, unknown>, idempotencyKey?: string): Promise<Record<string, unknown>>;
	retry(principal: Principal, teamId: string, assignmentId: string, body: Record<string, unknown>, idempotencyKey?: string): Promise<Record<string, unknown>>;
}; }
function result<T>(call: () => T | Promise<T>) { return Promise.resolve().then(call).catch((error) => {
	if (error instanceof CapacityOperationError) throw new ControlPlaneOperationError(error.status, error.code, error.message);
	throw error;
}); }
export function createAssignmentOperations({ assignments }: AssignmentOperationDependencies): BoundOperation[] { return [
	{ binding: CONTROL_PLANE_OPERATIONS.assignments.list, handler: (input, context) => result(() => assignments.list(context.principal, input.path.teamId, input.query as Record<string, unknown>)) },
	{ binding: CONTROL_PLANE_OPERATIONS.assignments.show, handler: (input, context) => result(() => assignments.show(context.principal, input.path.teamId, input.path.assignmentId)) },
	{ binding: CONTROL_PLANE_OPERATIONS.assignments.explain, handler: (input, context) => result(() => assignments.explain(context.principal, input.path.teamId, input.path.assignmentId)) },
	{ binding: CONTROL_PLANE_OPERATIONS.assignments.cancel, handler: (input, context) => result(() => assignments.cancel(context.principal, input.path.teamId, input.path.assignmentId, input.body as Record<string, unknown>, context.idempotencyKey)) },
	{ binding: CONTROL_PLANE_OPERATIONS.assignments.retry, handler: (input, context) => result(() => assignments.retry(context.principal, input.path.teamId, input.path.assignmentId, input.body as Record<string, unknown>, context.idempotencyKey)) },
]; }

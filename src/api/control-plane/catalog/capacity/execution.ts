import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { CapacityOperationError } from '../../repositories/capacity/capacity-operation-error.ts';
import { ControlPlaneOperationError, type BoundOperation, type OperationInvocationContext } from '../operation-registry.ts';

type Principal = OperationInvocationContext['principal'];
type Row = Record<string, unknown>;
export interface ExecutionOperationDependencies { execution: {
	show(principal: Principal, teamId: string, query: Row): Promise<any>;
	watch(principal: Principal, teamId: string, query: Row): Promise<any>;
	node(principal: Principal, teamId: string, nodeId: string): Promise<any>;
	explain(principal: Principal, teamId: string, nodeId: string): Promise<any>;
	reconcile(principal: Principal, teamId: string, body: Row, idempotencyKey?: string): Promise<any>;
	assignments(principal: Principal, teamId: string, query: Row): Promise<any>;
}; }
function result<T>(call: () => T | Promise<T>) { return Promise.resolve().then(call).catch((error) => {
	if (error instanceof CapacityOperationError) throw new ControlPlaneOperationError(error.status as 400, error.code, error.message);
	throw error;
}); }
export function createExecutionOperations({ execution }: ExecutionOperationDependencies): BoundOperation[] { return [
	{ binding: CONTROL_PLANE_OPERATIONS.execution.graph.show, handler: (input, context) => result(() => execution.show(context.principal, input.path.teamId, input.query as Row)) },
	{ binding: CONTROL_PLANE_OPERATIONS.execution.graph.watch, handler: (input, context) => result(() => execution.watch(context.principal, input.path.teamId, input.query as Row)) },
	{ binding: CONTROL_PLANE_OPERATIONS.execution.nodes.show, handler: (input, context) => result(() => execution.node(context.principal, input.path.teamId, input.path.nodeId)) },
	{ binding: CONTROL_PLANE_OPERATIONS.execution.nodes.explain, handler: (input, context) => result(() => execution.explain(context.principal, input.path.teamId, input.path.nodeId)) },
	{ binding: CONTROL_PLANE_OPERATIONS.execution.reconcile, handler: (input, context) => result(() => execution.reconcile(context.principal, input.path.teamId, input.body as Row, context.idempotencyKey)) },
	{ binding: CONTROL_PLANE_OPERATIONS.execution.assignments, handler: (input, context) => result(() => execution.assignments(context.principal, input.path.teamId, input.query as Row)) },
]; }

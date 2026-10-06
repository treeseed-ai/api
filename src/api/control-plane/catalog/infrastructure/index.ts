import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { CapacityOperationError } from '../../repositories/capacity/capacity-operation-error.ts';
import { ControlPlaneOperationError, type BoundOperation, type OperationInvocationContext } from '../operation-registry.ts';

type Principal = OperationInvocationContext['principal'];
export interface HostedTopologyOperationDependencies { hostedTopology: {
	plan(principal: Principal, teamId: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
	apply(principal: Principal, teamId: string, body: Record<string, unknown>, ifMatch?: string, idempotencyKey?: string): Promise<Record<string, unknown>>;
	status(principal: Principal, teamId: string): Promise<Record<string, unknown>>;
	rollback(principal: Principal, teamId: string, body: Record<string, unknown>, ifMatch?: string, idempotencyKey?: string): Promise<Record<string, unknown>>;
}; }
function result<T>(call: () => T | Promise<T>) { return Promise.resolve().then(call).catch((error) => {
	if (error instanceof CapacityOperationError) throw new ControlPlaneOperationError(error.status, error.code, error.message);
	throw error;
}); }
export function createHostedTopologyOperations({ hostedTopology }: HostedTopologyOperationDependencies): BoundOperation[] { const operations = CONTROL_PLANE_OPERATIONS.infrastructure.topology; return [
	{ binding: operations.plan, handler: (input, context) => result(() => hostedTopology.plan(context.principal, input.path.teamId, input.body as Record<string, unknown>)) },
	{ binding: operations.apply, handler: (input, context) => result(() => hostedTopology.apply(context.principal, input.path.teamId, input.body as Record<string, unknown>, context.ifMatch, context.idempotencyKey)) },
	{ binding: operations.status, handler: (input, context) => result(() => hostedTopology.status(context.principal, input.path.teamId)) },
	{ binding: operations.rollback, handler: (input, context) => result(() => hostedTopology.rollback(context.principal, input.path.teamId, input.body as Record<string, unknown>, context.ifMatch, context.idempotencyKey)) },
]; }

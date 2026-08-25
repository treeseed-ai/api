import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { CapacityOperationError } from '../../repositories/capacity/capacity-operation-error.ts';
import { ControlPlaneOperationError, type BoundOperation, type OperationInvocationContext } from '../operation-registry.ts';
type Principal = OperationInvocationContext['principal'];
export interface CapacityQueryOperationDependencies { capacityQueries: {
	availability(principal: Principal, teamId: string, query: Record<string, unknown>): Promise<Record<string, unknown>>;
	explain(principal: Principal, teamId: string): Promise<Record<string, unknown>>;
	usage(principal: Principal, teamId: string, query: Record<string, unknown>): Promise<Record<string, unknown>>;
	ledger(principal: Principal, teamId: string, query: Record<string, unknown>): Promise<Record<string, unknown>>;
	audit(principal: Principal, teamId: string, query: Record<string, unknown>): Promise<Record<string, unknown>>;
	lanes(principal: Principal, teamId: string): Promise<Record<string, unknown>>;
	grants(principal: Principal, teamId: string, query: Record<string, unknown>): Promise<Record<string, unknown>>;
	grant(principal: Principal, teamId: string, grantId: string): Promise<Record<string, unknown>>;
}; }
function result<T>(call: () => T | Promise<T>) { return Promise.resolve().then(call).catch((error) => {
	if (error instanceof CapacityOperationError) throw new ControlPlaneOperationError(error.status, error.code, error.message);
	throw error;
}); }
export function createCapacityQueryOperations({ capacityQueries }: CapacityQueryOperationDependencies): BoundOperation[] { return [
	{ binding: CONTROL_PLANE_OPERATIONS.capacity.availability, handler: (input, context) => result(() => capacityQueries.availability(context.principal, input.path.teamId, input.query as Record<string, unknown>)) },
	{ binding: CONTROL_PLANE_OPERATIONS.capacity.explain, handler: (input, context) => result(() => capacityQueries.explain(context.principal, input.path.teamId)) },
	{ binding: CONTROL_PLANE_OPERATIONS.capacity.usage, handler: (input, context) => result(() => capacityQueries.usage(context.principal, input.path.teamId, input.query as Record<string, unknown>)) },
	{ binding: CONTROL_PLANE_OPERATIONS.capacity.ledger, handler: (input, context) => result(() => capacityQueries.ledger(context.principal, input.path.teamId, input.query as Record<string, unknown>)) },
	{ binding: CONTROL_PLANE_OPERATIONS.capacity.audit, handler: (input, context) => result(() => capacityQueries.audit(context.principal, input.path.teamId, input.query as Record<string, unknown>)) },
	{ binding: CONTROL_PLANE_OPERATIONS.capacity.lanes, handler: (input, context) => result(() => capacityQueries.lanes(context.principal, input.path.teamId)) },
	{ binding: CONTROL_PLANE_OPERATIONS.capacity.grants, handler: (input, context) => result(() => capacityQueries.grants(context.principal, input.path.teamId, input.query as Record<string, unknown>)) },
	{ binding: CONTROL_PLANE_OPERATIONS.capacity.grant, handler: (input, context) => result(() => capacityQueries.grant(context.principal, input.path.teamId, input.path.grantId)) },
]; }

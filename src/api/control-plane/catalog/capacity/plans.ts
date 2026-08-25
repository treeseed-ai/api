import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { CapacityOperationError } from '../../repositories/capacity/capacity-operation-error.ts';
import { ControlPlaneOperationError, type BoundOperation, type OperationInvocationContext } from '../operation-registry.ts';

export interface CapacityPlanOperationDependencies {
	plans: {
		list(principal: OperationInvocationContext['principal'], decisionId: string, query: Record<string, unknown>): Promise<Record<string, unknown>>;
		show(principal: OperationInvocationContext['principal'], planId: string): Promise<Record<string, unknown>>;
	};
}

function result<T>(call: () => T | Promise<T>) {
	return Promise.resolve().then(call).catch((error) => {
		if (error instanceof CapacityOperationError) throw new ControlPlaneOperationError(error.status, error.code, error.message);
		throw error;
	});
}

export function createCapacityPlanOperations(dependencies: CapacityPlanOperationDependencies): BoundOperation[] {
	return [
		{ binding: CONTROL_PLANE_OPERATIONS.plans.list, handler: (input, context) => result(() =>
			dependencies.plans.list(context.principal, input.path.decisionId, input.query as Record<string, unknown>)) },
		{ binding: CONTROL_PLANE_OPERATIONS.plans.show, handler: (input, context) => result(() =>
			dependencies.plans.show(context.principal, input.path.capacityPlanId)) },
	];
}

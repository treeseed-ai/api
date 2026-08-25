import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { CapacityOperationError } from '../../repositories/capacity/capacity-operation-error.ts';
import { ControlPlaneOperationError, type BoundOperation, type OperationInvocationContext } from '../operation-registry.ts';

export interface PlanningAndEstimateOperationDependencies {
	planningAndEstimates: {
		planningStatus(principal: OperationInvocationContext['principal'], decisionId: string): Promise<Record<string, unknown>>;
		requestPlanningInput(principal: OperationInvocationContext['principal'], decisionId: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
		executionInputs(principal: OperationInvocationContext['principal'], decisionId: string, query: Record<string, unknown>): Promise<Record<string, unknown>>;
		createExecutionInput(principal: OperationInvocationContext['principal'], decisionId: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
		transitionExecutionInput(principal: OperationInvocationContext['principal'], inputId: string, status: 'accepted' | 'revision_requested', body: Record<string, unknown>): Promise<Record<string, unknown>>;
		createEstimate(principal: OperationInvocationContext['principal'], decisionId: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
		estimates(principal: OperationInvocationContext['principal'], decisionId: string, query: Record<string, unknown>): Promise<Record<string, unknown>>;
		transitionEstimate(principal: OperationInvocationContext['principal'], estimateId: string, status: 'accepted' | 'rejected', body: Record<string, unknown>): Promise<Record<string, unknown>>;
	};
}

function result<T>(call: () => T | Promise<T>) {
	return Promise.resolve().then(call).catch((error) => {
		if (error instanceof CapacityOperationError) throw new ControlPlaneOperationError(error.status as 400 | 401 | 403 | 404 | 409 | 412 | 500, error.code, error.message);
		throw error;
	});
}

export function createPlanningAndEstimateOperations(dependencies: PlanningAndEstimateOperationDependencies): BoundOperation[] {
	const service = dependencies.planningAndEstimates;
	return [
		{ binding: CONTROL_PLANE_OPERATIONS.planning.status, handler: (input, context) => result(() => service.planningStatus(context.principal, input.path.decisionId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.planning.requestInput, handler: (input, context) => result(() => service.requestPlanningInput(context.principal, input.path.decisionId, input.body as Record<string, unknown>)) },
		{ binding: CONTROL_PLANE_OPERATIONS.planning.executionInputs, handler: (input, context) => result(() => service.executionInputs(context.principal, input.path.decisionId, input.query as Record<string, unknown>)) },
		{ binding: CONTROL_PLANE_OPERATIONS.planning.createExecutionInput, handler: (input, context) => result(() => service.createExecutionInput(context.principal, input.path.decisionId, input.body as Record<string, unknown>)) },
		{ binding: CONTROL_PLANE_OPERATIONS.planning.acceptExecutionInput, handler: (input, context) => result(() => service.transitionExecutionInput(context.principal, input.path.inputId, 'accepted', input.body as Record<string, unknown>)) },
		{ binding: CONTROL_PLANE_OPERATIONS.planning.requestExecutionInputRevision, handler: (input, context) => result(() => service.transitionExecutionInput(context.principal, input.path.inputId, 'revision_requested', input.body as Record<string, unknown>)) },
		{ binding: CONTROL_PLANE_OPERATIONS.estimates.create, handler: (input, context) => result(() => service.createEstimate(context.principal, input.path.decisionId, input.body as Record<string, unknown>)) },
		{ binding: CONTROL_PLANE_OPERATIONS.estimates.list, handler: (input, context) => result(() => service.estimates(context.principal, input.path.decisionId, input.query as Record<string, unknown>)) },
		{ binding: CONTROL_PLANE_OPERATIONS.estimates.accept, handler: (input, context) => result(() => service.transitionEstimate(context.principal, input.path.estimateId, 'accepted', input.body as Record<string, unknown>)) },
		{ binding: CONTROL_PLANE_OPERATIONS.estimates.reject, handler: (input, context) => result(() => service.transitionEstimate(context.principal, input.path.estimateId, 'rejected', input.body as Record<string, unknown>)) },
	];
}

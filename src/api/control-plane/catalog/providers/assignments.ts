import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { CapacityGovernanceError } from '../../../capacity/database.ts';
import type { ProviderAssignmentService } from '../../repositories/providers/provider-assignment-service.ts';
import type { ProviderSignalService } from '../../repositories/providers/provider-signal-service.ts';
import type { ProviderWorkflowService } from '../../repositories/providers/provider-workflow-service.ts';
import { ControlPlaneOperationError, type BoundOperation } from '../operation-registry.ts';

export interface ProviderAssignmentOperationDependencies {
	providerAssignments: ProviderAssignmentService;
	providerSignals: ProviderSignalService;
	providerWorkflows: ProviderWorkflowService;
}

function result<T>(call: () => T | Promise<T>) {
	return Promise.resolve().then(call).catch((error) => {
		if (error instanceof CapacityGovernanceError) throw new ControlPlaneOperationError(error.status as 400, error.code, error.message);
		throw error;
	});
}

export function createProviderAssignmentOperations(dependencies: ProviderAssignmentOperationDependencies): BoundOperation[] {
	const { providerAssignments: assignments, providerSignals: signals, providerWorkflows: workflows } = dependencies;
	const operations = CONTROL_PLANE_OPERATIONS.providers;
	return [
		{ binding: operations.nextAssignment, handler: (input, context) => result(() => assignments.next(context.providerAuth, input.body as Record<string, unknown>, context.signal)) },
		{ binding: operations.assignment, handler: (input, context) => result(() => assignments.show(context.providerAuth, input.path.assignmentId)) },
		{ binding: operations.assignmentExplanation, handler: (input, context) => result(() => assignments.explain(context.providerAuth, input.path.assignmentId)) },
		{ binding: operations.renewAssignment, handler: (input, context) => result(() => assignments.renew(context.providerAuth, input.path.assignmentId, input.body as Record<string, unknown>)) },
		{ binding: operations.startExecution, handler: (input, context) => result(() => assignments.startExecution(context.providerAuth, input.path.assignmentId, input.body as Record<string, unknown>)) },
		{ binding: operations.startCloseout, handler: (input, context) => result(() => assignments.startCloseout(context.providerAuth, input.path.assignmentId, input.body as Record<string, unknown>)) },
		{ binding: operations.completionPreflight, handler: (input, context) => result(() => assignments.preflight(context.providerAuth, input.path.assignmentId, input.body as Record<string, unknown>)) },
		{ binding: operations.returnAssignment, handler: (input, context) => result(() => assignments.returnAssignment(context.providerAuth, input.path.assignmentId, input.body as Record<string, unknown>)) },
		{ binding: operations.completeAssignment, handler: (input, context) => result(() => assignments.complete(context.providerAuth, input.path.assignmentId, input.body as Record<string, unknown>)) },
		{ binding: operations.failAssignment, handler: (input, context) => result(() => assignments.fail(context.providerAuth, input.path.assignmentId, input.body as Record<string, unknown>)) },
		{ binding: operations.reportUsage, handler: (input, context) => result(() => assignments.reportUsage(context.providerAuth, input.path.assignmentId, input.body as Record<string, unknown>, context.idempotencyKey)) },
		{ binding: operations.settleAssignment, handler: (input, context) => result(() => assignments.settle(context.providerAuth, input.path.assignmentId, input.body as Record<string, unknown>, context.idempotencyKey)) },
		{ binding: operations.createModeRun, handler: (input, context) => result(() => assignments.createModeRun(context.providerAuth, input.path.assignmentId, input.body as Record<string, unknown>)) },
		{ binding: operations.createEvent, handler: (input, context) => result(() => assignments.createEvent(context.providerAuth, input.path.assignmentId, input.body as Record<string, unknown>)) },
		{ binding: operations.publishSignal, handler: (input, context) => result(() => signals(context.providerAuth, input.path.assignmentId, input.body as Record<string, unknown>)) },
		{ binding: operations.dispatchWorkflow, handler: (input, context) => result(() => workflows.dispatch(context.providerAuth, input.path.assignmentId, input.path.operationId, input.body as Record<string, unknown>)) },
		{ binding: operations.workflowRun, handler: (input, context) => result(() => workflows.show(context.providerAuth, input.path.assignmentId, input.path.runId)) },
	];
}

import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { CapacityOperationError } from '../../repositories/capacity/capacity-operation-error.ts';
import { ControlPlaneOperationError, type BoundOperation, type OperationInvocationContext } from '../operation-registry.ts';

type Principal = OperationInvocationContext['principal'];
type RecordValue = Record<string, unknown>;

export interface ResearchOperationDependencies {
	agentGovernance: {
		createResearch(principal: Principal, projectId: string, body: RecordValue): Promise<RecordValue>;
		researchWorkflows(principal: Principal, projectId: string, query: RecordValue): Promise<RecordValue>;
		researchWorkflow(principal: Principal, workflowId: string): Promise<RecordValue>;
		completeResearchStage(principal: Principal, workflowId: string, stage: string, body: RecordValue): Promise<RecordValue>;
	};
}

function result<T>(call: () => T | Promise<T>) {
	return Promise.resolve().then(call).catch((error) => {
		if (error instanceof CapacityOperationError) {
			throw new ControlPlaneOperationError(error.status as 400 | 401 | 403 | 404 | 409 | 412 | 500, error.code, error.message);
		}
		throw error;
	});
}

export function createResearchOperations(dependencies: ResearchOperationDependencies): BoundOperation[] {
	const service = dependencies.agentGovernance;
	return [
		{ binding: CONTROL_PLANE_OPERATIONS.research.createWorkflow, handler: (input, context) => result(() => service.createResearch(context.principal, input.path.projectId, input.body as RecordValue)) },
		{ binding: CONTROL_PLANE_OPERATIONS.research.workflows, handler: (input, context) => result(() => service.researchWorkflows(context.principal, input.path.projectId, input.query as RecordValue)) },
		{ binding: CONTROL_PLANE_OPERATIONS.research.workflow, handler: (input, context) => result(() => service.researchWorkflow(context.principal, input.path.workflowId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.research.completeStage, handler: (input, context) => result(() => service.completeResearchStage(context.principal, input.path.workflowId, input.path.stage, input.body as RecordValue)) },
	];
}

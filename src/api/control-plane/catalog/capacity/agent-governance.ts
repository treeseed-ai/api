import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { CapacityOperationError } from '../../repositories/capacity/capacity-operation-error.ts';
import { ControlPlaneOperationError, type BoundOperation, type OperationInvocationContext } from '../operation-registry.ts';

type Principal = OperationInvocationContext['principal'];
type RecordValue = Record<string, unknown>;

export interface AgentGovernanceOperationDependencies {
	agentGovernance: {
		validateAuthorities(principal: Principal, body: RecordValue): Promise<RecordValue>;
		compileGraph(principal: Principal, decisionId: string, body: RecordValue): Promise<RecordValue>;
		graphs(principal: Principal, decisionId: string, query: RecordValue): Promise<RecordValue>;
		graph(principal: Principal, graphId: string): Promise<RecordValue>;
		manifest(principal: Principal, manifestId: string): Promise<RecordValue>;
		createManifest(principal: Principal, contractId: string, body: RecordValue): Promise<RecordValue>;
		transitionContract(principal: Principal, contractId: string, status: 'approved' | 'rejected', body: RecordValue): Promise<RecordValue>;
		createResearch(principal: Principal, projectId: string, body: RecordValue): Promise<RecordValue>;
		researchWorkflows(principal: Principal, projectId: string, query: RecordValue): Promise<RecordValue>;
		researchWorkflow(principal: Principal, workflowId: string): Promise<RecordValue>;
		completeResearchStage(principal: Principal, workflowId: string, stage: string, body: RecordValue): Promise<RecordValue>;
	};
}

function result<T>(call: () => T | Promise<T>) {
	return Promise.resolve().then(call).catch((error) => {
		if (error instanceof CapacityOperationError) throw new ControlPlaneOperationError(error.status as 400 | 401 | 403 | 404 | 409 | 412 | 500, error.code, error.message);
		throw error;
	});
}

export function createAgentGovernanceOperations(dependencies: AgentGovernanceOperationDependencies): BoundOperation[] {
	const service = dependencies.agentGovernance;
	return [
		{ binding: CONTROL_PLANE_OPERATIONS.assignmentGraphs.validateAuthority, handler: (input, context) => result(() => service.validateAuthorities(context.principal, input.body as RecordValue)) },
		{ binding: CONTROL_PLANE_OPERATIONS.assignmentGraphs.compile, handler: (input, context) => result(() => service.compileGraph(context.principal, input.path.decisionId, input.body as RecordValue)) },
		{ binding: CONTROL_PLANE_OPERATIONS.assignmentGraphs.list, handler: (input, context) => result(() => service.graphs(context.principal, input.path.decisionId, input.query as RecordValue)) },
		{ binding: CONTROL_PLANE_OPERATIONS.assignmentGraphs.show, handler: (input, context) => result(() => service.graph(context.principal, input.path.graphId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.assignmentGraphs.manifest, handler: (input, context) => result(() => service.manifest(context.principal, input.path.manifestId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.assignmentGraphs.createManifest, handler: (input, context) => result(() => service.createManifest(context.principal, input.path.contractId, input.body as RecordValue)) },
		{ binding: CONTROL_PLANE_OPERATIONS.assignmentGraphs.approveContract, handler: (input, context) => result(() => service.transitionContract(context.principal, input.path.contractId, 'approved', input.body as RecordValue)) },
		{ binding: CONTROL_PLANE_OPERATIONS.assignmentGraphs.rejectContract, handler: (input, context) => result(() => service.transitionContract(context.principal, input.path.contractId, 'rejected', input.body as RecordValue)) },
		{ binding: CONTROL_PLANE_OPERATIONS.research.createWorkflow, handler: (input, context) => result(() => service.createResearch(context.principal, input.path.projectId, input.body as RecordValue)) },
		{ binding: CONTROL_PLANE_OPERATIONS.research.workflows, handler: (input, context) => result(() => service.researchWorkflows(context.principal, input.path.projectId, input.query as RecordValue)) },
		{ binding: CONTROL_PLANE_OPERATIONS.research.workflow, handler: (input, context) => result(() => service.researchWorkflow(context.principal, input.path.workflowId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.research.completeStage, handler: (input, context) => result(() => service.completeResearchStage(context.principal, input.path.workflowId, input.path.stage, input.body as RecordValue)) },
	];
}

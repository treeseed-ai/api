import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { RepositoryOperationError } from '../../repositories/repository-operation-error.ts';
import { WorkflowOperationError } from '../../repositories/workflow-operation-error.ts';
import { ControlPlaneOperationError, type BoundOperation, type OperationInvocationContext } from '../operation-registry.ts';

export interface RepositoryOperationDependencies {
	repositories: {
		topology(principal: OperationInvocationContext['principal'], projectId: string): Promise<Record<string, any>>;
		status(principal: OperationInvocationContext['principal'], projectId: string): Promise<Record<string, any>>;
		update(principal: OperationInvocationContext['principal'], projectId: string, body: Record<string, unknown>, ifMatch?: string): Promise<Record<string, any>>;
	};
	workflows: {
		operations(principal: OperationInvocationContext['principal'], projectId: string, query: Record<string, unknown>): Promise<Record<string, any>>;
		runs(principal: OperationInvocationContext['principal'], projectId: string, query: Record<string, unknown>): Promise<Record<string, any>>;
		update(principal: OperationInvocationContext['principal'], projectId: string, operationId: string, body: Record<string, unknown>, ifMatch?: string): Promise<Record<string, any>>;
		dispatch(principal: OperationInvocationContext['principal'], projectId: string, operationId: string, body: Record<string, unknown>, idempotencyKey?: string): Promise<Record<string, any>>;
		run(principal: OperationInvocationContext['principal'], runId: string): Promise<Record<string, any>>;
		cancel(principal: OperationInvocationContext['principal'], runId: string): Promise<Record<string, any>>;
		artifacts(principal: OperationInvocationContext['principal'], runId: string): Promise<Record<string, any>>;
	};
	workflowConfiguration: {
		publicKey(principal: OperationInvocationContext['principal'], projectId: string, query: Record<string, unknown>): Promise<Record<string, any>>;
		list(principal: OperationInvocationContext['principal'], projectId: string, kind: 'secrets' | 'variables', query: Record<string, unknown>): Promise<Record<string, any>>;
		put(principal: OperationInvocationContext['principal'], projectId: string, kind: 'secrets' | 'variables', name: string,
			query: Record<string, unknown>, body: Record<string, unknown>, idempotencyKey?: string, ifMatch?: string): Promise<Record<string, any>>;
		remove(principal: OperationInvocationContext['principal'], projectId: string, kind: 'secrets' | 'variables', name: string,
			query: Record<string, unknown>, idempotencyKey?: string, ifMatch?: string): Promise<Record<string, any>>;
	};
}

function result<T>(call: () => Promise<T>) {
	return call().catch((error) => {
		if (error instanceof RepositoryOperationError) throw new ControlPlaneOperationError(error.status, error.code, error.message);
		if (error instanceof WorkflowOperationError) throw new ControlPlaneOperationError(error.status, error.code, error.message);
		throw error;
	});
}

export function createRepositoryOperations(dependencies: RepositoryOperationDependencies): BoundOperation[] {
	return [
		{ binding: CONTROL_PLANE_OPERATIONS.projects.repositoryTopology,
			handler: (input, context) => result(() => dependencies.repositories.topology(context.principal, input.path.projectId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.projects.repositoryTopologyStatus,
			handler: (input, context) => result(() => dependencies.repositories.status(context.principal, input.path.projectId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.projects.updateRepositoryTopology,
			handler: (input, context) => result(() => dependencies.repositories.update(context.principal, input.path.projectId,
				input.body as Record<string, unknown>, context.ifMatch)) },
		{ binding: CONTROL_PLANE_OPERATIONS.repositories.workflowOperations,
			handler: (input, context) => result(() => dependencies.workflows.operations(context.principal, input.path.projectId, input.query)) },
		{ binding: CONTROL_PLANE_OPERATIONS.repositories.workflowRuns,
			handler: (input, context) => result(() => dependencies.workflows.runs(context.principal, input.path.projectId, input.query)) },
		{ binding: CONTROL_PLANE_OPERATIONS.repositories.updateWorkflow,
			handler: (input, context) => result(() => dependencies.workflows.update(context.principal, input.path.projectId,
				input.path.operationId, input.body as Record<string, unknown>, context.ifMatch)) },
		{ binding: CONTROL_PLANE_OPERATIONS.repositories.dispatchWorkflow,
			handler: (input, context) => result(() => dependencies.workflows.dispatch(context.principal, input.path.projectId,
				input.path.operationId, input.body as Record<string, unknown>, context.idempotencyKey)) },
		{ binding: CONTROL_PLANE_OPERATIONS.repositories.workflowRun,
			handler: (input, context) => result(() => dependencies.workflows.run(context.principal, input.path.runId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.repositories.cancelWorkflowRun,
			handler: (input, context) => result(() => dependencies.workflows.cancel(context.principal, input.path.runId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.repositories.workflowArtifacts,
			handler: (input, context) => result(() => dependencies.workflows.artifacts(context.principal, input.path.runId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.repositories.workflowPublicKey,
			handler: (input, context) => result(() => dependencies.workflowConfiguration.publicKey(context.principal, input.path.projectId, input.query)) },
		{ binding: CONTROL_PLANE_OPERATIONS.repositories.workflowSecrets,
			handler: (input, context) => result(() => dependencies.workflowConfiguration.list(context.principal, input.path.projectId, 'secrets', input.query)) },
		{ binding: CONTROL_PLANE_OPERATIONS.repositories.putWorkflowSecret,
			handler: (input, context) => result(() => dependencies.workflowConfiguration.put(context.principal, input.path.projectId,
				'secrets', input.path.name, input.body as Record<string, unknown>, input.body as Record<string, unknown>, context.idempotencyKey)) },
		{ binding: CONTROL_PLANE_OPERATIONS.repositories.deleteWorkflowSecret,
			handler: (input, context) => result(() => dependencies.workflowConfiguration.remove(context.principal, input.path.projectId,
				'secrets', input.path.name, input.body as Record<string, unknown>, context.idempotencyKey)) },
		{ binding: CONTROL_PLANE_OPERATIONS.repositories.workflowVariables,
			handler: (input, context) => result(() => dependencies.workflowConfiguration.list(context.principal, input.path.projectId, 'variables', input.query)) },
		{ binding: CONTROL_PLANE_OPERATIONS.repositories.putWorkflowVariable,
			handler: (input, context) => result(() => dependencies.workflowConfiguration.put(context.principal, input.path.projectId,
				'variables', input.path.name, input.body as Record<string, unknown>, input.body as Record<string, unknown>, context.idempotencyKey, context.ifMatch)) },
		{ binding: CONTROL_PLANE_OPERATIONS.repositories.deleteWorkflowVariable,
			handler: (input, context) => result(() => dependencies.workflowConfiguration.remove(context.principal, input.path.projectId,
				'variables', input.path.name, input.body as Record<string, unknown>, context.idempotencyKey, context.ifMatch)) },
	];
}

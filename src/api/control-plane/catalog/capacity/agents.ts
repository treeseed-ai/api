import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { CapacityOperationError } from '../../repositories/capacity/capacity-operation-error.ts';
import { ControlPlaneOperationError, type BoundOperation, type OperationInvocationContext } from '../operation-registry.ts';

type Principal = OperationInvocationContext['principal'];
export interface AgentOperationDependencies { agents: {
	list(principal: Principal, projectId: string): Promise<Record<string, unknown>>;
	show(principal: Principal, projectId: string, slug: string): Promise<Record<string, unknown>>;
	classes(principal: Principal, projectId: string, query: Record<string, unknown>): Promise<Record<string, unknown>>;
	classShow(principal: Principal, projectId: string, classId: string): Promise<Record<string, unknown>>;
	artifacts(principal: Principal, projectId: string): Promise<Record<string, unknown>>;
	artifact(principal: Principal, projectId: string, artifactId: string): Promise<Record<string, unknown>>;
}; }
function result<T>(call: () => T | Promise<T>) { return Promise.resolve().then(call).catch((error) => {
	if (error instanceof CapacityOperationError) throw new ControlPlaneOperationError(error.status, error.code, error.message);
	throw error;
}); }
export function createAgentOperations({ agents }: AgentOperationDependencies): BoundOperation[] { return [
	{ binding: CONTROL_PLANE_OPERATIONS.agents.list, handler: (input, context) => result(() => agents.list(context.principal, input.path.projectId)) },
	{ binding: CONTROL_PLANE_OPERATIONS.agents.show, handler: (input, context) => result(() => agents.show(context.principal, input.path.projectId, input.path.agentSlug)) },
	{ binding: CONTROL_PLANE_OPERATIONS.agents.classes, handler: (input, context) => result(() => agents.classes(context.principal, input.path.projectId, input.query as Record<string, unknown>)) },
	{ binding: CONTROL_PLANE_OPERATIONS.agents.classShow, handler: (input, context) => result(() => agents.classShow(context.principal, input.path.projectId, input.path.classId)) },
	{ binding: CONTROL_PLANE_OPERATIONS.agents.artifacts, handler: (input, context) => result(() => agents.artifacts(context.principal, input.path.projectId)) },
	{ binding: CONTROL_PLANE_OPERATIONS.agents.artifact, handler: (input, context) => result(() => agents.artifact(context.principal, input.path.projectId, input.path.artifactId)) },
]; }

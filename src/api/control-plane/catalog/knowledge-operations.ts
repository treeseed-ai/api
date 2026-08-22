import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { KnowledgeOperationError } from '../knowledge/knowledge-operation-error.ts';
import { ControlPlaneOperationError, type BoundOperation, type OperationInvocationContext } from './operation-registry.ts';

export interface KnowledgeOperationDependencies {
	knowledgeReader: {
		teamCatalog(principal: OperationInvocationContext['principal'], teamId: string): Promise<Record<string, any>>;
		projectCatalog(principal: OperationInvocationContext['principal'], projectId: string): Promise<Record<string, any>>;
		library(principal: OperationInvocationContext['principal'], query: Record<string, unknown>): Promise<Record<string, any>>;
		reader(principal: OperationInvocationContext['principal'], query: Record<string, unknown>): Promise<Record<string, any>>;
		context(principal: OperationInvocationContext['principal'], query: Record<string, unknown>): Promise<Record<string, any>>;
		page(principal: OperationInvocationContext['principal'], pageId: string): Promise<Record<string, any>>;
		search(principal: OperationInvocationContext['principal'], query: Record<string, unknown>): Promise<Record<string, any>>;
	};
	knowledgeWorkspaces: {
		create(principal: OperationInvocationContext['principal'], projectId: string, input: Record<string, unknown>): Promise<Record<string, any>>;
		show(principal: OperationInvocationContext['principal'], workspaceId: string): Promise<Record<string, any>>;
		readContent(principal: OperationInvocationContext['principal'], workspaceId: string, path: unknown): Promise<Record<string, any>>;
		updateContent(principal: OperationInvocationContext['principal'], workspaceId: string, input: Record<string, unknown>): Promise<Record<string, any>>;
		submit(principal: OperationInvocationContext['principal'], workspaceId: string, input: Record<string, unknown>): Promise<Record<string, any>>;
		diff(principal: OperationInvocationContext['principal'], workspaceId: string): Promise<Record<string, any>>;
		abandon(principal: OperationInvocationContext['principal'], workspaceId: string, input: Record<string, unknown>): Promise<Record<string, any>>;
	};
}

function result<T>(call: () => Promise<T>) {
	return call().catch((error) => { if (error instanceof KnowledgeOperationError) throw new ControlPlaneOperationError(error.status, error.code, error.message); throw error; });
}

export function createKnowledgeOperations(dependencies: KnowledgeOperationDependencies): BoundOperation[] {
	return [
		{ binding: CONTROL_PLANE_OPERATIONS.knowledge.teamCatalog, handler: (input, context) => result(() => dependencies.knowledgeReader.teamCatalog(context.principal, input.path.teamId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.knowledge.projectCatalog, handler: (input, context) => result(() => dependencies.knowledgeReader.projectCatalog(context.principal, input.path.projectId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.knowledge.library, handler: (input, context) => result(() => dependencies.knowledgeReader.library(context.principal, input.query)) },
		{ binding: CONTROL_PLANE_OPERATIONS.knowledge.reader, handler: (input, context) => result(() => dependencies.knowledgeReader.reader(context.principal, input.query)) },
		{ binding: CONTROL_PLANE_OPERATIONS.knowledge.context, handler: (input, context) => result(() => dependencies.knowledgeReader.context(context.principal, input.query)) },
		{ binding: CONTROL_PLANE_OPERATIONS.knowledge.page, handler: (input, context) => result(() => dependencies.knowledgeReader.page(context.principal, input.path.pageId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.knowledge.search, handler: (input, context) => result(() => dependencies.knowledgeReader.search(context.principal, input.query)) },
		{ binding: CONTROL_PLANE_OPERATIONS.knowledge.createWorkspace, handler: (input, context) => result(() => dependencies.knowledgeWorkspaces.create(context.principal, input.path.projectId, input.body as Record<string, unknown>)) },
		{ binding: CONTROL_PLANE_OPERATIONS.knowledge.workspace, handler: (input, context) => result(() => dependencies.knowledgeWorkspaces.show(context.principal, input.path.workspaceId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.knowledge.workspaceContent, handler: (input, context) => result(() => dependencies.knowledgeWorkspaces.readContent(context.principal, input.path.workspaceId, input.query.path)) },
		{ binding: CONTROL_PLANE_OPERATIONS.knowledge.updateWorkspaceContent, handler: (input, context) => result(() => dependencies.knowledgeWorkspaces.updateContent(context.principal, input.path.workspaceId, input.body as Record<string, unknown>)) },
		{ binding: CONTROL_PLANE_OPERATIONS.knowledge.workspaceDiff, handler: (input, context) => result(() => dependencies.knowledgeWorkspaces.diff(context.principal, input.path.workspaceId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.knowledge.abandonWorkspace, handler: (input, context) => result(() => dependencies.knowledgeWorkspaces.abandon(context.principal, input.path.workspaceId, input.body as Record<string, unknown>)) },
		{ binding: CONTROL_PLANE_OPERATIONS.knowledge.submitWorkspace, handler: (input, context) => result(() => dependencies.knowledgeWorkspaces.submit(context.principal, input.path.workspaceId, input.body as Record<string, unknown>)) },
	];
}

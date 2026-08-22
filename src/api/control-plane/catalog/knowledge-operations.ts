import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { KnowledgeReaderError } from '../knowledge/knowledge-reader-service.ts';
import { ControlPlaneOperationError, type BoundOperation, type OperationInvocationContext } from './operation-registry.ts';

export interface KnowledgeOperationDependencies {
	knowledgeReader: {
		library(principal: OperationInvocationContext['principal'], query: Record<string, unknown>): Promise<Record<string, any>>;
		reader(principal: OperationInvocationContext['principal'], query: Record<string, unknown>): Promise<Record<string, any>>;
		context(principal: OperationInvocationContext['principal'], query: Record<string, unknown>): Promise<Record<string, any>>;
		page(principal: OperationInvocationContext['principal'], pageId: string): Promise<Record<string, any>>;
		search(principal: OperationInvocationContext['principal'], query: Record<string, unknown>): Promise<Record<string, any>>;
	};
}

function result<T>(call: () => Promise<T>) {
	return call().catch((error) => { if (error instanceof KnowledgeReaderError) throw new ControlPlaneOperationError(error.status, error.code, error.message); throw error; });
}

export function createKnowledgeOperations(dependencies: KnowledgeOperationDependencies): BoundOperation[] {
	return [
		{ binding: CONTROL_PLANE_OPERATIONS.knowledge.library, handler: (input, context) => result(() => dependencies.knowledgeReader.library(context.principal, input.query)) },
		{ binding: CONTROL_PLANE_OPERATIONS.knowledge.reader, handler: (input, context) => result(() => dependencies.knowledgeReader.reader(context.principal, input.query)) },
		{ binding: CONTROL_PLANE_OPERATIONS.knowledge.context, handler: (input, context) => result(() => dependencies.knowledgeReader.context(context.principal, input.query)) },
		{ binding: CONTROL_PLANE_OPERATIONS.knowledge.page, handler: (input, context) => result(() => dependencies.knowledgeReader.page(context.principal, input.path.pageId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.knowledge.search, handler: (input, context) => result(() => dependencies.knowledgeReader.search(context.principal, input.query)) },
	];
}

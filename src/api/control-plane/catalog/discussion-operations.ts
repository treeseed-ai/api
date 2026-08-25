import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { DiscussionServiceError } from '../../discussions/discussion-service.ts';
import { ControlPlaneOperationError, type BoundOperation, type OperationInvocationContext } from './operation-registry.ts';

export interface DiscussionOperationDependencies {
	discussions: {
		list(principal: OperationInvocationContext['principal'], query: Record<string, unknown>): Promise<Record<string, any>>;
		create(principal: OperationInvocationContext['principal'], body: Record<string, unknown>, idempotencyKey?: string): Promise<Record<string, any>>;
		updateStatus(principal: OperationInvocationContext['principal'], discussionId: string, body: Record<string, unknown>, idempotencyKey?: string): Promise<Record<string, any>>;
	};
}

function result<T>(call: () => Promise<T>) {
	return call().catch((error) => {
		if (error instanceof DiscussionServiceError) throw new ControlPlaneOperationError(error.status, error.code, error.message);
		throw error;
	});
}

export function createDiscussionOperations(dependencies: DiscussionOperationDependencies): BoundOperation[] {
	return [
		{ binding: CONTROL_PLANE_OPERATIONS.discussions.list,
			handler: (input, context) => result(() => dependencies.discussions.list(context.principal, input.query)) },
		{ binding: CONTROL_PLANE_OPERATIONS.discussions.create,
			handler: (input, context) => result(() => dependencies.discussions.create(context.principal, input.body as Record<string, unknown>, context.idempotencyKey)) },
		{ binding: CONTROL_PLANE_OPERATIONS.discussions.updateStatus,
			handler: (input, context) => result(() => dependencies.discussions.updateStatus(context.principal, input.path.discussionId,
				input.body as Record<string, unknown>, context.idempotencyKey)) },
	];
}

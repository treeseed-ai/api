import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { FeedbackOperationError } from '../../feedback/feedback-operation-error.ts';
import { ControlPlaneOperationError, type BoundOperation, type OperationInvocationContext } from '../operation-registry.ts';
type Principal = OperationInvocationContext['principal'];
export interface FeedbackOperationDependencies { feedback: {
	create(principal: Principal, body: Record<string, unknown>, idempotencyKey?: string, requestUrl?: string, requestHeaders?: Readonly<Record<string, string>>): Promise<Record<string, unknown>>;
	list(principal: Principal, query: Record<string, unknown>): Promise<Record<string, unknown>>;
	show(principal: Principal, id: string): Promise<Record<string, unknown>>;
	updateStatus(principal: Principal, id: string, body: Record<string, unknown>, ifMatch?: string): Promise<Record<string, unknown>>;
}; }
function result<T>(call: () => T | Promise<T>) { return Promise.resolve().then(call).catch((error) => {
	if (error instanceof FeedbackOperationError) throw new ControlPlaneOperationError(error.status, error.code, error.message);
	throw error;
}); }
export function createFeedbackOperations({ feedback }: FeedbackOperationDependencies): BoundOperation[] { return [
	{ binding: CONTROL_PLANE_OPERATIONS.feedback.create, handler: (input, context) => result(() => feedback.create(context.principal, input.body as Record<string, unknown>, context.idempotencyKey, context.requestUrl, context.requestHeaders)) },
	{ binding: CONTROL_PLANE_OPERATIONS.feedback.list, handler: (input, context) => result(() => feedback.list(context.principal, input.query as Record<string, unknown>)) },
	{ binding: CONTROL_PLANE_OPERATIONS.feedback.show, handler: (input, context) => result(() => feedback.show(context.principal, input.path.feedbackId)) },
	{ binding: CONTROL_PLANE_OPERATIONS.feedback.updateStatus, handler: (input, context) => result(() => feedback.updateStatus(context.principal, input.path.feedbackId, input.body as Record<string, unknown>, context.ifMatch)) },
]; }

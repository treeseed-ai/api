import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { RealtimeOperationError } from '../../realtime/realtime-operation-error.ts';
import { ControlPlaneOperationError, type BoundOperation, type OperationInvocationContext } from '../operation-registry.ts';

type Principal = OperationInvocationContext['principal'];
export interface RealtimeOperationDependencies { realtime: {
	events(principal: Principal, query: Record<string, unknown>): Promise<Record<string, unknown>>;
	createSession(principal: Principal, body: Record<string, unknown>): Promise<Record<string, unknown>>;
	heartbeat(principal: Principal, sessionId: string): Promise<Record<string, unknown>>;
	actions(principal: Principal, sessionId: string): Promise<Record<string, unknown>>;
	actionResult(principal: Principal, sessionId: string, actionId: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
}; }
function result<T>(call: () => T | Promise<T>) { return Promise.resolve().then(call).catch((error) => {
	if (error instanceof RealtimeOperationError) throw new ControlPlaneOperationError(error.status, error.code, error.message);
	throw error;
}); }
export function createRealtimeOperations({ realtime }: RealtimeOperationDependencies): BoundOperation[] { return [
	{ binding: CONTROL_PLANE_OPERATIONS.realtime.events, handler: (input, context) => result(() => realtime.events(context.principal, input.query as Record<string, unknown>)) },
	{ binding: CONTROL_PLANE_OPERATIONS.realtime.createSession, handler: (input, context) => result(() => realtime.createSession(context.principal, input.body as Record<string, unknown>)) },
	{ binding: CONTROL_PLANE_OPERATIONS.realtime.heartbeat, handler: (input, context) => result(() => realtime.heartbeat(context.principal, input.path.sessionId)) },
	{ binding: CONTROL_PLANE_OPERATIONS.realtime.actions, handler: (input, context) => result(() => realtime.actions(context.principal, input.path.sessionId)) },
	{ binding: CONTROL_PLANE_OPERATIONS.realtime.actionResult, handler: (input, context) => result(() => realtime.actionResult(context.principal, input.path.sessionId, input.path.actionId, input.body as Record<string, unknown>)) },
]; }

import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { CapacityOperationError } from '../../repositories/capacity/capacity-operation-error.ts';
import { ControlPlaneOperationError, type BoundOperation, type OperationInvocationContext } from '../operation-registry.ts';

type Principal = OperationInvocationContext['principal'];
type RecordValue = Record<string, unknown>;

export interface CommunicationOperationDependencies {
	communications: {
		send(principal: Principal, teamId: string, channel: string, body: RecordValue, idempotencyKey?: string): Promise<RecordValue>;
		sendStatus(principal: Principal, teamId: string, sendId: string, query?: RecordValue): Promise<RecordValue>;
		topics(principal: Principal, teamId: string, query: RecordValue): Promise<RecordValue>;
		topic(principal: Principal, teamId: string, channel: string): Promise<RecordValue>;
		timeline(principal: Principal, teamId: string, channel: string, query: RecordValue): Promise<RecordValue>;
		subscribe(principal: Principal, teamId: string, channel: string, body: RecordValue): Promise<RecordValue>;
		unsubscribe(principal: Principal, teamId: string, channel: string, body: RecordValue): Promise<RecordValue>;
		invocations(principal: Principal, teamId: string, query: RecordValue): Promise<RecordValue>;
		invocation(principal: Principal, teamId: string, invocationId: string): Promise<RecordValue>;
		status(principal: Principal, teamId: string): Promise<RecordValue>;
		records(principal: Principal, teamId: string, table: 'agent_operation_handoffs' | 'agent_client_actions', query: RecordValue): Promise<RecordValue>;
		cancel(principal: Principal, teamId: string, invocationId: string, body: RecordValue, idempotencyKey?: string, ifMatch?: string): Promise<RecordValue>;
	};
}

function result<T>(call: () => T | Promise<T>) {
	return Promise.resolve().then(call).catch((error) => {
		if (error instanceof CapacityOperationError) throw new ControlPlaneOperationError(error.status as 400 | 401 | 403 | 404 | 409 | 412 | 500, error.code, error.message);
		throw error;
	});
}

export function createCommunicationOperations(dependencies: CommunicationOperationDependencies): BoundOperation[] {
	const service = dependencies.communications;
	return [
		{ binding: CONTROL_PLANE_OPERATIONS.communications.send, handler: (input, context) => result(() => service.send(context.principal, input.path.teamId, input.path.channel, input.body as RecordValue, context.idempotencyKey)) },
		{ binding: CONTROL_PLANE_OPERATIONS.communications.sendStatus, handler: (input, context) => result(() => service.sendStatus(context.principal, input.path.teamId, input.path.sendId, input.query as RecordValue)) },
		{ binding: CONTROL_PLANE_OPERATIONS.communications.topicsList, handler: (input, context) => result(() => service.topics(context.principal, input.path.teamId, input.query as RecordValue)) },
		{ binding: CONTROL_PLANE_OPERATIONS.communications.topicsShow, handler: (input, context) => result(() => service.topic(context.principal, input.path.teamId, input.path.channel)) },
		{ binding: CONTROL_PLANE_OPERATIONS.communications.topicsTimeline, handler: (input, context) => result(() => service.timeline(context.principal, input.path.teamId, input.path.channel, input.query as RecordValue)) },
		{ binding: CONTROL_PLANE_OPERATIONS.communications.topicsSubscribe, handler: (input, context) => result(() => service.subscribe(context.principal, input.path.teamId, input.path.channel, input.body as RecordValue)) },
		{ binding: CONTROL_PLANE_OPERATIONS.communications.topicsUnsubscribe, handler: (input, context) => result(() => service.unsubscribe(context.principal, input.path.teamId, input.path.channel, input.body as RecordValue)) },
		{ binding: CONTROL_PLANE_OPERATIONS.communications.invocations, handler: (input, context) => result(() => service.invocations(context.principal, input.path.teamId, input.query as RecordValue)) },
		{ binding: CONTROL_PLANE_OPERATIONS.communications.invocation, handler: (input, context) => result(() => service.invocation(context.principal, input.path.teamId, input.path.invocationId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.communications.status, handler: (input, context) => result(() => service.status(context.principal, input.path.teamId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.communications.handoffs, handler: (input, context) => result(() => service.records(context.principal, input.path.teamId, 'agent_operation_handoffs', input.query as RecordValue)) },
		{ binding: CONTROL_PLANE_OPERATIONS.communications.clientActions, handler: (input, context) => result(() => service.records(context.principal, input.path.teamId, 'agent_client_actions', input.query as RecordValue)) },
		{ binding: CONTROL_PLANE_OPERATIONS.communications.cancelInvocation, handler: (input, context) => result(() => service.cancel(context.principal,
			input.path.teamId, input.path.invocationId, input.body as RecordValue, context.idempotencyKey, context.ifMatch)) },
	];
}

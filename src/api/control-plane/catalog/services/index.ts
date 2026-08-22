import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { ServiceOperationError } from '../../repositories/service-operation-error.ts';
import { ControlPlaneOperationError, type BoundOperation, type OperationInvocationContext } from '../operation-registry.ts';

export interface ServiceOperationDependencies {
	services: {
		providers(): Record<string, any>;
		connections(principal: OperationInvocationContext['principal'], teamId: string): Promise<Record<string, any>>;
		connection(principal: OperationInvocationContext['principal'], teamId: string, connectionId: string): Promise<Record<string, any>>;
		create(principal: OperationInvocationContext['principal'], teamId: string, body: Record<string, unknown>): Promise<Record<string, any>>;
		update(principal: OperationInvocationContext['principal'], teamId: string, connectionId: string,
			body: Record<string, unknown>, ifMatch?: string): Promise<Record<string, any>>;
		disconnect(principal: OperationInvocationContext['principal'], teamId: string, connectionId: string, ifMatch?: string): Promise<Record<string, any>>;
		authorities(principal: OperationInvocationContext['principal'], teamId: string, connectionId: string): Promise<Record<string, any>>;
		putAuthority(principal: OperationInvocationContext['principal'], teamId: string, connectionId: string, profileId: string,
			body: Record<string, unknown>, ifMatch?: string): Promise<Record<string, any>>;
	};
}

function result<T>(call: () => T | Promise<T>) {
	return Promise.resolve().then(call).catch((error) => {
		if (error instanceof ServiceOperationError) throw new ControlPlaneOperationError(error.status, error.code, error.message);
		throw error;
	});
}

export function createServiceOperations(dependencies: ServiceOperationDependencies): BoundOperation[] {
	const services = dependencies.services;
	return [
		{ binding: CONTROL_PLANE_OPERATIONS.services.providers, handler: () => result(() => services.providers()) },
		{ binding: CONTROL_PLANE_OPERATIONS.services.connections,
			handler: (input, context) => result(() => services.connections(context.principal, input.path.teamId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.services.connection,
			handler: (input, context) => result(() => services.connection(context.principal, input.path.teamId, input.path.connectionId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.services.createConnection,
			handler: (input, context) => result(() => services.create(context.principal, input.path.teamId, input.body as Record<string, unknown>)) },
		{ binding: CONTROL_PLANE_OPERATIONS.services.updateConnection,
			handler: (input, context) => result(() => services.update(context.principal, input.path.teamId, input.path.connectionId,
				input.body as Record<string, unknown>, context.ifMatch)) },
		{ binding: CONTROL_PLANE_OPERATIONS.services.disconnect,
			handler: (input, context) => result(() => services.disconnect(context.principal, input.path.teamId, input.path.connectionId, context.ifMatch)) },
		{ binding: CONTROL_PLANE_OPERATIONS.services.authorities,
			handler: (input, context) => result(() => services.authorities(context.principal, input.path.teamId, input.path.connectionId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.services.putAuthority,
			handler: (input, context) => result(() => services.putAuthority(context.principal, input.path.teamId, input.path.connectionId,
				input.path.profileId, input.body as Record<string, unknown>, context.ifMatch)) },
	];
}

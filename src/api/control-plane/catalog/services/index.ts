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
		userVaultKey(principal: OperationInvocationContext['principal']): Promise<Record<string, any> | null>;
		putUserVaultKey(principal: OperationInvocationContext['principal'], body: Record<string, unknown>): Promise<Record<string, any>>;
		teamVault(principal: OperationInvocationContext['principal'], teamId: string): Promise<Record<string, any> | null>;
		initializeTeamVault(principal: OperationInvocationContext['principal'], teamId: string, body: Record<string, unknown>): Promise<Record<string, any>>;
		resetTeamVault(principal: OperationInvocationContext['principal'], teamId: string, body: Record<string, unknown>): Promise<Record<string, any>>;
		rotateTeamVault(principal: OperationInvocationContext['principal'], teamId: string, body: Record<string, unknown>): Promise<Record<string, any>>;
		grantCandidates(principal: OperationInvocationContext['principal'], teamId: string): Promise<Record<string, any>[]>;
		createGrant(principal: OperationInvocationContext['principal'], teamId: string, body: Record<string, unknown>): Promise<Record<string, any>>;
		deleteGrant(principal: OperationInvocationContext['principal'], teamId: string, grantId: string): Promise<Record<string, any>>;
		credentialEnvelopes(principal: OperationInvocationContext['principal'], teamId: string, connectionId?: string): Promise<Record<string, any>[]>;
		putCredentialEnvelope(principal: OperationInvocationContext['principal'], teamId: string, connectionId: string, body: Record<string, unknown>): Promise<Record<string, any>>;
		createLease(principal: OperationInvocationContext['principal'], teamId: string, body: Record<string, unknown>): Promise<Record<string, any>>;
		operationLease(principal: OperationInvocationContext['principal'], teamId: string, leaseId: string): Promise<Record<string, any>>;
		putLeasePayload(principal: OperationInvocationContext['principal'], teamId: string, leaseId: string, body: Record<string, unknown>): Promise<Record<string, any>>;
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
		{ binding: CONTROL_PLANE_OPERATIONS.services.userVaultKey, handler: (_input, context) => result(() => services.userVaultKey(context.principal)) },
		{ binding: CONTROL_PLANE_OPERATIONS.services.putUserVaultKey, handler: (input, context) => result(() => services.putUserVaultKey(context.principal, input.body as Record<string, unknown>)) },
		{ binding: CONTROL_PLANE_OPERATIONS.services.teamVault, handler: (input, context) => result(() => services.teamVault(context.principal, input.path.teamId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.services.initializeTeamVault, handler: (input, context) => result(() => services.initializeTeamVault(context.principal, input.path.teamId, input.body as Record<string, unknown>)) },
		{ binding: CONTROL_PLANE_OPERATIONS.services.resetTeamVault, handler: (input, context) => result(() => services.resetTeamVault(context.principal, input.path.teamId, input.body as Record<string, unknown>)) },
		{ binding: CONTROL_PLANE_OPERATIONS.services.rotateTeamVault, handler: (input, context) => result(() => services.rotateTeamVault(context.principal, input.path.teamId, input.body as Record<string, unknown>)) },
		{ binding: CONTROL_PLANE_OPERATIONS.services.vaultGrantCandidates, handler: (input, context) => result(() => services.grantCandidates(context.principal, input.path.teamId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.services.createVaultGrant, handler: (input, context) => result(() => services.createGrant(context.principal, input.path.teamId, input.body as Record<string, unknown>)) },
		{ binding: CONTROL_PLANE_OPERATIONS.services.deleteVaultGrant, handler: (input, context) => result(() => services.deleteGrant(context.principal, input.path.teamId, input.path.grantId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.services.vaultCredentialEnvelopes, handler: (input, context) => result(() => services.credentialEnvelopes(context.principal, input.path.teamId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.services.credentialEnvelopes, handler: (input, context) => result(() => services.credentialEnvelopes(context.principal, input.path.teamId, input.path.connectionId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.services.putCredentialEnvelope, handler: (input, context) => result(() => services.putCredentialEnvelope(context.principal, input.path.teamId, input.path.connectionId, input.body as Record<string, unknown>)) },
		{ binding: CONTROL_PLANE_OPERATIONS.services.createOperationLease, handler: (input, context) => result(() => services.createLease(context.principal, input.path.teamId, input.body as Record<string, unknown>)) },
		{ binding: CONTROL_PLANE_OPERATIONS.services.operationLease, handler: (input, context) => result(() => services.operationLease(context.principal, input.path.teamId, input.path.leaseId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.services.putOperationLeasePayload, handler: (input, context) => result(() => services.putLeasePayload(context.principal, input.path.teamId, input.path.leaseId, input.body as Record<string, unknown>)) },
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

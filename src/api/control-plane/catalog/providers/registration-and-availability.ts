import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { CapacityGovernanceError } from '../../../capacity/database.ts';
import type { ProviderRuntimeService } from '../../repositories/providers/provider-runtime-service.ts';
import { ControlPlaneOperationError, type BoundOperation } from '../operation-registry.ts';

export interface ProviderOperationDependencies { providers: ProviderRuntimeService; }

function result<T>(call: () => T | Promise<T>) {
	return Promise.resolve().then(call).catch((error) => {
		if (error instanceof CapacityGovernanceError) throw new ControlPlaneOperationError(error.status as 400, error.code, error.message);
		throw error;
	});
}

export function createProviderRegistrationAndAvailabilityOperations({ providers }: ProviderOperationDependencies): BoundOperation[] {
	const operations = CONTROL_PLANE_OPERATIONS.providers;
	return [
		{ binding: operations.list, handler: (input, context) => result(() => providers.list(context.principal, input.path.teamId, input.query as Record<string, unknown>)) },
		{ binding: operations.show, handler: (input, context) => result(() => providers.show(context.principal, input.path.teamId, input.path.providerId)) },
		{ binding: operations.status, handler: (input, context) => result(() => providers.status(context.principal, input.path.teamId, input.path.providerId)) },
		{ binding: operations.diagnose, handler: (input, context) => result(() => providers.diagnose(context.principal, input.path.teamId, input.path.providerId)) },
		{ binding: operations.connect, handler: (_input, context) => result(() => providers.connect(context.principal, _input.path.teamId, context.idempotencyKey)) },
		{ binding: operations.registrationCode.status, handler: (input, context) => result(() => providers.registrationCodeStatus(context.principal, input.path.teamId)) },
		{ binding: operations.registrationCode.reveal, handler: (input, context) => result(() => providers.revealRegistrationCode(context.principal, input.path.teamId)) },
		{ binding: operations.registrationCode.rotate, handler: (input, context) => result(() => providers.rotateRegistrationCode(context.principal, input.path.teamId, context.idempotencyKey, context.ifMatch)) },
		{ binding: operations.disconnect, handler: (input, context) => result(() => providers.disconnect(context.principal, input.path.teamId, input.path.connectionId, context.idempotencyKey)) },
		{ binding: operations.requests.list, handler: (input, context) => result(() => providers.requests(context.principal, input.path.teamId, input.query as Record<string, unknown>)) },
		{ binding: operations.requests.show, handler: (input, context) => result(() => providers.request(context.principal, input.path.teamId, input.path.requestId)) },
		{ binding: operations.requests.approve, handler: (input, context) => result(() => providers.approve(context.principal, input.path.teamId, input.path.requestId, input.body as Record<string, unknown>, context.idempotencyKey)) },
		{ binding: operations.requests.reject, handler: (input, context) => result(() => providers.reject(context.principal, input.path.teamId, input.path.requestId, input.body as Record<string, unknown>, context.idempotencyKey)) },
		{ binding: operations.credentials.status, handler: (input, context) => result(() => providers.credentials(context.principal, input.path.teamId, input.path.connectionId)) },
		{ binding: operations.credentials.rotate, handler: (input, context) => result(() => providers.rotateCredentials(context.principal, input.path.teamId, input.path.connectionId, context.idempotencyKey)) },
		{ binding: operations.credentials.revoke, handler: (input, context) => result(() => providers.revokeCredentials(context.principal, input.path.teamId, input.path.connectionId, context.idempotencyKey)) },
		{ binding: operations.environmentProfiles.list, handler: (input, context) => result(() => providers.environmentProfiles.list(context.principal, input.path.teamId, input.path.providerId, input.query as Record<string, unknown>)) },
		{ binding: operations.environmentProfiles.show, handler: (input, context) => result(() => providers.environmentProfiles.show(context.principal, input.path.teamId, input.path.providerId, input.path.profileId)) },
		{ binding: operations.environmentProfiles.publish, handler: (input, context) => result(() => providers.environmentProfiles.publish(context.providerAuth, input.path.profileId, input.body as Record<string, unknown>)) },
		{ binding: operations.environmentGrants.show, handler: (input, context) => result(() => providers.environmentProfiles.showGrant(context.principal, input.path.teamId, input.path.assignmentId)) },
		{ binding: operations.environmentGrants.put, handler: (input, context) => result(() => providers.environmentProfiles.putGrant(context.principal, input.path.teamId, input.path.assignmentId, input.body as Record<string, unknown>, context.ifMatch)) },
		{ binding: operations.environmentGrants.revoke, handler: (input, context) => result(() => providers.environmentProfiles.revokeGrant(context.principal, input.path.teamId, input.path.assignmentId, context.ifMatch)) },
		{ binding: operations.register, handler: (input, context) => result(() => providers.register(input.body as Record<string, unknown>, context.requestHeaders, context.idempotencyKey)) },
		{ binding: operations.registration, handler: (input, context) => result(() => providers.registration(input.path.requestId, context.requestHeaders)) },
		{ binding: operations.exchangeCredential, handler: (input, context) => result(() => providers.exchangeCredential(input.path.requestId, input.body as Record<string, unknown>, context.idempotencyKey)) },
		{ binding: operations.issueAccessToken, handler: (input, context) => result(() => providers.issueAccessToken(input.body as Record<string, unknown>, context.requestHeaders, context.idempotencyKey)) },
		{ binding: operations.leaveMembership, handler: (_input, context) => result(() => providers.leave(context.providerAuth, context.idempotencyKey)) },
		{ binding: operations.rotateIdentity, handler: (input, context) => result(() => providers.rotateIdentity(context.providerAuth, input.body as Record<string, unknown>, context.idempotencyKey)) },
		{ binding: operations.rotateCredential, handler: (_input, context) => result(() => providers.rotateCredential(context.providerAuth, context.idempotencyKey)) },
		{ binding: operations.createAvailability, handler: (input, context) => result(() => providers.createAvailability(context.providerAuth, input.body as Record<string, unknown>)) },
		{ binding: operations.refreshAvailability, handler: (input, context) => result(() => providers.refreshAvailability(context.providerAuth, input.path.sessionId, input.body as Record<string, unknown>)) },
		{ binding: operations.closeAvailability, handler: (input, context) => result(() => providers.closeAvailability(context.providerAuth, input.path.sessionId)) },
	];
}

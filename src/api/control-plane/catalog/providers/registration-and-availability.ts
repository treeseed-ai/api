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

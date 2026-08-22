import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { ControlPlaneOperationError, type BoundOperation } from './operation-registry.ts';

export interface AccountOperationDependencies {
	store: {
		listTeamsForPrincipal(principal: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
	};
}

export function createCurrentAccountOperation(
	dependencies: AccountOperationDependencies,
): BoundOperation<typeof CONTROL_PLANE_OPERATIONS.accounts.current> {
	return {
		binding: CONTROL_PLANE_OPERATIONS.accounts.current,
		async handler(_input, context) {
			if (!context.principal) {
				throw new ControlPlaneOperationError(401, 'authentication_required', 'Authentication is required.');
			}
			return {
				principal: context.principal,
				teams: await dependencies.store.listTeamsForPrincipal(context.principal),
			};
		},
	};
}

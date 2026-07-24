import type { Context } from 'hono';
import { CapacityGovernanceError } from '../../../database.ts';

export interface CapacityProviderAccessPrincipal {
	membershipId: string;
	teamId: string;
	capacityProviderId: string;
	scopes: string[];
}

export function requireProviderPrincipal(c: Context, requiredScopes: string[]): CapacityProviderAccessPrincipal {
	const auth = c.get('capacityProviderAccessAuth') as { principal?: CapacityProviderAccessPrincipal } | null;
	if (!auth?.principal) {
		throw new CapacityGovernanceError('provider_access_token_required', 'Provider membership access token is required.', 401);
	}
	const missingScopes = requiredScopes.filter((scope) => !auth.principal!.scopes.includes(scope));
	if (missingScopes.length > 0) {
		throw new CapacityGovernanceError(
			'provider_scope_required',
			'Provider token does not include the required scope.',
			403,
			{ requiredScopes, missingScopes },
		);
	}
	return auth.principal;
}

import type { AuthInfo } from '@modelcontextprotocol/server';
import type { ControlPlaneOperationDescriptor } from '@treeseed/sdk/operator-contracts';
import { ControlPlaneOperationError } from '../catalog/operation-registry.ts';

export function enforceOperationAuthorization(
	descriptor: ControlPlaneOperationDescriptor,
	authInfo: AuthInfo | undefined,
	options: { providerAuthenticated?: boolean } = {},
) {
	if (descriptor.authentication === 'anonymous' || descriptor.authentication === 'signed_request') return;
	if (descriptor.authentication === 'provider') {
		if (options.providerAuthenticated) return;
		throw new ControlPlaneOperationError(401, 'provider_authentication_required', 'The operation requires provider authentication.');
	}
	if (!authInfo && descriptor.authentication === 'oauth_or_provider' && options.providerAuthenticated) return;
	if (!authInfo) throw new ControlPlaneOperationError(401, 'authentication_required', 'The operation requires authentication.');
	const missingScope = descriptor.oauthScopes.find((scope) => !authInfo.scopes.includes(scope));
	if (missingScope) throw new ControlPlaneOperationError(403, 'oauth_scope_insufficient', `The operation requires ${missingScope}.`);
}

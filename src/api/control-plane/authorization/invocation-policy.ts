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

/** Apply the descriptor's write guards before either transport dispatches work. */
export function readOperationPreconditions(descriptor: ControlPlaneOperationDescriptor, headers?: Headers, supplied?: Record<string, string>) {
	const read = (name: string) => {
		const transport = headers?.get(name) ?? undefined, argument = supplied?.[name]?.trim();
		if (transport !== undefined && argument !== undefined && transport !== argument) {
			throw new ControlPlaneOperationError(409, 'operation_metadata_conflict', `Conflicting ${name} values in HTTP headers and tool arguments.`);
		}
		return argument ?? transport;
	};
	const idempotencyKey = read(descriptor.idempotency.header)
		?? (descriptor.operationId === 'repositories.github.webhook' ? headers?.get('x-github-delivery') : undefined)
		?? undefined;
	const ifMatch = read(descriptor.concurrency.writeHeader);
	if (descriptor.idempotency.required && !idempotencyKey) {
		throw new ControlPlaneOperationError(400, 'idempotency_key_required', `${descriptor.idempotency.header} is required.`);
	}
	if (descriptor.concurrency.required && !ifMatch) {
		throw new ControlPlaneOperationError(412, 'precondition_required', `${descriptor.concurrency.writeHeader} is required.`);
	}
	return { idempotencyKey, ifMatch: ifMatch?.replace(/^"|"$/gu, '') };
}

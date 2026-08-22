import type {
	CapacityProviderIdentityRotationRequest,
	CapacityProviderSignedProof,
	ProviderRegistrationSubmission,
} from '@treeseed/sdk/capacity-provider/contracts';
import type { CapacityGovernanceDatabase } from '../../../capacity/database.ts';
import { CapacityGovernanceError } from '../../../capacity/database.ts';
import { CapacityGovernanceRepository } from '../../../capacity/repositories/governance/policy/governance.ts';
import { CapacitySecretCodec } from '../../../capacity/security.ts';
import { AvailabilitySessionService } from '../../../capacity/services/accounts/availability-session-service.ts';
import { CapacityRegistrationService } from '../../../capacity/services/support/registration-service.ts';

export interface ProviderPrincipal {
	membershipId: string;
	teamId: string;
	capacityProviderId: string;
	scopes: string[];
}

type ProviderAuth = { principal?: ProviderPrincipal } | null | undefined;

function credential(headers: Readonly<Record<string, string>> | undefined, scheme: string) {
	const value = headers?.authorization?.trim() ?? '';
	return value.startsWith(`${scheme} `) ? value.slice(scheme.length + 1).trim() : '';
}

function proofHeader(headers: Readonly<Record<string, string>> | undefined): CapacityProviderSignedProof {
	const value = headers?.['x-treeseed-provider-proof']?.trim();
	if (!value) throw new CapacityGovernanceError('provider_proof_required', 'X-Treeseed-Provider-Proof is required.', 401);
	try { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as CapacityProviderSignedProof; }
	catch { throw new CapacityGovernanceError('provider_proof_invalid', 'X-Treeseed-Provider-Proof is invalid.', 401); }
}

export function providerPrincipal(auth: unknown, requiredScopes: string[]): ProviderPrincipal {
	const principal = (auth as ProviderAuth)?.principal;
	if (!principal) throw new CapacityGovernanceError('provider_access_token_required', 'Provider membership access token is required.', 401);
	const missingScopes = requiredScopes.filter((scope) => !principal.scopes.includes(scope));
	if (missingScopes.length) throw new CapacityGovernanceError('provider_scope_required', 'Provider token does not include the required scope.', 403, { requiredScopes, missingScopes });
	return principal;
}

function identityRotation(body: Record<string, unknown>): CapacityProviderIdentityRotationRequest {
	if (!Number.isInteger(body.expectedIdentityVersion) || !body.newPublicJwk || typeof body.newPublicJwk !== 'object'
		|| !body.oldProof || typeof body.oldProof !== 'object' || !body.newProof || typeof body.newProof !== 'object') {
		throw new CapacityGovernanceError('provider_identity_rotation_invalid', 'Identity rotation requires the expected version, new public key, and both signed proofs.', 400);
	}
	return body as unknown as CapacityProviderIdentityRotationRequest;
}

export function createProviderRuntimeService(store: CapacityGovernanceDatabase, config: Record<string, unknown>) {
	const environment = String(config.environment ?? process.env.TREESEED_ENVIRONMENT ?? 'local');
	const secretSource = config.capacityGovernanceSecret ?? config.TREESEED_CAPACITY_GOVERNANCE_SECRET
		?? process.env.TREESEED_CAPACITY_GOVERNANCE_SECRET
		?? (['local', 'test'].includes(environment) ? 'treeseed-local-capacity-governance-secret' : config.authSecret ?? process.env.TREESEED_AUTH_SECRET);
	if (!secretSource && !['local', 'test'].includes(environment)) throw new Error('TREESEED_CAPACITY_GOVERNANCE_SECRET is required outside local/test environments.');
	const rawSecret = String(secretSource ?? 'treeseed-local-capacity-governance-secret');
	if (rawSecret.trim().length < 24 && !['local', 'test'].includes(environment)) throw new Error('TREESEED_CAPACITY_GOVERNANCE_SECRET must contain at least 24 characters.');
	const configuredSecret = rawSecret.trim().length >= 24 ? rawSecret : `treeseed-local:${rawSecret}:capacity-governance`;
	const audience = String(config.baseUrl ?? process.env.TREESEED_API_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/u, '');
	const registration = new CapacityRegistrationService(new CapacityGovernanceRepository(store), new CapacitySecretCodec(configuredSecret), audience);
	const availability = new AvailabilitySessionService(store);
	return {
		authenticator: registration,
		async register(body: Record<string, unknown>, headers: Readonly<Record<string, string>> | undefined, idempotencyKey = '') {
			const key = credential(headers, 'Treeseed-Registration');
			if (!key) throw new CapacityGovernanceError('registration_key_required', 'Treeseed-Registration authorization is required.', 401);
			const clientAddress = headers?.['cf-connecting-ip'] || headers?.['x-forwarded-for']?.split(',')[0]?.trim() || 'local';
			return registration.submitRegistration(key, body as unknown as ProviderRegistrationSubmission, '/v1/provider-registrations', idempotencyKey, clientAddress);
		},
		registration(requestId: string, headers: Readonly<Record<string, string>> | undefined) {
			return registration.registrationStatus(requestId, proofHeader(headers), `/v1/provider-registrations/${encodeURIComponent(requestId)}`);
		},
		exchangeCredential(requestId: string, body: Record<string, unknown>, idempotencyKey = '') {
			if (!body.proof) throw new CapacityGovernanceError('provider_proof_required', 'Provider proof is required.', 401);
			return registration.exchangeCredential(requestId, body.proof as CapacityProviderSignedProof, `/v1/provider-registrations/${encodeURIComponent(requestId)}/credential`, idempotencyKey);
		},
		issueAccessToken(body: Record<string, unknown>, headers: Readonly<Record<string, string>> | undefined, idempotencyKey = '') {
			const credentialValue = credential(headers, 'Treeseed-Credential');
			if (!credentialValue) throw new CapacityGovernanceError('provider_credential_required', 'Treeseed-Credential authorization is required.', 401);
			if (typeof body.credentialId !== 'string' || !body.credentialId) throw new CapacityGovernanceError('provider_credential_id_required', 'Provider credentialId is required.', 400);
			if (!body.proof) throw new CapacityGovernanceError('provider_proof_required', 'Provider proof is required.', 401);
			return registration.issueAccessToken({ credentialValue, credentialId: body.credentialId,
				requestedValiditySeconds: typeof body.requestedValiditySeconds === 'number' ? body.requestedValiditySeconds : undefined,
				proof: body.proof as CapacityProviderSignedProof, path: '/v1/provider/access-tokens', idempotencyKey });
		},
		leave(auth: unknown, idempotencyKey = '') { return registration.leaveMembership(providerPrincipal(auth, []), idempotencyKey); },
		rotateIdentity(auth: unknown, body: Record<string, unknown>, idempotencyKey = '') { return registration.rotateIdentity(providerPrincipal(auth, []), identityRotation(body), idempotencyKey); },
		rotateCredential(auth: unknown, idempotencyKey = '') { return registration.authorizeProviderCredentialRotation(providerPrincipal(auth, []), idempotencyKey); },
		createAvailability(auth: unknown, body: Record<string, unknown>) { return availability.open(providerPrincipal(auth, ['provider:availability:write']), body); },
		async refreshAvailability(auth: unknown, sessionId: string, body: Record<string, unknown>) {
			const session = await availability.refresh(providerPrincipal(auth, ['provider:availability:write']), sessionId, body);
			if (!session) throw new CapacityGovernanceError('provider_availability_refresh_conflict', 'Availability session refresh was rejected because the session is closed, expired, or changed concurrently.', 409);
			return session;
		},
		async closeAvailability(auth: unknown, sessionId: string) {
			const session = await availability.close(providerPrincipal(auth, ['provider:availability:write']), sessionId);
			if (!session) throw new CapacityGovernanceError('provider_availability_not_found', 'Availability session does not exist for this membership.', 404);
			return session;
		},
	};
}

export type ProviderRuntimeService = ReturnType<typeof createProviderRuntimeService>;

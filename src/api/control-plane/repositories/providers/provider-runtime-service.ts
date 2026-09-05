import type {
	CapacityProviderIdentityRotationRequest,
	CapacityProviderSignedProof,
	ProviderRegistrationSubmission,
} from '@treeseed/sdk/capacity-provider/contracts';
import type { CapacityGovernanceDatabase } from '../../../capacity/database.ts';
import { CapacityGovernanceError } from '../../../capacity/database.ts';
import { CapacityGovernanceRepository } from '../../../capacity/repositories/governance/policy/governance.ts';
import { CapacitySecretCodec } from '../../../capacity/security.ts';
import { createHash } from 'node:crypto';
import { readOsCredentialFile } from '@treeseed/deployment/security/custody';
const keyText=(file:string)=>{const key=readOsCredentialFile(file);try{return key.toString('utf8').trim();}finally{key.fill(0);}};
import { AvailabilitySessionService } from '../../../capacity/services/accounts/availability-session-service.ts';
import { CapacityRegistrationService } from '../../../capacity/services/support/registration-service.ts';
import { createProviderEnvironmentService } from './provider-environment-service.ts';

export interface ProviderPrincipal {
	membershipId: string;
	teamId: string;
	capacityProviderId: string;
	scopes: string[];
}

type ProviderAuth = { principal?: ProviderPrincipal } | null | undefined;
type UserPrincipal = { id: string; roles?: string[]; permissions?: string[] };
type OwnerStore = CapacityGovernanceDatabase & {
	principalCanAccessTeam(principal: UserPrincipal, teamId: string): Promise<boolean>;
	principalCanManageTeam(principal: UserPrincipal, teamId: string): Promise<boolean>;
};

function credential(headers: Readonly<Record<string, string>> | undefined, scheme: string) {
	const value = headers?.authorization?.trim() ?? '';
	return value.startsWith(`${scheme} `) ? value.slice(scheme.length + 1).trim() : '';
}

function etag(value: unknown) {
	return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

export function registrationCodeStatus(metadata: { teamId: string; generation: number; keyPrefix: string; createdAt: string; rotatedAt: string | null }) {
	return { schemaVersion: 'treeseed.provider-registration-code-status/v1' as const, teamId: metadata.teamId,
		generation: metadata.generation, codePrefix: metadata.keyPrefix, rotatedAt: metadata.rotatedAt ?? metadata.createdAt };
}

export function registrationCodeReceipt(metadata: { teamId: string; generation: number; keyPrefix: string; registrationKey: string; createdAt: string; rotatedAt: string | null }) {
	return { schemaVersion: 'treeseed.provider-registration-code-receipt/v1' as const, teamId: metadata.teamId,
		generation: metadata.generation, codePrefix: metadata.keyPrefix, registrationCode: metadata.registrationKey,
		rotatedAt: metadata.rotatedAt ?? metadata.createdAt };
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

export function providerAvailabilityIsRunnable(sessions: Record<string, unknown>[], activeExecutionProviderCount: number, now = Date.now()) {
	return activeExecutionProviderCount > 0 && sessions.some((entry) => entry.status === 'open' && Date.parse(String(entry.expires_at)) > now);
}

export async function revealReusableRegistrationCode(registration: Pick<CapacityRegistrationService, 'revealRegistrationKey'>, teamId: string, actorId: string) {
	const issued = await registration.revealRegistrationKey(teamId, actorId);
	return { teamId, connectionState: 'registration_ready', expiresAfterUse: false,
		registrationCode: issued.registrationKey, codePrefix: issued.keyPrefix, generation: issued.generation };
}

export function createProviderRuntimeService(store: CapacityGovernanceDatabase, config: Record<string, unknown>, ownerStore: OwnerStore = store as OwnerStore) {
	const encryptionFile = String(config.capacityEncryptionKeyFile ?? process.env.TREESEED_CAPACITY_ENCRYPTION_KEY_FILE ?? '');
	if (!encryptionFile) throw new Error('An OS-custodied capacity key file is required.');
	const encryptionSource = keyText(encryptionFile);
	if (encryptionSource.length < 24) throw new Error('Capacity encryption key is invalid.');
	const configuredSecret = createHash('sha256').update('capacity-governance:').update(encryptionSource).digest('hex');
	const audience = String(config.baseUrl ?? process.env.TREESEED_API_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/u, '');
	const keyVersion = Math.max(1, Number(config.TREESEED_CAPACITY_ENCRYPTION_KEY_VERSION ?? process.env.TREESEED_CAPACITY_ENCRYPTION_KEY_VERSION ?? 1));
	const historical = String(config.TREESEED_CAPACITY_HISTORICAL_KEY_FILES ?? process.env.TREESEED_CAPACITY_HISTORICAL_KEY_FILES ?? '').split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
		const match = /^(\d+):(.+)$/u.exec(entry); if (!match) throw new Error('Historical capacity keys must use VERSION:/absolute/path entries.'); return { version: Number(match[1]), secret: keyText(match[2]!) };
	});
	const registration = new CapacityRegistrationService(new CapacityGovernanceRepository(store), new CapacitySecretCodec(configuredSecret, String(encryptionSource), keyVersion, historical), audience);
	const availability = new AvailabilitySessionService(store);
	const environmentProfiles = createProviderEnvironmentService(ownerStore);
	const requireUser = (principal: UserPrincipal | null | undefined) => {
		if (!principal) throw new CapacityGovernanceError('authentication_required', 'An authenticated team principal is required.', 401);
		return principal;
	};
	const requireRead = async (principal: UserPrincipal | null | undefined, teamId: string) => {
		const actor = requireUser(principal);
		if (!await ownerStore.principalCanAccessTeam(actor, teamId)) throw new CapacityGovernanceError('provider_team_access_denied', 'The principal cannot read this team provider.', 403);
		return actor;
	};
	const requireManage = async (principal: UserPrincipal | null | undefined, teamId: string) => {
		const actor = requireUser(principal);
		if (!await ownerStore.principalCanManageTeam(actor, teamId)) throw new CapacityGovernanceError('provider_team_management_denied', 'The principal cannot manage this team provider.', 403);
		return actor;
	};
	const membership = async (teamId: string, connectionId: string) => registration.membership(teamId, connectionId);
	return {
		authenticator: registration,
		async registrationCodeStatus(principal: UserPrincipal | null | undefined, teamId: string) {
			const actor = await requireRead(principal, teamId);
			return registrationCodeStatus(await registration.registrationKey(teamId, actor.id));
		},
		async revealRegistrationCode(principal: UserPrincipal | null | undefined, teamId: string) {
			const actor = await requireManage(principal, teamId);
			return registrationCodeReceipt(await registration.revealRegistrationKey(teamId, actor.id));
		},
		async rotateRegistrationCode(principal: UserPrincipal | null | undefined, teamId: string, idempotencyKey: string, ifMatch?: string) {
			const actor = await requireManage(principal, teamId);
			const current = registrationCodeStatus(await registration.registrationKey(teamId, actor.id));
			if (ifMatch !== etag(current)) throw new CapacityGovernanceError('provider_registration_code_precondition_failed', 'The registration code changed after it was loaded.', 412);
			return registrationCodeReceipt(await registration.rotateRegistrationKey(teamId, actor.id, idempotencyKey));
		},
		environmentProfiles,
		async list(principal: UserPrincipal | null | undefined, teamId: string, query: Record<string, unknown>) {
			await requireRead(principal, teamId);
			return registration.listMembershipsPage(teamId, query);
		},
		async show(principal: UserPrincipal | null | undefined, teamId: string, providerId: string) {
			await requireRead(principal, teamId);
			const page = await registration.listMembershipsPage(teamId, { providerId, limit: 2 });
			const item = page.items[0];
			if (!item) throw new CapacityGovernanceError('provider_not_found', 'The team capacity provider was not found.', 404);
			return item;
		},
		async status(principal: UserPrincipal | null | undefined, teamId: string, providerId: string) {
			const item = await this.show(principal, teamId, providerId);
			const [sessions, activeExecutionProvider, unavailableOffers] = await Promise.all([
				store.all(`SELECT id, status, expires_at, refreshed_at, metadata_json FROM capacity_provider_availability_sessions WHERE team_id = ? AND capacity_provider_id = ? ORDER BY created_at DESC LIMIT 5`, [teamId, providerId]),
				store.first(`SELECT COUNT(*) AS count FROM capacity_execution_providers WHERE capacity_provider_id = ? AND status = 'active'`, [providerId]),
				store.all(`SELECT offer_id, execution_provider_id, status, last_seen_at FROM execution_capability_offers
					WHERE capacity_provider_id = ? AND status <> 'active' ORDER BY last_seen_at DESC, offer_id ASC`, [providerId]),
			]);
			const activeExecutionProviderCount = Number(activeExecutionProvider?.count ?? 0);
			return { provider: item, healthy: providerAvailabilityIsRunnable(sessions, activeExecutionProviderCount), activeExecutionProviderCount,
				availability: sessions, unavailableOffers, alerts: unavailableOffers.map((offer) => ({
					code: offer.status === 'context_overflow' ? 'provider_context_capacity_overflow' : 'provider_offer_unavailable',
					offerId: offer.offer_id, executionProviderId: offer.execution_provider_id, status: offer.status,
					observedAt: offer.last_seen_at,
				})) };
		},
		async diagnose(principal: UserPrincipal | null | undefined, teamId: string, providerId: string) {
			const status = await this.status(principal, teamId, providerId);
			const offerBlockers = status.unavailableOffers.map((offer) => `${offer.status}:${offer.offer_id}`);
			return { ...status, blockers: [...(status.healthy ? [] : ['provider_availability_unhealthy']), ...offerBlockers],
				nextActions: [...(status.healthy ? [] : ['Start or reconcile the local provider manager.']),
					...(status.unavailableOffers.some((offer) => offer.status === 'context_overflow')
						? ['Publish an updated context-capacity offer and pass conformance before re-enabling it.'] : [])] };
		},
		async connect(principal: UserPrincipal | null | undefined, teamId: string, _idempotencyKey: string) {
			const actor = await requireManage(principal, teamId);
			return revealReusableRegistrationCode(registration, teamId, actor.id);
		},
		async disconnect(principal: UserPrincipal | null | undefined, teamId: string, connectionId: string, idempotencyKey: string) {
			const actor = await requireManage(principal, teamId);
			return registration.updateMembership(teamId, connectionId, actor.id, 'revoked', idempotencyKey);
		},
		async requests(principal: UserPrincipal | null | undefined, teamId: string, query: Record<string, unknown>) {
			await requireRead(principal, teamId);
			return registration.listRequestsPage(teamId, query);
		},
		async request(principal: UserPrincipal | null | undefined, teamId: string, requestId: string) {
			await requireRead(principal, teamId);
			return registration.registrationRequest(teamId, requestId);
		},
		async approve(principal: UserPrincipal | null | undefined, teamId: string, requestId: string, body: Record<string, unknown>, idempotencyKey: string) {
			const actor = await requireManage(principal, teamId);
			return registration.approve(teamId, requestId, actor.id, idempotencyKey, typeof body.teamAlias === 'string' ? body.teamAlias : null);
		},
		async reject(principal: UserPrincipal | null | undefined, teamId: string, requestId: string, body: Record<string, unknown>, idempotencyKey: string) {
			const actor = await requireManage(principal, teamId);
			return registration.reject(teamId, requestId, actor.id, String(body.reason ?? ''), idempotencyKey);
		},
		async credentials(principal: UserPrincipal | null | undefined, teamId: string, connectionId: string) {
			await requireRead(principal, teamId); await membership(teamId, connectionId);
			return registration.listCredentialsPage(teamId, connectionId, { limit: 20 });
		},
		async rotateCredentials(principal: UserPrincipal | null | undefined, teamId: string, connectionId: string, idempotencyKey: string) {
			const actor = await requireManage(principal, teamId);
			return registration.authorizeTeamCredentialRotation(teamId, connectionId, actor.id, idempotencyKey);
		},
		async revokeCredentials(principal: UserPrincipal | null | undefined, teamId: string, connectionId: string, idempotencyKey: string) {
			const actor = await requireManage(principal, teamId);
			const credentials = await registration.listCredentialsPage(teamId, connectionId, { status: 'active', limit: 100 });
			const revoked = [];
			for (const item of credentials.items) revoked.push(await registration.revokeCredential(teamId, connectionId, item.id, actor.id, `${idempotencyKey}:${item.id}`));
			return { connectionId, revoked };
		},
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

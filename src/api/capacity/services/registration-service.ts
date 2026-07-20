import { randomUUID } from 'node:crypto';
import {
	PROVIDER_MEMBERSHIP_SCOPES,
	validateProviderSupplyOffer,
	type CapacityProviderSignedProof,
	type CapacityProviderIdentityRotationRequest,
	type ProviderRegistrationSubmission,
	type ProviderTeamCredentialIssue,
	type ProviderAccessTokenIssue,
} from '@treeseed/sdk/capacity-provider';
import { CapacityGovernanceError } from '../database.ts';
import { CapacitySecretCodec, canonicalJson, capacityProviderFingerprint, sha256, verifyCapacityProviderProof } from '../security.ts';
import { CapacityGovernanceRepository } from '../repositories/governance.ts';
import { CapacityAuditRepository } from '../repositories/audit.ts';
import { CapacityCredentialAuthorizationRepository } from '../repositories/credential-authorization.ts';
import { CapacityProviderIdentityRepository } from '../repositories/provider-identity.ts';
import { settleCapacityReservationExactlyOnce } from './settlement-service.ts';

function secretPrefix(value: string) {
	const parts = value.split('_');
	return parts.length >= 3 ? `${parts[0]}_${parts[1]}` : '';
}

function nowIso(now?: Date) {
	return (now ?? new Date()).toISOString();
}

export class CapacityRegistrationService {
	private readonly auditRepository: CapacityAuditRepository;
	private readonly credentialAuthorizationRepository: CapacityCredentialAuthorizationRepository;
	private readonly identityRepository: CapacityProviderIdentityRepository;

	constructor(
		private readonly repository: CapacityGovernanceRepository,
		private readonly secrets: CapacitySecretCodec,
		private readonly audience: string,
	) {
		this.auditRepository = new CapacityAuditRepository(repository.database);
		this.credentialAuthorizationRepository = new CapacityCredentialAuthorizationRepository(repository.database);
		this.identityRepository = new CapacityProviderIdentityRepository(repository.database);
	}

	private async assertTeamExists(teamId: string) {
		if (!await this.repository.teamExists(teamId)) {
			throw new CapacityGovernanceError('capacity_team_not_found', 'Capacity provider governance team does not exist.', 404, { teamId });
		}
	}

	async registrationKey(teamId: string, actorId: string | null) {
		await this.assertTeamExists(teamId);
		const existing = await this.repository.registrationKeyMetadata(teamId);
		if (existing) return existing;
		const issued = this.secrets.issue('registration');
		const now = nowIso();
		const created = await this.repository.createRegistrationKey({ id: randomUUID(), teamId, generation: 1, prefix: issued.prefix, hash: issued.hash, encryptedRevealValue: this.secrets.encrypt(issued.plaintext), actorId, now });
await this.auditRepository.record({ id: randomUUID(), teamId, actorType: 'team-principal', actorId, action: 'registration-key.created', resourceType: 'team-capacity-registration-key', resourceId: created?.keyPrefix, now });
		return created;
	}

	async revealRegistrationKey(teamId: string, actorId: string | null) {
		await this.registrationKey(teamId, actorId);
		const row = await this.repository.currentRegistrationKeyRow(teamId);
		if (!row) throw new CapacityGovernanceError('registration_key_missing', 'Team capacity registration key does not exist.', 404);
		const now = nowIso();
		await this.repository.recordRegistrationKeyReveal(teamId, now);
		await this.auditRepository.record({ id: randomUUID(), teamId, actorType: 'team-principal', actorId, action: 'registration-key.revealed', resourceType: 'team-capacity-registration-key', resourceId: String(row.key_prefix), now });
		return { ...(await this.repository.registrationKeyMetadata(teamId)), registrationKey: this.secrets.decrypt(String(row.encrypted_reveal_value)) };
	}

	async rotateRegistrationKey(teamId: string, actorId: string | null, idempotencyKey: string) {
		if (!idempotencyKey) throw new CapacityGovernanceError('idempotency_key_required', 'Idempotency-Key is required.', 400);
		await this.assertTeamExists(teamId);
		const prior = await this.repository.registrationKeyByRotationIdempotency(teamId, idempotencyKey);
		if (prior) return { ...prior.metadata, registrationKey: this.secrets.decrypt(prior.encryptedRevealValue) };
		const current = await this.repository.currentRegistrationKeyRow(teamId);
		const issued = this.secrets.derive('registration', `team-registration-key:${teamId}:${idempotencyKey}`);
		const now = nowIso();
		const rotated = await this.repository.rotateRegistrationKey({ id: randomUUID(), teamId, generation: Number(current?.generation ?? 0) + 1, prefix: issued.prefix, hash: issued.hash, encryptedRevealValue: this.secrets.encrypt(issued.plaintext), idempotencyKey, actorId, now });
		const committed = await this.repository.registrationKeyByRotationIdempotency(teamId, idempotencyKey);
		if (!committed) throw new CapacityGovernanceError('registration_key_rotation_conflict', 'Registration key rotation did not commit its idempotent result.', 409);
		if (committed.metadata.createdAt === now) await this.auditRepository.record({ id: randomUUID(), teamId, actorType: 'team-principal', actorId, action: 'registration-key.rotated', resourceType: 'team-capacity-registration-key', resourceId: rotated?.keyPrefix, idempotencyKey, metadata: { previousGeneration: Number(current?.generation ?? 0), generation: rotated?.generation }, now });
		return { ...committed.metadata, registrationKey: this.secrets.decrypt(committed.encryptedRevealValue) };
	}

	async setRegistrationKeyStatus(teamId: string, actorId: string | null, status: 'active' | 'disabled', idempotencyKey: string) {
		if (!idempotencyKey) throw new CapacityGovernanceError('idempotency_key_required', 'Idempotency-Key is required.', 400);
		await this.registrationKey(teamId, actorId);
		const requestDigest = sha256(canonicalJson({ status }));
		const prior = await this.repository.registrationKeyStatusEvidence(teamId);
		if (prior?.status_idempotency_key === idempotencyKey) {
			if (prior.status_request_digest !== requestDigest) throw new CapacityGovernanceError('idempotency_key_conflict', 'Registration-key status idempotency key is already bound to another request.', 409);
			return this.repository.registrationKeyMetadata(teamId);
		}
		if (prior?.status === status) return this.repository.registrationKeyMetadata(teamId);
		const now = nowIso();
		const result = await this.repository.setRegistrationKeyStatus(teamId, prior?.status as 'active' | 'disabled', status, idempotencyKey, requestDigest, now);
		if ((await this.repository.registrationKeyStatusEvidence(teamId))?.status_idempotency_key !== idempotencyKey) throw new CapacityGovernanceError('registration_key_status_conflict', 'Registration key changed before the status operation committed.', 409);
		await this.auditRepository.record({ id: randomUUID(), teamId, actorType: 'team-principal', actorId, action: `registration-key.${status === 'active' ? 'enabled' : 'disabled'}`, resourceType: 'team-capacity-registration-key', resourceId: result?.keyPrefix, idempotencyKey, now });
		return result;
	}

	async submitRegistration(registrationKey: string, submission: ProviderRegistrationSubmission, path: string, idempotencyKey: string, clientAddress = 'local') {
		if (!idempotencyKey) throw new CapacityGovernanceError('idempotency_key_required', 'Idempotency-Key is required.', 400);
		const prefix = secretPrefix(registrationKey);
		const keyRow = prefix ? await this.repository.registrationKeyByPrefix(prefix) : null;
		if (!keyRow || !this.secrets.verify(registrationKey, String(keyRow.key_hash))) throw new CapacityGovernanceError('registration_key_invalid', 'Team capacity registration key is invalid.', 401);
		if (keyRow.status !== 'active') throw new CapacityGovernanceError('registration_key_disabled', 'Team capacity registration key is disabled.', 403);
		await this.assertTeamExists(String(keyRow.team_id));
		const offerValidation = validateProviderSupplyOffer(submission.supplyOffer);
		if (!offerValidation.ok) throw new CapacityGovernanceError('provider_offer_invalid', 'Provider supply offer is invalid.', 400, { diagnostics: offerValidation.diagnostics });
		const signedBody = { schemaVersion: submission.schemaVersion, displayName: submission.displayName, publicJwk: submission.publicJwk, capabilitySummary: submission.capabilitySummary, supplyOffer: submission.supplyOffer, metadata: submission.metadata ?? {} };
		const verified = verifyCapacityProviderProof({ proof: submission.proof, publicJwk: submission.publicJwk, method: 'POST', path, audience: this.audience, body: signedBody });
		const requestDigest = sha256(canonicalJson(signedBody));
		const priorIdempotentRequest = await this.repository.registrationRequestByIdempotency(String(keyRow.team_id), idempotencyKey);
		if (priorIdempotentRequest) {
			if (priorIdempotentRequest.requestDigest !== requestDigest || priorIdempotentRequest.request.providerFingerprint !== verified.fingerprint) throw new CapacityGovernanceError('idempotency_key_conflict', 'Registration idempotency key is already bound to another request.', 409);
			return priorIdempotentRequest.request;
		}
		const now = nowIso();
		if (!await this.repository.consumeProofNonce(verified.fingerprint, verified.payload.jti, verified.payload.expiresAt, now)) throw new CapacityGovernanceError('provider_proof_replayed', 'Provider proof has already been used.', 409);
		const rateDimensions = await this.repository.consumeRegistrationRateLimits({
			buckets: [
				{ dimension: 'team', key: sha256(String(keyRow.team_id)) },
				{ dimension: 'ip', key: sha256(clientAddress) },
				{ dimension: 'fingerprint', key: sha256(verified.fingerprint) },
				{ dimension: 'key-generation', key: sha256(`${String(keyRow.team_id)}:${String(keyRow.generation)}`) },
			],
			now,
			expiresAt: new Date(Date.parse(now) + 60_000).toISOString(),
			limit: 20,
		});
		if (rateDimensions.length) throw new CapacityGovernanceError('provider_registration_rate_limited', 'Provider registration rate limit exceeded.', 429, { retryAfterSeconds: 60, dimensions: rateDimensions });
		const providerId = `provider_${verified.fingerprint.replace(/^sha256:/u, '').slice(0, 32)}`;
		const existingMembership = await this.repository.membershipForTeamProvider(String(keyRow.team_id), providerId);
		if (existingMembership) throw new CapacityGovernanceError(existingMembership.status === 'revoked' ? 'provider_membership_revoked' : 'provider_membership_exists', 'Provider already has a membership with this team.', 409, { membershipId: existingMembership.id, status: existingMembership.status });
		const request = await this.repository.createRegistrationRequest({
			id: randomUUID(),
			teamId: String(keyRow.team_id),
			providerId,
			fingerprint: capacityProviderFingerprint(submission.publicJwk),
			publicJwkJson: canonicalJson(submission.publicJwk),
			displayName: submission.displayName.trim(),
			generation: Number(keyRow.generation),
			capabilities: submission.capabilitySummary.map(String),
			supplyOffer: submission.supplyOffer as unknown as Record<string, unknown>,
			proofJti: verified.payload.jti,
			idempotencyKey,
			requestDigest,
			expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
			metadata: { ...(submission.metadata ?? {}), idempotencyKey },
			now,
		});
		if (!request) throw new CapacityGovernanceError('registration_key_disabled', 'Team capacity registration key was disabled or rotated before registration committed.', 403);
		if (!(await this.repository.registrationRequestByIdempotency(String(keyRow.team_id), idempotencyKey))) throw new CapacityGovernanceError('provider_registration_exists', 'Provider already has a registration request for this key generation.', 409, { requestId: request.id, status: request.status });
		await this.auditRepository.record({ id: randomUUID(), teamId: request.teamId, providerId: request.providerId, actorType: 'provider-identity', actorId: request.providerFingerprint, action: 'provider-registration.requested', resourceType: 'provider-registration-request', resourceId: request.id, requestId: request.id, idempotencyKey, now });
		return request;
	}

	async registrationStatus(requestId: string, proof: CapacityProviderSignedProof, path: string) {
		const request = await this.repository.expireRegistrationRequest(requestId, nowIso());
		if (!request) throw new CapacityGovernanceError('provider_registration_not_found', 'Provider registration request does not exist.', 404);
		await this.assertTeamExists(request.teamId);
		const identity = await this.identityRepository.byId(request.providerId);
		if (!identity) throw new CapacityGovernanceError('provider_identity_not_found', 'Provider identity does not exist.', 404);
		const verified = verifyCapacityProviderProof({ proof, publicJwk: identity.publicJwk, method: 'GET', path, audience: this.audience, body: { requestId } });
		if (!await this.repository.consumeProofNonce(verified.fingerprint, verified.payload.jti, verified.payload.expiresAt, nowIso())) throw new CapacityGovernanceError('provider_proof_replayed', 'Provider proof has already been used.', 409);
		return request;
	}

	async approve(teamId: string, requestId: string, actorId: string, idempotencyKey: string, teamAlias?: string | null) {
		if (!idempotencyKey) throw new CapacityGovernanceError('idempotency_key_required', 'Idempotency-Key is required.', 400);
		await this.assertTeamExists(teamId);
		const existing = await this.repository.expireRegistrationRequest(requestId, nowIso());
		if (!existing || existing.teamId !== teamId) throw new CapacityGovernanceError('provider_registration_not_found', 'Provider registration request does not exist.', 404);
		const requestDigest = sha256(canonicalJson({ action: 'approve', teamAlias: teamAlias ?? null }));
		const prior = await this.repository.registrationRequestTransitionEvidence(requestId);
		if (prior?.transition_idempotency_key === idempotencyKey) {
			if (prior.transition_request_digest !== requestDigest) throw new CapacityGovernanceError('idempotency_key_conflict', 'Registration review idempotency key is already bound to another request.', 409);
			return existing;
		}
		if (existing.status === 'approved') return existing;
		if (existing.status !== 'pending' || Date.parse(existing.expiresAt) <= Date.now()) throw new CapacityGovernanceError('provider_registration_not_pending', 'Only an unexpired pending request can be approved.', 409, { status: existing.status });
		const now = nowIso();
		const approved = await this.repository.approveRequest({ requestId, membershipId: randomUUID(), authorizationId: randomUUID(), actorId, teamAlias, idempotencyKey, requestDigest, now });
		if (!approved || approved.status !== 'approved') throw new CapacityGovernanceError('provider_registration_state_conflict', 'Provider registration request changed before approval.', 409);
		if ((await this.repository.registrationRequestTransitionEvidence(requestId))?.transition_idempotency_key !== idempotencyKey) throw new CapacityGovernanceError('provider_registration_state_conflict', 'Another review operation won before approval.', 409);
		await this.auditRepository.record({ id: randomUUID(), teamId, providerId: approved.providerId, membershipId: approved.membershipId, actorType: 'team-principal', actorId, action: 'provider-registration.approved', resourceType: 'provider-registration-request', resourceId: requestId, requestId, idempotencyKey, metadata: { membershipOnly: true }, now });
		return approved;
	}

	async reject(teamId: string, requestId: string, actorId: string, reason: string, idempotencyKey: string) {
		if (!idempotencyKey) throw new CapacityGovernanceError('idempotency_key_required', 'Idempotency-Key is required.', 400);
		await this.assertTeamExists(teamId);
		if (!reason.trim()) throw new CapacityGovernanceError('rejection_reason_required', 'Rejection reason is required.', 400);
		const existing = await this.repository.expireRegistrationRequest(requestId, nowIso());
		if (!existing || existing.teamId !== teamId) throw new CapacityGovernanceError('provider_registration_not_found', 'Provider registration request does not exist.', 404);
		const requestDigest = sha256(canonicalJson({ action: 'reject', reason: reason.trim() }));
		const prior = await this.repository.registrationRequestTransitionEvidence(requestId);
		if (prior?.transition_idempotency_key === idempotencyKey) {
			if (prior.transition_request_digest !== requestDigest) throw new CapacityGovernanceError('idempotency_key_conflict', 'Registration review idempotency key is already bound to another request.', 409);
			return existing;
		}
		if (existing.status === 'rejected') return existing;
		if (existing.status !== 'pending') throw new CapacityGovernanceError('provider_registration_not_pending', 'Only a pending request can be rejected.', 409, { status: existing.status });
		const now = nowIso();
		const rejected = await this.repository.rejectRequest({ requestId, actorId, reason: reason.trim(), idempotencyKey, requestDigest, now });
		if (!rejected || rejected.status !== 'rejected') throw new CapacityGovernanceError('provider_registration_state_conflict', 'Provider registration request changed before rejection.', 409);
		if ((await this.repository.registrationRequestTransitionEvidence(requestId))?.transition_idempotency_key !== idempotencyKey) throw new CapacityGovernanceError('provider_registration_state_conflict', 'Another review operation won before rejection.', 409);
		await this.auditRepository.record({ id: randomUUID(), teamId, providerId: rejected.providerId, actorType: 'team-principal', actorId, action: 'provider-registration.rejected', resourceType: 'provider-registration-request', resourceId: requestId, requestId, idempotencyKey, metadata: { reason: reason.trim() }, now });
		return rejected;
	}

	async cancel(teamId: string, requestId: string, actorId: string, idempotencyKey: string) {
		if (!idempotencyKey) throw new CapacityGovernanceError('idempotency_key_required', 'Idempotency-Key is required.', 400);
		await this.assertTeamExists(teamId);
		const existing = await this.repository.expireRegistrationRequest(requestId, nowIso());
		if (!existing || existing.teamId !== teamId) throw new CapacityGovernanceError('provider_registration_not_found', 'Provider registration request does not exist.', 404);
		const requestDigest = sha256(canonicalJson({ action: 'cancel' }));
		const prior = await this.repository.registrationRequestTransitionEvidence(requestId);
		if (prior?.transition_idempotency_key === idempotencyKey) {
			if (prior.transition_request_digest !== requestDigest) throw new CapacityGovernanceError('idempotency_key_conflict', 'Registration review idempotency key is already bound to another request.', 409);
			return existing;
		}
		if (existing.status === 'cancelled') return existing;
		if (existing.status !== 'pending') throw new CapacityGovernanceError('provider_registration_not_pending', 'Only a pending request can be cancelled.', 409, { status: existing.status });
		const now = nowIso();
		const cancelled = await this.repository.cancelRequest(requestId, idempotencyKey, requestDigest, now);
		if ((await this.repository.registrationRequestTransitionEvidence(requestId))?.transition_idempotency_key !== idempotencyKey) throw new CapacityGovernanceError('provider_registration_state_conflict', 'Another review operation won before cancellation.', 409);
		await this.auditRepository.record({ id: randomUUID(), teamId, providerId: existing.providerId, actorType: 'team-principal', actorId, action: 'provider-registration.cancelled', resourceType: 'provider-registration-request', resourceId: requestId, requestId, idempotencyKey, now });
		return cancelled;
	}

	async exchangeCredential(requestId: string, proof: CapacityProviderSignedProof, path: string, idempotencyKey: string): Promise<ProviderTeamCredentialIssue> {
		if (!idempotencyKey) throw new CapacityGovernanceError('idempotency_key_required', 'Idempotency-Key is required.', 400);
		const request = await this.repository.registrationRequestById(requestId);
		if (!request || request.status !== 'approved' || !request.membershipId) throw new CapacityGovernanceError('provider_registration_not_approved', 'Provider registration request is not approved.', 409);
		await this.assertTeamExists(request.teamId);
		const identity = await this.identityRepository.byId(request.providerId);
		const membership = await this.repository.membershipById(request.membershipId);
		if (!identity || !membership || membership.status !== 'approved') throw new CapacityGovernanceError('provider_membership_not_approved', 'Provider membership is not approved.', 403);
		const verified = verifyCapacityProviderProof({ proof, publicJwk: identity.publicJwk, method: 'POST', path, audience: this.audience, body: { requestId, idempotencyKey } });
		const now = nowIso();
		if (!await this.repository.consumeProofNonce(verified.fingerprint, verified.payload.jti, verified.payload.expiresAt, now)) throw new CapacityGovernanceError('provider_proof_replayed', 'Provider proof has already been used.', 409);
		const priorIssue = await this.repository.credentialByIssueKey(membership.id, idempotencyKey);
		if (priorIssue) {
			if (priorIssue.metadata.status !== 'active') throw new CapacityGovernanceError('provider_credential_revoked', 'The credential created by this issuance operation is no longer active.', 403, { credentialId: priorIssue.metadata.id });
			const replay = this.secrets.derive('credential', `membership-credential:${priorIssue.metadata.id}`);
			if (replay.hash !== priorIssue.hash) throw new CapacityGovernanceError('provider_credential_replay_invalid', 'Credential issuance replay did not match durable credential evidence.', 500, { credentialId: priorIssue.metadata.id });
			return { ...priorIssue.metadata, credential: replay.plaintext };
		}
		const active = await this.repository.activeCredential(membership.id);
		if (active) {
			throw new CapacityGovernanceError('provider_credential_already_issued', 'An active membership credential already exists and cannot be revealed with a different idempotency key.', 409, { credentialId: active.metadata.id });
		}
		const authorization = await this.credentialAuthorizationRepository.pending(membership.id);
		if (!authorization) throw new CapacityGovernanceError('provider_credential_issuance_not_authorized', 'No pending credential issuance is authorized for this membership.', 409);
		const prior = await this.repository.latestCredential(membership.id);
		const credentialId = randomUUID();
		const issued = this.secrets.derive('credential', `membership-credential:${credentialId}`);
		const metadata = await this.repository.createCredential({ id: credentialId, authorization, membership, prefix: issued.prefix, hash: issued.hash, issueIdempotencyKey: idempotencyKey, scopes: [...PROVIDER_MEMBERSHIP_SCOPES], rotatedFromId: prior?.metadata.id, now });
		if (!metadata) throw new CapacityGovernanceError('provider_credential_issue_failed', 'Membership credential could not be issued.', 500);
		await this.repository.markCredentialRevealed(metadata.id, now);
		await this.auditRepository.record({ id: randomUUID(), teamId: membership.teamId, providerId: membership.providerId, membershipId: membership.id, actorType: 'provider-identity', actorId: identity.fingerprint, action: 'provider-credential.issued', resourceType: 'provider-team-credential', resourceId: metadata.id, requestId, idempotencyKey, now });
		return { ...metadata, credential: issued.plaintext };
	}

	async issueAccessToken(input: {
		credentialValue: string;
		credentialId: string;
		proof: CapacityProviderSignedProof;
		path: string;
		idempotencyKey: string;
	}): Promise<ProviderAccessTokenIssue> {
		if (!input.idempotencyKey) throw new CapacityGovernanceError('idempotency_key_required', 'Idempotency-Key is required.', 400);
		const prefix = secretPrefix(input.credentialValue);
		const matched = prefix ? await this.repository.authenticateCredential(prefix) : null;
		if (!matched || !this.secrets.verify(input.credentialValue, matched.hash)) throw new CapacityGovernanceError('provider_credential_invalid', 'Provider membership credential is invalid.', 401);
		if (matched.metadata.id !== input.credentialId) throw new CapacityGovernanceError('provider_credential_mismatch', 'Provider credential identifier does not match the presented credential.', 401);
		if (matched.metadata.status !== 'active' || matched.membershipStatus !== 'approved') throw new CapacityGovernanceError('provider_credential_revoked', 'Provider membership credential is not active.', 403);
		const membership = await this.repository.membershipById(matched.metadata.membershipId);
		const identity = membership ? await this.identityRepository.byId(membership.providerId) : null;
		if (!membership || !identity) throw new CapacityGovernanceError('provider_identity_not_found', 'Provider identity for the membership credential does not exist.', 404);
		await this.assertTeamExists(membership.teamId);
		const verified = verifyCapacityProviderProof({
			proof: input.proof,
			publicJwk: identity.publicJwk,
			method: 'POST',
			path: input.path,
			audience: this.audience,
			body: { credentialId: input.credentialId, idempotencyKey: input.idempotencyKey },
		});
		const issuedAt = nowIso();
		if (!await this.repository.consumeProofNonce(verified.fingerprint, verified.payload.jti, verified.payload.expiresAt, issuedAt)) throw new CapacityGovernanceError('provider_proof_replayed', 'Provider proof has already been used.', 409);
		const priorIssue = await this.repository.accessTokenByIssueKey(membership.id, input.idempotencyKey);
		if (priorIssue) {
			if (String(priorIssue.credential_id) !== input.credentialId) throw new CapacityGovernanceError('idempotency_key_conflict', 'Access-token idempotency key is already bound to another credential.', 409);
			if (priorIssue.status !== 'active' || Date.parse(String(priorIssue.expires_at)) <= Date.now()) throw new CapacityGovernanceError('provider_access_token_replay_expired', 'The access token created by this idempotent operation is no longer active.', 409, { accessTokenId: priorIssue.id });
			const replay = this.secrets.derive('access', `provider-access-token:${String(priorIssue.id)}`);
			if (replay.hash !== String(priorIssue.token_hash)) throw new CapacityGovernanceError('provider_access_token_replay_invalid', 'Access-token replay did not match durable token evidence.', 500, { accessTokenId: priorIssue.id });
			return { id: String(priorIssue.id), teamId: membership.teamId, providerId: membership.providerId, membershipId: membership.id, credentialId: input.credentialId, status: 'active', scopes: JSON.parse(String(priorIssue.scopes_json || '[]')) as ProviderAccessTokenIssue['scopes'], issuedAt: String(priorIssue.issued_at), expiresAt: String(priorIssue.expires_at), accessToken: replay.plaintext, identityVersion: identity.identityVersion };
		}
		const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
		const id = randomUUID();
		const issued = this.secrets.derive('access', `provider-access-token:${id}`);
		await this.repository.createAccessToken({ id, credential: matched.metadata, idempotencyKey: input.idempotencyKey, prefix: issued.prefix, hash: issued.hash, issuedAt, expiresAt });
		await this.auditRepository.record({ id: randomUUID(), teamId: membership.teamId, providerId: membership.providerId, membershipId: membership.id, actorType: 'provider-identity', actorId: identity.fingerprint, action: 'provider-access-token.issued', resourceType: 'provider-access-token', resourceId: id, idempotencyKey: input.idempotencyKey, metadata: { credentialId: input.credentialId, expiresAt }, now: issuedAt });
		return { id, teamId: membership.teamId, providerId: membership.providerId, membershipId: matched.metadata.membershipId, credentialId: matched.metadata.id, status: 'active', scopes: matched.metadata.scopes, issuedAt, expiresAt, accessToken: issued.plaintext, identityVersion: identity.identityVersion };
	}

	async rotateIdentity(principal: { membershipId: string; teamId: string; capacityProviderId: string }, request: CapacityProviderIdentityRotationRequest, idempotencyKey: string) {
		if (!idempotencyKey) throw new CapacityGovernanceError('idempotency_key_required', 'Idempotency-Key is required.', 400);
		const signedBody = { expectedIdentityVersion: request.expectedIdentityVersion, newPublicJwk: request.newPublicJwk };
		const requestDigest = sha256(canonicalJson(signedBody));
		const priorRotation = await this.identityRepository.rotationByKey(principal.capacityProviderId, idempotencyKey);
		if (priorRotation) {
			if (String(priorRotation.request_digest) !== requestDigest) throw new CapacityGovernanceError('idempotency_key_conflict', 'Identity-rotation idempotency key is already bound to another request.', 409);
			const priorResult = await this.identityRepository.byId(principal.capacityProviderId);
			if (!priorResult || priorResult.identityVersion < Number(priorRotation.to_identity_version)) throw new CapacityGovernanceError('provider_identity_rotation_incomplete', 'Identity rotation evidence exists without its provider postcondition.', 500);
			return priorResult;
		}
		const current = await this.identityRepository.byId(principal.capacityProviderId);
		if (!current || current.status !== 'active') throw new CapacityGovernanceError('provider_identity_not_active', 'Provider identity is not active.', 403);
		if (request.expectedIdentityVersion !== current.identityVersion) throw new CapacityGovernanceError('provider_identity_version_conflict', 'Provider identity changed before rotation.', 409, { expected: request.expectedIdentityVersion, actual: current.identityVersion });
		const oldVerified = verifyCapacityProviderProof({ proof: request.oldProof, publicJwk: current.publicJwk, method: 'POST', path: '/v1/provider/identity/rotate', audience: this.audience, body: signedBody });
		const newVerified = verifyCapacityProviderProof({ proof: request.newProof, publicJwk: request.newPublicJwk, method: 'POST', path: '/v1/provider/identity/rotate', audience: this.audience, body: signedBody });
		if (oldVerified.payload.identityVersion !== current.identityVersion || newVerified.payload.identityVersion !== current.identityVersion + 1) throw new CapacityGovernanceError('provider_identity_version_invalid', 'Identity rotation proofs must claim the current and next identity versions.', 400);
		if (newVerified.fingerprint === current.fingerprint) throw new CapacityGovernanceError('provider_identity_unchanged', 'Rotated provider identity must use a new Ed25519 key.', 409);
		const conflicting = await this.identityRepository.byFingerprint(newVerified.fingerprint);
		if (conflicting && conflicting.providerId !== current.providerId) throw new CapacityGovernanceError('provider_identity_conflict', 'The rotated provider identity is already registered.', 409);
		const now = nowIso();
		const rotated = await this.identityRepository.rotate({ id: randomUUID(), providerId: current.providerId, expectedVersion: current.identityVersion, oldFingerprint: current.fingerprint, fingerprint: newVerified.fingerprint, publicJwkJson: canonicalJson(request.newPublicJwk), idempotencyKey, requestDigest, proofs: [
			{ fingerprint: oldVerified.fingerprint, jti: oldVerified.payload.jti, expiresAt: oldVerified.payload.expiresAt },
			{ fingerprint: newVerified.fingerprint, jti: newVerified.payload.jti, expiresAt: newVerified.payload.expiresAt },
		], now });
		if (!rotated || rotated.identityVersion !== current.identityVersion + 1 || rotated.fingerprint !== newVerified.fingerprint) throw new CapacityGovernanceError('provider_identity_version_conflict', 'Provider identity changed before rotation committed.', 409);
		let membershipCursor: string | undefined;
		do {
			const page = await this.repository.membershipsForProviderPage(current.providerId, { limit: 200, cursor: membershipCursor });
			for (const membership of page.items) {
				await this.auditRepository.record({ id: randomUUID(), teamId: membership.teamId, providerId: current.providerId, membershipId: membership.id, actorType: 'provider-identity', actorId: current.fingerprint, action: 'provider-identity.rotated', resourceType: 'capacity-provider', resourceId: current.providerId, idempotencyKey, metadata: { previousFingerprint: current.fingerprint, fingerprint: rotated.fingerprint, previousVersion: current.identityVersion, identityVersion: rotated.identityVersion }, now });
			}
			membershipCursor = page.page.nextCursor ?? undefined;
		} while (membershipCursor);
		return rotated;
	}

	async authenticateAccessToken(accessToken: string) {
		const prefix = secretPrefix(accessToken);
		const row = prefix ? await this.repository.accessTokenByPrefix(prefix) : null;
		if (!row || !this.secrets.verify(accessToken, String(row.token_hash))) return null;
		const now = nowIso();
		if (row.status !== 'active' || row.membership_status !== 'approved' || row.provider_status !== 'active') return null;
		if (Date.parse(String(row.expires_at)) <= Date.now()) {
			await this.repository.expireAccessToken(String(row.id), now);
			return null;
		}
		await this.repository.recordAccessTokenUse(String(row.id), now);
		return {
			principal: {
				keyId: String(row.credential_id),
				accessTokenId: String(row.id),
				membershipId: String(row.membership_id),
				capacityProviderId: String(row.capacity_provider_id),
				teamId: String(row.team_id),
				scopes: JSON.parse(String(row.scopes_json || '[]')) as string[],
				authType: 'membership-access-token',
			},
			provider: {
				id: String(row.capacity_provider_id),
				teamId: String(row.team_id),
				name: String(row.display_name),
				status: String(row.provider_status),
				connectionState: 'connected',
			},
		};
	}

	async listRequestsPage(teamId: string, input: { status?: string | null; limit?: unknown; cursor?: unknown } = {}) {
		await this.repository.expireRegistrationRequestsForTeam(teamId, nowIso());
		return this.repository.listRegistrationRequestsPage(teamId, input);
	}

	async registrationRequest(teamId: string, requestId: string) {
		const registration = await this.repository.expireRegistrationRequest(requestId, nowIso());
		if (!registration || registration.teamId !== teamId) throw new CapacityGovernanceError('provider_registration_not_found', 'Provider registration request does not exist.', 404);
		return registration;
	}

	listMembershipsPage(teamId: string, input: { status?: string | null; providerId?: string | null; limit?: unknown; cursor?: unknown } = {}) {
		return this.repository.listMembershipsPage(teamId, input);
	}

	async membership(teamId: string, membershipId: string) {
		const membership = await this.repository.membershipById(membershipId);
		if (!membership || membership.teamId !== teamId) throw new CapacityGovernanceError('provider_membership_not_found', 'Provider membership does not exist.', 404);
		return membership;
	}

	async listCredentialsPage(teamId: string, membershipId: string, input: { status?: string | null; limit?: unknown; cursor?: unknown } = {}) {
		const membership = await this.repository.membershipById(membershipId);
		if (!membership || membership.teamId !== teamId) throw new CapacityGovernanceError('provider_membership_not_found', 'Provider membership does not exist.', 404);
		return this.repository.credentialsForMembershipPage(membershipId, input);
	}

	async revokeCredential(teamId: string, membershipId: string, credentialId: string, actorId: string, idempotencyKey: string) {
		if (!idempotencyKey) throw new CapacityGovernanceError('idempotency_key_required', 'Idempotency-Key is required.', 400);
		const membership = await this.repository.membershipById(membershipId);
		if (!membership || membership.teamId !== teamId) throw new CapacityGovernanceError('provider_membership_not_found', 'Provider membership does not exist.', 404);
		const credential = await this.repository.credentialById(membershipId, credentialId);
		if (!credential) throw new CapacityGovernanceError('provider_credential_not_found', 'Provider membership credential does not exist.', 404);
		const requestDigest = sha256(canonicalJson({ credentialId }));
		const prior = await this.repository.credentialRevocationEvidence(membershipId, credentialId);
		if (prior?.revoke_idempotency_key === idempotencyKey) {
			if (prior.revoke_request_digest !== requestDigest) throw new CapacityGovernanceError('idempotency_key_conflict', 'Credential revocation idempotency key is already bound to another request.', 409);
			return credential;
		}
		const now = nowIso();
		if (credential.status !== 'revoked') await this.repository.revokeCredential(credentialId, idempotencyKey, requestDigest, now);
		await this.auditRepository.record({ id: randomUUID(), teamId, providerId: membership.providerId, membershipId, actorType: 'team-principal', actorId, action: 'provider-credential.revoked', resourceType: 'provider-team-credential', resourceId: credentialId, idempotencyKey, now });
		return await this.repository.credentialById(membershipId, credentialId) ?? credential;
	}

	async authorizeTeamCredentialRotation(teamId: string, membershipId: string, actorId: string, idempotencyKey: string) {
		if (!idempotencyKey) throw new CapacityGovernanceError('idempotency_key_required', 'Idempotency-Key is required.', 400);
		const membership = await this.repository.membershipById(membershipId);
		if (!membership || membership.teamId !== teamId) throw new CapacityGovernanceError('provider_membership_not_found', 'Provider membership does not exist.', 404);
		if (membership.status !== 'approved') throw new CapacityGovernanceError('provider_membership_not_approved', 'Only an approved membership can authorize credential rotation.', 409);
		const prior = await this.credentialAuthorizationRepository.byIssueKey(membershipId, idempotencyKey);
		if (prior) return prior;
		const now = nowIso();
		const authorization = await this.credentialAuthorizationRepository.authorizeRotation({ id: randomUUID(), membership, idempotencyKey, actorId, actorType: 'team-principal', now });
		if (!authorization) throw new CapacityGovernanceError('provider_credential_rotation_conflict', 'Credential rotation authorization conflicted with another operation.', 409);
		await this.auditRepository.record({ id: randomUUID(), teamId, providerId: membership.providerId, membershipId, actorType: 'team-principal', actorId, action: 'provider-credential.rotation-authorized', resourceType: 'provider-credential-issuance-authorization', resourceId: authorization.id, idempotencyKey, metadata: { generation: authorization.generation }, now });
		return authorization;
	}

	async authorizeProviderCredentialRotation(principal: { membershipId: string; teamId: string; capacityProviderId: string; scopes: string[] }, idempotencyKey: string) {
		if (!idempotencyKey) throw new CapacityGovernanceError('idempotency_key_required', 'Idempotency-Key is required.', 400);
		if (!principal.scopes.includes('provider:credentials:rotate')) throw new CapacityGovernanceError('provider_scope_required', 'Provider token does not allow credential rotation.', 403);
		const membership = await this.repository.membershipById(principal.membershipId);
		if (!membership || membership.teamId !== principal.teamId || membership.providerId !== principal.capacityProviderId || membership.status !== 'approved') throw new CapacityGovernanceError('provider_membership_not_approved', 'Provider membership is not approved.', 403);
		const prior = await this.credentialAuthorizationRepository.byIssueKey(membership.id, idempotencyKey);
		if (prior) return prior;
		const now = nowIso();
		const authorization = await this.credentialAuthorizationRepository.authorizeRotation({ id: randomUUID(), membership, idempotencyKey, actorId: membership.providerId, actorType: 'provider-identity', now });
		if (!authorization) throw new CapacityGovernanceError('provider_credential_rotation_conflict', 'Credential rotation authorization conflicted with another operation.', 409);
		await this.auditRepository.record({ id: randomUUID(), teamId: membership.teamId, providerId: membership.providerId, membershipId: membership.id, actorType: 'provider-identity', actorId: membership.providerId, action: 'provider-credential.rotation-authorized', resourceType: 'provider-credential-issuance-authorization', resourceId: authorization.id, idempotencyKey, metadata: { generation: authorization.generation }, now });
		return authorization;
	}

	async updateMembership(teamId: string, membershipId: string, actorId: string, status: 'approved' | 'suspended' | 'revoked', idempotencyKey: string, actorType: 'team-principal' | 'provider-identity' = 'team-principal') {
		if (!idempotencyKey) throw new CapacityGovernanceError('idempotency_key_required', 'Idempotency-Key is required.', 400);
		const current = await this.repository.membershipById(membershipId);
		if (!current || current.teamId !== teamId) throw new CapacityGovernanceError('provider_membership_not_found', 'Provider membership does not exist.', 404);
		const requestDigest = sha256(canonicalJson({ status }));
		const prior = await this.repository.membershipStatusEvidence(membershipId);
		if (prior?.status_idempotency_key === idempotencyKey) {
			if (prior.status_request_digest !== requestDigest) throw new CapacityGovernanceError('idempotency_key_conflict', 'Membership-status idempotency key is already bound to another request.', 409);
			return current;
		}
		if (current.status === status) return current;
		if (current.status === 'revoked') throw new CapacityGovernanceError('provider_membership_revoked', 'A revoked membership cannot be resumed.', 409);
		const now = nowIso();
		const updated = await this.repository.updateMembershipStatus({ teamId, membershipId, expectedStatus: current.status as 'approved' | 'suspended', status, actorId, idempotencyKey, requestDigest, now });
		if ((await this.repository.membershipStatusEvidence(membershipId))?.status_idempotency_key !== idempotencyKey) throw new CapacityGovernanceError('provider_membership_state_conflict', 'Membership changed before the status operation committed.', 409);
		if (status === 'suspended' || status === 'revoked') {
			let assignments;
			do {
				assignments = await this.repository.activeAssignmentsForMembershipBatch(membershipId);
				for (const assignment of assignments) {
					if (assignment.reservation_id) {
						await settleCapacityReservationExactlyOnce(this.repository.database, {
							settlementKey: `membership-${status}:${membershipId}:${assignment.id}:${assignment.reservation_id}`,
							teamId,
							membershipId,
							reservationId: String(assignment.reservation_id),
							assignmentId: String(assignment.id),
							actualCredits: 0,
							source: `provider_membership_${status}`,
							existingSettlementPolicy: 'replay',
							metadata: { actorId, membershipStatus: status },
						});
					}
					await this.repository.invalidateMembershipAssignment({ membershipId, assignmentId: String(assignment.id), stateVersion: Number(assignment.state_version ?? 1), status, now });
				}
			} while (assignments.length > 0);
		}
		await this.auditRepository.record({ id: randomUUID(), teamId, providerId: current.providerId, membershipId, actorType, actorId, action: `provider-membership.${status}`, resourceType: 'provider-team-membership', resourceId: membershipId, idempotencyKey, now });
		return updated;
	}

	leaveMembership(principal: { membershipId: string; teamId: string; capacityProviderId: string }, idempotencyKey: string) {
		return this.updateMembership(principal.teamId, principal.membershipId, principal.capacityProviderId, 'revoked', idempotencyKey, 'provider-identity');
	}
}

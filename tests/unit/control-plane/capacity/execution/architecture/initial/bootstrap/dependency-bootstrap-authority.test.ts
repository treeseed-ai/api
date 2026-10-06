import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { PROVIDER_MEMBERSHIP_SCOPES, type CapacityProviderIdentity, type ProviderRegistrationRequest, type ProviderTeamCredentialMetadata, type ProviderTeamMembership } from '@treeseed/sdk/capacity-provider/contracts';
import { CapacityGovernanceError, type CapacityDatabaseOperation, type CapacityGovernanceDatabase } from '../../../../../../../../src/api/capacity/database.ts';
import { CapacityGovernanceRepository } from '../../../../../../../../src/api/capacity/repositories/governance/policy/governance.ts';
import { CapacityProviderIdentityRepository } from '../../../../../../../../src/api/capacity/repositories/capacity/providers/provider-identity.ts';
import { CapacityRegistrationService } from '../../../../../../../../src/api/capacity/services/support/registration-service.ts';
import { CapacitySecretCodec, canonicalJson, sha256, verifyCapacityProviderProof } from '../../../../../../../../src/api/capacity/security.ts';
import { tokenProofInputs } from '../tokens/dependency-token-fixture.ts';
const conditionalAuditQuery = `INSERT INTO capacity_audit_events (id, team_id, capacity_provider_id, membership_id, actor_type, actor_id, action, resource_type, resource_id, request_id, idempotency_key, metadata_json, created_at)
			 SELECT incoming.* FROM (VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?))
			AS incoming(id, team_id, capacity_provider_id, membership_id, actor_type, actor_id, action, resource_type, resource_id, request_id, idempotency_key, metadata_json, created_at)
			WHERE NOT EXISTS (SELECT 1 FROM capacity_audit_events existing WHERE existing.team_id IS NOT DISTINCT FROM incoming.team_id
				AND existing.action = incoming.action AND existing.resource_id IS NOT DISTINCT FROM incoming.resource_id
				AND existing.idempotency_key IS NOT DISTINCT FROM incoming.idempotency_key) ON CONFLICT DO NOTHING`;

it('original committed access token replay preserves the same missing audit interruption then recovers the original token actor metadata and issuance clock without creating or rewriting authority', async () => {
	const now = new Date(), issuedAt = new Date(now.getTime() - 1000).toISOString(), deadline = new Date(now.getTime() + 3000).toISOString(), signer = tokenProofInputs(now, deadline), body = { credentialId: 'unit-recovery-credential', idempotencyKey: 'unit-recovery-token', requestedValiditySeconds: 60 };
	const identity: CapacityProviderIdentity = { schemaVersion: 1, providerId: 'unit-recovery-provider', fingerprint: signer.payload.providerFingerprint, publicJwk: signer.publicJwk, displayName: 'Arbitrary enrolled identity input', identityVersion: 1, status: 'active', createdAt: issuedAt, updatedAt: issuedAt };
	const membership: ProviderTeamMembership = { id: 'unit-recovery-member', teamId: 'unit-recovery-team', providerId: identity.providerId, status: 'approved', approvedAt: issuedAt, approvedById: 'unit-operator', updatedAt: issuedAt };
	const secrets = new CapacitySecretCodec('unit-recovery-hash-material', 'unit-recovery-envelope-material'), credential = secrets.derive('credential', `membership-credential:${body.credentialId}`), token = secrets.derive('access', 'provider-access-token:unit-recovery-token-id');
	const metadata: ProviderTeamCredentialMetadata = { id: body.credentialId, membershipId: membership.id, teamId: membership.teamId, providerId: identity.providerId, keyPrefix: credential.prefix, issuanceGeneration: 1, status: 'active', scopes: [...PROVIDER_MEMBERSHIP_SCOPES], createdAt: issuedAt, updatedAt: issuedAt, rotatedFromCredentialId: null };
	const matched = { metadata, hash: credential.hash, membershipStatus: 'approved' }, prior = { id: 'unit-recovery-token-id', membership_id: membership.id, credential_id: metadata.id, idempotency_key: body.idempotencyKey, token_prefix: token.prefix, token_hash: token.hash, scopes_json: JSON.stringify(metadata.scopes), status: 'active', issued_at: issuedAt, expires_at: new Date(Date.parse(issuedAt) + 60000).toISOString(), last_used_at: null, expired_at: null, revoked_at: null, updated_at: issuedAt };
	const cause = new Error('Controlled original access-token audit interruption'), attempts: { query: string; params: unknown[] }[] = []; let interrupt = true, reads = 0, batches = 0, initialized = 0;
	const database: CapacityGovernanceDatabase = { ensureInitialized: async () => { initialized++; }, first: async () => { reads++; throw new Error('Unexpected token recovery read'); }, all: async () => { reads++; throw new Error('Unexpected token recovery list'); }, batch: async () => { batches++; throw new Error('Token recovery must not rewrite authority'); }, run: async (query, params = []) => {
		attempts.push({ query, params: structuredClone(params) }); if (interrupt) throw cause;
	} };
	const repository = new CapacityGovernanceRepository(database), service = new CapacityRegistrationService(repository, secrets, 'http://localhost');
	const authenticate = vi.spyOn(repository, 'authenticateCredential').mockResolvedValue(matched), member = vi.spyOn(repository, 'membershipById').mockResolvedValue(membership), current = vi.spyOn(CapacityProviderIdentityRepository.prototype, 'byId').mockResolvedValue(identity), team = vi.spyOn(repository, 'teamExists').mockResolvedValue(true), nonce = vi.spyOn(repository, 'consumeProofNonce').mockResolvedValue(true), lookup = vi.spyOn(repository, 'accessTokenByIssueKey').mockResolvedValue(prior), create = vi.spyOn(repository, 'createAccessToken');
	const spies = [authenticate, member, current, team, nonce, lookup, create], original = structuredClone({ identity, membership, matched, prior, body }), nonces: string[] = [];
	try {
		for (let index = 0; index < 4; index++) {
			for (const spy of spies) spy.mockClear();
			const payload = { ...signer.payload, identityVersion: 1, bodySha256: sha256(canonicalJson(body)), jti: randomUUID() }, input = { ...body, credentialValue: credential.plaintext, path: payload.path, proof: signer.proof(payload) }, before = structuredClone(input); nonces.push(payload.jti);
			if (index < 2) await expect(service.issueAccessToken(input)).rejects.toBe(cause);
			else {
				interrupt = false; const replay = await service.issueAccessToken(input); expect(replay.accessToken === token.plaintext).toBe(true);
				expect({ ...replay, accessToken: undefined }).toEqual({ id: prior.id, teamId: membership.teamId, providerId: identity.providerId, membershipId: membership.id, credentialId: metadata.id, status: 'active', scopes: metadata.scopes, issuedAt, expiresAt: prior.expires_at, identityVersion: 1, accessToken: undefined });
			}
			expect(attempts).toHaveLength(index + 1); const attempt = attempts[index]!;
			expect(attempt.query).toBe(conditionalAuditQuery);
			expect(attempt.params).toEqual([sha256(`provider-access-token.issued:${prior.id}`), membership.teamId, identity.providerId, membership.id, 'provider-identity', identity.fingerprint, 'provider-access-token.issued', 'provider-access-token', prior.id, null, body.idempotencyKey, JSON.stringify({ credentialId: metadata.id, expiresAt: prior.expires_at, validitySeconds: 60 }), issuedAt]); expect(attempt.params[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
			expect(authenticate).toHaveBeenCalledExactlyOnceWith(credential.prefix); expect(member).toHaveBeenCalledExactlyOnceWith(membership.id); expect(current).toHaveBeenCalledExactlyOnceWith(identity.providerId); expect(team).toHaveBeenCalledExactlyOnceWith(membership.teamId); expect(lookup).toHaveBeenCalledExactlyOnceWith(membership.id, body.idempotencyKey); expect(nonce).toHaveBeenCalledTimes(1); expect(nonce.mock.calls[0]!.slice(0, 3)).toEqual([identity.fingerprint, payload.jti, deadline]); expect(nonce.mock.calls[0]![3]).toBeTypeOf('string'); expect(create).not.toHaveBeenCalled();
			expect(initialized).toBe(index + 1); expect(reads).toBe(0); expect(batches).toBe(0); expect(input).toEqual(before); expect({ identity, membership, matched, prior, body }).toEqual(original); expect(Date.now() < Date.parse(deadline)).toBe(true); expect(JSON.stringify(attempts).includes(credential.plaintext)).toBe(false); expect(JSON.stringify(attempts).includes(token.plaintext)).toBe(false);
		}
		expect(new Set(nonces).size).toBe(4);
	} finally { for (const spy of spies) spy.mockRestore(); }
});

it('original identity rotation repository keeps both proofs evidence identity and token revocation in one exact pending batch and propagates the same interruption before unchanged retry readback', async () => {
	const now = '2026-10-03T20:45:14.000Z', deadline = '2026-10-03T20:45:17.000Z', oldKey = tokenProofInputs(new Date(now), deadline), newKey = tokenProofInputs(new Date(now), deadline);
	const input: Parameters<CapacityProviderIdentityRepository['rotate']>[0] = { id: 'unit-rotation', providerId: 'unit-provider', expectedVersion: 1, oldFingerprint: oldKey.payload.providerFingerprint, fingerprint: newKey.payload.providerFingerprint, publicJwkJson: canonicalJson(newKey.publicJwk), idempotencyKey: 'unit-rotation-key', requestDigest: sha256(canonicalJson({ expectedIdentityVersion: 1, newPublicJwk: newKey.publicJwk })), proofs: [{ fingerprint: oldKey.payload.providerFingerprint, jti: 'unit-old-nonce', expiresAt: deadline }, { fingerprint: newKey.payload.providerFingerprint, jti: 'unit-new-nonce', expiresAt: deadline }], now };
	const row = { id: input.providerId, fingerprint: input.fingerprint, public_jwk_json: input.publicJwkJson, display_name: 'Arbitrary unit identity', identity_version: 2, status: 'active', created_at: now, updated_at: now, rotated_at: now, revoked_at: null }, original = structuredClone({ input, row });
	const expected: CapacityDatabaseOperation[] = [
		{ query: 'WITH authority AS MATERIALIZED (SELECT id FROM capacity_providers WHERE id = ? FOR UPDATE), expired AS (DELETE FROM capacity_provider_proof_nonces WHERE expires_at <= ? RETURNING jti) SELECT id FROM authority', params: [input.providerId, now] },
		...input.proofs.map(proof => ({ query: "INSERT INTO capacity_provider_proof_nonces (provider_fingerprint, jti, expires_at, created_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM capacity_providers WHERE id = ? AND identity_version = ? AND fingerprint = ? AND status = 'active')", params: [proof.fingerprint, proof.jti, deadline, now, input.providerId, 1, input.oldFingerprint] })),
		{ query: "INSERT INTO capacity_provider_identity_rotations (id, capacity_provider_id, from_identity_version, to_identity_version, old_fingerprint, new_fingerprint, idempotency_key, request_digest, created_at) SELECT ?, id, identity_version, identity_version + 1, fingerprint, ?, ?, ?, ? FROM capacity_providers WHERE id = ? AND identity_version = ? AND fingerprint = ? AND status = 'active'", params: [input.id, input.fingerprint, input.idempotencyKey, input.requestDigest, now, input.providerId, 1, input.oldFingerprint] },
		{ query: "UPDATE capacity_providers SET fingerprint = ?, public_jwk_json = ?, identity_version = identity_version + 1, rotated_at = ?, updated_at = ? WHERE id = ? AND identity_version = ? AND status = 'active' AND EXISTS (SELECT 1 FROM capacity_provider_identity_rotations WHERE id = ? AND capacity_provider_id = ?)", params: [input.fingerprint, input.publicJwkJson, now, now, input.providerId, 1, input.id, input.providerId] },
		{ query: "UPDATE capacity_provider_access_tokens SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE membership_id IN (SELECT id FROM capacity_provider_team_memberships WHERE capacity_provider_id = ?) AND status = 'active' AND EXISTS (SELECT 1 FROM capacity_provider_identity_rotations WHERE id = ? AND capacity_provider_id = ?)", params: [now, now, input.providerId, input.id, input.providerId] },
	];
	let reject: (error: Error) => void = () => { throw new Error('Owned unit rotation barrier missing'); }, reads = 0, writes = 0, initialized = 0, settled = false, interrupted = true;
	const cause = new Error('Controlled final rotation batch interruption'), barrier = new Promise<unknown>((_, fail) => { reject = fail; }), batches: CapacityDatabaseOperation[][] = [];
	const database: CapacityGovernanceDatabase = { ensureInitialized: async () => { initialized++; }, first: async (query, params) => { reads++; expect(interrupted).toBe(false); expect(query).toBe('SELECT * FROM capacity_providers WHERE id = ? LIMIT 1'); expect(params).toEqual([input.providerId]); return row; }, all: async () => { reads++; throw new Error('Unexpected unit rotation list'); }, run: async () => { writes++; throw new Error('Unexpected split rotation write'); }, batch: operations => { batches.push(structuredClone(operations)); return interrupted ? barrier : Promise.resolve([]); } };
	const repository = new CapacityProviderIdentityRepository(database), pending = repository.rotate(input); void pending.then(() => { settled = true; }, () => { settled = true; });
	try {
		expect(batches).toEqual([expected]); expect(reads).toBe(0); expect(writes).toBe(0); expect(initialized).toBe(0); expect(settled).toBe(false); expect({ input, row }).toEqual(original);
		reject(cause); await expect(pending).rejects.toBe(cause); expect(settled).toBe(true); expect(batches).toEqual([expected]); expect(reads).toBe(0); expect(writes).toBe(0); expect(initialized).toBe(0); expect({ input, row }).toEqual(original);
		interrupted = false; expect(await repository.rotate(input)).toEqual({ schemaVersion: 1, providerId: input.providerId, fingerprint: input.fingerprint, publicJwk: newKey.publicJwk, displayName: row.display_name, identityVersion: 2, status: 'active', createdAt: now, updatedAt: now, rotatedAt: now, revokedAt: null });
		expect(batches).toEqual([expected, expected]); expect(reads).toBe(1); expect(writes).toBe(0); expect(initialized).toBe(1); expect({ input, row }).toEqual(original);
	} finally { reject(cause); await Promise.allSettled([pending]); }
});

it('original committed identity rotation replay preserves the same missing audit failure and recovers the exact original actor version and clock without rotating or consuming proofs again', async () => {
	const now = new Date(), deadline = new Date(now.getTime() + 3000).toISOString(), oldKey = tokenProofInputs(now, deadline), nextKey = tokenProofInputs(now, deadline), key = 'unit-rotation-recovery';
	const identity: CapacityProviderIdentity = { schemaVersion: 1, providerId: 'unit-recovery-provider', fingerprint: oldKey.payload.providerFingerprint, publicJwk: oldKey.publicJwk, displayName: 'Arbitrary recovery identity', identityVersion: 1, status: 'active', createdAt: now.toISOString(), updatedAt: now.toISOString() };
	const membership: ProviderTeamMembership = { id: 'unit-recovery-member', teamId: 'unit-recovery-team', providerId: identity.providerId, status: 'approved', approvedAt: now.toISOString(), approvedById: 'unit-operator', updatedAt: now.toISOString() }, principal = { membershipId: membership.id, teamId: membership.teamId, capacityProviderId: identity.providerId };
	const signed = { expectedIdentityVersion: 1, newPublicJwk: nextKey.publicJwk }, digest = sha256(canonicalJson(signed)), oldClaims = { ...oldKey.payload, path: '/v1/provider/identity/rotate', bodySha256: digest, jti: randomUUID() }, newClaims = { ...nextKey.payload, path: oldClaims.path, identityVersion: 2, bodySha256: digest, jti: randomUUID() }, body = { ...signed, oldProof: oldKey.proof(oldClaims), newProof: nextKey.proof(newClaims) };
	const original = structuredClone({ identity, membership, principal, oldClaims, newClaims, body }), cause = new Error('Controlled committed rotation audit interruption'), writes: unknown[][] = [], transitions: Array<Parameters<CapacityProviderIdentityRepository['rotate']>[0]> = [];
	let current = identity, evidence: Record<string, unknown> | null = null, interrupt = true, reads = 0, batches = 0;
	const database: CapacityGovernanceDatabase = { ensureInitialized: async () => undefined, first: async () => { reads++; throw new Error('Unexpected unit rotation read'); }, all: async () => { reads++; throw new Error('Unexpected unit rotation list'); }, batch: async () => { batches++; throw new Error('Unexpected unit rotation batch'); }, run: async (query, params = []) => {
		expect(query).toBe(conditionalAuditQuery); writes.push(structuredClone(params)); if (interrupt) throw cause;
	} };
	const repository = new CapacityGovernanceRepository(database), service = new CapacityRegistrationService(repository, new CapacitySecretCodec('unit-recovery-hash-material', 'unit-recovery-envelope-material'), 'http://localhost');
	const prior = vi.spyOn(CapacityProviderIdentityRepository.prototype, 'rotationByKey').mockImplementation(async () => evidence), lookup = vi.spyOn(CapacityProviderIdentityRepository.prototype, 'byId').mockImplementation(async () => current), conflict = vi.spyOn(CapacityProviderIdentityRepository.prototype, 'byFingerprint').mockResolvedValue(null), rotate = vi.spyOn(CapacityProviderIdentityRepository.prototype, 'rotate').mockImplementation(async input => {
		transitions.push(structuredClone(input)); current = { ...identity, identityVersion: 2, fingerprint: nextKey.payload.providerFingerprint, publicJwk: nextKey.publicJwk, rotatedAt: input.now, updatedAt: input.now };
		evidence = { id: input.id, capacity_provider_id: identity.providerId, from_identity_version: 1, to_identity_version: 2, old_fingerprint: identity.fingerprint, new_fingerprint: current.fingerprint, idempotency_key: key, request_digest: digest, created_at: input.now }; return current;
	}), members = vi.spyOn(repository, 'membershipsForProviderPage').mockResolvedValue({ items: [membership], page: { limit: 200, hasMore: false, nextCursor: null } });
	const spies = [prior, lookup, conflict, rotate, members];
	try {
		const start = new Date().toISOString(); await expect(service.rotateIdentity(principal, body, key)).rejects.toBe(cause); const end = new Date().toISOString();
		expect(transitions).toHaveLength(1); const transition = transitions[0]!; expect(transition.now >= start && transition.now <= end && end < deadline).toBe(true); expect(transition.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(transition).toEqual({ id: transition.id, providerId: identity.providerId, expectedVersion: 1, oldFingerprint: identity.fingerprint, fingerprint: nextKey.payload.providerFingerprint, publicJwkJson: canonicalJson(nextKey.publicJwk), idempotencyKey: key, requestDigest: digest, proofs: [{ fingerprint: oldClaims.providerFingerprint, jti: oldClaims.jti, expiresAt: deadline }, { fingerprint: newClaims.providerFingerprint, jti: newClaims.jti, expiresAt: deadline }], now: transition.now });
		const committed = structuredClone({ current, evidence }); expect(writes).toHaveLength(1);
		// SAME original key/body/proofs, not a refreshed proof or simulated
		// retry transition. A still-failing audit must retain the SAME cause.
		await expect(service.rotateIdentity(principal, body, key)).rejects.toBe(cause); expect(writes).toHaveLength(2); expect({ current, evidence }).toEqual(committed);
		interrupt = false; expect(await service.rotateIdentity(principal, body, key)).toEqual(committed.current); expect(writes).toHaveLength(3); expect(await service.rotateIdentity(principal, body, key)).toEqual(committed.current); expect(writes).toHaveLength(4);
		for (const params of writes) { expect(params).toHaveLength(13); expect(params[0]).toBe(sha256(`provider-identity.rotated:${identity.providerId}:${membership.teamId}:2`)); expect(params.slice(1)).toEqual([membership.teamId, identity.providerId, membership.id, 'provider-identity', identity.fingerprint, 'provider-identity.rotated', 'capacity-provider', identity.providerId, null, key, JSON.stringify({ previousFingerprint: identity.fingerprint, fingerprint: current.fingerprint, previousVersion: 1, identityVersion: 2 }), transition.now]); }
		expect(prior.mock.calls).toEqual(Array.from({ length: 5 }, () => [identity.providerId, key])); expect(lookup.mock.calls).toEqual(Array.from({ length: 4 }, () => [identity.providerId])); expect(conflict).toHaveBeenCalledExactlyOnceWith(nextKey.payload.providerFingerprint); expect(rotate).toHaveBeenCalledTimes(1); expect(members.mock.calls).toEqual(Array.from({ length: 4 }, () => [identity.providerId, { limit: 200, cursor: undefined }]));
		expect(reads).toBe(0); expect(batches).toBe(0); expect({ current, evidence }).toEqual(committed); expect({ identity, membership, principal, oldClaims, newClaims, body }).toEqual(original); expect(Date.now() < Date.parse(deadline)).toBe(true);
	} finally { for (const spy of spies) spy.mockRestore(); }
});

it('original access token authority admits the current signed identity version but denies stale and future versions under the same current key before nonce consumption or token lookup', async () => {
	const now = new Date(), deadline = new Date(now.getTime() + 3000).toISOString(), signer = tokenProofInputs(now, deadline), body = { ...signer.body, credentialId: 'unit-current-credential' };
	const identity: CapacityProviderIdentity = { schemaVersion: 1, providerId: 'unit-current-provider', fingerprint: signer.payload.providerFingerprint, publicJwk: signer.publicJwk, displayName: 'Arbitrary current identity', identityVersion: 2, status: 'active', createdAt: now.toISOString(), updatedAt: now.toISOString() };
	const membership: ProviderTeamMembership = { id: 'unit-current-member', teamId: 'unit-current-team', providerId: identity.providerId, status: 'approved', approvedAt: now.toISOString(), approvedById: 'unit-operator', updatedAt: now.toISOString() };
	const secrets = new CapacitySecretCodec('unit-current-hash-material', 'unit-current-envelope-material'), credential = secrets.derive('credential', `membership-credential:${body.credentialId}`), token = secrets.derive('access', 'provider-access-token:unit-current-token');
	const metadata: ProviderTeamCredentialMetadata = { id: body.credentialId, membershipId: membership.id, teamId: membership.teamId, providerId: identity.providerId, keyPrefix: credential.prefix, issuanceGeneration: 1, status: 'active', scopes: [...PROVIDER_MEMBERSHIP_SCOPES], createdAt: now.toISOString(), updatedAt: now.toISOString(), rotatedFromCredentialId: null };
	const matched = { metadata, hash: credential.hash, membershipStatus: 'approved' }, prior = { id: 'unit-current-token', credential_id: metadata.id, status: 'active', token_hash: token.hash, scopes_json: JSON.stringify(metadata.scopes), issued_at: now.toISOString(), expires_at: new Date(now.getTime() + 60000).toISOString() };
	let reads = 0, writes = 0;
	const database: CapacityGovernanceDatabase = { ensureInitialized: async () => undefined, first: async () => { reads++; throw new Error('Unexpected unit authority read'); }, all: async () => { reads++; throw new Error('Unexpected unit authority list'); }, run: async (query, params) => { writes++; expect(query).toBe(conditionalAuditQuery); expect(params).toEqual([sha256(`provider-access-token.issued:${prior.id}`), membership.teamId, identity.providerId, membership.id, 'provider-identity', identity.fingerprint, 'provider-access-token.issued', 'provider-access-token', prior.id, null, body.idempotencyKey, JSON.stringify({ credentialId: metadata.id, expiresAt: prior.expires_at, validitySeconds: 60 }), prior.issued_at]); }, batch: async () => { throw new Error('Unexpected unit authority batch'); } };
	const repository = new CapacityGovernanceRepository(database), service = new CapacityRegistrationService(repository, secrets, 'http://localhost');
	const authenticate = vi.spyOn(repository, 'authenticateCredential').mockResolvedValue(matched), member = vi.spyOn(repository, 'membershipById').mockResolvedValue(membership), current = vi.spyOn(CapacityProviderIdentityRepository.prototype, 'byId').mockResolvedValue(identity), team = vi.spyOn(repository, 'teamExists').mockResolvedValue(true), nonce = vi.spyOn(repository, 'consumeProofNonce').mockResolvedValue(true), lookup = vi.spyOn(repository, 'accessTokenByIssueKey').mockResolvedValue(prior), create = vi.spyOn(repository, 'createAccessToken');
	const spies = [authenticate, member, current, team, nonce, lookup, create], original = structuredClone({ identity, membership, metadata, matched, prior, body });
	try {
		for (const version of [2, 1, 3]) {
			for (const spy of spies) spy.mockClear();
			const payload = { ...signer.payload, identityVersion: version, bodySha256: sha256(canonicalJson(body)), jti: randomUUID() }, input = { ...body, credentialValue: credential.plaintext, path: payload.path, proof: signer.proof(payload) }, inputBefore = structuredClone(input);
			if (version === 2) {
				const result = await service.issueAccessToken(input); expect(result.accessToken === token.plaintext).toBe(true);
				expect({ ...result, accessToken: undefined }).toEqual({ id: prior.id, teamId: membership.teamId, providerId: identity.providerId, membershipId: membership.id, credentialId: metadata.id, status: 'active', scopes: metadata.scopes, issuedAt: prior.issued_at, expiresAt: prior.expires_at, accessToken: undefined, identityVersion: 2 });
				expect(nonce).toHaveBeenCalledTimes(1); expect(nonce.mock.calls[0]!.slice(0, 3)).toEqual([identity.fingerprint, payload.jti, deadline]); expect(nonce.mock.calls[0]![3]).toBeTypeOf('string'); expect(lookup).toHaveBeenCalledExactlyOnceWith(membership.id, body.idempotencyKey);
			} else {
				let failure: unknown; try { await service.issueAccessToken(input); } catch (error) { failure = error; }
				// No existing mismatch code is invented here: the owning error class
				// and exact authentication status, not an arbitrary exception, govern.
				expect(failure).toBeInstanceOf(CapacityGovernanceError); expect(failure).toMatchObject({ status: 401 }); expect(nonce).not.toHaveBeenCalled(); expect(lookup).not.toHaveBeenCalled();
			}
			expect(authenticate).toHaveBeenCalledExactlyOnceWith(credential.prefix); expect(member).toHaveBeenCalledExactlyOnceWith(membership.id); expect(current).toHaveBeenCalledExactlyOnceWith(identity.providerId); expect(team).toHaveBeenCalledExactlyOnceWith(membership.teamId); expect(create).not.toHaveBeenCalled(); expect(reads).toBe(0); expect(writes).toBe(1); expect(input).toEqual(inputBefore); expect({ identity, membership, metadata, matched, prior, body }).toEqual(original); expect(Date.now() < Date.parse(deadline)).toBe(true);
		}
	} finally { for (const spy of spies) spy.mockRestore(); }
});

// Signed inputs, not external identity issuance or native enrollment. The
// original verifier owns validation; no second proof validator is introduced.
it('original bootstrap proof verification binds each exchange and token stage to its exact body route identity and unchanged expiry without accepting crossover', () => {
	const now = new Date('2026-10-03T18:29:44.000Z'), deadline = new Date(now.getTime() + 3000).toISOString(), signer = tokenProofInputs(now, deadline), foreign = tokenProofInputs(now, deadline);
	const stages = [
		{ path: '/v1/provider-registrations/genuine-request/credential', body: { requestId: 'genuine-request', idempotencyKey: 'first-exchange' } },
		{ path: '/v1/provider/access-tokens', body: { credentialId: 'genuine-credential', idempotencyKey: 'first-token', requestedValiditySeconds: 60 } },
	];
	for (const [index, stage] of stages.entries()) {
		const payload = { ...signer.payload, path: stage.path, bodySha256: sha256(canonicalJson(stage.body)), jti: randomUUID() }, proof = signer.proof(payload);
		const input = { proof, publicJwk: signer.publicJwk, method: 'POST', path: stage.path, audience: 'http://localhost', body: stage.body, now }, original = structuredClone(input);
		expect(verifyCapacityProviderProof(input)).toMatchObject({ payload }); expect(input).toEqual(original);
		expect(verifyCapacityProviderProof({ ...input, now: new Date(Date.parse(deadline) - 1) })).toMatchObject({ payload }); expect(input).toEqual(original);
		for (const mode of ['crossover', 'body', 'identity', 'method', 'audience', 'signature', 'expiry', 'after-expiry'] as const) {
			const changed = structuredClone(input);
			if (mode === 'crossover') { changed.path = stages[1 - index]!.path; changed.body = stages[1 - index]!.body; }
			if (mode === 'body') changed.body = { ...stage.body, idempotencyKey: 'foreign-key' };
			if (mode === 'identity') changed.publicJwk = foreign.publicJwk;
			if (mode === 'method') changed.method = 'GET'; if (mode === 'audience') changed.audience = 'http://foreign';
			if (mode === 'signature') changed.proof.signature = `${proof.signature[0] === 'A' ? 'B' : 'A'}${proof.signature.slice(1)}`;
			if (mode === 'expiry' || mode === 'after-expiry') changed.now = new Date(Date.parse(deadline) + (mode === 'after-expiry' ? 1 : 0));
			const before = structuredClone(changed); let error: unknown; try { verifyCapacityProviderProof(changed); } catch (caught) { error = caught; }
			expect(error).toBeInstanceOf(CapacityGovernanceError); expect(error).toMatchObject({ status: 401 }); expect(changed).toEqual(before);
		}
	}
});

it('original first credential repository keeps conditional authorization and credential in one pending batch with exact inputs and propagates the same native boundary failure before readback', async () => {
	const now = '2026-10-03T18:46:14.000Z';
	const membership: ProviderTeamMembership = { id: 'unit-member', teamId: 'unit-team', providerId: 'unit-provider', status: 'approved', approvedAt: now, approvedById: 'unit-operator', updatedAt: now };
	const input: Parameters<CapacityGovernanceRepository['createCredential']>[0] = { id: 'unit-first-credential', authorization: { id: 'unit-authorization', membershipId: membership.id, teamId: membership.teamId, providerId: membership.providerId, generation: 1, status: 'pending', issuedCredentialId: null, createdAt: now, updatedAt: now }, membership, prefix: 'controlled-prefix', hash: 'controlled-hash-input', issueIdempotencyKey: 'unit-first-exchange', scopes: [...PROVIDER_MEMBERSHIP_SCOPES], now };
	const before = structuredClone(input), batches: CapacityDatabaseOperation[][] = []; let reads = 0, writes = 0;
	let release: (value: unknown) => void = () => { throw new Error('Owned unit batch barrier missing'); }; const barrier = new Promise<unknown>(resolve => { release = resolve; });
	const database: CapacityGovernanceDatabase = { ensureInitialized: async () => undefined,
		first: async (query, params) => { reads++; expect(query).toBe('SELECT * FROM capacity_provider_team_credentials WHERE membership_id = ? AND issue_idempotency_key = ? LIMIT 1'); expect(params).toEqual([membership.id, input.issueIdempotencyKey]); return null; },
		all: async () => { throw new Error('Unexpected unit list'); }, run: async () => { writes++; throw new Error('Unexpected split credential write'); }, batch: operations => { batches.push(structuredClone(operations)); return barrier; } };
	const pending = new CapacityGovernanceRepository(database).createCredential(input); void pending.catch(() => undefined);
	try {
		expect(reads).toBe(0); expect(writes).toBe(0); expect(batches).toHaveLength(1); const operations = batches[0]!; expect(operations).toHaveLength(2);
		expect(operations[0]!.query).toBe("UPDATE capacity_provider_credential_issuance_authorizations SET status = 'issued', issued_credential_id = ?, updated_at = ? WHERE id = ? AND membership_id = ? AND status = 'pending'"); expect(operations[0]!.params).toEqual([input.id, now, input.authorization.id, membership.id]);
		expect(operations[1]!.query).toContain("WHERE EXISTS (SELECT 1 FROM capacity_provider_credential_issuance_authorizations WHERE id = ? AND membership_id = ? AND status = 'issued' AND issued_credential_id = ?) AND NOT EXISTS (SELECT 1 FROM capacity_provider_team_credentials WHERE membership_id = ? AND status = 'active')");
		expect(operations[1]!.params).toEqual([input.id, membership.id, membership.teamId, membership.providerId, input.prefix, input.hash, input.authorization.id, 1, input.issueIdempotencyKey, JSON.stringify(input.scopes), null, now, now, input.authorization.id, membership.id, input.id, membership.id]);
		release([]); expect(await pending).toBeNull(); expect(reads).toBe(1); expect(writes).toBe(0); expect(input).toEqual(before);
	} finally { release([]); await Promise.allSettled([pending]); }
	const cause = new Error('Controlled first-credential batch interruption'); let failedReads = 0, failedBatches = 0;
	const failed: CapacityGovernanceDatabase = { ...database, first: async () => { failedReads++; return null; }, batch: async operations => { failedBatches++; expect(operations).toEqual(batches[0]); throw cause; } };
	await expect(new CapacityGovernanceRepository(failed).createCredential(input)).rejects.toBe(cause); expect(failedBatches).toBe(1); expect(failedReads).toBe(0); expect(input).toEqual(before);
});

it('original committed credential replay must propagate a missing audit write failure then recover that exact audit without reissuing or rewriting the approved authority', async () => {
	const now = new Date(), deadline = new Date(now.getTime() + 3000).toISOString(), signer = tokenProofInputs(now, deadline), body = { requestId: 'unit-approved-request', idempotencyKey: 'unit-committed-exchange' }, path = '/v1/provider-registrations/unit-approved-request/credential';
	const identity: CapacityProviderIdentity = { schemaVersion: 1, providerId: 'unit-provider', fingerprint: signer.payload.providerFingerprint, publicJwk: signer.publicJwk, displayName: 'Renamed unit provider', identityVersion: 1, status: 'active', createdAt: now.toISOString(), updatedAt: now.toISOString() };
	const membership: ProviderTeamMembership = { id: 'unit-member', teamId: 'unit-team', providerId: identity.providerId, status: 'approved', approvedAt: now.toISOString(), approvedById: 'unit-operator', updatedAt: now.toISOString() };
	const request: ProviderRegistrationRequest = { id: body.requestId, teamId: membership.teamId, providerId: identity.providerId, providerFingerprint: identity.fingerprint, registrationKeyGeneration: 1, status: 'approved', membershipId: membership.id, capabilitySummary: ['renamed.execution'], supplyOffer: { capabilities: ['renamed.execution'], weight: 1, maxConcurrentRunners: 1 }, expiresAt: deadline, createdAt: now.toISOString(), updatedAt: now.toISOString() };
	const metadata: ProviderTeamCredentialMetadata = { id: 'unit-committed-credential', membershipId: membership.id, teamId: membership.teamId, providerId: identity.providerId, keyPrefix: 'controlled-prefix', issuanceGeneration: 1, status: 'active', scopes: [...PROVIDER_MEMBERSHIP_SCOPES], createdAt: now.toISOString(), updatedAt: now.toISOString(), rotatedFromCredentialId: null };
	const secrets = new CapacitySecretCodec('controlled-unit-hash-material-only', 'controlled-unit-envelope-material-only'), derived = secrets.derive('credential', `membership-credential:${metadata.id}`), prior = { metadata, hash: derived.hash, issueIdempotencyKey: body.idempotencyKey, revealedAt: now.toISOString() };
	metadata.keyPrefix = derived.prefix;
	const cause = new Error('Controlled missing credential audit interruption'), writes: unknown[][] = []; let interrupt = true, reads = 0;
	const database: CapacityGovernanceDatabase = { ensureInitialized: async () => undefined, first: async () => { reads++; throw new Error('Unexpected unmocked unit read'); }, all: async () => { reads++; throw new Error('Unexpected unit list'); }, batch: async () => { throw new Error('Credential replay must not re-enroll'); }, run: async (query, params = []) => {
		expect(query).toContain('INSERT INTO capacity_audit_events'); expect(query).toContain('ON CONFLICT DO NOTHING'); writes.push(structuredClone(params)); if (interrupt) throw cause;
	} };
	const repository = new CapacityGovernanceRepository(database), service = new CapacityRegistrationService(repository, secrets, 'http://localhost');
	const spies = [vi.spyOn(repository, 'registrationRequestById').mockResolvedValue(request), vi.spyOn(repository, 'teamExists').mockResolvedValue(true), vi.spyOn(CapacityProviderIdentityRepository.prototype, 'byId').mockResolvedValue(identity), vi.spyOn(repository, 'membershipById').mockResolvedValue(membership), vi.spyOn(repository, 'consumeProofNonce').mockResolvedValue(true), vi.spyOn(repository, 'credentialByIssueKey').mockResolvedValue(prior)];
	const create = vi.spyOn(repository, 'createCredential'), reveal = vi.spyOn(repository, 'markCredentialRevealed'), original = structuredClone({ identity, membership, request, metadata, body, prior });
	const payload = { ...signer.payload, path, bodySha256: sha256(canonicalJson(body)) }, proof = () => signer.proof({ ...payload, jti: randomUUID() });
	try {
		await expect(service.exchangeCredential(request.id, proof(), path, body.idempotencyKey)).rejects.toBe(cause); expect(writes).toHaveLength(1); interrupt = false;
		const replay = await service.exchangeCredential(request.id, proof(), path, body.idempotencyKey); expect(replay.credential === derived.plaintext).toBe(true); expect({ ...replay, credential: undefined }).toEqual({ ...metadata, credential: undefined }); expect(writes).toHaveLength(2);
		for (const params of writes) { expect(params).toHaveLength(13); expect(params.slice(1, 12)).toEqual([membership.teamId, identity.providerId, membership.id, 'provider-identity', identity.fingerprint, 'provider-credential.issued', 'provider-team-credential', metadata.id, request.id, body.idempotencyKey, '{}']); expect(params[12]).toBeTypeOf('string'); }
		expect(create).not.toHaveBeenCalled(); expect(reveal).not.toHaveBeenCalled(); expect(reads).toBe(0); expect({ identity, membership, request, metadata, body, prior }).toEqual(original); expect(Date.now() < Date.parse(deadline)).toBe(true);
	} finally { for (const spy of spies) spy.mockRestore(); create.mockRestore(); reveal.mockRestore(); }
});

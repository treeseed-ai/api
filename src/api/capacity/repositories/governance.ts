import type {
	ProviderRegistrationRequest,
	ProviderTeamCredentialMetadata,
	ProviderTeamMembership,
	ProviderMembershipScope,
	ProviderCredentialIssuanceAuthorization,
	TeamCapacityRegistrationKeyMetadata,
} from '@treeseed/sdk/capacity-provider/contracts';
import {
	decodeCapacityPageCursor,
	encodeCapacityPageCursor,
	normalizeCapacityPageLimit,
	type CapacityPage,
	type CapacityPageCursor,
} from '@treeseed/sdk/capacity-pagination';
import type { CapacityDatabaseOperation, CapacityGovernanceDatabase } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';
import { isUniqueConstraintViolation } from '../database-errors.ts';
import { CapacityRegistrationSecurityRepository, type RegistrationRateBucket } from './registration-security.ts';
import { CapacityRegistrationRequestAdmissionRepository } from './registration-request-admission.ts';
function json<T>(value: unknown, fallback: T): T {
	if (typeof value !== 'string' || !value) return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}


function registrationKey(row: Record<string, unknown>): TeamCapacityRegistrationKeyMetadata {
	return {
		teamId: String(row.team_id),
		generation: Number(row.generation),
		keyPrefix: String(row.key_prefix),
		status: row.status as TeamCapacityRegistrationKeyMetadata['status'],
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
		rotatedAt: row.rotated_at ? String(row.rotated_at) : null,
		lastRevealedAt: row.last_revealed_at ? String(row.last_revealed_at) : null,
	};
}

function request(row: Record<string, unknown>): ProviderRegistrationRequest {
	return {
		id: String(row.id),
		teamId: String(row.team_id),
		providerId: String(row.capacity_provider_id),
		providerFingerprint: String(row.provider_fingerprint),
		registrationKeyGeneration: Number(row.registration_key_generation),
		status: row.status as ProviderRegistrationRequest['status'],
		capabilitySummary: json(String(row.capability_summary_json), []),
		supplyOffer: json(String(row.supply_offer_json), { capabilities: [] }),
		expiresAt: String(row.expires_at),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
		reviewedAt: row.reviewed_at ? String(row.reviewed_at) : null,
		reviewedById: row.reviewed_by_id ? String(row.reviewed_by_id) : null,
		rejectionReason: row.rejection_reason ? String(row.rejection_reason) : null,
		membershipId: row.membership_id ? String(row.membership_id) : null,
		metadata: json(String(row.metadata_json), {}),
	};
}

function membership(row: Record<string, unknown>): ProviderTeamMembership {
	return {
		id: String(row.id),
		teamId: String(row.team_id),
		providerId: String(row.capacity_provider_id),
		status: row.status as ProviderTeamMembership['status'],
		teamAlias: row.team_alias ? String(row.team_alias) : null,
		approvedAt: String(row.approved_at),
		approvedById: String(row.approved_by_id),
		updatedAt: String(row.updated_at),
		suspendedAt: row.suspended_at ? String(row.suspended_at) : null,
		revokedAt: row.revoked_at ? String(row.revoked_at) : null,
		revokedById: row.revoked_by_id ? String(row.revoked_by_id) : null,
		metadata: json(String(row.metadata_json), {}),
	};
}

function credential(row: Record<string, unknown>): ProviderTeamCredentialMetadata {
	return {
		id: String(row.id),
		membershipId: String(row.membership_id),
		teamId: String(row.team_id),
		providerId: String(row.capacity_provider_id),
		keyPrefix: String(row.key_prefix),
		issuanceGeneration: Number(row.issuance_generation),
		status: row.status as ProviderTeamCredentialMetadata['status'],
		scopes: json<ProviderMembershipScope[]>(String(row.scopes_json), []),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
		expiresAt: row.expires_at ? String(row.expires_at) : null,
		lastUsedAt: row.last_used_at ? String(row.last_used_at) : null,
		rotatedFromCredentialId: row.rotated_from_credential_id ? String(row.rotated_from_credential_id) : null,
		revokedAt: row.revoked_at ? String(row.revoked_at) : null,
	};
}

function pageInput(input: { limit?: unknown; cursor?: unknown }) {
	try {
		return {
			limit: normalizeCapacityPageLimit(input.limit),
			cursor: decodeCapacityPageCursor(input.cursor),
		};
	} catch (error) {
		throw new CapacityGovernanceError('capacity_page_invalid', error instanceof Error ? error.message : String(error), 400);
	}
}

export class CapacityGovernanceRepository {
	constructor(readonly database: CapacityGovernanceDatabase) {}

	private appendCursor(clauses: string[], values: unknown[], cursor: CapacityPageCursor | null) {
		if (!cursor) return;
		clauses.push('(created_at < ? OR (created_at = ? AND id > ?))');
		values.push(cursor.createdAt, cursor.createdAt, cursor.id);
	}

	async ready() {
		await this.database.ensureInitialized();
	}

	async teamExists(teamId: string) {
		await this.ready();
		return Boolean(await this.database.first(`SELECT id FROM teams WHERE id = ? LIMIT 1`, [teamId]));
	}

	async currentRegistrationKeyRow(teamId: string) {
		await this.ready();
		return this.database.first(`SELECT * FROM team_capacity_registration_keys WHERE team_id = ? ORDER BY generation DESC LIMIT 1`, [teamId]);
	}

	async registrationKeyByPrefix(prefix: string) {
		await this.ready();
		return this.database.first(`SELECT * FROM team_capacity_registration_keys WHERE key_prefix = ? LIMIT 1`, [prefix]);
	}

	async registrationKeyByRotationIdempotency(teamId: string, idempotencyKey: string) {
		await this.ready();
		const row = await this.database.first(`SELECT * FROM team_capacity_registration_keys WHERE team_id = ? AND rotation_idempotency_key = ? LIMIT 1`, [teamId, idempotencyKey]);
		return row ? { metadata: registrationKey(row), encryptedRevealValue: String(row.encrypted_reveal_value) } : null;
	}

	async registrationKeyMetadata(teamId: string) {
		const row = await this.currentRegistrationKeyRow(teamId);
		return row ? registrationKey(row) : null;
	}

	async createRegistrationKey(input: { id: string; teamId: string; generation: number; prefix: string; hash: string; encryptedRevealValue: string; actorId: string | null; now: string }) {
		await this.database.run(
			`INSERT INTO team_capacity_registration_keys (id, team_id, generation, key_prefix, key_hash, encrypted_reveal_value, status, created_by_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
			[input.id, input.teamId, input.generation, input.prefix, input.hash, input.encryptedRevealValue, input.actorId, input.now, input.now],
		);
		return this.registrationKeyMetadata(input.teamId);
	}

	async rotateRegistrationKey(input: { id: string; teamId: string; generation: number; prefix: string; hash: string; encryptedRevealValue: string; idempotencyKey: string; actorId: string | null; now: string }) {
		const operations: CapacityDatabaseOperation[] = [
			{ query: `UPDATE team_capacity_registration_keys SET status = 'disabled', rotated_at = ?, updated_at = ? WHERE team_id = ? AND status = 'active'`, params: [input.now, input.now, input.teamId] },
			{ query: `UPDATE capacity_provider_registration_requests SET status = 'cancelled', updated_at = ? WHERE team_id = ? AND status = 'pending'`, params: [input.now, input.teamId] },
			{ query: `INSERT INTO team_capacity_registration_keys (id, team_id, generation, key_prefix, key_hash, encrypted_reveal_value, rotation_idempotency_key, status, created_by_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`, params: [input.id, input.teamId, input.generation, input.prefix, input.hash, input.encryptedRevealValue, input.idempotencyKey, input.actorId, input.now, input.now] },
		];
		try {
			await this.database.batch(operations);
		} catch (error) {
			if (!isUniqueConstraintViolation(error) || !(await this.registrationKeyByRotationIdempotency(input.teamId, input.idempotencyKey))) throw error;
		}
		return this.registrationKeyMetadata(input.teamId);
	}

	async registrationKeyStatusEvidence(teamId: string) {
		await this.ready();
		return this.database.first(`SELECT status, status_idempotency_key, status_request_digest FROM team_capacity_registration_keys WHERE team_id = ? ORDER BY generation DESC LIMIT 1`, [teamId]);
	}

	async setRegistrationKeyStatus(teamId: string, expectedStatus: 'active' | 'disabled', status: 'active' | 'disabled', idempotencyKey: string, requestDigest: string, now: string) {
		await this.database.run(`UPDATE team_capacity_registration_keys SET status = ?, status_idempotency_key = ?, status_request_digest = ?, updated_at = ? WHERE id = (SELECT id FROM team_capacity_registration_keys WHERE team_id = ? ORDER BY generation DESC LIMIT 1) AND status = ?`, [status, idempotencyKey, requestDigest, now, teamId, expectedStatus]);
		return this.registrationKeyMetadata(teamId);
	}

	async recordRegistrationKeyReveal(teamId: string, now: string) {
		await this.database.run(`UPDATE team_capacity_registration_keys SET last_revealed_at = ?, updated_at = ? WHERE id = (SELECT id FROM team_capacity_registration_keys WHERE team_id = ? ORDER BY generation DESC LIMIT 1)`, [now, now, teamId]);
	}

	async consumeProofNonce(fingerprint: string, jti: string, expiresAt: string, now: string) {
		return new CapacityRegistrationSecurityRepository(this.database).consumeProofNonce(fingerprint, jti, expiresAt, now);
	}

	async consumeProofNonces(proofs: Array<{ fingerprint: string; jti: string; expiresAt: string }>, now: string) {
		return new CapacityRegistrationSecurityRepository(this.database).consumeProofNonces(proofs, now);
	}

	async consumeRegistrationRateLimits(input: {
		buckets: RegistrationRateBucket[];
		now: string;
		expiresAt: string;
		limit: number;
	}) {
		return new CapacityRegistrationSecurityRepository(this.database).consumeRegistrationRateLimits(input);
	}

	async expireRegistrationRequest(requestId: string, now: string) {
		await this.database.run(`UPDATE capacity_provider_registration_requests SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending' AND expires_at <= ?`, [now, requestId, now]);
		return this.registrationRequestById(requestId);
	}

	async expireRegistrationRequestsForTeam(teamId: string, now: string) {
		await this.database.run(`UPDATE capacity_provider_registration_requests SET status = 'expired', updated_at = ? WHERE team_id = ? AND status = 'pending' AND expires_at <= ?`, [now, teamId, now]);
	}

	async registrationRequestById(requestId: string) {
		await this.ready();
		const row = await this.database.first(`SELECT * FROM capacity_provider_registration_requests WHERE id = ? LIMIT 1`, [requestId]);
		return row ? request(row) : null;
	}

	async registrationRequestTransitionEvidence(requestId: string) {
		await this.ready();
		return this.database.first(`SELECT transition_action, transition_idempotency_key, transition_request_digest FROM capacity_provider_registration_requests WHERE id = ? LIMIT 1`, [requestId]);
	}

	async registrationRequestByIdempotency(teamId: string, idempotencyKey: string) {
		await this.ready();
		const row = await this.database.first(`SELECT * FROM capacity_provider_registration_requests WHERE team_id = ? AND idempotency_key = ? LIMIT 1`, [teamId, idempotencyKey]);
		return row ? { request: request(row), requestDigest: String(row.request_digest) } : null;
	}

	async createRegistrationRequest(input: { id: string; teamId: string; providerId: string; fingerprint: string; publicJwkJson: string; displayName: string; generation: number; capabilities: string[]; supplyOffer: Record<string, unknown>; proofJti: string; idempotencyKey: string; requestDigest: string; expiresAt: string; metadata: Record<string, unknown>; now: string }) {
		const row = await new CapacityRegistrationRequestAdmissionRepository(this.database).admit(input);
		return row ? request(row) : null;
	}

	private async page<T>(
		query: string,
		values: unknown[],
		limit: number,
		map: (row: Record<string, unknown>) => T,
	): Promise<CapacityPage<T>> {
		const rows = await this.database.all(`${query} ORDER BY created_at DESC, id ASC LIMIT ?`, [...values, limit + 1]);
		const hasMore = rows.length > limit;
		const pageRows = rows.slice(0, limit);
		const last = pageRows.at(-1);
		return {
			items: pageRows.map(map),
			page: {
				limit,
				hasMore,
				nextCursor: hasMore && last
					? encodeCapacityPageCursor({ createdAt: String(last.created_at), id: String(last.id) })
					: null,
			},
		};
	}

	async listRegistrationRequestsPage(teamId: string, input: { status?: string | null; limit?: unknown; cursor?: unknown } = {}) {
		await this.ready();
		const { limit, cursor } = pageInput(input);
		const clauses = ['team_id = ?'];
		const values: unknown[] = [teamId];
		if (input.status) {
			clauses.push('status = ?');
			values.push(input.status);
		}
		this.appendCursor(clauses, values, cursor);
		return this.page(`SELECT * FROM capacity_provider_registration_requests WHERE ${clauses.join(' AND ')}`, values, limit, request);
	}

	async membershipById(membershipId: string) {
		await this.ready();
		const row = await this.database.first(`SELECT * FROM capacity_provider_team_memberships WHERE id = ? LIMIT 1`, [membershipId]);
		return row ? membership(row) : null;
	}

	async membershipForTeamProvider(teamId: string, providerId: string) {
		await this.ready();
		const row = await this.database.first(`SELECT * FROM capacity_provider_team_memberships WHERE team_id = ? AND capacity_provider_id = ? LIMIT 1`, [teamId, providerId]);
		return row ? membership(row) : null;
	}

	async approveRequest(input: { requestId: string; membershipId: string; authorizationId: string; actorId: string; teamAlias?: string | null; idempotencyKey: string; requestDigest: string; now: string }) {
		await this.database.batch([
			{ query: `UPDATE capacity_provider_registration_requests SET status = 'approved', reviewed_at = ?, reviewed_by_id = ?, membership_id = ?, transition_action = 'approve', transition_idempotency_key = ?, transition_request_digest = ?, updated_at = ? WHERE id = ? AND status = 'pending' AND expires_at > ?`, params: [input.now, input.actorId, input.membershipId, input.idempotencyKey, input.requestDigest, input.now, input.requestId, input.now] },
			{ query: `INSERT INTO capacity_provider_team_memberships (id, team_id, capacity_provider_id, status, team_alias, approved_at, approved_by_id, metadata_json, created_at, updated_at) SELECT ?, team_id, capacity_provider_id, 'approved', ?, ?, ?, '{}', ?, ? FROM capacity_provider_registration_requests WHERE id = ? AND status = 'approved' AND membership_id = ?`, params: [input.membershipId, input.teamAlias ?? null, input.now, input.actorId, input.now, input.now, input.requestId, input.membershipId] },
			{ query: `INSERT INTO capacity_provider_credential_issuance_authorizations (id, membership_id, team_id, capacity_provider_id, generation, idempotency_key, status, created_by_type, created_by_id, created_at, updated_at) SELECT ?, membership.id, membership.team_id, membership.capacity_provider_id, 1, ?, 'pending', 'team-principal', ?, ?, ? FROM capacity_provider_team_memberships membership WHERE membership.id = ?`, params: [input.authorizationId, `approval:${input.requestId}`, input.actorId, input.now, input.now, input.membershipId] },
		]);
		return this.registrationRequestById(input.requestId);
	}

	async rejectRequest(input: { requestId: string; actorId: string; reason: string; idempotencyKey: string; requestDigest: string; now: string }) {
		await this.database.run(`UPDATE capacity_provider_registration_requests SET status = 'rejected', reviewed_at = ?, reviewed_by_id = ?, rejection_reason = ?, transition_action = 'reject', transition_idempotency_key = ?, transition_request_digest = ?, updated_at = ? WHERE id = ? AND status = 'pending'`, [input.now, input.actorId, input.reason, input.idempotencyKey, input.requestDigest, input.now, input.requestId]);
		return this.registrationRequestById(input.requestId);
	}

	async cancelRequest(requestId: string, idempotencyKey: string, requestDigest: string, now: string) {
		await this.database.run(`UPDATE capacity_provider_registration_requests SET status = 'cancelled', transition_action = 'cancel', transition_idempotency_key = ?, transition_request_digest = ?, updated_at = ? WHERE id = ? AND status = 'pending'`, [idempotencyKey, requestDigest, now, requestId]);
		return this.registrationRequestById(requestId);
	}

	async listMembershipsPage(teamId: string, input: { status?: string | null; providerId?: string | null; limit?: unknown; cursor?: unknown } = {}) {
		await this.ready();
		const { limit, cursor } = pageInput(input);
		const clauses = ['team_id = ?'];
		const values: unknown[] = [teamId];
		if (input.status) {
			clauses.push('status = ?');
			values.push(input.status);
		}
		if (input.providerId) {
			clauses.push('capacity_provider_id = ?');
			values.push(input.providerId);
		}
		this.appendCursor(clauses, values, cursor);
		return this.page(`SELECT * FROM capacity_provider_team_memberships WHERE ${clauses.join(' AND ')}`, values, limit, membership);
	}

	async membershipsForProviderPage(providerId: string, input: { limit?: unknown; cursor?: unknown } = {}) {
		await this.ready();
		const { limit, cursor } = pageInput(input);
		const clauses = ['capacity_provider_id = ?'];
		const values: unknown[] = [providerId];
		this.appendCursor(clauses, values, cursor);
		return this.page(`SELECT * FROM capacity_provider_team_memberships WHERE ${clauses.join(' AND ')}`, values, limit, membership);
	}

	async membershipStatusEvidence(membershipId: string) {
		await this.ready();
		return this.database.first(`SELECT status_idempotency_key, status_request_digest FROM capacity_provider_team_memberships WHERE id = ? LIMIT 1`, [membershipId]);
	}

	async updateMembershipStatus(input: { teamId: string; membershipId: string; expectedStatus: 'approved' | 'suspended'; status: 'approved' | 'suspended' | 'revoked'; actorId: string; idempotencyKey: string; requestDigest: string; now: string }) {
		await this.database.run(
			`UPDATE capacity_provider_team_memberships SET status = ?, suspended_at = CASE WHEN ? = 'suspended' THEN ? ELSE suspended_at END, revoked_at = CASE WHEN ? = 'revoked' THEN ? ELSE revoked_at END, revoked_by_id = CASE WHEN ? = 'revoked' THEN ? ELSE revoked_by_id END, status_idempotency_key = ?, status_request_digest = ?, updated_at = ? WHERE id = ? AND team_id = ? AND status = ?`,
			[input.status, input.status, input.now, input.status, input.now, input.status, input.actorId, input.idempotencyKey, input.requestDigest, input.now, input.membershipId, input.teamId, input.expectedStatus],
		);
		const evidence = await this.membershipStatusEvidence(input.membershipId);
		if (input.status === 'revoked' && evidence?.status_idempotency_key === input.idempotencyKey) await this.revokeMembershipCredentials(input.membershipId, input.now);
		return this.membershipById(input.membershipId);
	}

	async activeAssignmentsForMembershipBatch(membershipId: string, limit = 200) {
		await this.ready();
		return this.database.all(`SELECT id, team_id, reservation_id, state_version FROM capacity_provider_assignments WHERE membership_id = ? AND status IN ('pending', 'leased', 'returned') ORDER BY created_at ASC, id ASC LIMIT ?`, [membershipId, limit]);
	}

	async invalidateMembershipAssignment(input: { membershipId: string; assignmentId: string; stateVersion: number; status: 'suspended' | 'revoked'; now: string }) {
		await this.database.run(
			`UPDATE capacity_provider_assignments SET status = 'failed', lease_state = 'released', lease_token = NULL, lease_expires_at = NULL, lease_renewed_at = NULL, runner_id = NULL, failed_at = COALESCE(failed_at, ?), lifecycle_reason = ?, lifecycle_code = ?, state_version = state_version + 1, updated_at = ? WHERE id = ? AND membership_id = ? AND state_version = ? AND status IN ('pending', 'leased', 'returned')`,
			[input.now, `Provider membership was ${input.status}.`, `provider_membership_${input.status}`, input.now, input.assignmentId, input.membershipId, input.stateVersion],
		);
	}

	async credentialsForMembershipPage(membershipId: string, input: { status?: string | null; limit?: unknown; cursor?: unknown } = {}) {
		await this.ready();
		const { limit, cursor } = pageInput(input);
		const clauses = ['membership_id = ?'];
		const values: unknown[] = [membershipId];
		if (input.status) {
			clauses.push('status = ?');
			values.push(input.status);
		}
		this.appendCursor(clauses, values, cursor);
		return this.page(`SELECT * FROM capacity_provider_team_credentials WHERE ${clauses.join(' AND ')}`, values, limit, credential);
	}

	async credentialById(membershipId: string, credentialId: string) {
		await this.ready();
		const row = await this.database.first(`SELECT * FROM capacity_provider_team_credentials WHERE id = ? AND membership_id = ? LIMIT 1`, [credentialId, membershipId]);
		return row ? credential(row) : null;
	}

	async credentialRevocationEvidence(membershipId: string, credentialId: string) {
		await this.ready();
		return this.database.first(`SELECT revoke_idempotency_key, revoke_request_digest FROM capacity_provider_team_credentials WHERE id = ? AND membership_id = ? LIMIT 1`, [credentialId, membershipId]);
	}

	async activeCredential(membershipId: string) {
		await this.ready();
		const row = await this.database.first(`SELECT * FROM capacity_provider_team_credentials WHERE membership_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`, [membershipId]);
		return row ? { metadata: credential(row), hash: String(row.key_hash), issueIdempotencyKey: String(row.issue_idempotency_key), revealedAt: row.revealed_at ? String(row.revealed_at) : null } : null;
	}

	async latestCredential(membershipId: string) {
		await this.ready();
		const row = await this.database.first(`SELECT * FROM capacity_provider_team_credentials WHERE membership_id = ? ORDER BY created_at DESC LIMIT 1`, [membershipId]);
		return row ? { metadata: credential(row), hash: String(row.key_hash), issueIdempotencyKey: String(row.issue_idempotency_key), revealedAt: row.revealed_at ? String(row.revealed_at) : null } : null;
	}

	async credentialByIssueKey(membershipId: string, issueIdempotencyKey: string) {
		await this.ready();
		const row = await this.database.first(`SELECT * FROM capacity_provider_team_credentials WHERE membership_id = ? AND issue_idempotency_key = ? LIMIT 1`, [membershipId, issueIdempotencyKey]);
		return row ? { metadata: credential(row), hash: String(row.key_hash), issueIdempotencyKey: String(row.issue_idempotency_key), revealedAt: row.revealed_at ? String(row.revealed_at) : null } : null;
	}

	async createCredential(input: { id: string; authorization: ProviderCredentialIssuanceAuthorization; membership: ProviderTeamMembership; prefix: string; hash: string; issueIdempotencyKey: string; scopes: ProviderMembershipScope[]; rotatedFromId?: string | null; now: string }) {
		await this.database.batch([
			{ query: `UPDATE capacity_provider_credential_issuance_authorizations SET status = 'issued', issued_credential_id = ?, updated_at = ? WHERE id = ? AND membership_id = ? AND status = 'pending'`, params: [input.id, input.now, input.authorization.id, input.membership.id] },
			{ query: `INSERT INTO capacity_provider_team_credentials (id, membership_id, team_id, capacity_provider_id, key_prefix, key_hash, issuance_authorization_id, issuance_generation, issue_idempotency_key, scopes_json, status, rotated_from_credential_id, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, CAST(? AS INTEGER), ?, ?, 'active', ?, ?, ? WHERE EXISTS (SELECT 1 FROM capacity_provider_credential_issuance_authorizations WHERE id = ? AND membership_id = ? AND status = 'issued' AND issued_credential_id = ?) AND NOT EXISTS (SELECT 1 FROM capacity_provider_team_credentials WHERE membership_id = ? AND status = 'active')`, params: [input.id, input.membership.id, input.membership.teamId, input.membership.providerId, input.prefix, input.hash, input.authorization.id, input.authorization.generation, input.issueIdempotencyKey, JSON.stringify(input.scopes), input.rotatedFromId ?? null, input.now, input.now, input.authorization.id, input.membership.id, input.id, input.membership.id] },
		]);
		return this.credentialById(input.membership.id, input.id);
	}

	async markCredentialRevealed(credentialId: string, now: string) {
		await this.database.run(`UPDATE capacity_provider_team_credentials SET revealed_at = ?, updated_at = ? WHERE id = ? AND revealed_at IS NULL`, [now, now, credentialId]);
	}

	async revokeCredential(credentialId: string, idempotencyKey: string, requestDigest: string, now: string) {
		await this.database.batch([
			{ query: `UPDATE capacity_provider_team_credentials SET status = 'revoked', revoked_at = ?, revoke_idempotency_key = ?, revoke_request_digest = ?, updated_at = ? WHERE id = ? AND status <> 'revoked'`, params: [now, idempotencyKey, requestDigest, now, credentialId] },
			{ query: `UPDATE capacity_provider_access_tokens SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE credential_id = ? AND status = 'active'`, params: [now, now, credentialId] },
		]);
	}

	async revokeMembershipCredentials(membershipId: string, now: string) {
		await this.database.batch([
			{ query: `UPDATE capacity_provider_team_credentials SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE membership_id = ? AND status <> 'revoked'`, params: [now, now, membershipId] },
			{ query: `UPDATE capacity_provider_access_tokens SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE membership_id = ? AND status = 'active'`, params: [now, now, membershipId] },
		]);
	}

	async authenticateCredential(prefix: string) {
		await this.ready();
		const row = await this.database.first(`SELECT credential.*, membership.status AS membership_status FROM capacity_provider_team_credentials credential JOIN capacity_provider_team_memberships membership ON membership.id = credential.membership_id WHERE credential.key_prefix = ? LIMIT 1`, [prefix]);
		return row ? { metadata: credential(row), hash: String(row.key_hash), membershipStatus: String(row.membership_status) } : null;
	}

	async createAccessToken(input: { id: string; credential: ProviderTeamCredentialMetadata; idempotencyKey: string; prefix: string; hash: string; issuedAt: string; expiresAt: string }) {
		await this.database.run(`INSERT INTO capacity_provider_access_tokens (id, membership_id, credential_id, idempotency_key, token_prefix, token_hash, scopes_json, status, issued_at, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`, [input.id, input.credential.membershipId, input.credential.id, input.idempotencyKey, input.prefix, input.hash, JSON.stringify(input.credential.scopes), input.issuedAt, input.expiresAt, input.issuedAt]);
	}

	async accessTokenByIssueKey(membershipId: string, idempotencyKey: string) {
		await this.ready();
		return this.database.first(`SELECT * FROM capacity_provider_access_tokens WHERE membership_id = ? AND idempotency_key = ? LIMIT 1`, [membershipId, idempotencyKey]);
	}

	async accessTokenByPrefix(prefix: string) {
		await this.ready();
		return this.database.first(
			`SELECT token.*, membership.team_id, membership.capacity_provider_id, membership.status AS membership_status,
			 provider.fingerprint, provider.display_name, provider.status AS provider_status
			 FROM capacity_provider_access_tokens token
			 JOIN capacity_provider_team_memberships membership ON membership.id = token.membership_id
			 JOIN capacity_providers provider ON provider.id = membership.capacity_provider_id
			 WHERE token.token_prefix = ? LIMIT 1`,
			[prefix],
		);
	}

	async recordAccessTokenUse(tokenId: string, now: string) {
		await this.database.run(`UPDATE capacity_provider_access_tokens SET last_used_at = ?, updated_at = ? WHERE id = ?`, [now, now, tokenId]);
	}

	async expireAccessToken(tokenId: string, now: string) {
		await this.database.run(`UPDATE capacity_provider_access_tokens SET status = 'expired', expired_at = COALESCE(expired_at, ?), updated_at = ? WHERE id = ? AND status = 'active'`, [now, now, tokenId]);
	}

}

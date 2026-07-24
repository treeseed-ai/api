import type {
	CapacityProviderIdentity,
	CapacityProviderIdentityStatus,
	CapacityProviderMembershipView,
	CapacityProviderPublicJwk,
	ProviderTeamMembershipStatus,
} from '@treeseed/sdk/capacity-provider/contracts';
import { validateCapacityProviderPublicJwk } from '@treeseed/sdk/capacity-provider';
import type { CapacityGovernanceDatabase } from '../../../database.ts';
import { CapacityGovernanceError } from '../../../database.ts';
import { isUniqueConstraintViolation } from '../../../database-errors.ts';

type Row = Record<string, unknown>;
const IDENTITY_STATUSES = new Set<CapacityProviderIdentityStatus>(['active', 'rotating', 'revoked']);
const MEMBERSHIP_STATUSES = new Set<ProviderTeamMembershipStatus>(['approved', 'suspended', 'revoked']);

function corrupt(row: Row, column: string): never {
	throw new CapacityGovernanceError('capacity_provider_identity_projection_corrupt', `Capacity provider identity projection has invalid ${column}.`, 500, {
		providerId: typeof row.provider_id === 'string' ? row.provider_id : null, column,
	});
}
function text(row: Row, column: string): string { const value = row[column]; return typeof value === 'string' && value ? value : corrupt(row, column); }
function object(row: Row, column: string): Record<string, unknown> {
	const encoded = row[column];
	let value: unknown = encoded;
	if (typeof encoded === 'string') { try { value = JSON.parse(encoded); } catch { return corrupt(row, column); } }
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : corrupt(row, column);
}

export function serializeCapacityProviderMembershipView(row: Row | null): CapacityProviderMembershipView | null {
	if (!row) return null;
	const identityStatus = text(row, 'identity_status') as CapacityProviderIdentityStatus;
	const membershipStatus = text(row, 'membership_status') as ProviderTeamMembershipStatus;
	if (!IDENTITY_STATUSES.has(identityStatus)) corrupt(row, 'identity_status');
	if (!MEMBERSHIP_STATUSES.has(membershipStatus)) corrupt(row, 'membership_status');
	const identityVersion = Number(row.identity_version);
	if (!Number.isInteger(identityVersion) || identityVersion < 1) corrupt(row, 'identity_version');
	const publicJwk = object(row, 'public_jwk_json') as unknown as CapacityProviderPublicJwk;
	const validation = validateCapacityProviderPublicJwk(publicJwk);
	if (!validation.ok) corrupt(row, 'public_jwk_json');
	return {
		providerId: text(row, 'provider_id'), fingerprint: text(row, 'fingerprint'), publicJwk, displayName: text(row, 'display_name'),
		identityVersion, identityStatus, membershipId: text(row, 'membership_id'), teamId: text(row, 'team_id'), membershipStatus,
		identityMetadata: object(row, 'identity_metadata_json'), membershipMetadata: object(row, 'membership_metadata_json'),
		createdAt: text(row, 'membership_created_at'), updatedAt: text(row, 'membership_updated_at'),
	};
}

function serializeIdentity(row: Row | null): CapacityProviderIdentity | null {
	if (!row) return null;
	const status = text(row, 'status') as CapacityProviderIdentityStatus;
	if (!IDENTITY_STATUSES.has(status)) corrupt(row, 'status');
	const identityVersion = Number(row.identity_version);
	if (!Number.isInteger(identityVersion) || identityVersion < 1) corrupt(row, 'identity_version');
	const publicJwk = object(row, 'public_jwk_json') as unknown as CapacityProviderPublicJwk;
	if (!validateCapacityProviderPublicJwk(publicJwk).ok) corrupt(row, 'public_jwk_json');
	return {
		schemaVersion: 1, providerId: text(row, 'id'), fingerprint: text(row, 'fingerprint'), publicJwk,
		displayName: text(row, 'display_name'), identityVersion, status,
		createdAt: String(row.created_at), updatedAt: String(row.updated_at), rotatedAt: row.rotated_at ? String(row.rotated_at) : null, revokedAt: row.revoked_at ? String(row.revoked_at) : null,
	};
}

const SELECT = `SELECT provider.id AS provider_id, provider.fingerprint, provider.public_jwk_json, provider.display_name,
	provider.identity_version, provider.status AS identity_status, provider.metadata_json AS identity_metadata_json,
	membership.id AS membership_id, membership.team_id, membership.status AS membership_status,
	membership.metadata_json AS membership_metadata_json, membership.created_at AS membership_created_at,
	membership.updated_at AS membership_updated_at
	FROM capacity_provider_team_memberships membership
	JOIN capacity_providers provider ON provider.id = membership.capacity_provider_id`;

export class CapacityProviderIdentityRepository {
	constructor(private readonly database: CapacityGovernanceDatabase) {}

	async listTeamMemberships(teamId: string): Promise<CapacityProviderMembershipView[]> {
		await this.database.ensureInitialized();
		const rows = await this.database.all(`${SELECT} WHERE membership.team_id = ? ORDER BY membership.created_at ASC, membership.id ASC`, [teamId]);
		return rows.map((row) => serializeCapacityProviderMembershipView(row)!);
	}

	async getTeamMembership(teamId: string, providerId: string): Promise<CapacityProviderMembershipView | null> {
		await this.database.ensureInitialized();
		return serializeCapacityProviderMembershipView(await this.database.first(`${SELECT} WHERE membership.team_id = ? AND provider.id = ? LIMIT 1`, [teamId, providerId]));
	}

	async byFingerprint(fingerprint: string) {
		await this.database.ensureInitialized();
		return serializeIdentity(await this.database.first(`SELECT * FROM capacity_providers WHERE fingerprint = ? LIMIT 1`, [fingerprint]));
	}

	async byId(providerId: string) {
		await this.database.ensureInitialized();
		return serializeIdentity(await this.database.first(`SELECT * FROM capacity_providers WHERE id = ? LIMIT 1`, [providerId]));
	}

	async create(input: { id: string; fingerprint: string; publicJwkJson: string; displayName: string; now: string }) {
		await this.database.run(`INSERT INTO capacity_providers (id, fingerprint, public_jwk_json, display_name, identity_version, status, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'active', '{}', ?, ?) ON CONFLICT (fingerprint) DO NOTHING`, [input.id, input.fingerprint, input.publicJwkJson, input.displayName, input.now, input.now]);
		return this.byFingerprint(input.fingerprint);
	}

	async rotationByKey(providerId: string, idempotencyKey: string) {
		await this.database.ensureInitialized();
		return this.database.first(`SELECT * FROM capacity_provider_identity_rotations WHERE capacity_provider_id = ? AND idempotency_key = ? LIMIT 1`, [providerId, idempotencyKey]);
	}

	async rotate(input: { id: string; providerId: string; expectedVersion: number; oldFingerprint: string; fingerprint: string; publicJwkJson: string; idempotencyKey: string; requestDigest: string; proofs: Array<{ fingerprint: string; jti: string; expiresAt: string }>; now: string }) {
		try {
			await this.database.batch([
				{ query: `DELETE FROM capacity_provider_proof_nonces WHERE expires_at <= ?`, params: [input.now] },
				...input.proofs.map((proof) => ({ query: `INSERT INTO capacity_provider_proof_nonces (provider_fingerprint, jti, expires_at, created_at) VALUES (?, ?, ?, ?)`, params: [proof.fingerprint, proof.jti, proof.expiresAt, input.now] })),
				{ query: `INSERT INTO capacity_provider_identity_rotations (id, capacity_provider_id, from_identity_version, to_identity_version, old_fingerprint, new_fingerprint, idempotency_key, request_digest, created_at) SELECT ?, id, identity_version, identity_version + 1, fingerprint, ?, ?, ?, ? FROM capacity_providers WHERE id = ? AND identity_version = ? AND fingerprint = ? AND status = 'active'`, params: [input.id, input.fingerprint, input.idempotencyKey, input.requestDigest, input.now, input.providerId, input.expectedVersion, input.oldFingerprint] },
				{ query: `UPDATE capacity_providers SET fingerprint = ?, public_jwk_json = ?, identity_version = identity_version + 1, rotated_at = ?, updated_at = ? WHERE id = ? AND identity_version = ? AND status = 'active' AND EXISTS (SELECT 1 FROM capacity_provider_identity_rotations WHERE id = ? AND capacity_provider_id = ?)`, params: [input.fingerprint, input.publicJwkJson, input.now, input.now, input.providerId, input.expectedVersion, input.id, input.providerId] },
				{ query: `UPDATE capacity_provider_access_tokens SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE membership_id IN (SELECT id FROM capacity_provider_team_memberships WHERE capacity_provider_id = ?) AND status = 'active' AND EXISTS (SELECT 1 FROM capacity_provider_identity_rotations WHERE id = ? AND capacity_provider_id = ?)`, params: [input.now, input.now, input.providerId, input.id, input.providerId] },
			]);
		} catch (error) {
			if (!isUniqueConstraintViolation(error)) throw error;
			const prior = await this.rotationByKey(input.providerId, input.idempotencyKey);
			if (!prior || String(prior.request_digest) !== input.requestDigest) throw new CapacityGovernanceError('provider_proof_replayed', 'Provider identity rotation proof has already been used.', 409);
		}
		return this.byId(input.providerId);
	}
}

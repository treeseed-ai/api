import type { CapacityGovernanceDatabase } from '../database.ts';

type Row = Record<string, unknown>;

export interface RegistrationRequestAdmission {
	id: string;
	teamId: string;
	providerId: string;
	fingerprint: string;
	publicJwkJson: string;
	displayName: string;
	generation: number;
	capabilities: string[];
	supplyOffer: Record<string, unknown>;
	proofJti: string;
	idempotencyKey: string;
	requestDigest: string;
	expiresAt: string;
	metadata: Record<string, unknown>;
	now: string;
}

/** Serializes registration admission against broadcast-key rotation. */
export class CapacityRegistrationRequestAdmissionRepository {
	constructor(private readonly database: CapacityGovernanceDatabase) {}

	async admit(input: RegistrationRequestAdmission): Promise<Row | null> {
		await this.database.batch([
			{
				query: `UPDATE team_capacity_registration_keys SET updated_at = updated_at WHERE team_id = ? AND generation = ? AND status = 'active'`,
				params: [input.teamId, input.generation],
			},
			{
				query: `INSERT INTO capacity_providers (id, fingerprint, public_jwk_json, display_name, identity_version, status, metadata_json, created_at, updated_at)
					SELECT ?, ?, ?, ?, 1, 'active', '{}', ?, ?
					WHERE EXISTS (SELECT 1 FROM team_capacity_registration_keys WHERE team_id = ? AND generation = ? AND status = 'active')
					ON CONFLICT DO NOTHING`,
				params: [input.providerId, input.fingerprint, input.publicJwkJson, input.displayName, input.now, input.now, input.teamId, input.generation],
			},
			{
				query: `INSERT INTO capacity_provider_registration_requests (id, team_id, capacity_provider_id, provider_fingerprint, registration_key_generation, status, capability_summary_json, supply_offer_json, proof_jti, idempotency_key, request_digest, expires_at, metadata_json, created_at, updated_at)
					SELECT ?, ?, ?, ?, CAST(? AS INTEGER), 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?
					WHERE EXISTS (SELECT 1 FROM team_capacity_registration_keys WHERE team_id = ? AND generation = ? AND status = 'active')
					AND EXISTS (SELECT 1 FROM capacity_providers WHERE id = ? AND fingerprint = ? AND status = 'active')
					ON CONFLICT (team_id, capacity_provider_id, registration_key_generation) DO NOTHING`,
				params: [input.id, input.teamId, input.providerId, input.fingerprint, input.generation, JSON.stringify(input.capabilities), JSON.stringify(input.supplyOffer), input.proofJti, input.idempotencyKey, input.requestDigest, input.expiresAt, JSON.stringify(input.metadata), input.now, input.now, input.teamId, input.generation, input.providerId, input.fingerprint],
			},
		]);
		return this.database.first(`SELECT * FROM capacity_provider_registration_requests WHERE team_id = ? AND capacity_provider_id = ? AND registration_key_generation = ? LIMIT 1`, [input.teamId, input.providerId, input.generation]);
	}
}

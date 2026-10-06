import { isUniqueConstraintViolation } from '../../database-errors.ts';
import { CapacityGovernanceError } from '../../database.ts';
import type { CapacityDatabaseOperation,CapacityGovernanceDatabase } from '../../database.ts';

export interface RegistrationRateBucket {
	dimension: 'team' | 'ip' | 'fingerprint' | 'key-generation';
	key: string;
}

export class CapacityRegistrationSecurityRepository {
	constructor(private readonly database: CapacityGovernanceDatabase) {}

	consumeProofNonce(fingerprint: string, jti: string, expiresAt: string, now: string) {
		return this.consumeProofNonces([{ fingerprint, jti, expiresAt }], now);
	}

	async consumeProofNonces(proofs: Array<{ fingerprint: string; jti: string; expiresAt: string }>, now: string) {
		try {
			await this.database.batch([
				{ query: `DELETE FROM capacity_provider_proof_nonces WHERE expires_at <= ?`, params: [now] },
				...proofs.map((proof) => ({
					query: `INSERT INTO capacity_provider_proof_nonces (provider_fingerprint, jti, expires_at, created_at) VALUES (?, ?, ?, ?)`,
					params: [proof.fingerprint, proof.jti, proof.expiresAt, now],
				})),
			]);
			return true;
		} catch (error) {
			if (isUniqueConstraintViolation(error, 'capacity_provider_proof_nonces')) return false;
			throw error;
		}
	}

	async consumeRegistrationRateLimits(input: {
		buckets: RegistrationRateBucket[];
		now: string;
		expiresAt: string;
		limit: number;
	}) {
		const operations: CapacityDatabaseOperation[] = [
			{ query: `DELETE FROM capacity_provider_registration_rate_limits WHERE expires_at <= ?`, params: [input.now] },
			...input.buckets.map((bucket) => ({
				query: `INSERT INTO capacity_provider_registration_rate_limits (dimension, bucket_key, count, window_started_at, expires_at, updated_at) VALUES (?, ?, 1, ?, ?, ?) ON CONFLICT (dimension, bucket_key) DO UPDATE SET count = CASE WHEN capacity_provider_registration_rate_limits.expires_at <= excluded.window_started_at THEN 1 ELSE capacity_provider_registration_rate_limits.count + 1 END, window_started_at = CASE WHEN capacity_provider_registration_rate_limits.expires_at <= excluded.window_started_at THEN excluded.window_started_at ELSE capacity_provider_registration_rate_limits.window_started_at END, expires_at = CASE WHEN capacity_provider_registration_rate_limits.expires_at <= excluded.window_started_at THEN excluded.expires_at ELSE capacity_provider_registration_rate_limits.expires_at END, updated_at = excluded.updated_at`,
				params: [bucket.dimension, bucket.key, input.now, input.expiresAt, input.now],
			})),
			...input.buckets.map((bucket) => ({
				query: `SELECT count FROM capacity_provider_registration_rate_limits WHERE dimension = ? AND bucket_key = ? LIMIT 1`,
				params: [bucket.dimension, bucket.key],
			})),
		];
		const results: unknown = await this.database.batch(operations);
		const invalid = () => new CapacityGovernanceError('provider_registration_rate_observation_invalid', 'Registration rate transaction returned incomplete or malformed counters.', 500);
		if (!Array.isArray(results) || results.length !== operations.length) throw invalid();
		const exceeded: RegistrationRateBucket['dimension'][] = [];
		for (const [index, bucket] of input.buckets.entries()) {
			const entry: unknown = results[1 + input.buckets.length + index];
			if (!entry || typeof entry !== 'object' || !('results' in entry) || !Array.isArray(entry.results) || entry.results.length !== 1) throw invalid();
			const row: unknown = entry.results[0];
			if (!row || typeof row !== 'object' || !('count' in row) || typeof row.count !== 'number' || !Number.isSafeInteger(row.count) || row.count < 1) throw invalid();
			if (row.count > input.limit) exceeded.push(bucket.dimension);
		}
		return exceeded;
	}
}

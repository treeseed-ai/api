import type { CapacityDatabaseOperation, CapacityGovernanceDatabase } from '../../database.ts';
import { isUniqueConstraintViolation } from '../../database-errors.ts';

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
		const results = await this.database.batch(operations) as Array<{ results?: Array<Record<string, unknown>> }>;
		const exceeded: RegistrationRateBucket['dimension'][] = [];
		const counterResults = results.slice(-input.buckets.length);
		for (const [index, bucket] of input.buckets.entries()) {
			const row = counterResults[index]?.results?.[0];
			if (Number(row?.count ?? 0) > input.limit) exceeded.push(bucket.dimension);
		}
		return exceeded;
	}
}

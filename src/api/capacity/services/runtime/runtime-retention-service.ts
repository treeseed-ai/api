import type { CapacityGovernanceDatabase } from '../../database.ts';

export interface CapacityRuntimeRetentionResult {
	expiredAccessTokens: number;
	expiredAvailabilitySessions: number;
	expiredRegistrationRequests: number;
	deletedProofNonces: number;
	deletedRateLimitBuckets: number;
}

async function count(
	database: CapacityGovernanceDatabase,
	query: string,
	now: string,
): Promise<number> {
	const row = await database.first<{ total: number | string }>(query, [now]);
	return Math.max(0, Number(row?.total ?? 0) || 0);
}

export async function maintainCapacityRuntimeRetention(
	database: CapacityGovernanceDatabase,
	now = new Date().toISOString(),
): Promise<CapacityRuntimeRetentionResult> {
	const [
		expiredAccessTokens,
		expiredAvailabilitySessions,
		expiredRegistrationRequests,
		deletedProofNonces,
		deletedRateLimitBuckets,
	] = await Promise.all([
		count(database, `SELECT COUNT(*) AS total FROM capacity_provider_access_tokens WHERE status = 'active' AND expires_at <= ?`, now),
		count(database, `SELECT COUNT(*) AS total FROM capacity_provider_availability_sessions WHERE status IN ('open', 'draining') AND expires_at <= ?`, now),
		count(database, `SELECT COUNT(*) AS total FROM capacity_provider_registration_requests WHERE status = 'pending' AND expires_at <= ?`, now),
		count(database, `SELECT COUNT(*) AS total FROM capacity_provider_proof_nonces WHERE expires_at <= ?`, now),
		count(database, `SELECT COUNT(*) AS total FROM capacity_provider_registration_rate_limits WHERE expires_at <= ?`, now),
	]);
	await database.batch([
		{
			query: `UPDATE capacity_provider_access_tokens SET status = 'expired', expired_at = COALESCE(expired_at, ?), updated_at = ? WHERE status = 'active' AND expires_at <= ?`,
			params: [now, now, now],
		},
		{
			query: `UPDATE capacity_provider_availability_sessions SET status = 'expired', closed_at = COALESCE(closed_at, ?), updated_at = ? WHERE status IN ('open', 'draining') AND expires_at <= ?`,
			params: [now, now, now],
		},
		{
			query: `UPDATE capacity_provider_registration_requests SET status = 'expired', updated_at = ? WHERE status = 'pending' AND expires_at <= ?`,
			params: [now, now],
		},
		{
			query: `DELETE FROM capacity_provider_proof_nonces WHERE expires_at <= ?`,
			params: [now],
		},
		{
			query: `DELETE FROM capacity_provider_registration_rate_limits WHERE expires_at <= ?`,
			params: [now],
		},
	]);
	return {
		expiredAccessTokens,
		expiredAvailabilitySessions,
		expiredRegistrationRequests,
		deletedProofNonces,
		deletedRateLimitBuckets,
	};
}

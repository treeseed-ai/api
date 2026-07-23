import { describe, expect, it, vi } from 'vitest';
import type { CapacityGovernanceDatabase } from '../../../src/api/capacity/database.ts';
import type { CapacityDatabaseOperation } from '../../../src/api/capacity/database.ts';
import { maintainCapacityRuntimeRetention } from '../../../src/api/capacity/services/runtime-retention-service.ts';

describe('capacity runtime retention', () => {
	it('expires transient authority and deletes only elapsed security windows', async () => {
		const batch = vi.fn(async (_operations: CapacityDatabaseOperation[]) => undefined);
		const totals = [2, 3, 5, 7, 11];
		const database = {
			first: vi.fn(async () => ({ total: totals.shift() ?? 0 })),
			batch,
		} as unknown as CapacityGovernanceDatabase;
		const now = '2026-07-19T20:30:00.000Z';

		const result = await maintainCapacityRuntimeRetention(database, now);

		expect(result).toEqual({
			expiredAccessTokens: 2,
			expiredAvailabilitySessions: 3,
			expiredRegistrationRequests: 5,
			deletedProofNonces: 7,
			deletedRateLimitBuckets: 11,
		});
		const operations = batch.mock.calls[0]?.[0] ?? [];
		expect(operations).toHaveLength(5);
		expect(operations.map((operation) => operation.query)).toEqual([
			expect.stringContaining(`UPDATE capacity_provider_access_tokens SET status = 'expired'`),
			expect.stringContaining(`UPDATE capacity_provider_availability_sessions SET status = 'expired'`),
			expect.stringContaining(`UPDATE capacity_provider_registration_requests SET status = 'expired'`),
			expect.stringContaining(`DELETE FROM capacity_provider_proof_nonces`),
			expect.stringContaining(`DELETE FROM capacity_provider_registration_rate_limits`),
		]);
		expect(operations.every((operation) => !/capacity_(?:ledger_entries|usage_actuals|audit_events|provider_assignments)/u.test(operation.query))).toBe(true);
	});
});

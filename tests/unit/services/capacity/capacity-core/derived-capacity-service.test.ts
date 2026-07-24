import { describe, expect, it, vi } from 'vitest';
import { DerivedCapacityService, summarizeDerivedCapacity } from '../../../../../src/api/capacity/services/capacity/capacity-core/derived-capacity-service.ts';

function membershipRow(overrides: Record<string, unknown> = {}) {
	return {
		provider_id: 'provider-a', fingerprint: 'sha256:a',
		public_jwk_json: '{"kty":"OKP","crv":"Ed25519","x":"public-a","alg":"EdDSA"}',
		display_name: 'Provider A', identity_version: 1, identity_status: 'active', identity_metadata_json: '{}',
		membership_id: 'membership-a', team_id: 'team-a', membership_status: 'approved', membership_metadata_json: '{}',
		membership_created_at: '2026-07-18T00:00:00.000Z', membership_updated_at: '2026-07-18T00:00:00.000Z',
		...overrides,
	};
}

describe('derived capacity service', () => {
	it('summarizes native capacity without rounding individual evidence', () => {
		const entry = { nativeUnit: 'wall_minute', availableNativeAmount: 2.5, derivedAvailableCredits: 1.239 };
		expect(summarizeDerivedCapacity([entry as never])).toMatchObject({
			totalDerivedAvailableCredits: 1.23, derivedEntryCount: 1, learningEntryCount: 0,
			availableNativeByUnit: { wall_minute: 2.5 },
		});
	});

	it('returns no capacity for a suspended membership even when provider inventory is supplied', async () => {
		const all = vi.fn();
		const first = vi.fn().mockResolvedValue(membershipRow({ membership_status: 'suspended' }));
		const database = {
			ensureInitialized: vi.fn(), run: vi.fn(), batch: vi.fn(),
			all: async <T extends Record<string, unknown>>(query: string, params?: unknown[]) => await all(query, params) as T[],
			first: async <T extends Record<string, unknown>>(query: string, params?: unknown[]) => await first(query, params) as T,
		};
		await expect(new DerivedCapacityService(database).provider('team-a', 'provider-a', {
			executionProviders: [{ id: 'codex-a' } as never],
		})).resolves.toMatchObject({ entries: [], derivedEntryCount: 0 });
		expect(all).not.toHaveBeenCalled();
	});

	it('excludes revoked identities from team capacity before loading provider inventory', async () => {
		const approved = membershipRow();
		const revoked = membershipRow({ provider_id: 'provider-b', membership_id: 'membership-b', identity_status: 'revoked' });
		const all = vi.fn(async (query: string) => query.includes('FROM capacity_provider_team_memberships') ? [approved, revoked] : []);
		const first = vi.fn(async (_query: string, params?: unknown[]) => params?.[1] === 'provider-a' ? approved : revoked);
		const service = new DerivedCapacityService({
			ensureInitialized: vi.fn(), run: vi.fn(), batch: vi.fn(),
			all: async <T extends Record<string, unknown>>(query: string, params?: unknown[]) => await all(query) as unknown as T[],
			first: async <T extends Record<string, unknown>>(query: string, params?: unknown[]) => await first(query, params) as unknown as T,
		});
		const summary = await service.team('team-a');
		expect(summary.providers?.map((provider) => provider.capacityProviderId)).toEqual(['provider-a']);
		expect(first).toHaveBeenCalledTimes(1);
	});
});

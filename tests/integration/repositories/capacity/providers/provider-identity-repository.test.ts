import { describe, expect, it } from 'vitest';
import { CapacityProviderIdentityRepository, serializeCapacityProviderMembershipView } from '../../../../../src/api/capacity/repositories/capacity/providers/provider-identity.ts';

function row(overrides: Record<string, unknown> = {}) {
	return {
		provider_id: 'provider-a', fingerprint: 'sha256:a', public_jwk_json: '{"kty":"OKP","crv":"Ed25519","x":"public-a","alg":"EdDSA"}',
		display_name: 'Provider A', identity_version: 1, identity_status: 'active', identity_metadata_json: '{"region":"local"}',
		membership_id: 'membership-a', team_id: 'team-a', membership_status: 'approved', membership_metadata_json: '{"alias":"shared"}',
		membership_created_at: '2026-07-18T00:00:00.000Z', membership_updated_at: '2026-07-18T01:00:00.000Z', ...overrides,
	};
}

describe('capacity provider identity repository', () => {
	it('returns the strict team-scoped identity and membership projection', () => {
		expect(serializeCapacityProviderMembershipView(row())).toEqual(expect.objectContaining({
			providerId: 'provider-a', membershipId: 'membership-a', teamId: 'team-a', identityStatus: 'active', membershipStatus: 'approved',
			identityMetadata: { region: 'local' }, membershipMetadata: { alias: 'shared' },
		}));
	});

	it('fails closed for corrupt identity, membership, JWK, and metadata state', () => {
		for (const corrupt of [
			row({ identity_status: 'unknown' }), row({ membership_status: 'pending' }), row({ public_jwk_json: '{}' }), row({ membership_metadata_json: '[]' }),
		]) expect(() => serializeCapacityProviderMembershipView(corrupt)).toThrowError(/invalid/);
	});

	it('keeps every query team-scoped and preserves storage failures', async () => {
		const calls: Array<{ query: string; params?: unknown[] }> = [];
		const database = {
			ensureInitialized: async () => undefined, run: async () => undefined, batch: async () => undefined,
			all: async <T extends Record<string, unknown>>(query: string, params?: unknown[]) => {
				calls.push({ query, params }); return [row()] as unknown as T[];
			},
			first: async <T extends Record<string, unknown>>(query: string, params?: unknown[]) => {
				calls.push({ query, params }); return row() as unknown as T;
			},
		};
		const repository = new CapacityProviderIdentityRepository(database);
		expect(await repository.listTeamMemberships('team-a')).toHaveLength(1);
		expect(await repository.getTeamMembership('team-a', 'provider-a')).toMatchObject({ membershipId: 'membership-a' });
		expect(calls.map((call) => call.params)).toEqual([['team-a'], ['team-a', 'provider-a']]);
		expect(calls.every((call) => call.query.includes('membership.team_id = ?'))).toBe(true);
	});
});

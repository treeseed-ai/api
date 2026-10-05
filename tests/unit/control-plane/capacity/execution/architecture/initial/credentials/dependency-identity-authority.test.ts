import { describe, expect, it } from 'vitest';
import { serializeCapacityProviderMembershipView } from '../../../../../../../../src/api/capacity/repositories/capacity/providers/provider-identity.ts';
import { membershipIdentityRow } from './dependency-identity-fixture.ts';

describe('original provider identity projection authority', () => {
	it('original membership projection preserves exact configured identity key version team and status without rewriting source rows', () => {
		const row = membershipIdentityRow(), before = structuredClone(row);
		expect(serializeCapacityProviderMembershipView(row)).toEqual({ providerId: row.provider_id, fingerprint: row.fingerprint,
			publicJwk: JSON.parse(row.public_jwk_json), displayName: row.display_name, identityVersion: 1, identityStatus: 'active',
			membershipId: row.membership_id, teamId: row.team_id, membershipStatus: 'approved', identityMetadata: {}, membershipMetadata: {},
			createdAt: row.membership_created_at, updatedAt: row.membership_updated_at });
		expect(serializeCapacityProviderMembershipView(null)).toBeNull(); expect(row).toEqual(before);
	});
	it('missing malformed coerced identity version key membership and status projections deny without source mutation', () => {
		for (const [column, values] of Object.entries({ identity_version: [undefined, null, '', '1', true, 0, -1, 1.5, NaN, Infinity],
			public_jwk_json: [undefined, null, '', 'not-json', '{}', '[]'], identity_status: [undefined, null, '', 'unknown'],
			membership_status: [undefined, null, '', 'unknown'], provider_id: [undefined, null, ''], membership_id: [undefined, null, ''], team_id: [undefined, null, ''] })) {
			for (const value of values) { const row: Record<string, unknown> = { ...membershipIdentityRow(), [column]: value }, before = structuredClone(row);
				expect(() => serializeCapacityProviderMembershipView(row)).toThrow(/invalid/); expect(row).toEqual(before); }
		}
	});
});

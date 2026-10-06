import { describe, expect, it } from 'vitest';
import { providerPrincipal } from '../../../../../../../../src/api/control-plane/repositories/providers/provider-runtime-service.ts';
import { normalizeProviderAssignmentLeaseSeconds } from '../../../../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-lease-service.ts';

describe('provider poll input authority', () => {
	it('missing and insufficient provider poll scope deny before any assignment authority is returned', () => {
		for (const auth of [undefined, null, {}, { principal: { teamId: 'team', membershipId: 'membership', capacityProviderId: 'provider', scopes: [] } }]) {
			const before = structuredClone(auth); expect(() => providerPrincipal(auth, ['provider:assignments:read'])).toThrow(); expect(auth).toEqual(before);
		}
		const auth = { principal: { teamId: 'team', membershipId: 'membership', capacityProviderId: 'provider', scopes: ['provider:assignments:read'] } };
		expect(providerPrincipal(auth, ['provider:assignments:read'])).toEqual(auth.principal);
	});
	it('coerced empty fractional and nonfinite explicit lease seconds deny instead of creating authority from malformed poll input', () => {
		expect(normalizeProviderAssignmentLeaseSeconds(undefined)).toBe(300); expect(normalizeProviderAssignmentLeaseSeconds(30)).toBe(30);
		for (const value of ['', '30', null, true, 30.5, Number.NaN, Infinity, -Infinity]) expect(() => normalizeProviderAssignmentLeaseSeconds(value)).toThrow();
	});
});

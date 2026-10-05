import { describe, expect, it } from 'vitest';
import { CapacityGovernanceError } from '../../../../../../../../src/api/capacity/database.ts';
import { revocationGuard } from './dependency-revocation-fixture.ts';

describe('original revocation early authority guards', () => {
	it('empty credential and membership revocation keys deny before all original repository reads and writes without input rewriting', async () => {
		for (const target of ['credential', 'membership'] as const) {
			const guard = revocationGuard(), input = { teamId: 'team', membershipId: 'membership', capacityProviderId: 'provider', key: '' }, before = structuredClone(input);
			const call = target === 'credential' ? guard.service.revokeCredential(input.teamId, input.membershipId, 'credential', 'actor', input.key) : guard.service.leaveMembership(input, input.key);
			await expect(call).rejects.toMatchObject({ code: 'idempotency_key_required', status: 400 }); expect(guard.reads()).toBe(0); expect(guard.writes()).toBe(0); expect(input).toEqual(before);
		}
	});
	it('missing empty and unknown membership identities deny credential and leave operations with original governance errors and no writes', async () => {
		for (const member of ['', 'missing-member', 'foreign-member']) for (const target of ['credential', 'membership'] as const) {
			const guard = revocationGuard(), input = { teamId: 'team', membershipId: member, capacityProviderId: 'provider', key: 'original-key' }, before = structuredClone(input);
			let error: unknown; try { if (target === 'credential') await guard.service.revokeCredential(input.teamId, input.membershipId, 'credential', 'actor', input.key);
				else await guard.service.leaveMembership(input, input.key); } catch (caught) { error = caught; }
			expect(error).toBeInstanceOf(CapacityGovernanceError); expect(error).toMatchObject({ code: 'provider_membership_not_found', status: 404 });
			expect(guard.reads()).toBe(1); expect(guard.writes()).toBe(0); expect(input).toEqual(before);
		}
	});
});

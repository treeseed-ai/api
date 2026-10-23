import { describe, expect, it, vi } from 'vitest';
import { AvailabilitySessionRepository } from '../../../../../src/api/capacity/repositories/accounts/availability-session.ts';

describe('owned availability refresh conflict details', () => {
	it('returns only a live advanced session identity under the exact membership, team, and provider scope', async () => {
		const first = vi.fn().mockResolvedValue({ id: 'session-owned', status: 'open', sequence: 2 });
		const database = { ensureInitialized: vi.fn(), first } as never;
		const repository = new AvailabilitySessionRepository(database);
		const result = await repository.getRefreshConflict({ id: 'session-owned', membershipId: 'membership-owned',
			teamId: 'team-owned', providerId: 'provider-owned' }, 1, '2026-10-23T07:00:00.000Z');
		expect(result).toEqual({ id: 'session-owned', status: 'open', sequence: 2 });
		expect(Object.keys(result ?? {}).sort()).toEqual(['id', 'sequence', 'status']);
		expect(first.mock.calls[0]?.[0]).toContain('membership_id=? AND team_id=? AND capacity_provider_id=?');
		expect(first.mock.calls[0]?.[0]).toContain("status='open' AND expires_at>? AND sequence>?");
		expect(first.mock.calls[0]?.[1]).toEqual(['session-owned', 'membership-owned', 'team-owned', 'provider-owned', '2026-10-23T07:00:00.000Z', 1]);
	});

	it('returns no recovery details when the owned session is absent or not live', async () => {
		const first = vi.fn().mockResolvedValue(null);
		const repository = new AvailabilitySessionRepository({ ensureInitialized: vi.fn(), first } as never);
		expect(await repository.getRefreshConflict({ id: 'session-other', membershipId: 'membership-owned',
			teamId: 'team-owned', providerId: 'provider-owned' }, 1, '2026-10-23T07:00:00.000Z')).toBeNull();
	});
});

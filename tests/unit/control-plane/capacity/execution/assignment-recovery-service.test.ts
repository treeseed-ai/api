import { describe, expect, it, vi } from 'vitest';
import { recoverableLeaseSql, recoverExpiredProviderAssignments } from '../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-recovery-service.ts';

describe('assignment recovery eligibility', () => {
	it('treats an expired lease or a closed provider session as the same recovery frontier', () => {
		const predicate = recoverableLeaseSql('assignment');
		expect(predicate).toContain('assignment.lease_expires_at <= ?');
		expect(predicate).toContain('recovery_session.id = assignment.provider_session_id');
		expect(predicate).toContain("recovery_session.status IN ('closed','expired')");
	});

	it('scans closed-session leases without waiting for their wall-clock expiry', async () => {
		const all = vi.fn(async () => []);
		const database = { ensureInitialized: vi.fn(async () => undefined), all };
		const result = await recoverExpiredProviderAssignments(database as never, {
			teamId: 'team-1', providerId: 'provider-1', now: '2026-09-14T12:00:00.000Z', limit: 10,
		});
		expect(result).toMatchObject({ scanned: 0, recovered: 0 });
		expect(all).toHaveBeenCalledOnce();
		const [query, parameters] = all.mock.calls[0]!;
		expect(query).toContain("recovery_session.status IN ('closed','expired')");
		expect(query).toContain('provider_session_id IS NOT NULL');
		expect(parameters).toEqual(['2026-09-14T12:00:00.000Z', 'team-1', 'provider-1', 10]);
	});
});

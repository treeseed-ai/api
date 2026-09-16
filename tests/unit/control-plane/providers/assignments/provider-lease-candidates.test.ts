import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../src/api/capacity/services/capacity/providers/provider-synthesis-context-service.ts', () => ({
	resolveProviderSynthesisContext: vi.fn(async () => ({ session: { id: 'session' }, environment: 'local',
		executionProviders: [{ id: 'retired', status: 'unavailable' }, { id: 'codex-implementation', status: 'available' }] })),
}));
vi.mock('../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-recovery-service.ts', () => ({
	recoverExpiredProviderAssignments: vi.fn(async () => ({ scanned: 0, recovered: 0 })),
}));
import { leaseNextProviderAssignment } from '../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-lease-service.ts';

describe('provider lease candidate scope', () => {
	it('excludes unavailable execution providers and terminal workdays before parsing snapshots', async () => {
		const all = vi.fn(async (_query: string, _parameters: unknown[]) => []);
		const store = { ensureInitialized: vi.fn(), all, run: vi.fn(), synthesizeProviderAssignments: vi.fn(async () => ({})) };
		const result = await leaseNextProviderAssignment(store as never,
			{ teamId: 'team', capacityProviderId: 'provider', membershipId: 'member' });
		expect(result.assignment).toBeNull();
		expect(all).toHaveBeenCalledOnce();
		const [query, parameters] = all.mock.calls[0]!;
		expect(query).toContain('execution_provider_id IN (?)');
		expect(query).toContain("workday.status IN ('completed','cancelled')");
		expect(parameters).toEqual(['team', 'provider', 'codex-implementation']);
	});
});

import { describe, expect, it, vi } from 'vitest';
import { CapacityAllocationSetRepository, teamDefaultAllocationPredicate } from '../../../../../src/api/capacity/repositories/capacity/allocations/allocation-set.ts';

describe('repository profile and team default isolation', () => {
	it('filters implicit defaults but preserves explicit profile lookup', async () => {
		const store = { ensureInitialized: vi.fn(), first: vi.fn(async () => null) };
		const repository = new CapacityAllocationSetRepository(store as never);
		await repository.getActive('team-1', '2026-09-11T00:00:00Z');
		expect(store.first).toHaveBeenLastCalledWith(expect.stringContaining(teamDefaultAllocationPredicate), ['team-1', '2026-09-11T00:00:00Z', '2026-09-11T00:00:00Z']);
		await repository.get('team-1', 'profile-explicit');
		expect(store.first).toHaveBeenLastCalledWith(expect.not.stringContaining(teamDefaultAllocationPredicate), ['profile-explicit', 'team-1']);
	});
});

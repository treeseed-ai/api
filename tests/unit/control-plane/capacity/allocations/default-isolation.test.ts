import { describe, expect, it, vi } from 'vitest';
import { CapacityAllocationSetRepository, teamDefaultAllocationPredicate } from '../../../../../src/api/capacity/repositories/capacity/allocations/allocation-set.ts';
import { loadCapacityAdmissionState } from '../../../../../src/api/capacity/services/support/admission-state-service.ts';

describe('repository profile and team default isolation', () => {
	it('filters implicit defaults but preserves explicit profile lookup', async () => {
		const store = { ensureInitialized: vi.fn(), first: vi.fn(async () => null) };
		const repository = new CapacityAllocationSetRepository(store as never);
		await repository.getActive('team-1', '2026-09-11T00:00:00Z');
		expect(store.first).toHaveBeenLastCalledWith(expect.stringContaining(teamDefaultAllocationPredicate), ['team-1', '2026-09-11T00:00:00Z', '2026-09-11T00:00:00Z']);
		await repository.get('team-1', 'profile-explicit');
		expect(store.first).toHaveBeenLastCalledWith(expect.not.stringContaining(teamDefaultAllocationPredicate), ['profile-explicit', 'team-1']);
	});
	it.each([null, 'profile-explicit'])('keeps admission selection explicit for %s', async allocation => {
		const queries: string[] = [];
		const store = { ensureInitialized: vi.fn(), first: vi.fn(async (query: string) => {
			queries.push(query);
			if (query.includes('FROM capacity_provider_team_memberships')) return { id: 'membership' };
			if (query.includes('FROM projects')) return { id: 'project' };
			if (query.includes('FROM project_agent_classes')) return { id: 'class', status: 'active' };
			if (query.includes('FROM workday_capacity_envelopes')) return { allocation_set_id: allocation, metadata_json: '{"grantId":"grant"}' };
			return null;
		}) };
		await expect(loadCapacityAdmissionState(store as never, { teamId: 'team-1', providerId: 'provider', membershipId: 'membership', projectId: 'project', projectAgentClassId: 'class', workDayId: 'workday', mode: 'act', requestedSeconds: 900, environment: 'local' } as never)).rejects.toMatchObject({ code: 'capacity_workday_grant_invalid' });
		const query = queries.find(value => value.includes('FROM capacity_allocation_sets'))!;
		expect(query.includes(teamDefaultAllocationPredicate)).toBe(allocation === null);
	});
});

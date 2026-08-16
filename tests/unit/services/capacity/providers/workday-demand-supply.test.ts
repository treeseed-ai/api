import { describe,expect,it } from 'vitest';
import { selectWorkdayDemandSupply } from '../../../../../src/api/capacity/repositories/capacity/workdays/workday-demand-supply.ts';

const now = '2026-08-08T12:00:00.000Z';

function database(allowPlanningFailover = true) {
	const sessions = [
		{ id: 'session-a', membership_id: 'membership-a', capacity_provider_id: 'provider-a', execution_providers_json: JSON.stringify([{ id: 'runtime-a', status: 'available', capabilities: ['agent-execution'], reliability: 0.9, pressure: 'normal', availableConcurrency: 1 }]) },
		{ id: 'session-b', membership_id: 'membership-b', capacity_provider_id: 'provider-b', execution_providers_json: JSON.stringify([{ id: 'runtime-b', status: 'available', capabilities: ['agent-execution'], reliability: 0.99, pressure: 'idle', availableConcurrency: 2 }]) },
	];
	const grants = [
		{ id: 'grant-a', membership_id: 'membership-a', execution_provider_ids_json: '["runtime-a"]', capabilities_json: '["agent-execution"]', allowed_modes_json: '["planning"]' },
		{ id: 'grant-b', membership_id: 'membership-b', execution_provider_ids_json: '["runtime-b"]', capabilities_json: '["agent-execution"]', allowed_modes_json: '["planning"]' },
	];
	return {
		first: async (query: string) => query.includes('FROM teams')
			? { metadata_json: JSON.stringify({ capacitySupplyPolicy: { generation: 4, allowPlanningFailover } }) }
			: { required_capabilities_json: '["agent-execution"]' },
		all: async (query: string) => query.includes('capacity_grants') ? grants : sessions,
	} as never;
}

const demand = {
	id: 'demand-a', team_id: 'team-a', project_id: 'project-a', project_agent_class_id: 'class-a',
	mode: 'planning', primary_provider_id: 'provider-a', metadata_json: '{"environment":"local"}',
};

describe('workday demand supply brokerage', () => {
	it('selects the reliable eligible portfolio supply together with its exact grant', async () => {
		const result = await selectWorkdayDemandSupply(database(), demand, now);
		expect(result.selected).toMatchObject({ capacityProviderId: 'provider-b', executionProviderId: 'runtime-b', grantId: 'grant-b' });
		expect(result.policy.generation).toBe(4);
	});

	it('does not move planning demand away from its primary provider when failover is disabled', async () => {
		const result = await selectWorkdayDemandSupply(database(false), demand, now);
		expect(result.selected).toMatchObject({ capacityProviderId: 'provider-a', grantId: 'grant-a' });
	});

	it('does not select the same provider and execution adapter for a new failover generation', async () => {
		const retried = { ...demand, metadata_json: JSON.stringify({ environment: 'local', failoverCount: 1, failoverHistory: [{ capacityProviderId: 'provider-b', executionProviderId: 'runtime-b' }] }) };
		const result = await selectWorkdayDemandSupply(database(), retried, now);
		expect(result.selected).toMatchObject({ capacityProviderId: 'provider-a', executionProviderId: 'runtime-a' });
	});

	it('honors the provider-advertised default when eligible supply is otherwise equal', async () => {
		const source = {
			first: async (query: string) => query.includes('FROM teams')
				? { metadata_json: '{}' }
				: { required_capabilities_json: '["agent-execution"]' },
			all: async (query: string) => query.includes('capacity_grants')
				? [{ id: 'grant-a', membership_id: 'membership-a', execution_provider_ids_json: '["codex-key","codex-sub"]', capabilities_json: '["agent-execution"]', allowed_modes_json: '["planning"]' }]
				: [{ id: 'session-a', membership_id: 'membership-a', capacity_provider_id: 'provider-a', execution_providers_json: JSON.stringify([
					{ id: 'codex-key', status: 'available', capabilities: ['agent-execution'], reliability: 1, pressure: 'normal', availableConcurrency: 1 },
					{ id: 'codex-sub', preferred: true, status: 'available', capabilities: ['agent-execution'], reliability: 1, pressure: 'normal', availableConcurrency: 1 },
				]) }],
		} as never;
		const result = await selectWorkdayDemandSupply(source, demand, now);
		expect(result.selected?.executionProviderId).toBe('codex-sub');
	});

	it('explains a capability mismatch instead of silently dropping supply', async () => {
		const source = {
			first: async (query: string) => query.includes('FROM teams')
				? { metadata_json: '{}' }
				: { required_capabilities_json: '["agent-execution"]' },
			all: async (query: string) => query.includes('capacity_grants')
				? [{ id: 'grant-a', membership_id: 'membership-a', execution_provider_ids_json: '["codex-sub"]', capabilities_json: '["agent_mode_run"]', allowed_modes_json: '["planning"]' }]
				: [{ id: 'session-a', membership_id: 'membership-a', capacity_provider_id: 'provider-a', execution_providers_json: JSON.stringify([
					{ id: 'codex-sub', status: 'available', capabilities: ['agent_mode_run'], reliability: 1, pressure: 'normal', availableConcurrency: 1 },
				]) }],
		} as never;
		const result = await selectWorkdayDemandSupply(source, demand, now);
		expect(result.selected).toBeNull();
		expect(result.rejected).toEqual([
			expect.objectContaining({ reasons: ['missing_capability:agent-execution'] }),
		]);
	});
});

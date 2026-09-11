import { expect, it } from 'vitest';
import { selectWorkdayDemandSupply } from '../../../../../src/api/capacity/repositories/capacity/workdays/workday-demand-supply.ts';

it('selects the workday offer rather than repeatedly denying a higher-ranked communication-only offer', async () => {
	const capability = 'treeseed.engineering.review';
	const offer = (id: string, purpose: string) => ({ id, status: 'available', capabilities: [capability], lanes: [{ id, purpose }] });
	const database = {
		first: async () => ({ metadata_json: '{}' }),
		all: async (sql: string) => sql.includes('availability_sessions') ? [{ id: 'session', membership_id: 'member', capacity_provider_id: 'provider', execution_providers_json: JSON.stringify([offer('a-conversation', 'communication'), offer('z-engineering', 'workday')]) }]
			: [{ id: 'grant', membership_id: 'member', execution_provider_ids_json: '[]', allowed_modes_json: '["planning"]', capabilities_json: JSON.stringify([capability]) }],
	} as any;
	const demand = (kind: string) => ({ id: 'demand', team_id: 'team', project_id: 'sdk', primary_provider_id: 'provider', mode: 'planning', metadata_json: JSON.stringify({ executionKind: kind, capabilityDemand: { resolved: [{ id: capability }] } }) });
	const workday = await selectWorkdayDemandSupply(database, demand('workday'), new Date().toISOString());
	expect(workday.selected?.executionProviderId).toBe('z-engineering');
	expect(workday.rejected).toEqual([expect.objectContaining({ candidate: expect.objectContaining({ executionProviderId: 'a-conversation' }), reasons: ['status:unavailable'] })]);
	expect((await selectWorkdayDemandSupply(database, demand('conversation'), new Date().toISOString())).selected?.executionProviderId).toBe('a-conversation');
});

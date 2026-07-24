import { describe, expect, it, vi } from 'vitest';
import { decodeDurableJsonArray, decodeDurableJsonObject } from '../../../src/api/capacity/durable-json.ts';
import { loadCapacityAdmissionState } from '../../../src/api/capacity/services/support/admission-state-service.ts';
import { CapacityGrantService } from '../../../src/api/capacity/services/capacity/allocations/grant-service.ts';

describe('durable capacity JSON', () => {
	it('fails closed for malformed grant and admission durable JSON', async () => {
		expect(() => decodeDurableJsonObject('{', { owner: 'provider assignment', ownerId: 'assignment-a', column: 'workspace_context_json' }))
			.toThrowError(expect.objectContaining({ code: 'capacity_durable_json_invalid' }));
		expect(() => decodeDurableJsonArray('{}', { owner: 'capacity allocation set', ownerId: 'allocation-a', column: 'slices_json' }))
			.toThrowError(expect.objectContaining({ code: 'capacity_durable_json_invalid' }));

		const grant = {
			id: 'grant-a', membership_id: 'membership-a', team_id: 'team-a', capacity_provider_id: 'provider-a',
			project_id: 'project-a', environment: 'local', status: 'active', execution_provider_ids_json: '["codex"]',
			lane_ids_json: '[]', capabilities_json: '{', allowed_modes_json: '["planning"]', metadata_json: '{}',
		};
		const service = new CapacityGrantService({
			ensureInitialized: vi.fn(),
			first: vi.fn(async () => grant),
		} as never);
		await expect(service.get('team-a', 'grant-a')).rejects.toMatchObject({
			code: 'capacity_durable_json_invalid',
			details: { owner: 'capacity grant', ownerId: 'grant-a', column: 'capabilities_json' },
		});

		const first = vi.fn(async (query: string) => {
			if (query.includes('capacity_provider_team_memberships')) return { id: 'membership-a' };
			if (query.includes('FROM projects')) return { id: 'project-a' };
			if (query.includes('project_agent_classes')) return { id: 'class-a', status: 'active', required_capabilities_json: '[]' };
			if (query.includes('workday_capacity_envelopes')) return { id: 'workday-a', allocation_set_id: 'allocation-a', metadata_json: '{' };
			throw new Error(`Unexpected query: ${query}`);
		});
		await expect(loadCapacityAdmissionState({ ensureInitialized: vi.fn(), first } as never, {
			teamId: 'team-a', providerId: 'provider-a', membershipId: 'membership-a', projectId: 'project-a',
			environment: 'local', projectAgentClassId: 'class-a', mode: 'planning', workDayId: 'workday-a', requestedCredits: 1,
		})).rejects.toMatchObject({
			code: 'capacity_durable_json_invalid',
			details: { owner: 'workday capacity envelope', ownerId: 'workday-a', column: 'metadata_json' },
		});
	});
});

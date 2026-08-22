import { describe, expect, it, vi } from 'vitest';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { createCapacityQueryOperations } from '../../../../src/api/control-plane/catalog/capacity/capacity.ts';
import { createCapacityQueryService } from '../../../../src/api/control-plane/repositories/capacity/capacity-query-service.ts';

const principal = { id: 'user-1' };
describe('capacity query catalog operations', () => {
	it('binds only status, accounting, and grant reads', () => {
		const capacityQueries = Object.fromEntries(['availability', 'usage', 'ledger', 'grants', 'grant'].map((name) => [name, vi.fn()])) as any;
		expect(createCapacityQueryOperations({ capacityQueries }).map((operation) => operation.binding)).toEqual([
			CONTROL_PLANE_OPERATIONS.capacity.availability, CONTROL_PLANE_OPERATIONS.capacity.usage,
			CONTROL_PLANE_OPERATIONS.capacity.ledger, CONTROL_PLANE_OPERATIONS.capacity.grants,
			CONTROL_PLANE_OPERATIONS.capacity.grant,
		]);
	});

	it('rejects invalid grant status before querying durable state', async () => {
		const store = { principalCanAccessTeam: vi.fn(async () => true),
			getTeamAccessSummary: vi.fn(async () => ({ permissions: ['projects:read:team'] })), all: vi.fn() };
		await expect(createCapacityQueryService(store).grants(principal, 'team-1', { status: 'unknown' }))
			.rejects.toMatchObject({ status: 400, code: 'capacity_grant_status_invalid' });
		expect(store.all).not.toHaveBeenCalled();
	});
});

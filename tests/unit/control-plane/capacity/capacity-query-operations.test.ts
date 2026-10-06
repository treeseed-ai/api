import { describe, expect, it, vi } from 'vitest';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { createCapacityQueryOperations } from '../../../../src/api/control-plane/catalog/capacity/capacity.ts';
import { createCapacityQueryService } from '../../../../src/api/control-plane/repositories/capacity/capacity-query-service.ts';
import { CapacityOperationError } from '../../../../src/api/control-plane/repositories/capacity/capacity-operation-error.ts';
import { ControlPlaneOperationError } from '../../../../src/api/control-plane/catalog/operation-registry.ts';

const principal = { id: 'user-1' };
describe('capacity query catalog operations', () => {
	it('retains every declared capacity error status and fails closed on malformed or undeclared statuses through the original catalog boundary', async () => {
		for (const status of [400, 401, 403, 404, 409, 412, 413, 422, 429, 500, 503, -1, 0, 200, 418, NaN, Infinity]) {
			const supplied = new CapacityOperationError(status, 'capacity_native_observation_denied', 'Original denial');
			const queries = createCapacityQueryService({});
			queries.explain = async () => { throw supplied; };
			const operation = createCapacityQueryOperations({ capacityQueries: queries }).find(value => value.binding === CONTROL_PLANE_OPERATIONS.capacity.explain);
			if (!operation) throw new Error('Original capacity explain boundary required');
			const input = { path: { teamId: 'team-1' }, query: {}, body: undefined }, before = structuredClone(input);
			const allowed = [400, 401, 403, 404, 409, 412, 413, 422, 429, 500, 503];
			await expect(operation.handler(input, { interface: 'internal', requestId: 'error-status', principal }))
				.rejects.toEqual(new ControlPlaneOperationError(allowed.includes(status) ? supplied.status : 500, supplied.code, supplied.message));
			expect(input).toEqual(before); expect(supplied.code).toBe('capacity_native_observation_denied');
		}
	});
	it('scopes provider-owned lanes through approved team memberships', async () => {
		const store = { principalCanAccessTeam: vi.fn(async () => true), getTeamAccessSummary: vi.fn(async () => ({ permissions: ['projects:read:team'] })),
			listProviderAvailabilitySessionsPage: vi.fn(async () => []), first: vi.fn(async () => ({ count: 0 })), all: vi.fn(async () => []) };
		const service = createCapacityQueryService(store);
		await service.explain(principal, 'team-1');
		await service.lanes(principal, 'team-1');
		for (const [query, params] of store.all.mock.calls as unknown as [string, unknown[]][]) {
			expect(query).toContain('membership.team_id = ?');
			expect(query).toContain("membership.status = 'approved'");
			expect(query).not.toContain('lanes.team_id');
			expect(params).toEqual(['team-1']);
		}
	});
	it('binds the complete battery inspection surface', () => {
		const capacityQueries = Object.fromEntries(['availability', 'explain', 'usage', 'ledger', 'audit', 'lanes', 'grants', 'grant'].map((name) => [name, vi.fn()])) as any;
		expect(createCapacityQueryOperations({ capacityQueries }).map((operation) => operation.binding)).toEqual([
			CONTROL_PLANE_OPERATIONS.capacity.availability, CONTROL_PLANE_OPERATIONS.capacity.explain,
			CONTROL_PLANE_OPERATIONS.capacity.usage, CONTROL_PLANE_OPERATIONS.capacity.ledger,
			CONTROL_PLANE_OPERATIONS.capacity.audit, CONTROL_PLANE_OPERATIONS.capacity.lanes, CONTROL_PLANE_OPERATIONS.capacity.grants,
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

import { describe, expect, it, vi } from 'vitest';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { createCapacityPlanOperations } from '../../../../src/api/control-plane/catalog/capacity/plans.ts';
import { createCapacityPlanService } from '../../../../src/api/control-plane/repositories/capacity/capacity-plan-service.ts';

const principal = { id: 'user-1' };

describe('capacity plan catalog operations', () => {
	it('binds the two read-only plan operations without exposing plan authoring', () => {
		const plans = { list: vi.fn(), show: vi.fn() };
		expect(createCapacityPlanOperations({ plans }).map((operation) => operation.binding)).toEqual([
			CONTROL_PLANE_OPERATIONS.plans.list, CONTROL_PLANE_OPERATIONS.plans.show,
		]);
	});

	it('authorizes the owning project and validates status before querying plans', async () => {
		const store = {
			getDecisionPlanningStatus: vi.fn(async () => ({ projectId: 'project-1' })),
			getProjectDetails: vi.fn(async () => ({ project: { id: 'project-1', teamId: 'team-1' } })),
			principalCanAccessTeam: vi.fn(async () => true),
			getTeamAccessSummary: vi.fn(async () => ({ permissions: ['projects:read:team'] })),
			listAgentCapacityPlans: vi.fn(async () => [{ id: 'plan-1' }]),
		};
		const plans = createCapacityPlanService(store);
		await expect(plans.list(principal, 'decision-1', { status: 'accepted' })).resolves.toEqual({
			items: [{ id: 'plan-1' }], cursor: null,
		});
		expect(store.listAgentCapacityPlans).toHaveBeenCalledWith('decision-1', { status: 'accepted' });
		await expect(plans.list(principal, 'decision-1', { status: 'unknown' })).rejects.toMatchObject({
			status: 400, code: 'capacity_plan_status_invalid',
		});
	});
});

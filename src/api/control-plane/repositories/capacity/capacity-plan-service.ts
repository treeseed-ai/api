import type { DurableAgentCapacityPlanStatus } from '@treeseed/sdk/agent-capacity';
import { authorizeCapacityProject, type CapacityPrincipal } from './capacity-authorization.ts';
import { CapacityOperationError } from './capacity-operation-error.ts';

const STATUSES = new Set<DurableAgentCapacityPlanStatus>([
	'draft', 'accepted', 'revision_requested', 'deferred', 'scheduled', 'active', 'completed', 'superseded',
]);

function status(value: unknown): DurableAgentCapacityPlanStatus | null {
	if (value == null || value === '') return null;
	if (!STATUSES.has(String(value) as DurableAgentCapacityPlanStatus)) {
		throw new CapacityOperationError(400, 'capacity_plan_status_invalid', `Unknown capacity plan status ${String(value)}.`);
	}
	return String(value) as DurableAgentCapacityPlanStatus;
}

export function createCapacityPlanService(store: any) {
	return {
		async list(principal: CapacityPrincipal, decisionId: string, query: Record<string, unknown>) {
			const planning = await store.getDecisionPlanningStatus(decisionId);
			if (!planning) throw new CapacityOperationError(404, 'decision_planning_not_found', 'Decision planning status not found.');
			await authorizeCapacityProject(store, principal, planning.projectId, 'projects:read:team');
			return { items: await store.listAgentCapacityPlans(decisionId, { status: status(query.status) }), cursor: null };
		},
		async show(principal: CapacityPrincipal, planId: string) {
			const plan = await store.getAgentCapacityPlan(planId);
			if (!plan) throw new CapacityOperationError(404, 'capacity_plan_not_found', 'Capacity plan not found.');
			await authorizeCapacityProject(store, principal, plan.projectId, 'projects:read:team');
			return plan;
		},
	};
}

import type {
AgentCapacityPlanRecord,
DurableAgentCapacityPlanStatus,
} from '@treeseed/sdk/agent-capacity';
import type { Context,Hono } from 'hono';
import type { CapacityGovernanceDatabase } from '../../../database.ts';
import { CapacityGovernanceError } from '../../../database.ts';

const STATUSES = new Set<DurableAgentCapacityPlanStatus>([
	'draft', 'accepted', 'revision_requested', 'deferred', 'scheduled', 'active', 'completed', 'superseded',
]);

interface CapacityPlanStore extends CapacityGovernanceDatabase {
	getDecisionPlanningStatus(decisionId: string): Promise<{ projectId: string } | null>;
	listAgentCapacityPlans(decisionId: string, filters: { status: DurableAgentCapacityPlanStatus | null }): Promise<AgentCapacityPlanRecord[]>;
	getAgentCapacityPlan(planId: string): Promise<AgentCapacityPlanRecord | null>;
}

export interface CapacityPlanRouteOptions {
	store: CapacityGovernanceDatabase;
	requireProjectAccess(c: Context, store: CapacityGovernanceDatabase, projectId: string, permission: string): Promise<{ response?: Response | null }>;
}

function error(c: Context, status: 400 | 404, message: string) {
	return c.json({ ok: false, error: message }, { status });
}

function requestedStatus(value: unknown): DurableAgentCapacityPlanStatus | null {
	if (value == null || value === '') return null;
	const candidate = String(value) as DurableAgentCapacityPlanStatus;
	if (!STATUSES.has(candidate)) {
		throw new CapacityGovernanceError('agent_capacity_plan_status_invalid', `Unknown agent capacity plan status ${candidate}.`, 400);
	}
	return candidate;
}

export function installCapacityPlanRoutes(app: Hono, options: CapacityPlanRouteOptions) {
	const store = options.store as CapacityPlanStore;

	app.get('/v1/decisions/:decisionId/capacity-plans', async (c) => {
		const planning = await store.getDecisionPlanningStatus(c.req.param('decisionId'));
		if (!planning) return error(c, 404, 'Unknown decision planning status.');
		const access = await options.requireProjectAccess(c, options.store, planning.projectId, 'projects:read:team');
		if (access.response) return access.response;
		return c.json({ ok: true, payload: await store.listAgentCapacityPlans(c.req.param('decisionId'), { status: requestedStatus(c.req.query('status')) }) });
	});

	app.get('/v1/capacity-plans/:capacityPlanId', async (c) => {
		const plan = await store.getAgentCapacityPlan(c.req.param('capacityPlanId'));
		if (!plan) return error(c, 404, 'Unknown capacity plan.');
		const access = await options.requireProjectAccess(c, options.store, plan.projectId, 'projects:read:team');
		if (access.response) return access.response;
		return c.json({ ok: true, payload: plan });
	});

}

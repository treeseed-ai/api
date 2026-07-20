import type {
	AgentCapacityPlanRecord,
	DurableAgentCapacityPlanStatus,
} from '@treeseed/sdk/agent-capacity';
import type { Context, Hono } from 'hono';
import type { CapacityGovernanceDatabase } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';
import { readCapacityRequestObject } from './request-json.ts';

const STATUSES = new Set<DurableAgentCapacityPlanStatus>([
	'draft', 'accepted', 'revision_requested', 'deferred', 'scheduled', 'active', 'completed', 'superseded',
]);

interface CapacityPlanStore extends CapacityGovernanceDatabase {
	getDecisionPlanningStatus(decisionId: string): Promise<{ projectId: string } | null>;
	listAgentCapacityPlans(decisionId: string, filters: { status: DurableAgentCapacityPlanStatus | null }): Promise<AgentCapacityPlanRecord[]>;
	createAgentCapacityPlan(decisionId: string, input: Record<string, unknown>): Promise<AgentCapacityPlanRecord | null>;
	getAgentCapacityPlan(planId: string): Promise<AgentCapacityPlanRecord | null>;
	updateAgentCapacityPlanStatus(planId: string, status: DurableAgentCapacityPlanStatus, input: Record<string, unknown>): Promise<AgentCapacityPlanRecord | null>;
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

	app.post('/v1/decisions/:decisionId/capacity-plans', async (c) => {
		const body = await readCapacityRequestObject(c, { optional: true });
		const projectId = typeof body.projectId === 'string' ? body.projectId : '';
		if (!projectId) return error(c, 400, 'projectId is required.');
		const access = await options.requireProjectAccess(c, options.store, projectId, 'projects:manage:team');
		if (access.response) return access.response;
		const plan = await store.createAgentCapacityPlan(c.req.param('decisionId'), body);
		return plan ? c.json({ ok: true, payload: plan }, { status: 201 }) : error(c, 404, 'Unknown project.');
	});

	app.get('/v1/capacity-plans/:capacityPlanId', async (c) => {
		const plan = await store.getAgentCapacityPlan(c.req.param('capacityPlanId'));
		if (!plan) return error(c, 404, 'Unknown capacity plan.');
		const access = await options.requireProjectAccess(c, options.store, plan.projectId, 'projects:read:team');
		if (access.response) return access.response;
		return c.json({ ok: true, payload: plan });
	});

	const transition = (status: DurableAgentCapacityPlanStatus) => async (c: Context) => {
		const plan = await store.getAgentCapacityPlan(c.req.param('capacityPlanId'));
		if (!plan) return error(c, 404, 'Unknown capacity plan.');
		const access = await options.requireProjectAccess(c, options.store, plan.projectId, 'projects:manage:team');
		if (access.response) return access.response;
		const body = await readCapacityRequestObject(c, { optional: true });
		return c.json({ ok: true, payload: await store.updateAgentCapacityPlanStatus(plan.id, status, body) });
	};

	app.post('/v1/capacity-plans/:capacityPlanId/accept', transition('accepted'));
	app.post('/v1/capacity-plans/:capacityPlanId/request-revision', transition('revision_requested'));
	app.post('/v1/capacity-plans/:capacityPlanId/schedule', transition('scheduled'));
	app.post('/v1/capacity-plans/:capacityPlanId/supersede', transition('superseded'));
}

import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { describe,expect,it,vi } from 'vitest';
import { CapacityGovernanceError,type CapacityGovernanceDatabase } from '../../../../../src/api/capacity/database.ts';
import { installCapacityPlanRoutes } from '../../../../../src/api/capacity/routes/capacity/planning/capacity-plans.ts';

function appWith(store: Record<string, unknown>, permissions: string[] = []) {
	const app = new Hono();
	app.onError((error, c) => error instanceof CapacityGovernanceError
		? c.json({ ok: false, error: error.message, code: error.code }, { status: error.status as ContentfulStatusCode })
		: c.json({ ok: false, error: String(error) }, { status: 500 }));
	installCapacityPlanRoutes(app, {
		store: store as unknown as CapacityGovernanceDatabase,
		async requireProjectAccess(_c, _store, _projectId, permission) {
			permissions.push(permission);
			return {};
		},
	});
	return app;
}

describe('capacity plan routes', () => {
	it('lists a decision plan through the extracted typed route', async () => {
		const listAgentCapacityPlans = vi.fn(async () => [{ id: 'plan-a', projectId: 'project-a' }]);
		const permissions: string[] = [];
		const app = appWith({
			async getDecisionPlanningStatus() { return { projectId: 'project-a' }; },
			listAgentCapacityPlans,
		}, permissions);
		const response = await app.request('/v1/decisions/decision-a/capacity-plans?status=draft');
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, payload: [{ id: 'plan-a', projectId: 'project-a' }] });
		expect(listAgentCapacityPlans).toHaveBeenCalledWith('decision-a', { status: 'draft' });
		expect(permissions).toEqual(['projects:read:team']);
	});

	it('rejects an unknown status before persistence', async () => {
		const listAgentCapacityPlans = vi.fn();
		const app = appWith({
			async getDecisionPlanningStatus() { return { projectId: 'project-a' }; },
			listAgentCapacityPlans,
		});
		const response = await app.request('/v1/decisions/decision-a/capacity-plans?status=approved');
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ code: 'agent_capacity_plan_status_invalid' });
		expect(listAgentCapacityPlans).not.toHaveBeenCalled();
	});

	it('does not expose client-authored capacity-plan creation or transitions', async () => {
		const createAgentCapacityPlan = vi.fn();
		const updateAgentCapacityPlanStatus = vi.fn();
		const app = appWith({ createAgentCapacityPlan,updateAgentCapacityPlanStatus });
		for (const [path,body] of [
			['/v1/decisions/decision-a/capacity-plans', { projectId: 'project-a' }],
			['/v1/capacity-plans/plan-a/accept', {}],
			['/v1/capacity-plans/plan-a/request-revision', {}],
			['/v1/capacity-plans/plan-a/schedule', {}],
			['/v1/capacity-plans/plan-a/supersede', {}],
		] as const) {
			const response = await app.request(path, { method: 'POST',headers: { 'content-type': 'application/json' },body: JSON.stringify(body) });
			expect(response.status,path).toBe(404);
		}
		expect(createAgentCapacityPlan).not.toHaveBeenCalled();
		expect(updateAgentCapacityPlanStatus).not.toHaveBeenCalled();
	});
});

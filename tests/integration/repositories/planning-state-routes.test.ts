import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { describe, expect, it, vi } from 'vitest';
import { CapacityGovernanceError, type CapacityGovernanceDatabase } from '../../../src/api/capacity/database.ts';
import { installPlanningStateRoutes } from '../../../src/api/capacity/routes/planning-state.ts';

function appWith(store: Record<string, unknown>) {
	const app = new Hono();
	app.onError((error, c) => error instanceof CapacityGovernanceError
		? c.json({ ok: false, error: error.message, code: error.code }, { status: error.status as ContentfulStatusCode })
		: c.json({ ok: false, error: String(error) }, { status: 500 }));
	installPlanningStateRoutes(app, {
		store: store as unknown as CapacityGovernanceDatabase,
		async requireProjectAccess() { return {}; },
	});
	return app;
}

describe('planning state routes', () => {
	it('rejects unknown execution-input status before querying persistence', async () => {
		const listDecisionExecutionInputs = vi.fn();
		const app = appWith({ async getDecisionPlanningStatus() { return { projectId: 'project-a' }; }, listDecisionExecutionInputs });
		const response = await app.request('/v1/decisions/decision-a/execution-inputs?status=approved');
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ code: 'decision_execution_input_status_invalid' });
		expect(listDecisionExecutionInputs).not.toHaveBeenCalled();
	});

	it('creates an execution input through the canonical service boundary', async () => {
		const createDecisionExecutionInput = vi.fn(async () => ({ id: 'input-a', projectId: 'project-a', status: 'proposed' }));
		const app = appWith({ createDecisionExecutionInput });
		const response = await app.request('/v1/decisions/decision-a/execution-inputs', {
			method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'project-a', projectAgentClassId: 'class-a' }),
		});
		expect(response.status).toBe(201);
		expect(createDecisionExecutionInput).toHaveBeenCalledWith('decision-a', { projectId: 'project-a', projectAgentClassId: 'class-a' });
	});

	it('routes acceptance to the sole transition owner', async () => {
		const updateDecisionExecutionInputStatus = vi.fn(async () => ({ id: 'input-a', projectId: 'project-a', status: 'accepted' }));
		const app = appWith({
			async getDecisionExecutionInput() { return { id: 'input-a', projectId: 'project-a' }; },
			updateDecisionExecutionInputStatus,
		});
		const response = await app.request('/v1/decision-execution-inputs/input-a/accept', { method: 'POST', body: '{}' });
		expect(response.status).toBe(200);
		expect(updateDecisionExecutionInputStatus).toHaveBeenCalledWith('input-a', 'accepted', {});
	});
});

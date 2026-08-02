import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { installProjectWorkflowOperationRoutes } from '../../../../../src/api/routes/projects/operations/workflow-operations.ts';

function context(store: Record<string, unknown>, access = async () => ({})) {
	const app = new Hono();
	installProjectWorkflowOperationRoutes({
		app,
		store,
		requireProjectAccess: access,
		jsonError(c: any, status: number, message: string, details: Record<string, unknown> = {}) {
			return c.json({ ok: false, message, ...details }, status);
		},
	});
	return app;
}

describe('project workflow operation routes', () => {
	it('returns a bounded newest-first project run collection without provider polling', async () => {
		const calls: Array<{ sql: string; values: unknown[] }> = [];
		const store = {
			async all(sql: string, values: unknown[]) {
				calls.push({ sql, values });
				return [{ id: 'run-a', operation_id: 'operation-a', project_id: 'project-a', team_id: 'team-a',
					actor_type: 'user', actor_id: 'user-a', mode: 'operator', provider_id: 'github-actions',
					source_sha: 'a'.repeat(40), ref: 'refs/heads/main', correlation_id: 'correlation-a', status: 'queued',
					artifacts_json: '[]', created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z' }];
			},
		};
		const response = await context(store).request('/v1/projects/project-a/workflow-operation-runs?operationId=operation-a&limit=10');
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('private, no-store');
		expect(await response.json()).toMatchObject({ ok: true, payload: [{ id: 'run-a', operationId: 'operation-a', status: 'queued' }] });
		expect(calls).toHaveLength(1);
		expect(calls[0].sql).toContain('ORDER BY created_at DESC, id DESC LIMIT ?');
		expect(calls[0].values).toEqual(['project-a', 'operation-a', 10]);
	});

	it('rejects unbounded limits before persistence', async () => {
		let calls = 0;
		const response = await context({ async all() { calls += 1; return []; } })
			.request('/v1/projects/project-a/workflow-operation-runs?limit=101');
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ ok: false, code: 'workflow_run_limit_invalid' });
		expect(calls).toBe(0);
	});

	it('requires project read access before returning run metadata', async () => {
		const denied = new Response(JSON.stringify({ ok: false }), { status: 403 });
		const response = await context({ async all() { throw new Error('must not query'); } }, async () => ({ response: denied }))
			.request('/v1/projects/project-a/workflow-operation-runs');
		expect(response.status).toBe(403);
	});
});

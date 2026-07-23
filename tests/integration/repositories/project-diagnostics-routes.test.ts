import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { installProjectDiagnosticsRoutes } from '../../../src/api/capacity/routes/project-diagnostics.ts';
import type { CapacityProviderAccessEnv } from '../../../src/api/capacity/provider-access-middleware.ts';

function application(store: Record<string, unknown>, access = async () => ({ response: null })) {
	const app = new Hono();
	app.onError((error, c) => c.json({ ok: false, error: error.message }, 500));
	installProjectDiagnosticsRoutes(app, { store: store as never, requireProjectAccess: access as never });
	return app;
}

describe('project capacity diagnostics routes', () => {
	it('serves the environment-scoped capacity summary through project authorization', async () => {
		let environment = '';
		const response = await application({
			async getProjectCapacitySummary(_projectId: string, selected: string) { environment = selected; return { readiness: 'ready' }; },
		}).request('/v1/projects/project-a/capacity?environment=local');
		expect(response.status).toBe(200);
		expect(environment).toBe('local');
	});

	it('allows a project runner and preserves the requested environment', async () => {
		let accessCalls = 0;
		let environment = '';
		const response = await application({
			async authenticateRunner(_projectId: string, token: string) { return token === 'runner-a' ? {} : null; },
			async getProjectCapacityDiagnostics(_projectId: string, selected: string) { environment = selected; return { ready: true }; },
		}, async () => { accessCalls += 1; return { response: null }; }).request('/v1/projects/project-a/capacity-diagnostics?environment=local', { headers: { authorization: 'Bearer runner-a' } });
		expect(response.status).toBe(200);
		expect(environment).toBe('local');
		expect(accessCalls).toBe(0);
	});

	it('allows only a same-team provider principal with assignment read scope', async () => {
		let accessCalls = 0;
		const app = application({
			async getProjectDetails() { return { project: { id: 'project-a', teamId: 'team-a' } }; },
			async getProjectCapacityRuntimeDiagnostics() { return { workdays: [] }; },
		}, async () => { accessCalls += 1; return { response: null }; });
		app.use('*', async (_c, next) => next());
		const providerApp = new Hono<CapacityProviderAccessEnv>();
		providerApp.use('*', async (c, next) => { c.set('capacityProviderAccessAuth', { principal: { teamId: 'team-a', scopes: ['provider:assignments:read'] } }); await next(); });
		installProjectDiagnosticsRoutes(providerApp as unknown as Hono, {
			store: {
				async getProjectDetails() { return { project: { id: 'project-a', teamId: 'team-a' } }; },
				async getProjectCapacityRuntimeDiagnostics() { return { workdays: [] }; },
			} as never,
			requireProjectAccess: (async () => { accessCalls += 1; return { response: null }; }) as never,
		});
		const response = await providerApp.request('/v1/projects/project-a/capacity-runtime-diagnostics');
		expect(response.status).toBe(200);
		expect(accessCalls).toBe(0);
	});

	it('propagates team resolution failures instead of misreporting an unknown project', async () => {
		const response = await application({
			async getTeam() { throw new Error('database unavailable'); },
		}).request('/v1/projects/project-a/capacity-runtime-diagnostics?teamId=team-a');
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({ error: 'database unavailable' });
	});
});

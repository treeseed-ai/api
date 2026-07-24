import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { installProviderAssignmentRoutes } from '../../../../../src/api/capacity/routes/capacity/assignments/provider-assignments.ts';
import type { CapacityProviderAccessEnv } from '../../../../../src/api/capacity/provider-access-middleware.ts';

const principal = {
	membershipId: 'membership-a',
	teamId: 'team-a',
	capacityProviderId: 'provider-a',
	scopes: ['provider:assignments:read', 'provider:assignments:write', 'provider:usage:write'],
};

function application(store: Record<string, unknown>, scopes = principal.scopes) {
	const app = new Hono<CapacityProviderAccessEnv>();
	app.use('*', async (c, next) => {
		c.set('capacityProviderAccessAuth', { principal: { ...principal, scopes } });
		await next();
	});
	installProviderAssignmentRoutes(app as unknown as Hono, { store: store as never });
	return app;
}

describe('provider assignment routes', () => {
	it('delegates lease and lifecycle transitions through the canonical store owners', async () => {
		const calls: string[] = [];
		const assignment = { id: 'assignment-a', capacityProviderId: 'provider-a' };
		const store = {
			async leaseNextProviderAssignment() { calls.push('next'); return { assignment, leaseToken: 'lease-a', leaseSeconds: 30, diagnostics: { selected: true } }; },
			async renewProviderAssignmentLease() { calls.push('renew'); return { assignment, leaseToken: 'lease-b', leaseSeconds: 30 }; },
			async returnProviderAssignment() { calls.push('return'); return { assignment }; },
			async completeProviderAssignment() { calls.push('complete'); return { assignment }; },
			async failProviderAssignment() { calls.push('fail'); return { assignment }; },
		};
		const app = application(store);
		for (const path of ['next', 'assignment-a/renew', 'assignment-a/return', 'assignment-a/complete', 'assignment-a/fail']) {
			const response = await app.request(`/v1/provider/assignments/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
			expect(response.status, path).toBe(200);
		}
		expect(calls).toEqual(['next', 'renew', 'return', 'complete', 'fail']);
	});

	it('enforces assignment ownership and all mode-run scopes before mutation', async () => {
		let created = false;
		const store = {
			async getProviderAssignment() { return { id: 'assignment-b', capacityProviderId: 'provider-b' }; },
			async createAgentModeRun() { created = true; return { id: 'mode-a' }; },
		};
		const forbidden = await application(store).request('/v1/provider/assignments/assignment-b/mode-runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
		expect(forbidden.status).toBe(403);
		expect(created).toBe(false);

		const missingScope = await application(store, ['provider:assignments:write']).request('/v1/provider/assignments/assignment-b/mode-runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
		expect(missingScope.status).toBe(403);
		expect(await missingScope.json()).toMatchObject({ code: 'provider_scope_required', details: { missingScopes: ['provider:usage:write'] } });
	});

	it('requires usage scope when failure reports financial evidence', async () => {
		let failed = false;
		const response = await application({
			async failProviderAssignment() { failed = true; return null; },
		}, ['provider:assignments:write']).request('/v1/provider/assignments/assignment-a/fail', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ usageActualId: 'usage-a' }),
		});
		expect(response.status).toBe(403);
		expect(failed).toBe(false);
	});
});

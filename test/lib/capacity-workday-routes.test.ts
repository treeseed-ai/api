import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { encodeCapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import type { CapacityGovernanceDatabase } from '../../src/api/capacity/database.ts';
import { installCapacityWorkdayRoutes } from '../../src/api/capacity/routes/workdays.ts';

describe('capacity workday routes', () => {
	it('requires and forwards idempotency keys for public create and transitions', async () => {
		const calls: Array<Record<string, unknown>> = [];
		const store = {
			async createWorkdayCapacityEnvelope(input: Record<string, unknown>, key: string) { calls.push({ action: 'create', input, key }); return { id: 'workday-a', projectId: 'project-a' }; },
			async getWorkdayCapacityEnvelope() { return { id: 'workday-a', projectId: 'project-a' }; },
			async updateWorkdayCapacityEnvelopeState(id: string, status: string, key: string) { calls.push({ action: 'transition', id, status, key }); return { id, status, projectId: 'project-a' }; },
		} as unknown as CapacityGovernanceDatabase;
		const app = new Hono();
		installCapacityWorkdayRoutes(app, { store, async requireProjectAccess() { return {}; } });
		const missing = await app.request('/v1/workdays', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'project-a' }) });
		expect(missing.status).toBe(400);
		expect(await missing.json()).toMatchObject({ code: 'capacity_idempotency_key_required' });
		const created = await app.request('/v1/workdays', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'create-key' }, body: JSON.stringify({ projectId: 'project-a' }) });
		expect(created.status).toBe(201);
		const started = await app.request('/v1/workdays/workday-a/start', { method: 'POST', headers: { 'idempotency-key': 'start-key' } });
		expect(started.status).toBe(200);
		expect(calls).toEqual([
			expect.objectContaining({ action: 'create', key: 'create-key' }),
			{ action: 'transition', id: 'workday-a', status: 'active', key: 'start-key' },
		]);
	});

	it('rejects malformed create input before project access or persistence', async () => {
		let calls = 0;
		const app = new Hono();
		installCapacityWorkdayRoutes(app, {
			store: { async createWorkdayCapacityEnvelope() { calls += 1; return {}; } } as unknown as CapacityGovernanceDatabase,
			async requireProjectAccess() { calls += 1; return {}; },
		});
		const response = await app.request('/v1/workdays', { method: 'POST', body: '[' });
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ ok: false, code: 'capacity_request_json_invalid' });
		expect(calls).toBe(0);
	});

	it('forwards validated evidence continuation to the bounded summary query', async () => {
		const calls: Array<Record<string, unknown>> = [];
		const payload = { workday: { id: 'workday-a', projectId: 'project-a' }, evidence: {} };
		const store = {
			async getWorkdayCapacitySummary(workdayId: string, options: Record<string, unknown>) {
				calls.push({ workdayId, ...options });
				return { ok: true, payload };
			},
		} as unknown as CapacityGovernanceDatabase;
		const app = new Hono();
		installCapacityWorkdayRoutes(app, {
			store,
			async requireProjectAccess(_c, _store, projectId, permission) {
				calls.push({ projectId, permission });
				return {};
			},
		});
		const cursor = encodeCapacityPageCursor({ createdAt: '2026-07-17T00:00:00.000Z', id: 'assignment-a' });
		const response = await app.request(`/v1/workdays/workday-a/summary?evidence=assignments&limit=25&cursor=${encodeURIComponent(cursor)}`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, payload });
		expect(calls[0]).toMatchObject({
			workdayId: 'workday-a',
			evidence: 'assignments',
			limit: 25,
			cursor: { id: 'assignment-a' },
		});
		expect(calls[1]).toEqual({ projectId: 'project-a', permission: 'projects:read:team' });
	});

	it('rejects invalid, unscoped, and oversized evidence continuations before persistence', async () => {
		let calls = 0;
		const app = new Hono();
		installCapacityWorkdayRoutes(app, {
			store: { async getWorkdayCapacitySummary() { calls += 1; return null; } } as unknown as CapacityGovernanceDatabase,
			async requireProjectAccess() { return {}; },
		});
		const cursor = encodeCapacityPageCursor({ createdAt: '2026-07-17T00:00:00.000Z', id: 'assignment-a' });
		for (const path of [
			'/v1/workdays/workday-a/summary?evidence=unknown',
			`/v1/workdays/workday-a/summary?cursor=${encodeURIComponent(cursor)}`,
			'/v1/workdays/workday-a/summary?evidence=assignments&limit=201',
		]) {
			const response = await app.request(path);
			expect(response.status).toBe(400);
		}
		expect(calls).toBe(0);
	});
});

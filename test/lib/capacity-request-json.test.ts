import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { CapacityGovernanceError, type CapacityGovernanceDatabase } from '../../src/api/capacity/database.ts';
import { installCapacityOperatorRoutes } from '../../src/api/capacity/routes/operator.ts';
import { readCapacityRequestObject } from '../../src/api/capacity/routes/request-json.ts';
import { installCapacityRoutes } from '../../src/api/capacity/routes/index.ts';

function decoderApp(optional = false) {
	const app = new Hono();
	app.post('/decode', async (c) => {
		try {
			return c.json({ ok: true, payload: await readCapacityRequestObject(c, { optional }) });
		} catch (error) {
			if (error instanceof CapacityGovernanceError) {
				return c.json({ ok: false, code: error.code }, { status: error.status });
			}
			throw error;
		}
	});
	return app;
}

describe('capacity request JSON', () => {
	it('accepts exactly one JSON object and preserves its values', async () => {
		const response = await decoderApp().request('/decode', {
			method: 'POST',
			body: JSON.stringify({ projectId: 'project-a', credits: 2 }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, payload: { projectId: 'project-a', credits: 2 } });
	});

	it('distinguishes an optional empty body from a required body', async () => {
		const optional = await decoderApp(true).request('/decode', { method: 'POST' });
		const required = await decoderApp().request('/decode', { method: 'POST' });
		expect(optional.status).toBe(200);
		expect(await optional.json()).toEqual({ ok: true, payload: {} });
		expect(required.status).toBe(400);
		expect(await required.json()).toMatchObject({ ok: false, code: 'capacity_request_body_required' });
	});

	it('rejects malformed JSON and every non-object JSON root with one stable contract', async () => {
		for (const body of ['{', 'null', '[]', '"value"', '1']) {
			const response = await decoderApp(true).request('/decode', { method: 'POST', body });
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ ok: false, code: 'capacity_request_json_invalid' });
		}
	});

	it('rejects malformed operator mutations before invoking persistence', async () => {
		let writes = 0;
		const store = {
			async createCapacityWorkdayRun() { writes += 1; return {}; },
		} as unknown as CapacityGovernanceDatabase;
		const app = new Hono();
		installCapacityOperatorRoutes(app, {
			store,
			async requireTeamAccess() { return { principal: { id: 'owner-a' } }; },
		});
		const response = await app.request('/v1/teams/team-a/workday-runs', {
			method: 'POST',
			body: '{',
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ ok: false, code: 'capacity_request_json_invalid' });
		expect(writes).toBe(0);
	});

	it('maps strict decoder failures for inline capacity composition routes', async () => {
		const app = new Hono();
		installCapacityRoutes(app, {
			store: {} as CapacityGovernanceDatabase,
			async requireTeamAccess() { return {}; },
			async requireProjectAccess() { return {}; },
			config: { environment: 'test' },
		});
		app.post('/v1/inline-capacity-mutation', async (c) => c.json({
			ok: true,
			payload: await readCapacityRequestObject(c, { optional: true }),
		}));

		const response = await app.request('/v1/inline-capacity-mutation', {
			method: 'POST',
			body: 'null',
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ ok: false, code: 'capacity_request_json_invalid' });
	});
});

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createCapacityProviderAccessMiddleware, type CapacityProviderAccessEnv } from '../../../../../../../../src/api/capacity/provider-access-middleware.ts';

describe('provider bearer extraction unit boundary', () => {
	it('only the original provider bearer grammar reaches authentication and never rewrites the presented secret', async () => {
		const inputs = ['', 'Basic tspa_example', 'Bearer user-token', 'bearer tspa_example', 'Bearer tspa_example'];
		for (const value of inputs) {
			const calls: string[] = [], app = new Hono<CapacityProviderAccessEnv>();
			app.use('*', createCapacityProviderAccessMiddleware({ authenticateAccessToken: async token => { calls.push(token); return null; } }));
			app.get('/', context => context.json({ admitted: Boolean(context.get('capacityProviderAccessAuth')) }));
			expect((await app.request('/', { headers: { authorization: value } })).status).toBe(200);
			expect(calls).toEqual(value === 'Bearer tspa_example' ? ['tspa_example'] : []);
		}
	});
	it('authentication errors never invoke the downstream provider handler or install an admitted identity', async () => {
		let invoked = 0; const app = new Hono<CapacityProviderAccessEnv>();
		app.use('*', createCapacityProviderAccessMiddleware({ authenticateAccessToken: async () => { throw new Error('authentication unavailable'); } }));
		app.onError((_error, context) => context.json({ admitted: Boolean(context.get('capacityProviderAccessAuth')) }, 503));
		app.get('/', context => { invoked += 1; return context.json({ admitted: true }); });
		const response = await app.request('/', { headers: { authorization: 'Bearer tspa_example' } });
		expect(response.status).toBe(503); expect(await response.json()).toEqual({ admitted: false }); expect(invoked).toBe(0);
	});
});

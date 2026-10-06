import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { createOperationHttpHandler } from '../../../../src/api/control-plane/http/operation-http-handler.ts';

it('reports database exhaustion as an actionable unavailable response without exposing backend details', async () => {
	const log = vi.spyOn(console, 'error').mockImplementation(() => {});
	try {
		const app = new Hono();
		app.post('/validate', createOperationHttpHandler({ binding: CONTROL_PLANE_OPERATIONS.seeds.validate,
			handler: async () => { throw Object.assign(new Error('private database connection details'), { code: '53300' }); },
		}, async () => ({ token: 'synthetic', clientId: 'test', scopes: ['treeseed:admin'],
			extra: { principal: { id: 'user', roles: ['platform_admin'], permissions: ['*:*:*'] } } }), 'digest'));
		const response = await app.request('/validate', { method: 'POST', headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ bundle: { schemaVersion: 'treeseed.seed-bundle/v2', name: 'test' } }) });
		expect(response.status).toBe(503);
		const result = await response.json();
		expect(result.code).toBe('database_capacity_unavailable');
		expect(result.detail).toContain('connection budget');
		expect(result.requestId).toBeTruthy();
		expect(JSON.stringify(result)).not.toContain('private database connection details');
	} finally { log.mockRestore(); }
});

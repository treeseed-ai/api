import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import type { BoundOperation } from '../../../../src/api/control-plane/catalog/operation-registry.ts';
import { createOperationHttpHandler } from '../../../../src/api/control-plane/http/operation-http-handler.ts';

describe('catalogued POST read request bodies', () => {
	it('parses the body according to the REST method rather than mutation classification', async () => {
		const operation: BoundOperation<typeof CONTROL_PLANE_OPERATIONS.seeds.validate> = {
			binding: CONTROL_PLANE_OPERATIONS.seeds.validate,
			async handler(value) { return { received: value.body }; },
		};
		const authenticate = async () => ({ token: 'test-token', clientId: 'client-1', scopes: ['treeseed:admin'],
			extra: { principal: { id: 'user-1', roles: ['platform_admin'], permissions: ['*:*:*'] } } });
		const app = new Hono();
		app.post('/v1/seeds/validate', createOperationHttpHandler(operation, authenticate, 'sha256:test'));
		const response = await app.request('/v1/seeds/validate', { method: 'POST', headers: {
			'content-type': 'application/json', authorization: 'Bearer test-token',
		}, body: JSON.stringify({ bundle: { schemaVersion: 'treeseed.seed-bundle/v2', name: 'treeseed' } }) });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ data: { received: { bundle: { schemaVersion: 'treeseed.seed-bundle/v2', name: 'treeseed' } } } });
	});
});

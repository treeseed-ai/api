import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { OperationRegistry } from '../../../../src/api/control-plane/catalog/operation-registry.ts';
import { installControlPlaneProtocolRoutes } from '../../../../src/api/control-plane/http/protocol-routes.ts';
import { generateOpenApi } from '../../../../src/api/control-plane/openapi/generate-openapi.ts';

describe('provider HTTP authentication', () => {
	it('uses provider identity without invoking the OAuth verifier', async () => {
		let oauthCalls = 0;
		const registry = new OperationRegistry([{ binding: CONTROL_PLANE_OPERATIONS.providers.createAvailability,
			handler: async (_input, context) => ({ providerId: (context.providerAuth as any)?.principal?.capacityProviderId }) }]);
		const app = new Hono();
		app.use('/v1/provider/*', async (context, next) => {
			context.set('capacityProviderAccessAuth', { principal: { membershipId: 'membership-1', teamId: 'team-1', capacityProviderId: 'provider-1', scopes: ['provider:availability:write'] } });
			await next();
		});
		installControlPlaneProtocolRoutes(app, async () => { oauthCalls += 1; return null; }, undefined, registry);
		const response = await app.request('/v1/provider/availability-sessions', { method: 'POST',
			headers: { authorization: 'Bearer tspa_test', 'content-type': 'application/json', 'idempotency-key': 'availability-1' }, body: '{}' });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ data: { providerId: 'provider-1' } });
		expect(oauthCalls).toBe(0);
		expect(generateOpenApi(registry).paths['/v1/provider/availability-sessions']?.post).toMatchObject({ security: [{ providerProtocol: [] }] });
	});
});

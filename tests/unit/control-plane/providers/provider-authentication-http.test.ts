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

	it('selects OAuth or provider identity for a hybrid TreeDX operation', async () => {
		let oauthCalls = 0;
		const registry = new OperationRegistry([{ binding: CONTROL_PLANE_OPERATIONS.treedx.repositories.create,
			handler: async (_input, context) => ({ actor: context.providerAuth ? 'provider' : context.principal?.id }) }]);
		const app = new Hono();
		app.use('/v1/dx/*', async (context, next) => {
			if (context.req.header('authorization') === 'Bearer tspa_test') context.set('capacityProviderAccessAuth', {
				principal: { membershipId: 'membership-1', teamId: 'team-1', capacityProviderId: 'provider-1', scopes: ['provider:assignments:write'] },
			});
			await next();
		});
		installControlPlaneProtocolRoutes(app, async (token) => { oauthCalls += 1; return token === 'user-token'
			? { principal: { id: 'user-1', scopes: ['treeseed:projects:write'] }, credential: { id: 'client-1' } } : null; }, undefined, registry);
		const request = (token: string, key: string) => app.request('/v1/dx/projects/project-1/repos', { method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': key }, body: '{}' });
		expect(await (await request('user-token', 'user-key')).json()).toEqual({ data: { actor: 'user-1' } });
		expect(await (await request('tspa_test', 'provider-key')).json()).toEqual({ data: { actor: 'provider' } });
		expect(oauthCalls).toBe(1);
		expect(generateOpenApi(registry).paths['/v1/dx/projects/{projectId}/repos']?.post).toMatchObject({
			security: [{ oauth: ['treeseed:projects:write'] }, { providerProtocol: [] }],
		});
	});
});

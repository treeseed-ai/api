import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { OperationRegistry } from '../../../../src/api/control-plane/catalog/operation-registry.ts';
import { installControlPlaneProtocolRoutes } from '../../../../src/api/control-plane/http/protocol-routes.ts';

describe('MCP authorization equivalence', () => {
	it('enforces the same catalog OAuth scope before REST and MCP handler invocation', async () => {
		let invocations = 0;
		const status = CONTROL_PLANE_OPERATIONS.status.show;
		const registry = new OperationRegistry([{
			binding: { ...status, descriptor: { ...status.descriptor, oauthScopes: ['treeseed:admin'] } },
			async handler() { invocations += 1; return { status: 'ok', mcpProtocolVersion: '2026-07-28' as const }; },
		}]);
		const app = new Hono();
		installControlPlaneProtocolRoutes(app, async () => ({
			principal: { id: 'user_1', scopes: ['treeseed:read'], roles: [], permissions: [] }, credential: { id: 'client_1' },
		}), undefined, registry);
		const rest = await app.request('/v1/status', { headers: { authorization: 'Bearer test-token' } });
		expect(rest.status).toBe(403);
		expect(await rest.json()).toMatchObject({ code: 'oauth_scope_insufficient' });
		const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
			authProvider: { token: async () => 'test-token' },
			fetch: async (input, init) => {
				const request = input instanceof Request ? input : new Request(input, init);
				const headers = new Headers(request.headers);
				headers.set('host', 'localhost');
				return app.fetch(new Request(request, { headers }));
			},
		});
		const client = new Client({ name: 'scope-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
		await client.connect(transport);
		try {
			const toolResult = await client.callTool({ name: 'status.show', arguments: {} });
			expect(toolResult).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringMatching(/treeseed:admin/iu) }] });
			await expect(client.readResource({ uri: 'treeseed://status' })).rejects.toThrow(/treeseed:admin|scope|request failed/iu);
		} finally {
			await client.close();
		}
		expect(invocations).toBe(0);
	});
});

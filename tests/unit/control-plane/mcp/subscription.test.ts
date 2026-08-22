import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { installControlPlaneProtocolRoutes } from '../../../../src/api/control-plane/http/protocol-routes.ts';

function within<T>(label: string, promise: Promise<T>) {
	return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), 3_000))]);
}

describe('modern MCP progress and subscriptions', () => {
	it('streams progress and cancels a resource subscription without a session', async () => {
		const app = new Hono();
		const installed = installControlPlaneProtocolRoutes(app, async () => ({
			principal: { id: 'user-a', scopes: ['treeseed:read'] }, credential: { id: 'client-a' },
		}));
		const client = new Client({ name: 'subscription-test', version: '1.0.0' }, {
			versionNegotiation: { mode: { pin: '2026-07-28' } },
		});
		const progress: number[] = [];
		let updated: ((value: string) => void) | undefined;
		const notification = new Promise<string>((resolve) => { updated = resolve; });
		client.setNotificationHandler('notifications/progress', ({ params }) => { progress.push(params.progress); });
		client.setNotificationHandler('notifications/resources/updated', ({ params }) => { updated?.(params.uri); });
		await within('connect', client.connect(new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
			authProvider: { token: async () => 'test-token' },
			fetch: async (input, init) => {
				const request = input instanceof Request ? input : new Request(input, init);
				const headers = new Headers(request.headers); headers.set('host', 'localhost');
				return app.fetch(new Request(request, { headers }));
			},
		})));
		try {
			await within('progress tool call', client.callTool({ name: 'status.show', arguments: {}, _meta: { progressToken: 'progress-a' } }));
			expect(progress).toEqual([0, 1]);
			const subscription = await within('subscription listen', client.listen({ resourceSubscriptions: ['treeseed://status'] }));
			installed.mcpHandler.notify.resourceUpdated('treeseed://status');
			await expect(within('resource notification', notification)).resolves.toBe('treeseed://status');
			await within('subscription close', subscription.close());
		} finally {
			await client.close();
		}
	});
});

import { Hono } from 'hono';
import { AgentSdk } from '@treeseed/sdk';
import { registerAgentRoutes } from './agent-routes.ts';
import { bearerTokenFromRequest, jsonError } from './http.ts';
import type { GatewayServerOptions } from './types.ts';

export function createTreeseedGatewayApp(options: GatewayServerOptions) {
	const sdk = options.sdk instanceof AgentSdk ? options.sdk : new AgentSdk();
	const app = new Hono();

	app.use('*', async (c, next) => {
		const token = bearerTokenFromRequest(c.req.raw);
		if (token !== options.bearerToken) {
			return jsonError(c, 401, 'Unauthorized gateway request.');
		}
		await next();
	});

	app.get('/healthz', (c) => c.json({ ok: true, service: 'treeseed-agent-gateway' }));

	registerAgentRoutes(app as never, {
		sdk,
		prefix: '',
		scope: null,
		projectId: options.projectId,
		queueProducer: options.queueProducer,
		defaultActor: 'gateway',
	});

	return app;
}

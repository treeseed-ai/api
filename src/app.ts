import crypto from 'node:crypto';
import { AgentSdk, TREESEED_REMOTE_CONTRACT_HEADER, TREESEED_REMOTE_CONTRACT_VERSION } from '@treeseed/sdk';
import { Hono } from 'hono';
import { registerAgentRoutes } from './agent-routes.ts';
import { resolveApiConfig } from './config.ts';
import { bearerTokenFromRequest, jsonError, requireScope } from './http.ts';
import { registerOperationRoutes } from './operations-routes.ts';
import { resolveApiRuntimeProviders } from './providers.ts';
import { registerSdkRoutes } from './sdk-routes.ts';
import { loadTemplateCatalog } from './templates.ts';
import type { ApiServerOptions, AppVariables } from './types.ts';

function mergeApiOptions(options: ApiServerOptions) {
	const baseConfig = resolveApiConfig();
	return {
		config: {
			...baseConfig,
			...(options.config ?? {}),
			providers: {
				...baseConfig.providers,
				...(options.config?.providers ?? {}),
				agents: {
					...baseConfig.providers.agents,
					...(options.config?.providers?.agents ?? {}),
				},
			},
		},
		surfaces: {
			auth: true,
			templates: true,
			sdk: true,
			agent: true,
			operations: true,
			...(options.surfaces ?? {}),
		},
		scopes: {
			authMe: 'auth:me',
			sdk: 'sdk',
			agent: 'agent',
			operations: 'operations',
			...(options.scopes ?? {}),
		},
	};
}

export function createTreeseedApiApp(options: ApiServerOptions = {}) {
	const resolved = mergeApiOptions(options);
	const runtimeProviders = resolveApiRuntimeProviders(resolved.config, options.runtimeProviders);
	const sharedSdk = options.sdk ?? new AgentSdk({ repoRoot: resolved.config.repoRoot });
	const app = new Hono<{ Variables: AppVariables }>();

	app.use('*', async (c, next) => {
		const token = bearerTokenFromRequest(c.req.raw);
		const principal = token ? await runtimeProviders.auth.authenticateBearerToken(token) : null;
		c.set('requestId', crypto.randomUUID());
		c.set('config', resolved.config);
		c.set('principal', principal);
		c.header(TREESEED_REMOTE_CONTRACT_HEADER, String(TREESEED_REMOTE_CONTRACT_VERSION));
		await next();
	});

	app.get('/healthz', (c) => c.json({
		ok: true,
		service: resolved.config.name,
		status: 'ok',
		requestId: c.get('requestId'),
	}));

	app.get('/readyz', (c) => c.json({
		ok: true,
		ready: true,
		providers: runtimeProviders.selections,
		surfaces: resolved.surfaces,
	}));

	if (resolved.surfaces.templates) {
		app.get('/templates', (c) => c.json(loadTemplateCatalog(resolved.config)));
		app.get('/search/templates', (c) => c.json(loadTemplateCatalog(resolved.config)));
		app.get('/templates/:id', (c) => {
			const catalog = loadTemplateCatalog(resolved.config);
			const item = catalog.items.find((entry) => entry.id === c.req.param('id'));
			return item
				? c.json({ ok: true, payload: item })
				: jsonError(c, 404, `Unknown template "${c.req.param('id')}".`);
		});
	}

	if (resolved.surfaces.auth) {
		app.post('/auth/device/start', async (c) => {
			const body = await c.req.json().catch(() => ({}));
			return c.json(await runtimeProviders.auth.startDeviceFlow(body));
		});

		app.post('/auth/device/poll', async (c) => {
			const body = await c.req.json().catch(() => ({}));
			const response = await runtimeProviders.auth.pollDeviceFlow(body);
			return c.json(response, response.ok ? 200 : response.status === 'expired' ? 410 : 400);
		});

		app.post('/auth/device/approve', async (c) => {
			const body = await c.req.json().catch(() => ({}));
			try {
				return c.json(await runtimeProviders.auth.approveDeviceFlow(body));
			} catch (error) {
				return jsonError(c, 400, error instanceof Error ? error.message : String(error));
			}
		});

		app.post('/auth/token/refresh', async (c) => {
			const body = await c.req.json().catch(() => ({}));
			try {
				return c.json(await runtimeProviders.auth.refreshAccessToken(body));
			} catch (error) {
				return jsonError(c, 401, error instanceof Error ? error.message : String(error));
			}
		});

		app.get('/auth/me', (c) => {
			const unauthorized = requireScope(c, resolved.scopes.authMe);
			if (unauthorized) return unauthorized;
			return c.json({
				ok: true,
				payload: c.get('principal'),
			});
		});
	}

	if (resolved.surfaces.sdk) {
		registerSdkRoutes(app, {
			config: resolved.config,
			sharedSdk,
			scope: resolved.scopes.sdk,
		});
	}

	if (resolved.surfaces.agent) {
		registerAgentRoutes(app, {
			sdk: sharedSdk,
			prefix: '/agent',
			scope: resolved.scopes.agent,
			projectId: 'treeseed-market',
			defaultActor: 'api',
		});
	}

	if (resolved.surfaces.operations) {
		registerOperationRoutes(app, { scope: resolved.scopes.operations });
	}

	app.notFound((c) => jsonError(c, 404, 'Not found.'));

	return app;
}

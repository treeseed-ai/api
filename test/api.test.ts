import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentSdk, parseTemplateCatalogResponse } from '../../sdk/src/index.ts';
import { MemoryAgentDatabase } from '../../sdk/src/d1-store.ts';
import { createTreeseedApiApp } from '../src/app.ts';
import { resolveApiConfig } from '../src/config.ts';
import { createTreeseedGatewayApp } from '../src/gateway.ts';

const workspaceRoot = resolve(process.cwd(), '..', '..');

async function json(response: Response) {
	return response.json() as Promise<any>;
}

async function authorizeApp(scopes: string[]) {
	const app = createTreeseedApiApp({
		config: {
			repoRoot: workspaceRoot,
			authSecret: 'test-secret',
		},
	});

	const started = await json(await app.request('/auth/device/start', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ scopes }),
	}));
	await app.request('/auth/device/approve', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			userCode: started.userCode,
			principalId: 'test-user',
			displayName: 'Test User',
			scopes,
		}),
	});
	const tokenPayload = await json(await app.request('/auth/device/poll', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ deviceCode: started.deviceCode }),
	}));

	return {
		app,
		token: tokenPayload.accessToken as string,
	};
}

describe('@treeseed/api', () => {
	it('exposes the expected package exports and no direct core dependency', () => {
		const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as Record<string, any>;
		expect(packageJson.name).toBe('@treeseed/api');
		expect(packageJson.dependencies?.['@treeseed/core']).toBeUndefined();
		expect(packageJson.exports).toMatchObject({
			'.': {
				default: './dist/index.js',
			},
			'./app': {
				default: './dist/app.js',
			},
			'./gateway': {
				default: './dist/gateway.js',
			},
			'./config': {
				default: './dist/config.js',
			},
			'./railway': {
				default: './dist/railway.js',
			},
			'./types': {
				default: './dist/types.js',
			},
		});

		let importMatches = '';
		try {
			importMatches = execFileSync(
				'rg',
				['-n', '@treeseed/core', 'src', 'test', 'README.md', 'package.json'],
				{ cwd: process.cwd(), encoding: 'utf8' },
			).trim();
		} catch {
			importMatches = '';
		}
		expect(importMatches).toBe('');
	});

	it('derives Railway-aware config without contaminating local defaults', () => {
		const config = resolveApiConfig({
			PORT: '4312',
			RAILWAY_PUBLIC_DOMAIN: 'treeseed.up.railway.app',
			TREESEED_API_AUTH_SECRET: 'secret',
		});

		expect(config.port).toBe(4312);
		expect(config.baseUrl).toBe('https://treeseed.up.railway.app');
		expect(config.issuer).toBe('https://treeseed.up.railway.app');
		expect(config.providers.auth).toBe('memory');
	});

	it('serves health, templates, and the agent health surface', async () => {
		const app = createTreeseedApiApp({
			config: {
				repoRoot: workspaceRoot,
				authSecret: 'test-secret',
			},
		});

		const healthResponse = await app.request('/healthz');
		expect(healthResponse.status).toBe(200);
		expect(await json(healthResponse)).toMatchObject({ ok: true, status: 'ok' });

		const templatesResponse = await app.request('/templates');
		expect(templatesResponse.status).toBe(200);
		const templatesPayload = await json(templatesResponse);
		expect(parseTemplateCatalogResponse(templatesPayload).items.length).toBeGreaterThan(0);

		const agentHealthResponse = await app.request('/agent/healthz');
		expect(agentHealthResponse.status).toBe(200);
		expect(await json(agentHealthResponse)).toMatchObject({ ok: true });
	});

	it('runs the device-code lifecycle and injects bearer principals', async () => {
		const app = createTreeseedApiApp({
			config: {
				repoRoot: workspaceRoot,
				authSecret: 'test-secret',
			},
		});

		const started = await json(await app.request('/auth/device/start', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				clientName: 'test-cli',
				scopes: ['auth:me', 'sdk', 'operations', 'agent'],
			}),
		}));

		const pending = await app.request('/auth/device/poll', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ deviceCode: started.deviceCode }),
		});
		expect(pending.status).toBe(200);
		expect(await json(pending)).toMatchObject({ ok: true, status: 'pending' });

		const approved = await app.request('/auth/device/approve', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				userCode: started.userCode,
				principalId: 'user-123',
				displayName: 'CLI User',
				scopes: ['auth:me', 'sdk', 'operations', 'agent'],
			}),
		});
		expect(approved.status).toBe(200);

		const polled = await json(await app.request('/auth/device/poll', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ deviceCode: started.deviceCode }),
		}));
		expect(polled).toMatchObject({
			ok: true,
			status: 'approved',
			tokenType: 'Bearer',
		});

		const me = await app.request('/auth/me', {
			headers: {
				authorization: `Bearer ${polled.accessToken}`,
			},
		});
		expect(me.status).toBe(200);
		expect(await json(me)).toMatchObject({
			ok: true,
			payload: {
				id: 'user-123',
				displayName: 'CLI User',
			},
		});

		const refreshed = await app.request('/auth/token/refresh', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ refreshToken: polled.refreshToken }),
		});
		expect(refreshed.status).toBe(200);
		expect(await json(refreshed)).toMatchObject({ ok: true, tokenType: 'Bearer' });
	});

	it('delegates sdk operations using canonical operation names', async () => {
		const { app, token } = await authorizeApp(['sdk', 'auth:me']);

		const response = await app.request('/sdk/search', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				repoRoot: workspaceRoot,
				input: {
					model: 'page',
					limit: 5,
				},
			}),
		});

		expect(response.status).toBe(200);
		const payload = await json(response);
		expect(payload.ok).toBe(true);
		expect(payload.operation).toBe('search');
		expect(Array.isArray(payload.payload)).toBe(true);
	});

	it('exposes graph query and context-pack sdk operations', async () => {
		const { app, token } = await authorizeApp(['sdk', 'auth:me']);

		const parseResponse = await app.request('/sdk/parseGraphDsl', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				repoRoot: workspaceRoot,
				input: {
					source: 'ctx "market architecture" for plan in /knowledge via related,references depth 1 budget 400 as brief',
				},
			}),
		});
		expect(parseResponse.status).toBe(200);
		const parsePayload = await json(parseResponse);
		expect(parsePayload.query).toMatchObject({ stage: 'plan', view: 'brief' });

		const queryResponse = await app.request('/sdk/queryGraph', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				repoRoot: workspaceRoot,
				input: {
					...(parsePayload.query as Record<string, unknown>),
					options: { ...((parsePayload.query as Record<string, any>).options ?? {}), maxNodes: 5 },
				},
			}),
		});
		expect(queryResponse.status).toBe(200);
		const queryPayload = await json(queryResponse);
		expect(Array.isArray(queryPayload.seedIds)).toBe(true);
		expect(Array.isArray(queryPayload.nodes)).toBe(true);

		const contextResponse = await app.request('/sdk/buildContextPack', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				repoRoot: workspaceRoot,
				input: {
					...(parsePayload.query as Record<string, unknown>),
					options: { ...((parsePayload.query as Record<string, any>).options ?? {}), maxNodes: 5 },
					budget: { maxTokens: 400, includeMode: 'mixed' },
				},
			}),
		});
		expect(contextResponse.status).toBe(200);
		const contextPayload = await json(contextResponse);
		expect(Array.isArray(contextPayload.nodes)).toBe(true);
		expect(typeof contextPayload.totalTokenEstimate).toBe('number');
	});

	it('delegates workflow operations through the shared sdk workflow runtime', async () => {
		const { app, token } = await authorizeApp(['operations', 'auth:me']);

		const response = await app.request('/operations/status', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				cwd: workspaceRoot,
			}),
		});

		expect(response.status).toBe(200);
		const payload = await json(response);
		expect(payload.operation).toBe('status');
		expect(payload.ok).toBe(true);
	});

	it('exposes the agent surface on the main api app', async () => {
		const { app, token } = await authorizeApp(['agent', 'auth:me']);

		const started = await app.request('/agent/workdays/start', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ capacityBudget: 25 }),
		});
		expect(started.status).toBe(200);
		const startedPayload = await json(started);
		const workDayId = startedPayload.payload.id;

		const task = await app.request('/agent/tasks', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				workDayId,
				agentId: 'market-curator',
				type: 'agent_root',
				idempotencyKey: `${workDayId}:market-curator`,
				payload: { hello: 'world' },
			}),
		});
		expect(task.status).toBe(200);
		const taskPayload = await json(task);

		const context = await app.request('/agent/context/resolve-task', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ taskId: taskPayload.payload.id }),
		});
		expect(context.status).toBe(200);
		expect(await json(context)).toMatchObject({
			ok: true,
			payload: {
				task: {
					id: taskPayload.payload.id,
				},
			},
		});

		const graph = await app.request('/agent/graph/parse-dsl', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ source: 'ctx "market architecture" for plan' }),
		});
		expect(graph.status).toBe(200);

		const specs = await app.request('/agent/specs', {
			headers: {
				authorization: `Bearer ${token}`,
			},
		});
		expect(specs.status).toBe(200);
		const specsPayload = await json(specs);
		expect(Array.isArray(specsPayload.payload)).toBe(true);
		expect(Array.isArray(specsPayload.handlers)).toBe(true);
	});

	it('returns stable errors for unsupported operations and missing auth', async () => {
		const app = createTreeseedApiApp({
			config: {
				repoRoot: workspaceRoot,
				authSecret: 'test-secret',
			},
		});

		const unauthorized = await app.request('/sdk/search', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ input: { model: 'page' } }),
		});
		expect(unauthorized.status).toBe(401);

		const { app: authorizedApp, token } = await authorizeApp(['sdk', 'operations']);

		const unsupportedSdk = await authorizedApp.request('/sdk/nope', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ input: {} }),
		});
		expect(unsupportedSdk.status).toBe(400);
		expect(await json(unsupportedSdk)).toMatchObject({ ok: false });

		const unsupportedWorkflow = await authorizedApp.request('/operations/dev', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ cwd: workspaceRoot }),
		});
		expect(unsupportedWorkflow.status).toBe(400);
	});

	it('fails fast on duplicate or missing provider selections', () => {
		expect(() => createTreeseedApiApp({
			config: {
				repoRoot: workspaceRoot,
				authSecret: 'test-secret',
			},
			runtimeProviders: {
				auth: {
					memory: ({ config }) => ({
						id: 'memory',
						startDeviceFlow: async () => ({
							ok: true,
							deviceCode: 'a',
							userCode: 'b',
							verificationUri: config.baseUrl,
							verificationUriComplete: config.baseUrl,
							intervalSeconds: 1,
							expiresAt: new Date().toISOString(),
							expiresInSeconds: 1,
						}),
						pollDeviceFlow: async () => ({ ok: false, status: 'invalid', error: 'bad' }),
						refreshAccessToken: async () => {
							throw new Error('nope');
						},
						approveDeviceFlow: async () => ({ ok: true }),
						authenticateBearerToken: async () => null,
					}),
				},
			},
		})).toThrow(/duplicate auth provider/i);

		expect(() => createTreeseedApiApp({
			config: {
				repoRoot: workspaceRoot,
				authSecret: 'test-secret',
				providers: {
					auth: 'missing',
					agents: {
						execution: 'stub',
						queue: 'memory',
						notification: 'stub',
						repository: 'stub',
						verification: 'stub',
					},
				},
			},
		})).toThrow(/could not resolve auth provider/i);
	});

	it('reuses the shared agent route handlers in the gateway app', async () => {
		const queued: Array<Record<string, unknown>> = [];
		const sdk = new AgentSdk({
			repoRoot: workspaceRoot,
			database: new MemoryAgentDatabase(),
		});
		const app = createTreeseedGatewayApp({
			sdk,
			bearerToken: 'gateway-secret',
			projectId: 'treeseed-market',
			queueProducer: {
				async enqueue(request) {
					queued.push(request.message as unknown as Record<string, unknown>);
				},
			},
		});

		const started = await app.request('/workdays/start', {
			method: 'POST',
			headers: {
				authorization: 'Bearer gateway-secret',
				'content-type': 'application/json',
			},
			body: JSON.stringify({ capacityBudget: 25 }),
		});
		expect(started.status).toBe(200);
		const startedPayload = await json(started);
		const workDayId = startedPayload.payload.id;

		const task = await app.request('/tasks', {
			method: 'POST',
			headers: {
				authorization: 'Bearer gateway-secret',
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				workDayId,
				agentId: 'market-curator',
				type: 'agent_root',
				idempotencyKey: `${workDayId}:market-curator`,
				payload: { hello: 'world' },
			}),
		});
		const taskPayload = await json(task);
		expect(taskPayload.payload.agentId).toBe('market-curator');

		const queuedResponse = await app.request('/queue/enqueue', {
			method: 'POST',
			headers: {
				authorization: 'Bearer gateway-secret',
				'content-type': 'application/json',
			},
			body: JSON.stringify({ taskId: taskPayload.payload.id }),
		});
		expect(queuedResponse.status).toBe(200);
		expect(queued).toHaveLength(1);

		const completed = await app.request(`/tasks/${taskPayload.payload.id}/complete`, {
			method: 'POST',
			headers: {
				authorization: 'Bearer gateway-secret',
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				output: { ok: true },
				summary: { status: 'done' },
			}),
		});
		expect(completed.status).toBe(200);

		const report = await app.request('/reports', {
			method: 'POST',
			headers: {
				authorization: 'Bearer gateway-secret',
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				workDayId,
				kind: 'workday_summary',
				body: { totalTasks: 1 },
			}),
		});
		expect(report.status).toBe(200);
	});
});

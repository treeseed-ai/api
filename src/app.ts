import { AgentSdk } from '@treeseed/sdk/sdk';
import {
	TREESEED_REMOTE_CONTRACT_HEADER,
	TREESEED_REMOTE_CONTRACT_VERSION,
} from '@treeseed/sdk/remote';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { executeHttpWorkflowOperation } from './operations.ts';
import { resolveApiConfig } from './config.ts';
import { resolveApiRuntimeProviders } from './providers.ts';
import { loadTemplateCatalog } from './templates.ts';
import type {
	ApiPrincipal,
	ApiServerOptions,
	ApiConfig,
	SdkHttpOperationRequest,
} from './types.ts';

type AppVariables = {
	requestId: string;
	config: ApiConfig;
	principal: ApiPrincipal | null;
};

const SDK_OPERATION_SCOPE = 'sdk';
const WORKFLOW_OPERATION_SCOPE = 'operations';

function jsonError(c: Context, status: number, error: string, details?: Record<string, unknown>) {
	return c.json({
		ok: false,
		error,
		...(details ?? {}),
	}, status);
}

function bearerTokenFromRequest(request: Request) {
	const header = request.headers.get('authorization');
	if (!header) return null;
	const match = header.match(/^Bearer\s+(.+)$/i);
	return match?.[1] ?? null;
}

function hasScope(principal: ApiPrincipal | null, requiredScope: string) {
	return Boolean(principal && (principal.scopes.includes(requiredScope) || principal.scopes.includes('*')));
}

function withScope(c: Context<{ Variables: AppVariables }>, requiredScope: string) {
	if (!hasScope(c.get('principal'), requiredScope)) {
		return jsonError(c, 401, 'Authentication required.', { requiredScope });
	}
	return null;
}

function resolveSdkInstance(sharedSdk: AgentSdk | undefined, config: ApiConfig, request: SdkHttpOperationRequest) {
	if (!request.repoRoot || request.repoRoot === config.repoRoot) {
		return sharedSdk ?? new AgentSdk({ repoRoot: config.repoRoot });
	}
	return new AgentSdk({ repoRoot: request.repoRoot });
}

async function executeSdkOperation(sdk: AgentSdk, operation: string, input: Record<string, unknown>) {
	switch (operation) {
		case 'get':
			return sdk.get(input as any);
		case 'read':
			return sdk.read(input as any);
		case 'search':
			return sdk.search(input as any);
		case 'follow':
			return sdk.follow(input as any);
		case 'pick':
			return sdk.pick(input as any);
		case 'create':
			return sdk.create(input as any);
		case 'update':
			return sdk.update(input as any);
		case 'claim-message':
		case 'claimMessage':
			return sdk.claimMessage(input as any);
		case 'ack-message':
		case 'ackMessage':
			return sdk.ackMessage(input as any);
		case 'create-message':
		case 'createMessage':
			return sdk.createMessage(input as any);
		case 'record-run':
		case 'recordRun':
			return sdk.recordRun(input as any);
		case 'get-cursor':
		case 'getCursor':
			return sdk.getCursor(input as any);
		case 'upsert-cursor':
		case 'upsertCursor':
			return sdk.upsertCursor(input as any);
		case 'release-lease':
		case 'releaseLease':
			return sdk.releaseLease(input as any);
		case 'release-all-leases':
		case 'releaseAllLeases':
			return sdk.releaseAllLeases();
		case 'start-work-day':
		case 'startWorkDay':
			return sdk.startWorkDay(input as any);
		case 'close-work-day':
		case 'closeWorkDay':
			return sdk.closeWorkDay(input as any);
		case 'create-task':
		case 'createTask':
			return sdk.createTask(input as any);
		case 'claim-task':
		case 'claimTask':
			return sdk.claimTask(input as any);
		case 'record-task-progress':
		case 'recordTaskProgress':
			return sdk.recordTaskProgress(input as any);
		case 'complete-task':
		case 'completeTask':
			return sdk.completeTask(input as any);
		case 'fail-task':
		case 'failTask':
			return sdk.failTask(input as any);
		case 'append-task-event':
		case 'appendTaskEvent':
			return sdk.appendTaskEvent(input as any);
		case 'search-tasks':
		case 'searchTasks':
			return sdk.searchTasks(input as any);
		case 'get-manager-context':
		case 'getManagerContext':
			return sdk.getManagerContext(String(input.taskId ?? input.id ?? ''));
		case 'create-report':
		case 'createReport':
			return sdk.createReport(input as any);
		case 'list-agent-specs':
		case 'listAgentSpecs':
			return sdk.listAgentSpecs(input as any);
		case 'refresh-graph':
		case 'refreshGraph':
			return sdk.refreshGraph(input as any);
		case 'search-files':
		case 'searchFiles':
			return sdk.searchFiles(String(input.query ?? ''), input.options as any);
		case 'search-sections':
		case 'searchSections':
			return sdk.searchSections(String(input.query ?? ''), input.options as any);
		case 'search-entities':
		case 'searchEntities':
			return sdk.searchEntities(String(input.query ?? ''), input.options as any);
		case 'get-graph-node':
		case 'getGraphNode':
			return sdk.getGraphNode(String(input.id ?? ''));
		case 'get-neighbors':
		case 'getNeighbors':
			return sdk.getNeighbors(String(input.id ?? ''), input.options as any);
		case 'follow-references':
		case 'followReferences':
			return sdk.followReferences(String(input.id ?? ''), input.options as any);
		case 'get-backlinks':
		case 'getBacklinks':
			return sdk.getBacklinks(String(input.id ?? ''), input.options as any);
		case 'get-related':
		case 'getRelated':
			return sdk.getRelated(String(input.id ?? ''), input.options as any);
		case 'get-subgraph':
		case 'getSubgraph':
			return sdk.getSubgraph(Array.isArray(input.seedIds) ? input.seedIds.map(String) : [], input.options as any);
		case 'resolve-seeds':
		case 'resolveSeeds':
			return sdk.resolveSeeds(input as any);
		case 'query-graph':
		case 'queryGraph':
			return sdk.queryGraph(input as any);
		case 'build-context-pack':
		case 'buildContextPack':
			return sdk.buildContextPack(input as any);
		case 'parse-graph-dsl':
		case 'parseGraphDsl':
			return sdk.parseGraphDsl(String(input.source ?? input.query ?? ''));
		case 'resolve-reference':
		case 'resolveReference':
			return sdk.resolveReference(String(input.reference ?? ''), input.options as any);
		case 'explain-reference-chain':
		case 'explainReferenceChain':
			return sdk.explainReferenceChain(String(input.fromId ?? ''), String(input.toId ?? ''));
		default:
			throw new Error(`Unsupported SDK operation "${operation}".`);
	}
}

export function createTreeseedApiApp(options: ApiServerOptions = {}) {
	const baseConfig = resolveApiConfig();
	const config = {
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
	};
	const runtimeProviders = resolveApiRuntimeProviders(config, options.runtimeProviders);
	const sharedSdk = options.sdk ?? new AgentSdk({ repoRoot: config.repoRoot });
	const app = new Hono<{ Variables: AppVariables }>();

	app.use('*', async (c, next) => {
		const token = bearerTokenFromRequest(c.req.raw);
		const principal = token ? await runtimeProviders.auth.authenticateBearerToken(token) : null;
		c.set('requestId', crypto.randomUUID());
		c.set('config', config);
		c.set('principal', principal);
		c.header(TREESEED_REMOTE_CONTRACT_HEADER, String(TREESEED_REMOTE_CONTRACT_VERSION));
		await next();
	});

	app.get('/healthz', (c) => c.json({
		ok: true,
		service: config.name,
		status: 'ok',
		requestId: c.get('requestId'),
	}));

	app.get('/readyz', (c) => c.json({
		ok: true,
		ready: true,
		providers: runtimeProviders.selections,
	}));

	app.get('/templates', (c) => c.json(loadTemplateCatalog(config)));
	app.get('/search/templates', (c) => c.json(loadTemplateCatalog(config)));

	app.get('/templates/:id', (c) => {
		const catalog = loadTemplateCatalog(config);
		const item = catalog.items.find((entry) => entry.id === c.req.param('id'));
		return item
			? c.json({ ok: true, payload: item })
			: jsonError(c, 404, `Unknown template "${c.req.param('id')}".`);
	});

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
		const unauthorized = withScope(c, 'auth:me');
		if (unauthorized) return unauthorized;
		return c.json({
			ok: true,
			payload: c.get('principal'),
		});
	});

	app.post('/sdk/:operation', async (c) => {
		const unauthorized = withScope(c, SDK_OPERATION_SCOPE);
		if (unauthorized) return unauthorized;

		const operation = c.req.param('operation');
		const body = await c.req.json().catch(() => ({})) as SdkHttpOperationRequest;
		try {
			const result = await executeSdkOperation(
				resolveSdkInstance(sharedSdk, config, body),
				operation,
				body.input ?? {},
			);
			return c.json(result);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const status = /Unsupported SDK operation/.test(message) ? 400 : 500;
			return jsonError(c, status, message, { operation });
		}
	});

	app.post('/operations/:operation', async (c) => {
		const unauthorized = withScope(c, WORKFLOW_OPERATION_SCOPE);
		if (unauthorized) return unauthorized;

		const body = await c.req.json().catch(() => ({}));
		const operation = c.req.param('operation');
		try {
			const result = await executeHttpWorkflowOperation(operation, body);
			return c.json(result, result.ok ? 200 : 400);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const status = /Unsupported workflow operation|not supported over HTTP|confirmation required/i.test(message) ? 400 : 500;
			return jsonError(c, status, message, { operation });
		}
	});

	app.all('/agents', (c) => jsonError(c, 501, 'Agent API endpoints are reserved for a later phase.'));
	app.all('/agents/*', (c) => jsonError(c, 501, 'Agent API endpoints are reserved for a later phase.'));

	app.notFound((c) => jsonError(c, 404, 'Not found.'));

	return app;
}

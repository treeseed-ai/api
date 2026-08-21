import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { CONTROL_PLANE_OPERATION_SCHEMA_VERSION } from '@treeseed/sdk/operator-contracts';
import { z } from 'zod';
import { controlPlaneOperations, createApiControlPlaneOperations } from '../../../src/api/control-plane/catalog/index.ts';
import { OperationRegistry, type BoundOperation } from '../../../src/api/control-plane/catalog/operation-registry.ts';
import { installControlPlaneProtocolRoutes } from '../../../src/api/control-plane/http/protocol-routes.ts';
import { generateOpenApi, openApiDigest } from '../../../src/api/control-plane/openapi/generate-openapi.ts';

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

describe('control-plane protocol contract', () => {
	const authenticate = async (token: string) => token === 'test-token' ? {
		principal: { id: 'user_1', scopes: ['treeseed:read'], roles: [], permissions: [] },
		credential: { id: 'client_1' },
	} : null;
	const oauthProvider = {
		async startDeviceFlow() {
			return { deviceCode: 'device-code', userCode: 'ABCD-EFGH', verificationUri: 'http://localhost/approve', verificationUriComplete: 'http://localhost/approve?user_code=ABCD-EFGH', intervalSeconds: 5, expiresInSeconds: 600 };
		},
		async pollDeviceFlow({ deviceCode }: { deviceCode: string }) {
			if (deviceCode === 'pending') return { status: 'pending', intervalSeconds: 5 };
			return { status: 'approved', accessToken: 'access', refreshToken: 'refresh', tokenType: 'Bearer', expiresInSeconds: 900, principal: { scopes: ['treeseed:read'] } };
		},
		async refreshAccessToken() {
			return { accessToken: 'access-2', refreshToken: 'refresh-2', tokenType: 'Bearer', expiresInSeconds: 900, principal: { scopes: ['treeseed:read'] } };
		},
	};
	const operationStore = (overrides: Record<string, unknown> = {}) => ({
		async ensureInitialized() {},
		async first() { return { ok: 1 }; },
		async listProjectsForPrincipal() { return []; },
		async listTeamProjects() { return []; },
		async principalCanAccessTeam() { return true; },
		...overrides,
	});

	it('binds status to one catalog operation and deterministic OpenAPI 3.1.1', () => {
		const operation = controlPlaneOperations.require('status.show');
		expect(operation.descriptor.surfaces).toEqual(expect.arrayContaining(['rest', 'cli', 'mcp_tool', 'mcp_resource']));
		const first = generateOpenApi(controlPlaneOperations);
		const second = generateOpenApi(controlPlaneOperations);
		expect(first.openapi).toBe('3.1.1');
		expect(first.paths['/v1/status']?.get).toMatchObject({ operationId: 'status.show' });
		expect(first.components.securitySchemes.oauth).toMatchObject({ type: 'http', scheme: 'bearer', bearerFormat: 'opaque' });
		expect(first.components.securitySchemes.oauth).not.toHaveProperty('flows');
		expect(openApiDigest(first)).toBe(openApiDigest(second));
	});

	it('serves the shared REST projection and contract digest', async () => {
		const app = new Hono();
		installControlPlaneProtocolRoutes(app, authenticate);
		const status = await app.request('/v1/status', { headers: { authorization: 'Bearer test-token' } });
		expect(status.status).toBe(200);
		expect(await status.json()).toEqual({ data: expect.objectContaining({ status: 'ok', mcpProtocolVersion: '2026-07-28' }) });
		const specification = await app.request('/openapi.json');
		expect(specification.headers.get('x-treeseed-contract-digest')).toMatch(/^sha256:[a-f0-9]{64}$/u);
		const mcpCatalog = await app.request('/mcp/catalog.json');
		expect(mcpCatalog.headers.get('x-treeseed-contract-digest')).toMatch(/^sha256:[a-f0-9]{64}$/u);
	});

	it('binds dependency-backed deep health directly through the catalog', async () => {
		const app = new Hono();
		const registry = createApiControlPlaneOperations({ store: operationStore() });
		installControlPlaneProtocolRoutes(app, authenticate, oauthProvider, registry);
		const response = await app.request('/healthz/deep');
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ data: { status: 'ok', checks: { database: true } } });
		const specification = await app.request('/openapi.json');
		expect((await specification.json() as any).paths['/healthz/deep'].get.operationId).toBe('health.deep');
		const unavailableApp = new Hono();
		const unavailable = createApiControlPlaneOperations({ store: operationStore({ async ensureInitialized() { throw new Error('private database detail'); } }) });
		installControlPlaneProtocolRoutes(unavailableApp, authenticate, oauthProvider, unavailable);
		const failed = await unavailableApp.request('/healthz/deep');
		const failedText = await failed.text();
		expect(failed.status).toBe(503);
		expect(failed.headers.get('content-type')).toContain('application/problem+json');
		expect(JSON.parse(failedText)).toMatchObject({ status: 503, code: 'control_plane_database_unavailable' });
		expect(failedText).not.toContain('private database detail');
	});

	it('enforces mutation idempotency and concurrency through the shared operation adapter', async () => {
		const calls: Array<{ input: unknown; requestId: string; traceparent?: string }> = [];
		const input = z.object({ projectId: z.string().min(1), name: z.string().min(1) }).strict();
		const output = z.object({ projectId: z.string(), name: z.string(), revision: z.number().int() }).strict();
		const operation: BoundOperation<z.infer<typeof input>, z.infer<typeof output>> = {
			descriptor: {
				schemaVersion: CONTROL_PLANE_OPERATION_SCHEMA_VERSION,
				operationId: 'projects.update',
				description: 'Update a project through the shared operation adapter.',
				rest: { method: 'PATCH', path: '/v1/projects/:projectId' },
				schemas: { input: 'treeseed.projects.update.input/v1', output: 'treeseed.projects.update.output/v1', errors: 'treeseed.problem/v1' },
				capability: 'projects.write', oauthScopes: ['treeseed:projects:write'], kind: 'mutation', riskClass: 'ordinary', confirmation: 'never',
				idempotency: { required: true, header: 'Idempotency-Key' },
				concurrency: { required: true, readHeader: 'ETag', writeHeader: 'If-Match' },
				surfaces: ['rest'], cacheScope: 'private', pagination: 'none', audited: true, receipt: true, redactedPaths: [],
			},
			inputSchema: input,
			outputSchema: output,
			async handler(value, context) {
				calls.push({ input: value, requestId: context.requestId, traceparent: context.traceparent });
				return { ...value, revision: 2 };
			},
		};
		const app = new Hono();
		installControlPlaneProtocolRoutes(app, async () => ({ principal: { id: 'user_1', scopes: ['treeseed:projects:write'] }, credential: { id: 'client_1' } }), oauthProvider, new OperationRegistry([operation]));
		const headers = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
		const missingIdempotency = await app.request('/v1/projects/project-a', { method: 'PATCH', headers, body: JSON.stringify({ name: 'Example' }) });
		const missingIdempotencyProblem = await missingIdempotency.json();
		expect({ status: missingIdempotency.status, body: missingIdempotencyProblem }).toMatchObject({ status: 400, body: { code: 'idempotency_key_required' } });
		const missingConcurrency = await app.request('/v1/projects/project-a', { method: 'PATCH', headers: { ...headers, 'idempotency-key': 'attempt-1' }, body: JSON.stringify({ name: 'Example' }) });
		expect(missingConcurrency.status).toBe(412);
		expect(await missingConcurrency.json()).toMatchObject({ code: 'precondition_required' });
		const accepted = await app.request('/v1/projects/project-a', {
			method: 'PATCH',
			headers: { ...headers, 'idempotency-key': 'attempt-1', 'if-match': '"revision-1"', 'x-request-id': 'request-1', traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01' },
			body: JSON.stringify({ name: 'Example' }),
		});
		expect(accepted.status).toBe(200);
		expect(accepted.headers.get('etag')).toMatch(/^"sha256:[a-f0-9]{64}"$/u);
		expect(await accepted.json()).toEqual({ data: { projectId: 'project-a', name: 'Example', revision: 2 } });
		expect(calls).toEqual([{ input: { projectId: 'project-a', name: 'Example' }, requestId: 'request-1', traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01' }]);
	});

	it('lists only visible team projects through the shared REST and MCP operation', async () => {
		const registry = createApiControlPlaneOperations({ store: operationStore({
			async listTeamProjects() {
				return [{ id: 'active', metadata: {} }, { id: 'archived', metadata: { inventory: { status: 'archived' } } }];
			},
		}) });
		const app = new Hono();
		installControlPlaneProtocolRoutes(app, authenticate, oauthProvider, registry);
		const response = await app.request('/v1/projects?teamId=team-a', { headers: { authorization: 'Bearer test-token' } });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ data: { projects: [{ id: 'active', metadata: {} }] } });
		const specification = await app.request('/openapi.json');
		expect((await specification.json() as any).paths['/v1/projects'].get.operationId).toBe('projects.list');
		const catalog = await app.request('/mcp/catalog.json');
		expect((await catalog.json() as any).tools.map((tool: { name: string }) => tool.name)).toContain('projects.list');
		const adminApp = new Hono();
		const adminRegistry = createApiControlPlaneOperations({ store: operationStore({ async principalCanAccessTeam() { return false; } }) });
		installControlPlaneProtocolRoutes(adminApp, async () => ({ principal: { id: 'admin', scopes: ['treeseed:read'], roles: ['admin'], permissions: [] }, credential: { id: 'admin-client' } }), oauthProvider, adminRegistry);
		expect((await adminApp.request('/v1/projects?teamId=team-a', { headers: { authorization: 'Bearer admin' } })).status).toBe(200);
		const deniedApp = new Hono();
		const deniedRegistry = createApiControlPlaneOperations({ store: operationStore({ async principalCanAccessTeam() { return false; } }) });
		installControlPlaneProtocolRoutes(deniedApp, authenticate, oauthProvider, deniedRegistry);
		const denied = await deniedApp.request('/v1/projects?teamId=team-a', { headers: { authorization: 'Bearer test-token' } });
		expect(denied.status).toBe(403);
		expect(await denied.json()).toMatchObject({ code: 'team_access_denied' });
	});

	it('publishes truthful OAuth resource metadata and RFC 8628 device exchange', async () => {
		const app = new Hono();
		installControlPlaneProtocolRoutes(app, authenticate, oauthProvider);
		const resource = await app.request('/.well-known/oauth-protected-resource/mcp');
		expect(await resource.json()).toMatchObject({ resource: 'http://localhost/mcp', authorization_servers: ['http://localhost'] });
		const server = await app.request('/.well-known/oauth-authorization-server');
		const metadata = await server.json() as any;
		expect(metadata.grant_types_supported).toEqual([DEVICE_GRANT, 'refresh_token']);
		expect(metadata).not.toHaveProperty('authorization_endpoint');
		const started = await app.request('/oauth/device_authorization', {
			method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: 'client_id=trsd&scope=treeseed%3Aread',
		});
		expect(await started.json()).toMatchObject({ device_code: 'device-code', user_code: 'ABCD-EFGH', expires_in: 600 });
		const pending = await app.request('/oauth/token', {
			method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: `client_id=trsd&grant_type=${encodeURIComponent(DEVICE_GRANT)}&device_code=pending`,
		});
		expect(pending.status).toBe(400);
		expect(await pending.json()).toMatchObject({ error: 'authorization_pending' });
		const approved = await app.request('/oauth/token', {
			method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: `client_id=trsd&grant_type=${encodeURIComponent(DEVICE_GRANT)}&device_code=device-code`,
		});
		expect(await approved.json()).toMatchObject({ access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', scope: 'treeseed:read' });
		expect(approved.headers.get('cache-control')).toBe('no-store');
		const unregistered = await app.request('/oauth/device_authorization', {
			method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'client_id=unknown',
		});
		expect(unregistered.status).toBe(401);
		expect(await unregistered.json()).toMatchObject({ error: 'invalid_client' });
	});

	it('rejects legacy MCP initialization traffic', async () => {
		const app = new Hono();
		installControlPlaneProtocolRoutes(app, authenticate);
		const response = await app.request('/mcp', {
			method: 'POST',
			headers: { authorization: 'Bearer test-token', 'content-type': 'application/json', host: 'localhost' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'legacy', version: '1' } } }),
		});
		const body = await response.text();
		expect(body).toContain('Unsupported protocol version');
		expect(body).toContain('2026-07-28');
	});

	it('serves discovery and tools through the official modern client', async () => {
		const app = new Hono();
		installControlPlaneProtocolRoutes(app, authenticate);
		const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
			authProvider: { token: async () => 'test-token' },
			fetch: async (input, init) => {
				const request = input instanceof Request ? input : new Request(input, init);
				const headers = new Headers(request.headers);
				headers.set('host', 'localhost');
				return app.fetch(new Request(request, { headers }));
			},
		});
		const client = new Client({ name: 'contract-test', version: '1.0.0' }, {
			versionNegotiation: { mode: { pin: '2026-07-28' } },
		});
		await client.connect(transport);
		try {
			const tools = await client.listTools();
			expect(tools.tools.map((tool) => tool.name)).toContain('status.show');
			const result = await client.callTool({ name: 'status.show', arguments: {} });
			expect(result.structuredContent).toEqual(expect.objectContaining({ status: 'ok' }));
			const resources = await client.listResources();
			expect(resources.resources.map((resource) => resource.uri)).toContain('treeseed://status');
			const statusResource = await client.readResource({ uri: 'treeseed://status' });
			expect(statusResource.contents[0]).toMatchObject({ uri: 'treeseed://status', mimeType: 'application/json' });
			const prompts = await client.listPrompts();
			expect(prompts.prompts.map((prompt) => prompt.name)).toEqual(expect.arrayContaining(['operate', 'research', 'governance-review', 'workday-planning', 'project-agent-chat']));
			const prompt = await client.getPrompt({ name: 'operate', arguments: { objective: 'Inspect status.' } });
			expect(prompt.messages[0]?.content).toMatchObject({ type: 'text' });
		} finally {
			await client.close();
		}
	});
});

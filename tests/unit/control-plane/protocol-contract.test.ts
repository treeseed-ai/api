import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
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
		async listTeamsForPrincipal() { return []; },
		async loadTeamProfileByName() { return null; },
		async getTeam(teamId: string) { return { id: teamId, name: 'TreeSeed' }; },
		async principalCanAccessTeam() { return true; },
		async getTeamAccessSummary(teamId: string) { return { teamId, roles: ['project_lead'] }; },
		async resolvePrincipalTeamContext() { return { roles: ['project_lead'] }; },
		async listTeamMembers() { return []; },
		async listTeamInvites() { return []; },
		async getProjectDetails(projectId: string) { return { project: { id: projectId, teamId: 'team-a', slug: 'sdk', metadata: {} }, repositories: [] }; },
		async getProjectAccessSummary(projectId: string) { return { projectId, access: 'member' }; },
		async getProjectSummary(projectId: string) { return { projectId, status: 'active' }; },
		async principalCanManageTeam() { return true; },
		async createProject(teamId: string, input: Record<string, unknown>) { return { id: 'project-new', teamId, ...input }; },
		async updateProject(projectId: string, input: Record<string, unknown>) { return { id: projectId, ...input }; },
		async run() {},
		async recordAuditEvent() {},
		...overrides,
	});
	const apiDependencies = (overrides: Record<string, unknown> = {}) => ({
		store: operationStore(overrides),
		capacity: { async evaluateProjectDeletionBlockers() { return []; } },
	});

	it('binds status to one catalog operation and deterministic OpenAPI 3.1.1', () => {
		const operation = controlPlaneOperations.require('status.show');
		expect(operation.binding.descriptor.surfaces).toEqual(expect.arrayContaining(['rest', 'cli', 'mcp_tool', 'mcp_resource']));
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
		const registry = createApiControlPlaneOperations(apiDependencies());
		installControlPlaneProtocolRoutes(app, authenticate, oauthProvider, registry);
		const response = await app.request('/v1/health/deep');
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ data: { status: 'ok', checks: { database: true } } });
		const specification = await app.request('/openapi.json');
		expect((await specification.json() as any).paths['/v1/health/deep'].get.operationId).toBe('health.deep');
		const unavailableApp = new Hono();
		const unavailable = createApiControlPlaneOperations(apiDependencies({ async ensureInitialized() { throw new Error('private database detail'); } }));
		installControlPlaneProtocolRoutes(unavailableApp, authenticate, oauthProvider, unavailable);
		const failed = await unavailableApp.request('/v1/health/deep');
		const failedText = await failed.text();
		expect(failed.status).toBe(503);
		expect(failed.headers.get('content-type')).toContain('application/problem+json');
		expect(JSON.parse(failedText)).toMatchObject({ status: 503, code: 'control_plane_database_unavailable' });
		expect(failedText).not.toContain('private database detail');
	});

	it('binds the readiness probe through the same catalog and database check', async () => {
		const app = new Hono();
		const registry = createApiControlPlaneOperations(apiDependencies());
		installControlPlaneProtocolRoutes(app, authenticate, oauthProvider, registry);
		const response = await app.request('/v1/health/ready');
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ data: { status: 'ok', checks: { database: true } } });
		const specification = await app.request('/openapi.json');
		expect((await specification.json() as any).paths['/v1/health/ready'].get.operationId).toBe('health.ready');
	});

	it('serves the current account through the SDK-owned operation binding', async () => {
		const app = new Hono();
		const registry = createApiControlPlaneOperations(apiDependencies({
			async listTeamsForPrincipal() { return [{ id: 'team-a', name: 'TreeSeed' }]; },
		}));
		installControlPlaneProtocolRoutes(app, authenticate, oauthProvider, registry);
		const response = await app.request('/v1/me', { headers: { authorization: 'Bearer test-token' } });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ data: { principal: expect.objectContaining({ id: 'user_1' }), teams: [{ id: 'team-a', name: 'TreeSeed' }] } });
		expect(registry.require('accounts.current.show').binding).toBe(CONTROL_PLANE_OPERATIONS.accounts.current);
	});

	it('serves team discovery through SDK-owned operation bindings', async () => {
		const app = new Hono();
		const registry = createApiControlPlaneOperations(apiDependencies({
			async listTeamsForPrincipal() { return [{ id: 'team-a', name: 'TreeSeed' }]; },
			async loadTeamProfileByName(name: string) { return name === 'treeseed' ? { id: 'team-a', name: 'TreeSeed' } : null; },
		}));
		installControlPlaneProtocolRoutes(app, authenticate, oauthProvider, registry);
		const headers = { authorization: 'Bearer test-token' };
		expect(await (await app.request('/v1/teams', { headers })).json()).toEqual({ data: { teams: [{ id: 'team-a', name: 'TreeSeed' }] } });
		expect(await (await app.request('/v1/teams/by-name/treeseed/profile', { headers })).json()).toEqual({ data: { id: 'team-a', name: 'TreeSeed' } });
		expect((await app.request('/v1/teams/by-name/missing/profile', { headers })).status).toBe(404);
		expect(registry.require('teams.list').binding).toBe(CONTROL_PLANE_OPERATIONS.teams.list);
		expect(registry.require('teams.profile.show').binding).toBe(CONTROL_PLANE_OPERATIONS.teams.profile);
	});

	it('serves team access, members, and invites through SDK-owned operation bindings', async () => {
		const app = new Hono();
		const registry = createApiControlPlaneOperations(apiDependencies({
			async listTeamMembers() { return [{ id: 'member-1', displayName: 'Adrian', roles: ['team_owner'] }]; },
			async listTeamInvites() { return [{ id: 'invite-1', email: 'member@example.test' }]; },
		}));
		installControlPlaneProtocolRoutes(app, authenticate, oauthProvider, registry);
		const headers = { authorization: 'Bearer test-token' };
		expect(await (await app.request('/v1/teams/team-a/access', { headers })).json()).toEqual({ data: {
			team: { id: 'team-a', name: 'TreeSeed' }, access: { teamId: 'team-a', roles: ['project_lead'] },
		} });
		expect(await (await app.request('/v1/teams/team-a/members?limit=1', { headers })).json()).toEqual({ data: {
			items: [{ id: 'member-1', displayName: 'Adrian', roles: ['team_owner'] }], total: 1, ownerCount: 1, cursor: null,
		} });
		expect(await (await app.request('/v1/teams/team-a/invites', { headers })).json()).toEqual({ data: {
			items: [{ id: 'invite-1', email: 'member@example.test' }], total: 1, cursor: null,
		} });
		expect(registry.require('teams.access.show').binding).toBe(CONTROL_PLANE_OPERATIONS.teams.access);
		expect(registry.require('teams.members.list').binding).toBe(CONTROL_PLANE_OPERATIONS.teams.members);
		expect(registry.require('teams.invites.list').binding).toBe(CONTROL_PLANE_OPERATIONS.teams.invites);
	});

	it('enforces mutation idempotency and concurrency through the shared operation adapter', async () => {
		const calls: Array<{ input: unknown; requestId: string; traceparent?: string }> = [];
		const operation: BoundOperation<typeof CONTROL_PLANE_OPERATIONS.projects.update> = {
			binding: CONTROL_PLANE_OPERATIONS.projects.update,
			async handler(value, context) {
				calls.push({ input: value, requestId: context.requestId, traceparent: context.traceparent });
				return { projectId: value.path.projectId, ...value.body, revision: 2 };
			},
		};
		const app = new Hono();
		installControlPlaneProtocolRoutes(app, async () => ({ principal: { id: 'user_1', scopes: ['treeseed:projects:write'] }, credential: { id: 'client_1' } }), oauthProvider, new OperationRegistry([operation]));
		const headers = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
		const missingIdempotency = await app.request('/v1/projects/project-a', { method: 'PUT', headers, body: JSON.stringify({ name: 'Example' }) });
		const missingIdempotencyProblem = await missingIdempotency.json();
		expect({ status: missingIdempotency.status, body: missingIdempotencyProblem }).toMatchObject({ status: 400, body: { code: 'idempotency_key_required' } });
		const missingConcurrency = await app.request('/v1/projects/project-a', { method: 'PUT', headers: { ...headers, 'idempotency-key': 'attempt-1' }, body: JSON.stringify({ name: 'Example' }) });
		expect(missingConcurrency.status).toBe(412);
		expect(await missingConcurrency.json()).toMatchObject({ code: 'precondition_required' });
		const accepted = await app.request('/v1/projects/project-a', {
			method: 'PUT',
			headers: { ...headers, 'idempotency-key': 'attempt-1', 'if-match': '"revision-1"', 'x-request-id': 'request-1', traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01' },
			body: JSON.stringify({ name: 'Example' }),
		});
		expect(accepted.status).toBe(200);
		expect(accepted.headers.get('etag')).toMatch(/^"sha256:[a-f0-9]{64}"$/u);
		expect(await accepted.json()).toEqual({ data: { projectId: 'project-a', name: 'Example', revision: 2 } });
		expect(calls).toEqual([{ input: { path: { projectId: 'project-a' }, query: {}, body: { name: 'Example' } }, requestId: 'request-1', traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01' }]);
	});

	it('lists only visible team projects through the shared REST and MCP operation', async () => {
		const registry = createApiControlPlaneOperations(apiDependencies({
			async listTeamProjects() {
				return [{ id: 'active', metadata: {} }, { id: 'archived', metadata: { inventory: { status: 'archived' } } }];
			},
		}));
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
		const adminRegistry = createApiControlPlaneOperations(apiDependencies({ async principalCanAccessTeam() { return false; } }));
		installControlPlaneProtocolRoutes(adminApp, async () => ({ principal: { id: 'admin', scopes: ['treeseed:read'], roles: ['admin'], permissions: [] }, credential: { id: 'admin-client' } }), oauthProvider, adminRegistry);
		expect((await adminApp.request('/v1/projects?teamId=team-a', { headers: { authorization: 'Bearer admin' } })).status).toBe(200);
		const deniedApp = new Hono();
		const deniedRegistry = createApiControlPlaneOperations(apiDependencies({ async principalCanAccessTeam() { return false; } }));
		installControlPlaneProtocolRoutes(deniedApp, authenticate, oauthProvider, deniedRegistry);
		const denied = await deniedApp.request('/v1/projects?teamId=team-a', { headers: { authorization: 'Bearer test-token' } });
		expect(denied.status).toBe(403);
		expect(await denied.json()).toMatchObject({ code: 'team_access_denied' });
	});

	it('serves project identity, access, and summary through SDK-owned bindings', async () => {
		const app = new Hono();
		const registry = createApiControlPlaneOperations(apiDependencies());
		installControlPlaneProtocolRoutes(app, authenticate, oauthProvider, registry);
		const headers = { authorization: 'Bearer test-token' };
		expect(await (await app.request('/v1/projects/project-a', { headers })).json()).toMatchObject({ data: { project: { id: 'project-a' } } });
		expect(await (await app.request('/v1/projects/project-a/access', { headers })).json()).toEqual({ data: { projectId: 'project-a', access: 'member' } });
		expect(await (await app.request('/v1/projects/project-a/summary', { headers })).json()).toEqual({ data: { projectId: 'project-a', status: 'active' } });
		expect(registry.require('projects.show').binding).toBe(CONTROL_PLANE_OPERATIONS.projects.show);
		expect(registry.require('projects.access.show').binding).toBe(CONTROL_PLANE_OPERATIONS.projects.access);
		expect(registry.require('projects.summary.show').binding).toBe(CONTROL_PLANE_OPERATIONS.projects.summary);
	});

	it('routes project lifecycle mutations through SDK-owned bindings', async () => {
		const app = new Hono();
		const registry = createApiControlPlaneOperations(apiDependencies());
		installControlPlaneProtocolRoutes(app, async () => ({
			principal: { id: 'user_1', scopes: ['treeseed:read', 'treeseed:projects:write'], roles: ['admin'], permissions: [] },
			credential: { id: 'client_1' },
		}), oauthProvider, registry);
		const mutationHeaders = { authorization: 'Bearer test-token', 'content-type': 'application/json', 'idempotency-key': 'project-lifecycle-1' };
		const created = await app.request('/v1/teams/team-a/projects', { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ slug: 'new', name: 'New Project' }) });
		expect(created.status).toBe(200);
		expect(await created.json()).toMatchObject({ data: { id: 'project-new', teamId: 'team-a', slug: 'new' } });
		const archive = await app.request('/v1/projects/project-a/archive', { method: 'POST', headers: { ...mutationHeaders, 'if-match': '"project-a"' }, body: '{}' });
		expect(archive.status).toBe(200);
		const blockers = await app.request('/v1/projects/project-a/deletion-blockers', { headers: { authorization: 'Bearer test-token' } });
		expect(await blockers.json()).toEqual({ data: { blockers: [] } });
		const removed = await app.request('/v1/projects/project-a', { method: 'DELETE', headers: { ...mutationHeaders, 'if-match': '"project-a"' }, body: JSON.stringify({ confirmation: 'DELETE sdk' }) });
		expect(removed.status).toBe(200);
		expect(await removed.json()).toEqual({ data: { id: 'project-a', deleted: true } });
		expect(registry.require('projects.create').binding).toBe(CONTROL_PLANE_OPERATIONS.projects.create);
		expect(registry.require('projects.archive').binding).toBe(CONTROL_PLANE_OPERATIONS.projects.archive);
		expect(registry.require('projects.delete').binding).toBe(CONTROL_PLANE_OPERATIONS.projects.remove);
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

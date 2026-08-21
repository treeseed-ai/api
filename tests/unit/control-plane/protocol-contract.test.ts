import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { controlPlaneOperations } from '../../../src/api/control-plane/catalog/index.ts';
import { installControlPlaneProtocolRoutes } from '../../../src/api/control-plane/http/protocol-routes.ts';
import { generateOpenApi, openApiDigest } from '../../../src/api/control-plane/openapi/generate-openapi.ts';

describe('control-plane protocol contract', () => {
	const authenticate = async (token: string) => token === 'test-token' ? {
		principal: { id: 'user_1', scopes: ['treeseed:read'], roles: [], permissions: [] },
		credential: { id: 'client_1' },
	} : null;

	it('binds status to one catalog operation and deterministic OpenAPI 3.1.1', () => {
		const operation = controlPlaneOperations.require('status.show');
		expect(operation.descriptor.surfaces).toEqual(expect.arrayContaining(['rest', 'cli', 'mcp_tool', 'mcp_resource']));
		const first = generateOpenApi(controlPlaneOperations);
		const second = generateOpenApi(controlPlaneOperations);
		expect(first.openapi).toBe('3.1.1');
		expect(first.paths['/v1/status']?.get).toMatchObject({ operationId: 'status.show' });
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

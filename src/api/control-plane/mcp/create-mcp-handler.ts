import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { OperationRegistry } from '../catalog/operation-registry.ts';
import { mcpCatalog } from './mcp-catalog.ts';

export function createControlPlaneMcpHandler(registry: OperationRegistry) {
	return createMcpHandler((requestContext) => {
		const server = new McpServer({ name: 'treeseed-control-plane', version: '0.8.0-rc.1' });
		for (const operation of registry.operations.values()) {
			if (!operation.descriptor.surfaces.includes('mcp_tool')) continue;
			server.registerTool(operation.descriptor.operationId, {
				description: operation.descriptor.description,
				inputSchema: operation.inputSchema,
				outputSchema: operation.outputSchema,
				annotations: {
					readOnlyHint: operation.descriptor.kind === 'read',
					destructiveHint: operation.descriptor.riskClass !== 'ordinary',
					idempotentHint: operation.descriptor.kind === 'read' || operation.descriptor.idempotency.required,
					openWorldHint: false,
				},
			}, async (input) => {
				const parsed = operation.inputSchema.parse(input);
				const output = await operation.handler(parsed, { interface: 'mcp', requestId: crypto.randomUUID(), authInfo: requestContext.authInfo });
				const validated = operation.outputSchema.parse(output) as Record<string, unknown>;
				return { content: [{ type: 'text', text: JSON.stringify(validated) }], structuredContent: validated };
			});
		}
		for (const resource of mcpCatalog.resources) {
			const operation = registry.require(resource.operationId);
			server.registerResource(resource.name, resource.uriTemplate, {
				description: resource.description,
				mimeType: resource.mimeType,
				cacheHint: { ttlMs: (resource.cacheTtlSeconds ?? 0) * 1000, cacheScope: operation.descriptor.cacheScope === 'public' ? 'public' : 'private' },
			}, async (uri) => {
				const output = await operation.handler(operation.inputSchema.parse({}), { interface: 'mcp', requestId: crypto.randomUUID(), authInfo: requestContext.authInfo });
				return { contents: [{ uri: uri.href, mimeType: resource.mimeType, text: JSON.stringify(operation.outputSchema.parse(output)) }] };
			});
		}
		for (const prompt of mcpCatalog.prompts) {
			server.registerPrompt(prompt.name, {
				description: prompt.description,
				argsSchema: z.object({ objective: z.string().min(1).max(4000) }),
			}, ({ objective }) => ({
				description: prompt.description,
				messages: [{ role: 'user', content: { type: 'text', text: `${prompt.description}\n\nObjective: ${objective}\n\nDiscover current tools and resources before taking action. Treat API authorization and receipts as authoritative.` } }],
			}));
		}
		return server;
	}, { legacy: 'reject', responseMode: 'auto' });
}

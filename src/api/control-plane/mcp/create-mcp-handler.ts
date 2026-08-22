import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { OperationRegistry } from '../catalog/operation-registry.ts';
import { sdkOperationInputStandardSchema, sdkStandardSchema } from '../catalog/sdk-standard-schema.ts';
import { createMcpCatalog } from './mcp-catalog.ts';

export function createControlPlaneMcpHandler(registry: OperationRegistry) {
	const mcpCatalog = createMcpCatalog(registry);
	return createMcpHandler((requestContext) => {
		const server = new McpServer({ name: 'treeseed-control-plane', version: '0.8.0-rc.1' });
		for (const operation of registry.operations.values()) {
			const descriptor = operation.binding.descriptor;
			if (!descriptor.surfaces.includes('mcp_tool')) continue;
			server.registerTool(descriptor.operationId, {
				description: descriptor.description,
				inputSchema: sdkOperationInputStandardSchema(operation.binding),
				outputSchema: sdkStandardSchema(operation.binding.schema.output),
				annotations: {
					readOnlyHint: descriptor.kind === 'read',
					destructiveHint: descriptor.riskClass !== 'ordinary',
					idempotentHint: descriptor.kind === 'read' || descriptor.idempotency.required,
					openWorldHint: false,
				},
			}, async (input) => {
				const output = await operation.handler(input as any, {
					interface: 'mcp', requestId: crypto.randomUUID(), authInfo: requestContext.authInfo,
					principal: requestContext.authInfo?.extra?.principal as any,
				});
				const validated = operation.binding.schema.output.parse(output) as Record<string, unknown>;
				return { content: [{ type: 'text', text: JSON.stringify(validated) }], structuredContent: validated };
			});
		}
		for (const resource of mcpCatalog.resources) {
			const operation = registry.require(resource.operationId);
			server.registerResource(resource.name, resource.uriTemplate, {
				description: resource.description,
				mimeType: resource.mimeType,
				cacheHint: { ttlMs: (resource.cacheTtlSeconds ?? 0) * 1000, cacheScope: operation.binding.descriptor.cacheScope === 'public' ? 'public' : 'private' },
			}, async (uri) => {
				const output = await operation.handler({ path: operation.binding.schema.path.parse({}), query: operation.binding.schema.query.parse({}), body: operation.binding.schema.body.parse(undefined) }, {
					interface: 'mcp', requestId: crypto.randomUUID(), authInfo: requestContext.authInfo,
					principal: requestContext.authInfo?.extra?.principal as any,
				});
				return { contents: [{ uri: uri.href, mimeType: resource.mimeType, text: JSON.stringify(operation.binding.schema.output.parse(output)) }] };
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

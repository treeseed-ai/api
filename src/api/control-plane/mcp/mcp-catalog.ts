import { MCP_PROTOCOL_VERSION, buildMcpTools, type McpCatalog } from '@treeseed/sdk/operator-contracts';
import { createHash } from 'node:crypto';
import type { OperationRegistry } from '../catalog/operation-registry.ts';

export function createMcpCatalog(registry: OperationRegistry): McpCatalog {
	return {
		schemaVersion: 'treeseed.mcp-catalog/v1',
		protocolVersion: MCP_PROTOCOL_VERSION,
		tools: buildMcpTools([...registry.catalog.operations]),
		resources: [{
		uriTemplate: 'treeseed://status',
		name: 'Control-plane status',
		description: 'Current control-plane and protocol readiness.',
		mimeType: 'application/json',
		operationId: 'status.show',
		subscribable: true,
		cacheTtlSeconds: 10,
		}],
		prompts: [
		{ name: 'operate', description: 'Operate TreeSeed through currently discoverable capabilities.', argumentSchemaId: 'treeseed.prompt.objective/v1', requiredScopes: ['treeseed:read'] },
		{ name: 'research', description: 'Research a governed TreeSeed question and accumulate knowledge.', argumentSchemaId: 'treeseed.prompt.objective/v1', requiredScopes: ['treeseed:read'] },
		{ name: 'governance-review', description: 'Review a proposal or decision using current governance evidence.', argumentSchemaId: 'treeseed.prompt.objective/v1', requiredScopes: ['treeseed:read'] },
		{ name: 'workday-planning', description: 'Plan a time-based workday without bypassing API authority.', argumentSchemaId: 'treeseed.prompt.objective/v1', requiredScopes: ['treeseed:read'] },
		{ name: 'project-agent-chat', description: 'Prepare an explicit governed project-agent chat invocation.', argumentSchemaId: 'treeseed.prompt.objective/v1', requiredScopes: ['treeseed:read'] },
		],
		capabilities: { completion: true, progress: true, cancellation: true, inputRequired: true, resourceSubscriptions: true },
	};
}

export function mcpCatalogDigest(catalog: McpCatalog) {
	return `sha256:${createHash('sha256').update(JSON.stringify(catalog)).digest('hex')}`;
}

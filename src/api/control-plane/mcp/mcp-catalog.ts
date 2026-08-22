import { buildMcpCatalog, type McpCatalog } from '@treeseed/sdk/operator-contracts';
import { createHash } from 'node:crypto';
import type { OperationRegistry } from '../catalog/operation-registry.ts';

export function createMcpCatalog(registry: OperationRegistry): McpCatalog {
	return buildMcpCatalog([...registry.catalog.operations]);
}

export function mcpCatalogDigest(catalog: McpCatalog) {
	return `sha256:${createHash('sha256').update(JSON.stringify(catalog)).digest('hex')}`;
}

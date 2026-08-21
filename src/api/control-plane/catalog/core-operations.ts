import { CONTROL_PLANE_OPERATION_SCHEMA_VERSION } from '@treeseed/sdk/operator-contracts';
import { z } from 'zod';
import type { BoundOperation } from './operation-registry.ts';

const statusInput = z.object({}).strict();
const statusOutput = z.object({
	service: z.literal('control-plane'),
	status: z.literal('ok'),
	contractVersion: z.literal('treeseed.control-plane-operation/v1'),
	mcpProtocolVersion: z.literal('2026-07-28'),
});

export const statusOperation: BoundOperation<z.infer<typeof statusInput>, z.infer<typeof statusOutput>> = {
	descriptor: {
		schemaVersion: CONTROL_PLANE_OPERATION_SCHEMA_VERSION,
		operationId: 'status.show',
		description: 'Read control-plane and protocol readiness.',
		rest: { method: 'GET', path: '/v1/status' },
		schemas: { input: 'treeseed.status.show.input/v1', output: 'treeseed.status.show.output/v1', errors: 'treeseed.problem/v1' },
		capability: 'status.read',
		oauthScopes: ['treeseed:read'],
		kind: 'read',
		riskClass: 'ordinary',
		confirmation: 'never',
		idempotency: { required: false, header: 'Idempotency-Key' },
		concurrency: { required: false, readHeader: 'ETag', writeHeader: 'If-Match' },
		surfaces: ['rest', 'cli', 'mcp_tool', 'mcp_resource'],
		cacheScope: 'public',
		pagination: 'none',
		audited: true,
		receipt: false,
		redactedPaths: [],
	},
	inputSchema: statusInput,
	outputSchema: statusOutput,
	async handler() {
		return { service: 'control-plane', status: 'ok', contractVersion: 'treeseed.control-plane-operation/v1', mcpProtocolVersion: '2026-07-28' };
	},
};

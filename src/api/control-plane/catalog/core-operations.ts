import { CONTROL_PLANE_OPERATION_SCHEMA_VERSION } from '@treeseed/sdk/operator-contracts';
import { z } from 'zod';
import { ControlPlaneOperationError, type BoundOperation } from './operation-registry.ts';

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

const deepHealthInput = z.object({}).strict();
const deepHealthOutput = z.object({
	status: z.enum(['ok', 'unavailable']),
	checks: z.object({ database: z.boolean() }),
});

export interface DeepHealthDependencies {
	store: {
		ensureInitialized(): Promise<unknown>;
		first(query: string): Promise<Record<string, unknown> | null | undefined>;
	};
}

export function createDeepHealthOperation(dependencies: DeepHealthDependencies): BoundOperation<z.infer<typeof deepHealthInput>, z.infer<typeof deepHealthOutput>> {
	return {
		descriptor: {
			schemaVersion: CONTROL_PLANE_OPERATION_SCHEMA_VERSION,
			operationId: 'health.deep',
			description: 'Read authoritative control-plane database readiness.',
			rest: { method: 'GET', path: '/v1/health/deep' },
			schemas: { input: 'treeseed.health.deep.input/v1', output: 'treeseed.health.deep.output/v1', errors: 'treeseed.problem/v1' },
			capability: 'health.read', oauthScopes: [], kind: 'read', riskClass: 'ordinary', confirmation: 'never',
			idempotency: { required: false, header: 'Idempotency-Key' },
			concurrency: { required: false, readHeader: 'ETag', writeHeader: 'If-Match' },
			surfaces: ['rest'], cacheScope: 'private', pagination: 'none', audited: false, receipt: false, redactedPaths: [],
		},
		inputSchema: deepHealthInput,
		outputSchema: deepHealthOutput,
		async handler() {
			try {
				await dependencies.store.ensureInitialized();
				const probe = await dependencies.store.first('SELECT 1 AS ok');
				const database = probe?.ok === 1 || probe?.ok === '1';
				if (!database) throw new Error('Readiness probe failed.');
				return { status: 'ok', checks: { database: true } };
			} catch {
				throw new ControlPlaneOperationError(503, 'control_plane_database_unavailable', 'The control-plane database is unavailable.');
			}
		},
	};
}

export function createReadinessOperation(dependencies: DeepHealthDependencies): BoundOperation<z.infer<typeof deepHealthInput>, z.infer<typeof deepHealthOutput>> {
	const operation = createDeepHealthOperation(dependencies);
	return {
		...operation,
		descriptor: {
			...operation.descriptor,
			operationId: 'health.ready',
			description: 'Read authoritative control-plane readiness.',
			rest: { method: 'GET', path: '/v1/health/ready' },
			schemas: { ...operation.descriptor.schemas, output: 'treeseed.health.ready.output/v1' },
		},
	};
}

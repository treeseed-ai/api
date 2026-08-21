import type { AuthInfo } from '@modelcontextprotocol/server';
import type { ControlPlaneCatalog, ControlPlaneOperationDescriptor } from '@treeseed/sdk/operator-contracts';
import { validateControlPlaneCatalog } from '@treeseed/sdk/operator-contracts';
import type { z } from 'zod';

export interface OperationInvocationContext {
	interface: 'rest' | 'cli' | 'mcp' | 'internal';
	requestId: string;
	traceparent?: string;
	authInfo?: AuthInfo;
}

export interface BoundOperation<TInput = unknown, TOutput = unknown> {
	descriptor: ControlPlaneOperationDescriptor;
	inputSchema: z.ZodType<TInput>;
	outputSchema: z.ZodType<TOutput>;
	handler(input: TInput, context: OperationInvocationContext): Promise<TOutput>;
}

export class ControlPlaneOperationError extends Error {
	constructor(
		readonly status: 400 | 401 | 403 | 404 | 409 | 412 | 422 | 429 | 500 | 503,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = 'ControlPlaneOperationError';
	}
}

export class OperationRegistry {
	readonly catalog: ControlPlaneCatalog;
	readonly operations: ReadonlyMap<string, BoundOperation>;

	constructor(operations: readonly BoundOperation[]) {
		this.catalog = { schemaVersion: 'treeseed.control-plane-catalog/v1', operations: operations.map((operation) => operation.descriptor) };
		const diagnostics = validateControlPlaneCatalog(this.catalog);
		if (diagnostics.length > 0) throw new Error(`Invalid control-plane operation catalog: ${diagnostics.map((entry) => entry.code).join(', ')}`);
		this.operations = new Map(operations.map((operation) => [operation.descriptor.operationId, operation]));
		if (this.operations.size !== operations.length) throw new Error('Every bound operation must have a unique operation ID.');
	}

	require(operationId: string) {
		const operation = this.operations.get(operationId);
		if (!operation) throw new Error(`Control-plane operation ${operationId} is not bound.`);
		return operation;
	}
}

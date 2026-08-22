type RunnerStore = {
	upsertControlPlaneOperationRunner(input: Record<string, unknown>): Promise<unknown>;
	claimPlatformOperation(input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	findPlatformOperationById(operationId: string): Promise<Record<string, unknown> | null>;
	appendPlatformOperationEvent(operationId: string, kind: string, data?: Record<string, unknown>): Promise<unknown>;
	renewPlatformOperationLease(operationId: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	checkpointPlatformOperation(operationId: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	completePlatformOperation(operationId: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	failPlatformOperation(operationId: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	assertPlatformOperationRunnerUpdate(operationId: string, runnerId: unknown): Promise<unknown>;
	cancelPlatformOperation(operationId: string): Promise<Record<string, unknown> | null>;
	db?: { close?: () => Promise<void> | void };
};

export class DirectControlPlaneRunnerClient {
	constructor(private readonly store: RunnerStore) {}

	async register(input: Record<string, unknown>) {
		return { ok: true, runner: await this.store.upsertControlPlaneOperationRunner(input) };
	}

	heartbeat(input: Record<string, unknown>) {
		return this.register(input);
	}

	async claimJob(input: Record<string, unknown>) {
		return { ok: true, operation: await this.store.claimPlatformOperation(input) };
	}

	async getOperation(operationId: string) {
		return { ok: true, operation: await this.store.findPlatformOperationById(operationId) };
	}

	async appendEvent(operationId: string, input: Record<string, unknown>) {
		const event = input.event && typeof input.event === 'object' ? input.event as Record<string, unknown> : {};
		return {
			ok: true,
			event: await this.store.appendPlatformOperationEvent(
				operationId,
				typeof event.kind === 'string' ? event.kind : 'event',
				event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {},
			),
		};
	}

	async renewLease(operationId: string, input: Record<string, unknown>) {
		return { ok: true, operation: await this.store.renewPlatformOperationLease(operationId, input) };
	}

	async checkpoint(operationId: string, input: Record<string, unknown>) {
		return { ok: true, operation: await this.store.checkpointPlatformOperation(operationId, input) };
	}

	async complete(operationId: string, input: Record<string, unknown>) {
		return { ok: true, operation: await this.store.completePlatformOperation(operationId, input) };
	}

	async fail(operationId: string, input: Record<string, unknown>) {
		return { ok: true, operation: await this.store.failPlatformOperation(operationId, input) };
	}

	async cancel(operationId: string, input: Record<string, unknown>) {
		await this.store.assertPlatformOperationRunnerUpdate(operationId, input.runnerId);
		return { ok: true, operation: await this.store.cancelPlatformOperation(operationId) };
	}

	async close() {
		await this.store.db?.close?.();
	}
}

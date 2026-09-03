type Operation = {
	id: string;
	namespace: string;
	operation: string;
	status: string;
	input: Record<string, unknown>;
};

type Executor = {
	namespace: string;
	operation: string;
	run(input: Record<string, unknown>, context: Record<string, unknown>): Promise<unknown>;
};

const executorRegistry = (executors: Executor[]) => new Map(
	executors.map((executor) => [`${executor.namespace}:${executor.operation}`, executor]),
);

function operationFailure(error: unknown) {
	const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
	return {
		message: error instanceof Error ? error.message : String(error),
		...(typeof record.code === 'string' ? { code: record.code } : {}),
		...(Array.isArray(record.details) ? { details: record.details } : {}),
	};
}

export async function runPlatformOperationOnce(options: any) {
	const registry = executorRegistry(options.executors);
	const claimed = await options.client.claimJob({
		runnerId: options.runnerId,
		operationId: options.operationId ?? undefined,
		capabilities: [...registry.keys()],
		limit: options.limit ?? 1,
		leaseSeconds: options.leaseSeconds ?? 300,
	});
	let operation = claimed.operation as Operation | null;
	if (!operation) return { ok: true, claimed: false, operation: null };
	const executor = registry.get(`${operation.namespace}:${operation.operation}`);
	if (!executor) {
		const message = `No executor registered for platform operation "${operation.namespace}:${operation.operation}".`;
		const failed = await options.client.fail(operation.id, {
			runnerId: options.runnerId,
			error: { message },
			event: { kind: 'runner.executor_missing', data: { namespace: operation.namespace, operation: operation.operation } },
		});
		return { ok: false, claimed: true, operation: failed.operation, error: { message } };
	}
	const context: any = {
		operation,
		operationId: operation.id,
		workspaceRoot: options.workspaceRoot,
		environment: options.environment,
		emit: async (event: unknown) => {
			await options.client.appendEvent(operation!.id, { runnerId: options.runnerId, event });
		},
		checkpoint: async (output: unknown, event: unknown) => {
			await context.throwIfCancelled();
			await options.client.checkpoint(operation!.id, { runnerId: options.runnerId, output, event });
		},
		renewLease: async (leaseSeconds?: number) => {
			if (!options.client.renewLease) return operation;
			const renewed = await options.client.renewLease(operation!.id, {
				runnerId: options.runnerId,
				leaseSeconds,
				event: { kind: 'runner.lease_renewed', data: { leaseSeconds: leaseSeconds ?? options.leaseSeconds ?? 300 } },
			});
			operation = renewed.operation;
			return operation;
		},
		throwIfCancelled: async () => {
			const latest = options.client.getOperation ? (await options.client.getOperation(operation!.id)).operation : operation;
			operation = latest;
			if (latest?.status === 'cancelled') throw new Error('Platform operation was cancelled.');
			await options.throwIfCancelled?.(operation);
		},
	};
	const leaseSeconds = Math.max(30, Math.min(Number(options.leaseSeconds ?? 300), 3600));
	const leaseRenewalIntervalMs = Math.max(1, options.leaseRenewalIntervalMs ?? Math.min(60_000, Math.floor(leaseSeconds * 1000 / 3)));
	let leaseRenewalFailure: Error | null = null;
	let leaseRenewal: Promise<void> = Promise.resolve();
	let leaseTimer: ReturnType<typeof setInterval> | null = null;
	const assertLeaseRenewal = () => {
		if (leaseRenewalFailure) throw leaseRenewalFailure;
	};
	try {
		await context.emit({ kind: 'runner.started', data: { namespace: operation.namespace, operation: operation.operation } });
		await context.throwIfCancelled();
		await context.renewLease(leaseSeconds);
		if (options.client.renewLease) {
			leaseTimer = setInterval(() => {
				leaseRenewal = leaseRenewal.then(async () => {
					if (leaseRenewalFailure) return;
					try {
						await context.renewLease(leaseSeconds);
					} catch (error) {
						leaseRenewalFailure = new Error(`Platform operation lease renewal failed: ${error instanceof Error ? error.message : String(error)}`);
					}
				});
			}, leaseRenewalIntervalMs);
			leaseTimer.unref?.();
		}
		const output = await executor.run(operation.input, context);
		assertLeaseRenewal();
		await context.throwIfCancelled();
		assertLeaseRenewal();
		const completed = await options.client.complete(operation.id, { runnerId: options.runnerId, output });
		return { ok: true, claimed: true, operation: completed.operation, output };
	} catch (error) {
		const failure = operationFailure(error);
		const eventKind = failure.message.toLowerCase().includes('cancel') ? 'runner.cancelled' : 'runner.retry_safe_failure';
		if (eventKind === 'runner.cancelled' && options.client.cancel) {
			const cancelled = await options.client.cancel(operation.id, {
				runnerId: options.runnerId,
				error: failure,
				event: { kind: eventKind, data: failure },
			});
			return { ok: false, claimed: true, operation: cancelled.operation, error: failure };
		}
		const failed = await options.client.fail(operation.id, {
			runnerId: options.runnerId,
			error: failure,
			event: { kind: eventKind, data: failure },
		});
		return { ok: false, claimed: true, operation: failed.operation, error: failure };
	} finally {
		if (leaseTimer) clearInterval(leaseTimer);
		await leaseRenewal;
	}
}

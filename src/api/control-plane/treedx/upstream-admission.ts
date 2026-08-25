type Waiter = {
	projectId: string;
	actorId: string;
	resolve: () => void;
	reject: (error: TreeDxUpstreamAdmissionError) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
};

type ConnectionState = {
	active: number;
	activeProjects: Map<string, number>;
	activeActors: Map<string, number>;
	queue: Waiter[];
	consecutiveFailures: number;
	openUntil: number;
};

export class TreeDxUpstreamAdmissionError extends Error {
	constructor(readonly code: 'treedx_upstream_busy' | 'treedx_upstream_circuit_open' | 'treedx_upstream_cancelled') {
		super(code === 'treedx_upstream_busy' ? 'TreeDX request capacity is exhausted.'
			: code === 'treedx_upstream_circuit_open' ? 'TreeDX connection is temporarily unavailable.'
				: 'TreeDX request was cancelled before admission.');
	}
}

export interface TreeDxUpstreamAdmissionOptions {
	connectionConcurrency?: number;
	projectConcurrency?: number;
	actorConcurrency?: number;
	queueLimit?: number;
	failureThreshold?: number;
	circuitOpenMs?: number;
	now?: () => number;
}

function positive(value: number | undefined, fallback: number) {
	return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

export class TreeDxUpstreamAdmission {
	private readonly states = new Map<string, ConnectionState>();
	private readonly connectionConcurrency: number;
	private readonly projectConcurrency: number;
	private readonly actorConcurrency: number;
	private readonly queueLimit: number;
	private readonly failureThreshold: number;
	private readonly circuitOpenMs: number;
	private readonly now: () => number;

	constructor(options: TreeDxUpstreamAdmissionOptions = {}) {
		this.connectionConcurrency = positive(options.connectionConcurrency, 32);
		this.projectConcurrency = positive(options.projectConcurrency, 8);
		this.actorConcurrency = positive(options.actorConcurrency, 4);
		this.queueLimit = positive(options.queueLimit, 128);
		this.failureThreshold = positive(options.failureThreshold, 5);
		this.circuitOpenMs = positive(options.circuitOpenMs, 30_000);
		this.now = options.now ?? Date.now;
	}

	async run<T>(input: { connectionId: string; projectId: string; actorId: string; retryable: boolean;
		signal?: AbortSignal; invoke: () => Promise<T>; transient?: (error: unknown) => boolean }): Promise<T> {
		const state = this.state(input.connectionId);
		if (state.openUntil > this.now()) throw new TreeDxUpstreamAdmissionError('treedx_upstream_circuit_open');
		await this.acquire(state, input.projectId, input.actorId, input.signal);
		try {
			for (let attempt = 0; ; attempt += 1) {
				try {
					const result = await input.invoke();
					state.consecutiveFailures = 0;
					return result;
				} catch (error) {
					const transient = input.transient?.(error) ?? error instanceof TypeError;
					if (transient) {
						state.consecutiveFailures += 1;
						if (state.consecutiveFailures >= this.failureThreshold) state.openUntil = this.now() + this.circuitOpenMs;
					}
					if (!(input.retryable && transient && attempt === 0) || input.signal?.aborted) throw error;
				}
			}
		} finally {
			this.release(state, input.projectId, input.actorId);
		}
	}

	private state(connectionId: string) {
		let state = this.states.get(connectionId);
		if (!state) {
			state = { active: 0, activeProjects: new Map(), activeActors: new Map(), queue: [], consecutiveFailures: 0, openUntil: 0 };
			this.states.set(connectionId, state);
		}
		return state;
	}

	private available(state: ConnectionState, projectId: string, actorId: string) {
		return state.active < this.connectionConcurrency
			&& (state.activeProjects.get(projectId) ?? 0) < this.projectConcurrency
			&& (state.activeActors.get(actorId) ?? 0) < this.actorConcurrency;
	}

	private admit(state: ConnectionState, projectId: string, actorId: string) {
		state.active += 1;
		state.activeProjects.set(projectId, (state.activeProjects.get(projectId) ?? 0) + 1);
		state.activeActors.set(actorId, (state.activeActors.get(actorId) ?? 0) + 1);
	}

	private acquire(state: ConnectionState, projectId: string, actorId: string, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return Promise.reject(new TreeDxUpstreamAdmissionError('treedx_upstream_cancelled'));
		if (this.available(state, projectId, actorId)) { this.admit(state, projectId, actorId); return Promise.resolve(); }
		if (state.queue.length >= this.queueLimit) return Promise.reject(new TreeDxUpstreamAdmissionError('treedx_upstream_busy'));
		return new Promise((resolve, reject) => {
			const waiter: Waiter = { projectId, actorId, resolve, reject, signal };
			waiter.onAbort = () => {
				state.queue = state.queue.filter((candidate) => candidate !== waiter);
				reject(new TreeDxUpstreamAdmissionError('treedx_upstream_cancelled'));
			};
			signal?.addEventListener('abort', waiter.onAbort, { once: true });
			state.queue.push(waiter);
		});
	}

	private release(state: ConnectionState, projectId: string, actorId: string) {
		state.active = Math.max(0, state.active - 1);
		this.decrement(state.activeProjects, projectId);
		this.decrement(state.activeActors, actorId);
		if (state.openUntil > this.now()) {
			for (const waiter of state.queue.splice(0)) {
				waiter.signal?.removeEventListener('abort', waiter.onAbort!);
				waiter.reject(new TreeDxUpstreamAdmissionError('treedx_upstream_circuit_open'));
			}
			return;
		}
		for (let index = 0; index < state.queue.length;) {
			const waiter = state.queue[index]!;
			if (!this.available(state, waiter.projectId, waiter.actorId)) { index += 1; continue; }
			state.queue.splice(index, 1);
			waiter.signal?.removeEventListener('abort', waiter.onAbort!);
			this.admit(state, waiter.projectId, waiter.actorId);
			waiter.resolve();
		}
	}

	private decrement(values: Map<string, number>, key: string) {
		const next = (values.get(key) ?? 1) - 1;
		if (next > 0) values.set(key, next); else values.delete(key);
	}
}

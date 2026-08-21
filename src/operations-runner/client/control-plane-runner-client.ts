const endpoints = {
	register: '/v1/platform/runners/register',
	heartbeat: '/v1/platform/runners/heartbeat',
	claim: '/v1/platform/runners/jobs/claim',
	job: (operationId: string) => `/v1/platform/runners/jobs/${encodeURIComponent(operationId)}`,
};

function normalizeServerUrl(value: string): string {
	return String(value ?? '').trim().replace(/\/+$/u, '');
}

export class ControlPlaneRunnerClient {
	private readonly serverUrl: string;
	private readonly serverId: string;
	private readonly runnerSecret: string;
	private readonly fetchImpl: typeof fetch;
	private readonly userAgent?: string;

	constructor(options: {
		serverUrl: string;
		serverId: string;
		runnerSecret: string;
		fetchImpl?: typeof fetch;
		userAgent?: string;
	}) {
		this.serverUrl = normalizeServerUrl(options.serverUrl);
		this.serverId = String(options.serverId ?? '').trim();
		this.runnerSecret = String(options.runnerSecret ?? '').trim();
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.userAgent = options.userAgent;
		if (!this.serverUrl) throw new Error('API server URL is required.');
		if (!this.serverId) throw new Error('Control-plane server ID is required.');
		if (!this.runnerSecret) throw new Error('Platform runner secret is required.');
	}

	private async request(path: string, options: { method?: string; body?: unknown } = {}) {
		const headers: Record<string, string> = {
			accept: 'application/json',
			authorization: `Bearer ${this.runnerSecret}`,
		};
		if (this.userAgent) headers['user-agent'] = this.userAgent;
		if (options.body !== undefined) headers['content-type'] = 'application/json';
		const response = await this.fetchImpl(`${this.serverUrl}${path}`, {
			method: options.method ?? 'GET',
			headers,
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
		});
		const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
		if (!response.ok) {
			const error = new Error(typeof payload.error === 'string'
				? payload.error
				: `Platform operation request failed with ${response.status}.`);
			Object.assign(error, { status: response.status, payload });
			throw error;
		}
		return payload as any;
	}

	private withServer(input: Record<string, unknown>) {
		return { ...input, serverId: this.serverId };
	}

	register(input: Record<string, unknown>) {
		return this.request(endpoints.register, { method: 'POST', body: this.withServer(input) });
	}

	heartbeat(input: Record<string, unknown>) {
		return this.request(endpoints.heartbeat, { method: 'POST', body: this.withServer(input) });
	}

	claimJob(input: Record<string, unknown>) {
		return this.request(endpoints.claim, { method: 'POST', body: this.withServer(input) });
	}

	getOperation(operationId: string) {
		return this.request(endpoints.job(operationId));
	}

	appendEvent(operationId: string, input: Record<string, unknown>) {
		return this.request(`${endpoints.job(operationId)}/events`, { method: 'POST', body: this.withServer(input) });
	}

	renewLease(operationId: string, input: Record<string, unknown>) {
		return this.request(`${endpoints.job(operationId)}/renew-lease`, { method: 'POST', body: this.withServer(input) });
	}

	checkpoint(operationId: string, input: Record<string, unknown>) {
		return this.request(`${endpoints.job(operationId)}/checkpoint`, { method: 'POST', body: this.withServer(input) });
	}

	complete(operationId: string, input: Record<string, unknown>) {
		return this.request(`${endpoints.job(operationId)}/complete`, { method: 'POST', body: this.withServer(input) });
	}

	fail(operationId: string, input: Record<string, unknown>) {
		return this.request(`${endpoints.job(operationId)}/fail`, { method: 'POST', body: this.withServer(input) });
	}

	cancel(operationId: string, input: Record<string, unknown>) {
		return this.request(`${endpoints.job(operationId)}/cancel`, { method: 'POST', body: this.withServer(input) });
	}
}

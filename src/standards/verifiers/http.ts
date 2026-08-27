import { randomUUID } from 'node:crypto';

export interface VerifierResponse<T = Record<string, unknown>> {
	status: number;
	body: T;
	data: T;
	headers: Headers;
}

export class VerifierHttp {
	constructor(readonly origin: string, private token = '') {}

	withToken(token: string) {
		return new VerifierHttp(this.origin, token);
	}

	async request<T = Record<string, unknown>>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<VerifierResponse<T>> {
		const requestHeaders = new Headers({ accept: 'application/json', ...headers });
		if (this.token) requestHeaders.set('authorization', `Bearer ${this.token}`);
		if (body !== undefined) requestHeaders.set('content-type', 'application/json');
		if (method !== 'GET' && method !== 'HEAD') requestHeaders.set('idempotency-key', `guarantee-${randomUUID()}`);
		const response = await fetch(new URL(path, this.origin), {
			method,
			headers: requestHeaders,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			redirect: 'manual',
		});
		const text = await response.text();
		let parsed: T = {} as T;
		if (text) {
			try { parsed = JSON.parse(text) as T; }
			catch { parsed = { text } as T; }
		}
		const envelope = parsed as Record<string, unknown>;
		return { status: response.status, body: parsed, data: (envelope.data ?? parsed) as T, headers: response.headers };
	}

	async confirmed<T = Record<string, unknown>>(method: string, path: string, body: unknown, headers: Record<string, string> = {}) {
		const required = await this.request(method, path, body, headers);
		if (required.status !== 409) return required as VerifierResponse<T>;
		const problem = required.body as { code?: string; inputRequired?: { confirmation?: unknown } };
		if (problem.code !== 'confirmation_required' || !problem.inputRequired?.confirmation) return required as VerifierResponse<T>;
		const encoded = Buffer.from(JSON.stringify(problem.inputRequired.confirmation)).toString('base64url');
		return this.request<T>(method, path, body, { ...headers, 'x-treeseed-confirmation': encoded });
	}
}

export function expectStatus(response: VerifierResponse, expected: number, label: string) {
	if (response.status !== expected) {
		const value = JSON.stringify(response.body).replace(/confirm_[A-Za-z0-9_-]+/gu, '[REDACTED]');
		throw new Error(`${label}: expected HTTP ${expected}, received ${response.status}: ${value.slice(0, 500)}`);
	}
	return response;
}

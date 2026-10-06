import { describe, expect, it, vi } from 'vitest';
import { TREEAI_CONTROL_PLANE_OPERATION_LIST } from '@treeseed/sdk/treeai';
import { createTreeAiOperations } from '../../../../src/api/control-plane/catalog/treeai/index.ts';
import { TreeAiProxyService } from '../../../../src/api/control-plane/treeai/proxy-service.ts';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Hono } from 'hono';
import { createOperationHttpHandler } from '../../../../src/api/control-plane/http/operation-http-handler.ts';

describe('TreeAI SDK-driven proxy', () => {
	it('native agent tool upstream bad gateway retains exact public failure and permits only a fresh unchanged retry', async () => {
		const requests: Array<{ method: string | undefined; path: string | undefined }> = [];
		const rawFailure = JSON.stringify({ privateDetail: 'controlled-upstream-input-not-public' });
		let status = 502;
		const upstream = createServer((request, response) => {
			requests.push({ method: request.method, path: request.url });
			response.writeHead(status, { 'content-type': 'application/json' });
			response.end(status === 200 ? JSON.stringify({ mode: 'awake' }) : rawFailure);
		});
		const listening = once(upstream, 'listening');
		upstream.listen(0, '127.0.0.1');
		try {
			await listening;
			const address = upstream.address();
			if (!address || typeof address === 'string') throw new Error('Allocated native upstream required.');
			const endpoint = `http://127.0.0.1:${address.port}`;
			const service = new TreeAiProxyService({ resolve: () => ({ token: 'controlled-fixture-token', endpoints: { lab: endpoint } }) });
			const operation = createTreeAiOperations({ treeAiProxy: service }).find(candidate => candidate.binding.descriptor.upstream?.operationId === 'lab.get.status');
			if (!operation?.binding.descriptor.rest) throw new Error('Original public agent tool binding required.');
			const rest = operation.binding.descriptor.rest;
			const route = rest.path.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, ':$1');
			const url = rest.path.replace('{nodeId}', 'node-1');
			const app = new Hono();
			app.on(rest.method, route, createOperationHttpHandler(operation, async () => ({
				token: 'controlled-auth-input', clientId: 'test', scopes: [...operation.binding.descriptor.oauthScopes],
				extra: { principal: { id: 'user', roles: ['platform_admin'], permissions: ['*:*:*'] } },
			}), 'fixture-contract-digest'));
			const failures = [];
			for (const suppliedStatus of [502, 503, 502]) {
				status = suppliedStatus;
				const response = await app.request(url, { method: rest.method, headers: { 'x-request-id': 'tool-failure' } });
				const body = await response.json();
				failures.push(structuredClone(body));
				expect(response.status).toBe(suppliedStatus);
				expect(body).toMatchObject({ status: suppliedStatus, code: 'treeai_upstream_failed', requestId: 'tool-failure',
					detail: `TreeAI lab.get.status returned ${suppliedStatus}.` });
				expect(JSON.stringify(body)).not.toContain('controlled-upstream-input-not-public');
			}
			const retainedFailures = structuredClone(failures);
			status = 200;
			const retry = await app.request(url, { method: rest.method, headers: { 'x-request-id': 'tool-retry' } });
			expect(retry.status).toBe(200);
			expect(await retry.json()).toEqual({ data: { mode: 'awake' } });
			expect(requests).toEqual(Array.from({ length: 4 }, () => ({ method: 'GET', path: '/v1/status' })));
			expect(failures).toEqual(retainedFailures);
			expect(rawFailure).toBe('{"privateDetail":"controlled-upstream-input-not-public"}');
		} finally {
			upstream.closeAllConnections();
			await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
			expect(upstream.listening).toBe(false);
		}
	});
	it('binds exactly the SDK-adopted operation set', () => {
		const service = { invoke: vi.fn() } as unknown as TreeAiProxyService;
		expect(createTreeAiOperations({ treeAiProxy: service }).map(({ binding }) => binding.descriptor.operationId).sort())
			.toEqual(TREEAI_CONTROL_PLANE_OPERATION_LIST.map(({ descriptor }) => descriptor.operationId).sort());
	});

	it('resolves a node and forwards an upstream operation without exposing its credential', async () => {
		const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
			expect((init?.headers as Headers).get('authorization')).toBe('Bearer private-token');
			return new Response(JSON.stringify({ mode: 'awake' }), { headers: { 'content-type': 'application/json' } });
		});
		const service = new TreeAiProxyService({ resolve: () => ({ token: 'private-token', endpoints: {
			inference: 'https://inference.test', training: 'https://training.test', lab: 'https://lab.test',
		} }) }, fetchImpl);
		await expect(service.invoke('node-1', 'lab.get.status', {}, { interface: 'rest', requestId: 'request-1' })).resolves.toEqual({ mode: 'awake' });
		expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('https://lab.test/v1/status');
	});
});

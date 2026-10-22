import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { OperationRegistry } from '../../../../src/api/control-plane/catalog/operation-registry.ts';
import { ConfirmationService, encodeConfirmation } from '../../../../src/api/control-plane/confirmation/confirmation-service.ts';
import { installControlPlaneProtocolRoutes } from '../../../../src/api/control-plane/http/protocol-routes.ts';

describe('stateless native MCP confirmation', () => {
	it('returns and consumes the existing signed confirmation without server-to-client requests', async () => {
		const calls: unknown[] = [], used = new Set<string>();
		const confirmations = new ConfirmationService('controlled-legacy-confirmation-secret', { async consume(nonce) {
			if (used.has(nonce)) return false; used.add(nonce); return true;
		} });
		const app = new Hono(), binding = CONTROL_PLANE_OPERATIONS.workdays.start;
		installControlPlaneProtocolRoutes(app, async token => ({ principal: { id: token, scopes: ['treeseed:execution'] }, credential: { id: 'client' } }), undefined,
			new OperationRegistry([{ binding, async handler(input) { calls.push(input); return { started: true }; } }]), confirmations);
		const args = { path: { teamId: 'team' }, query: {}, body: { preflightId: 'real-preflight', preflightDigest: 'sha256:inspected' }, headers: { 'Idempotency-Key': 'start-real-work' } };
		const call = async (input: unknown, token = 'coordinator') => {
			const response = await app.request('/mcp', { method: 'POST', headers: { host: 'localhost', authorization: `Bearer ${token}`,
				'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: binding.descriptor.operationId, arguments: input } }) });
			const wire = await response.text();
			const payload = response.headers.get('content-type')?.includes('text/event-stream')
				? wire.split('\n').find(line => line.startsWith('data: '))!.slice(6) : wire;
			return JSON.parse(payload).result;
		};
		const first = await call(args);
		expect(first.isError).toBe(true); expect(calls).toEqual([]);
		const required = JSON.parse(first.content[0].text);
		expect(required.type).toBe('input_required'); expect(required.confirmation.operationId).toBe('workdays.start');
		const confirmed = { ...args, headers: { ...args.headers, 'x-treeseed-confirmation': encodeConfirmation(required.confirmation) } };
		for (const invalid of [
			{ ...confirmed, body: { ...args.body, preflightId: 'different' } },
			{ ...confirmed, headers: { ...confirmed.headers, 'Idempotency-Key': 'different' } },
			{ ...confirmed, headers: { ...confirmed.headers, 'x-treeseed-confirmation': 'malformed' } },
		]) { expect((await call(invalid)).isError).toBe(true); expect(calls).toEqual([]); }
		expect((await call(confirmed, 'other-principal')).isError).toBe(true); expect(calls).toEqual([]);
		expect((await call(confirmed)).structuredContent).toEqual({ started: true });
		expect(calls).toEqual([{ path: args.path, query: {}, body: args.body }]);
		expect((await call(confirmed)).isError).toBe(true); expect(calls).toHaveLength(1);
	});
});

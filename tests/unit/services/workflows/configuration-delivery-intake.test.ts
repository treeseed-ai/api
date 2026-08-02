import { afterEach, describe, expect, it } from 'vitest';
import { startHealthServer } from '../../../../src/operations-runner/entrypoint-support/support/health-server.ts';
import { clearWorkflowConfigurationDeliveries, consumeWorkflowConfigurationDelivery } from '../../../../src/operations-runner/workflows/configuration-deliveries.ts';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const servers: Server[] = [];
afterEach(async () => {
	clearWorkflowConfigurationDeliveries();
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
});

async function serverUrl(secret = 'runner-test-secret') {
	const server = startHealthServer({ port: 0, runnerSecret: secret }, { ready: true }) as Server;
	servers.push(server);
	await new Promise<void>((resolve) => server.once('listening', resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('workflow configuration delivery intake', () => {
	it('accepts a digest-bound delivery over the authenticated internal endpoint exactly once', async () => {
		const baseUrl = await serverUrl();
		const payload = 'provider-encrypted-canary';
		const response = await fetch(`${baseUrl}/internal/workflow-configuration-deliveries/delivery-a`, {
			method: 'PUT', headers: { authorization: 'Bearer runner-test-secret', 'content-type': 'application/json' },
			body: JSON.stringify({ operationId: 'operation-a', payload, payloadDigest: createHash('sha256').update(payload).digest('hex'),
				keyId: 'provider-key', expiresAt: new Date(Date.now() + 30_000).toISOString() }),
		});
		expect(response.status).toBe(202);
		expect(consumeWorkflowConfigurationDelivery('delivery-a', 'operation-a')).toMatchObject({ payload, keyId: 'provider-key' });
		expect(() => consumeWorkflowConfigurationDelivery('delivery-a', 'operation-a')).toThrow(/unavailable or expired/u);
	});

	it('rejects unauthorized and digest-mismatched deliveries without registering them', async () => {
		const baseUrl = await serverUrl();
		const body = JSON.stringify({ operationId: 'operation-b', payload: 'canary', payloadDigest: '0'.repeat(64),
			keyId: null, expiresAt: new Date(Date.now() + 30_000).toISOString() });
		expect((await fetch(`${baseUrl}/internal/workflow-configuration-deliveries/delivery-b`, {
			method: 'PUT', headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' }, body })).status).toBe(401);
		expect((await fetch(`${baseUrl}/internal/workflow-configuration-deliveries/delivery-b`, {
			method: 'PUT', headers: { authorization: 'Bearer runner-test-secret', 'content-type': 'application/json' }, body })).status).toBe(422);
		expect(() => consumeWorkflowConfigurationDelivery('delivery-b', 'operation-b')).toThrow(/unavailable or expired/u);
	});
});

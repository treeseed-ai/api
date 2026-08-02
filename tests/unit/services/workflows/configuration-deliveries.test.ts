import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearWorkflowConfigurationDeliveries, consumeWorkflowConfigurationDelivery,
	registerWorkflowConfigurationDelivery } from '../../../../src/operations-runner/workflows/configuration-deliveries.ts';

describe('transient workflow configuration deliveries', () => {
	beforeEach(() => clearWorkflowConfigurationDeliveries());

	it('consumes a digest-bound delivery exactly once', () => {
		const payload = 'github-encrypted-value';
		registerWorkflowConfigurationDelivery({ id: 'delivery-a', operationId: 'operation-a', payload,
			payloadDigest: createHash('sha256').update(payload).digest('hex'), keyId: 'key-a',
			expiresAt: new Date(Date.now() + 60_000).toISOString() });
		expect(consumeWorkflowConfigurationDelivery('delivery-a', 'operation-a')).toMatchObject({ payload, keyId: 'key-a' });
		expect(() => consumeWorkflowConfigurationDelivery('delivery-a', 'operation-a')).toThrow(/unavailable or expired/u);
	});

	it('rejects ciphertext substitution and wrong-operation consumption', () => {
		expect(() => registerWorkflowConfigurationDelivery({ id: 'delivery-a', operationId: 'operation-a', payload: 'changed',
			payloadDigest: createHash('sha256').update('original').digest('hex'), keyId: 'key-a',
			expiresAt: new Date(Date.now() + 60_000).toISOString() })).toThrow(/digest does not match/u);
		registerWorkflowConfigurationDelivery({ id: 'delivery-b', operationId: 'operation-b', payload: null,
			payloadDigest: null, keyId: null, expiresAt: new Date(Date.now() + 60_000).toISOString() });
		expect(() => consumeWorkflowConfigurationDelivery('delivery-b', 'operation-other')).toThrow(/unavailable or expired/u);
	});

	it('fails closed after runner state is cleared', () => {
		registerWorkflowConfigurationDelivery({ id: 'delivery-a', operationId: 'operation-a', payload: null,
			payloadDigest: null, keyId: null, expiresAt: new Date(Date.now() + 60_000).toISOString() });
		clearWorkflowConfigurationDeliveries();
		expect(() => consumeWorkflowConfigurationDelivery('delivery-a', 'operation-a')).toThrow(/unavailable or expired/u);
	});
});

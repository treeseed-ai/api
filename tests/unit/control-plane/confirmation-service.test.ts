import { describe, expect, it } from 'vitest';
import { ConfirmationService } from '../../../src/api/control-plane/confirmation/confirmation-service.ts';

describe('operation confirmation service', () => {
	it('binds state to principal, client, operation, arguments, expiry, and one use', async () => {
		const used = new Set<string>();
		const confirmations = new ConfirmationService('test-confirmation-secret', { async consume(nonce) {
			if (used.has(nonce)) return false;
			used.add(nonce);
			return true;
		} });
		const identity = { principalId: 'user-1', clientId: 'client-1', operationId: 'projects.delete', arguments: { path: { projectId: 'project-1' }, body: { confirmation: 'DELETE project' } } };
		const state = confirmations.request({ ...identity, requestId: 'request-1' }).confirmation;
		expect(await confirmations.verify(state, { ...identity, principalId: 'user-2' })).toBe(false);
		expect(await confirmations.verify(state, { ...identity, clientId: 'client-2' })).toBe(false);
		expect(await confirmations.verify(state, { ...identity, operationId: 'projects.archive' })).toBe(false);
		expect(await confirmations.verify(state, { ...identity, arguments: { ...identity.arguments, body: { confirmation: 'changed' } } })).toBe(false);
		expect(await confirmations.verify({ ...state, expiresAt: '2000-01-01T00:00:00.000Z' }, identity)).toBe(false);
		expect(await confirmations.verify(state, identity)).toBe(true);
		expect(await confirmations.verify(state, identity)).toBe(false);
	});
});

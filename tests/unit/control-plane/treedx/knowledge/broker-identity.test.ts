import { describe, expect, it } from 'vitest';
import { treeDxBrokerIdentity } from '../../../../../src/security/treedx-broker-identity.ts';

describe('TreeDX broker identity', () => {
	it('uses the authenticated service identity, not placement or database binding metadata', () => {
		const connection = { nodeId: 'broker-service', primaryNodeId: 'storage-node', instanceId: 'database-binding' };
		expect(treeDxBrokerIdentity(connection)).toBe('broker-service');
	});
	it.each([undefined, null, '', ' ', 123])('rejects missing or invalid identity %s without a local/history fallback', nodeId => {
		expect(() => treeDxBrokerIdentity({ nodeId })).toThrow('configured broker node identity');
	});
});

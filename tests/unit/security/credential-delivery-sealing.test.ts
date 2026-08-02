import { createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deliveryScopeMatches, sealCredential } from '../../../src/api/routes/treedx/repositories/treedx-credentials-mirrors-and-shares.ts';

function rawPublic(key: ReturnType<typeof generateKeyPairSync>['publicKey']) {
	return Buffer.from(key.export({ format: 'der', type: 'spki' })).subarray(-32);
}

function decrypt(envelope: ReturnType<typeof sealCredential>, privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'], scope: Record<string, string>) {
	const ephemeral = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.from(envelope.ephemeralPublicKey, 'base64')]), format: 'der', type: 'spki' });
	const shared = diffieHellman({ privateKey, publicKey: ephemeral });
	const key = Buffer.from(hkdfSync('sha256', shared, Buffer.from(scope.deliveryId), Buffer.from('treedx-credential-delivery-v1'), 32));
	const decipher = createDecipheriv('chacha20-poly1305', key, Buffer.from(envelope.nonce, 'base64'), { authTagLength: 16 });
	decipher.setAAD(Buffer.from([scope.deliveryId, scope.operation, scope.allowedHost, scope.refspecDigest, scope.nodeId].join('\n')));
	decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
	return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
}

describe('TreeDX credential delivery sealing', () => {
	it('binds each delivery to one Git operation kind and exact scope', () => {
		const delivery = { allowed_host: 'github.com', refspec_digest: 'digest-a', operation_kind: 'fetch' };
		expect(deliveryScopeMatches(delivery, { allowedHost: 'github.com', refspecDigest: 'digest-a', operation: 'fetch' })).toBe(true);
		expect(deliveryScopeMatches(delivery, { allowedHost: 'github.com', refspecDigest: 'digest-a', operation: 'push' })).toBe(false);
		expect(deliveryScopeMatches(delivery, { allowedHost: 'github.com', refspecDigest: 'digest-b', operation: 'fetch' })).toBe(false);
	});

	it('seals a transient credential to one node and exact operation scope', () => {
		const node = generateKeyPairSync('x25519');
		const other = generateKeyPairSync('x25519');
		const scope = { deliveryId: 'delivery-1', operation: 'push', allowedHost: 'github.com', refspecDigest: 'digest-1', nodeId: 'node-1' };
		const envelope = sealCredential(rawPublic(node.publicKey).toString('base64'), { type: 'token', token: 'secret-canary' }, scope);
		expect(JSON.stringify(envelope)).not.toContain('secret-canary');
		expect(decrypt(envelope, node.privateKey, scope)).toEqual({ type: 'token', token: 'secret-canary' });
		expect(() => decrypt(envelope, other.privateKey, scope)).toThrow();
		expect(() => decrypt(envelope, node.privateKey, { ...scope, refspecDigest: 'changed' })).toThrow();
	});
});

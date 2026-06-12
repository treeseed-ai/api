import { describe, expect, it } from 'vitest';
import { decryptHostConfig, encryptHostConfig } from '../../src/crypto/host-crypto.ts';

describe('host credential encryption', () => {
	it('round-trips real secretbox envelopes in the Node API runtime', async () => {
		const config = {
			GH_TOKEN: 'ghp_test_token',
			GITHUB_TOKEN: 'ghp_test_token',
			organizationOrOwner: 'example-org',
		};
		const envelope = await encryptHostConfig(config, 'test passphrase', { opsLimit: 2, memLimit: 8192 });
		expect(envelope.algorithm).toBe('secretbox');
		const decrypted = await decryptHostConfig(envelope, 'test passphrase');
		expect(decrypted).toEqual(config);
	});
});

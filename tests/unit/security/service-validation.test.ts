import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateProviderConnection } from '../../../src/operations-runner/security/service-validation.ts';

afterEach(() => vi.unstubAllGlobals());

describe('provider connection validation', () => {
	it('validates fine-grained GitHub tokens without accepting legacy App private-key input', async () => {
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			expect(init?.headers).toMatchObject({ authorization: 'Bearer fine-grained-token' });
			return new Response('{}', { status: 200 });
		});
		vi.stubGlobal('fetch', fetchMock);

		await validateProviderConnection({ providerId: 'github', nonSecretConfig: { organization: 'example' } }, {
			accessToken: 'fine-grained-token',
		});
		expect(fetchMock).toHaveBeenCalledWith('https://api.github.com/user', expect.any(Object));
		await expect(validateProviderConnection({ providerId: 'github', nonSecretConfig: {} }, {
			privateKey: 'legacy-private-key',
		})).rejects.toThrow(/Connector flow/u);
	});
});

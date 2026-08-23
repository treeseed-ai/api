import { describe, expect, it } from 'vitest';
import { resolveTreeDxProxyBaseUrl } from '../../../../src/api/capacity/services/treedx/repositories/treedx-proxy-token-service.ts';

const binding = (baseUrl: string) => ({ topology: { contentRepository: { treeDx: { baseUrl } } } });

describe('TreeDX proxy connection validation', () => {
	it('requires TLS outside explicit local development', () => {
		expect(() => resolveTreeDxProxyBaseUrl({ env: { NODE_ENV: 'production' } }, binding('http://treedx.internal:4000')))
			.toThrow('require TLS');
		expect(resolveTreeDxProxyBaseUrl({ env: { NODE_ENV: 'production' } }, binding('https://treedx.example.test/service/')))
			.toBe('https://treedx.example.test/service');
	});

	it('allows local HTTP but rejects URL-carried credentials and routing data', () => {
		expect(resolveTreeDxProxyBaseUrl({ env: { TREESEED_ENVIRONMENT: 'local' } }, binding('http://127.0.0.1:4000/')))
			.toBe('http://127.0.0.1:4000');
		for (const value of ['https://user:secret@treedx.example.test', 'https://treedx.example.test?token=secret', 'file:///tmp/treedx']) {
			expect(() => resolveTreeDxProxyBaseUrl({ env: { NODE_ENV: 'production' } }, binding(value))).toThrow('credential-free HTTP service URL');
		}
	});
});

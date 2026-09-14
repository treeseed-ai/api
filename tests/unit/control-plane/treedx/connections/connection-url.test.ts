import { describe, expect, it } from 'vitest';
import { resolveTreeDxServiceUrl } from '../../../../../src/api/control-plane/treedx/connection-url.ts';

describe('TreeDX service URL', () => {
	it('normalizes a manager-owned local container authority', () => {
		expect(resolveTreeDxServiceUrl('treedx:4000', {
			TREESEED_ENVIRONMENT: 'local',
			TREESEED_LOCAL_TREEDX_HOSTS: 'treedx,treedx-api',
		})).toBe('http://treedx:4000');
	});

	it('does not accept a scheme-less authority outside local custody', () => {
		expect(() => resolveTreeDxServiceUrl('treedx:4000', { TREESEED_ENVIRONMENT: 'production' }))
			.toThrow(/invalid: protocol/u);
	});
});

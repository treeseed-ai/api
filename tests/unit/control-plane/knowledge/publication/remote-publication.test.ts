import { describe, expect, it } from 'vitest';
import { treeDxPromotionExpectedHead } from '../../../../../src/operations-runner/knowledge/remote-publication.ts';

describe('remote TreeDX publication', () => {
	it('uses the observed local publication head as the promotion compare-and-swap boundary', () => {
		expect(treeDxPromotionExpectedHead('local-staging', 'reviewed-remote-base')).toBe('local-staging');
	});

	it('uses the reviewed base when the local publication ref does not exist', () => {
		expect(treeDxPromotionExpectedHead(null, 'reviewed-remote-base')).toBe('reviewed-remote-base');
	});
});

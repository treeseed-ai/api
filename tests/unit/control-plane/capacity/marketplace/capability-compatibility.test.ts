import { describe, expect, it } from 'vitest';
import { providerCapabilityCompatibility, usesLegacyCapabilityCompatibility } from '../../../../../src/api/capacity/policy/capability-compatibility.ts';

describe('provider capability compatibility', () => {
	it('adds exact ontology identities for legacy v4 supply', () => {
		expect(providerCapabilityCompatibility(['communication', 'planning', 'repository_work'])).toEqual([
			'communication',
			'treeseed.coordination.conversation',
			'planning',
			'treeseed.coordination.planning',
			'repository_work',
			'treeseed.engineering.repository-analysis',
		]);
	});

	it('preserves exact v5 identities without duplication', () => {
		expect(providerCapabilityCompatibility([
			'treeseed.coordination.conversation',
			'treeseed.coordination.conversation',
		])).toEqual(['treeseed.coordination.conversation']);
	});

	it('limits the no-offer migration bridge to genuinely legacy declarations', () => {
		expect(usesLegacyCapabilityCompatibility(['communication'])).toBe(true);
		expect(usesLegacyCapabilityCompatibility(['treeseed.coordination.conversation'])).toBe(false);
		expect(usesLegacyCapabilityCompatibility([])).toBe(false);
	});
});

import { expect, it } from 'vitest';
import { requireNativeAdmissionSamples } from '../../../../../acceptance/execution-inventory.ts';

it('normal SDK schema accepts cold start and default zero samples while original architecture proof still requires both measured controls', () => {
	for (const counts of [[0, 0], [0, 1], [1, 0], [1, 1], [2, 3]]) {
		expect(() => Reflect.apply(requireNativeAdmissionSamples, undefined, [...counts, false])).not.toThrow();
		if (counts[0]! > 0 && counts[1]! > 0) expect(() => requireNativeAdmissionSamples(counts[0]!, counts[1]!)).not.toThrow();
		else expect(() => requireNativeAdmissionSamples(counts[0]!, counts[1]!)).toThrow(counts[0] === 0 ? 'ACCEPTANCE_PRIORITY_EMPTY' : 'ACCEPTANCE_CALIBRATION_EMPTY');
	}
});

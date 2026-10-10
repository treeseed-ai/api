import { expect, it } from 'vitest';
import { requireNativeAdmissionSamples } from '../../../../../acceptance/execution-inventory.ts';

it('normal SDK schema accepts cold start and default zero samples while original architecture proof still requires both measured controls', () => {
	for (const counts of [[0, 0], [0, 1], [1, 0], [1, 1], [2, 3]]) {
		expect(() => requireNativeAdmissionSamples(counts[0]!, counts[1]!, false)).not.toThrow();
		if (counts[0]! > 0 && counts[1]! > 0) expect(() => requireNativeAdmissionSamples(counts[0]!, counts[1]!)).not.toThrow();
		else expect(() => requireNativeAdmissionSamples(counts[0]!, counts[1]!)).toThrow(counts[0] === 0 ? 'ACCEPTANCE_PRIORITY_EMPTY' : 'ACCEPTANCE_CALIBRATION_EMPTY');
	}
});

it('denies missing malformed negative fractional or unbounded native sample counts and unknown case scope without converting failed observations', () => {
	for (const mode of [false, true]) for (const invalid of [undefined, null, '', '0', -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, {}, []]) {
		for (const counts of [[invalid, 1], [1, invalid]]) {
			const held = structuredClone(counts);
			expect(() => requireNativeAdmissionSamples(counts[0] as number, counts[1] as number, mode)).toThrow('ACCEPTANCE_SCHEMA_SAMPLES');
			expect(counts).toEqual(held);
		}
	}
	for (const invalid of [null, '', 'sdk', 0, 1, {}, []]) expect(() => requireNativeAdmissionSamples(1, 1, invalid as boolean)).toThrow('ACCEPTANCE_SCHEMA_SAMPLES');
	expect(() => requireNativeAdmissionSamples(1, 1)).not.toThrow();
});

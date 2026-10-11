import { expect, it } from 'vitest';
import { requireNativeAdmissionSamples, executionCliReadArguments } from '../../../../../acceptance/execution-inventory.ts';

it('schema reader retains exact public library ref without unsupported server or team selectors through repeated readback', () => {
	const args = ['library', 'read', 'original-project', 'proposals/current.mdx', '--ref', 'a'.repeat(40)], held = [...args];
	for (let retry = 0; retry < 2; retry++) expect.soft(executionCliReadArguments(args, 'original-team')).toEqual([...args, '--json']);
	expect(args).toEqual(held);
});

it('schema reader preserves original local server and team scope on canonical workday assignment and inventory reads', () => {
	for (const args of [['workdays', 'show', 'original-workday'], ['assignments', 'show', 'original-attempt'],
		['capacity', 'reservations', 'list', '--workday', 'original-workday', '--limit', '200']]) {
		const held = [...args]; expect(executionCliReadArguments(args, 'original-team')).toEqual([...args, '--server', 'local', '--team', 'original-team', '--json']);
		expect(args).toEqual(held);
	}
});

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

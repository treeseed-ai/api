import { describe, expect, it } from 'vitest';
import { acceptedLibraryRevision, canonicalWorkdayShares } from '../../../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-scheduling-service.ts';
import { parsePublicWorkdayIntent } from '../../../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-preflight-service.ts';
const intent = { schemaVersion: 'treeseed.workday-intent/v1', teamId: 'team', profileId: 'default', projects: ['project'],
	executionMode: 'simulation', startsAt: '2026-10-03T00:00:00.000Z', durationSeconds: 60, planningOnly: true };

describe('first-start compiler authority before native admission', () => {
	it('normalizes repeated public decision selectors in exact code point order without deriving authority or changing omitted planning controls', () => {
		const expected = ['A', 'Z', 'a', 'e\u0301', 'é', '\uE000', '\u{10000}'];
		const permutations = [expected, [...expected].reverse(), ['\u{10000}', 'é', 'A', '\uE000', 'e\u0301', 'a', 'Z']];
		for (const planningOnly of [false, true]) {
			for (const permutation of permutations) {
				const input = { ...intent, planningOnly, decisionIds: [...permutation.map(id => ` ${id} `), 'A', ' A '] };
				const before = structuredClone(input);
				expect(parsePublicWorkdayIntent('team', input)).toEqual({ ...intent, planningOnly, decisionIds: expected });
				expect(input).toEqual(before);
			}
			const omitted = { ...intent, planningOnly }, before = structuredClone(omitted);
			const parsed = parsePublicWorkdayIntent('team', omitted);
			expect(parsed).toEqual(omitted); expect(Object.hasOwn(parsed, 'decisionIds')).toBe(false); expect(omitted).toEqual(before);
		}
		for (const decisionIds of [Array.from({ length: 64 }, (_, index) => `decision-${String(index).padStart(2, '0')}`), ['x'.repeat(128)]]) {
			const input = { ...intent, decisionIds }, before = structuredClone(input);
			expect(parsePublicWorkdayIntent('team', input)).toEqual(input); expect(input).toEqual(before);
		}
	});
	it('rejects every malformed mixed decision selector and named caller derived identity before normalization can discard it', () => {
		const malformed = [[], [''], [' \t\n '], ['valid', ''], ['valid', ' '], ['valid', null], ['valid', 1],
			['valid', {}], ['valid', []], null, 'valid', Array.from({ length: 65 }, (_, index) => `decision-${index}`), ['x'.repeat(129)]];
		for (const decisionIds of malformed) {
			const input = { ...intent, decisionIds }, before = structuredClone(input);
			expect(() => parsePublicWorkdayIntent('team', input)).toThrow(expect.objectContaining({ status: 400, code: 'workday_intent_invalid' }));
			expect(input).toEqual(before);
		}
		for (const field of ['executionPlanId', 'capacityPlanId', 'executionInputId', 'demandSetId']) {
			for (const value of [undefined, null, '', 'invented', { id: 'invented' }]) {
				const input = { ...intent, [field]: value }, before = structuredClone(input);
				expect(Object.hasOwn(input, field)).toBe(true);
				expect(() => parsePublicWorkdayIntent('team', input)).toThrow(expect.objectContaining({ status: 400, code: 'workday_intent_derived_fields_forbidden' }));
				expect(input).toEqual(before); expect(Object.hasOwn(input, field)).toBe(true);
			}
		}
	});
	it('requires one exact immutable library commit and denies absent malformed or moving revision authority without changing inputs', () => {
		const exact = { contentRepositoryRef: 'a'.repeat(40), metadata: { resolvedRef: 'a'.repeat(40) } }, before = structuredClone(exact);
		expect(acceptedLibraryRevision(exact, 'project')).toBe('a'.repeat(40)); expect(exact).toEqual(before);
		const mutations = [{}, { contentRepositoryRef: 'staging' }, { metadata: { resolvedRef: '' } },
			{ metadata: { resolvedRef: 1 } }, { metadata: { resolvedRef: 'a'.repeat(39) } }, { metadata: { resolvedRef: 'G'.repeat(40) } }];
		for (const input of mutations) { const original = structuredClone(input); expect(() => acceptedLibraryRevision(input, 'project')).toThrow(); expect(input).toEqual(original); }
	});
	it('resolves selected project shares once and denies foreign or duplicate alias allocation without manufacturing another authority', () => {
		const projects = [{ id: 'project', slug: 'arbitrary-project' }], input = { projectPercentages: { 'arbitrary-project': 100 }, agentClassPercentages: { project: { 'boundary-planner': 100 } } };
		const before = structuredClone({ projects, input }); expect(canonicalWorkdayShares(input, projects)).toEqual({ projectPercentages: { project: 100 }, agentClassPercentages: { project: { 'boundary-planner': 100 } } });
		expect({ projects, input }).toEqual(before);
		for (const allocation of [{ projectPercentages: { foreign: 100 } }, { projectPercentages: { project: 50, 'arbitrary-project': 50 } },
			{ agentClassPercentages: { foreign: { 'boundary-planner': 100 } } }]) expect(() => canonicalWorkdayShares(allocation, projects)).toThrow();
	});
	it('preserves identical public manual and nested recurring intent mode selection and original time authority', () => {
		const original = structuredClone(intent), manual = parsePublicWorkdayIntent('team', original);
		const recurring = { intent: structuredClone(original), cadenceSeconds: 60 };
		expect(parsePublicWorkdayIntent('team', recurring.intent)).toEqual(manual); expect(original).toEqual(intent);
		for (const mode of ['production', 'simulation']) expect(parsePublicWorkdayIntent('team', { ...original, executionMode: mode }).executionMode).toBe(mode);
		for (const field of ['assignmentSeconds', 'nativeUsage', 'lease', 'providerReceiptRefs', 'executionModeAuthority']) {
			expect(() => parsePublicWorkdayIntent('team', { ...original, [field]: 'invented' })).toThrow();
		}
	});
});

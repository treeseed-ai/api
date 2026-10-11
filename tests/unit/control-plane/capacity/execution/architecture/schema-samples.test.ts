import { expect, it } from 'vitest';
import { compileWorkday, DEFAULT_WORKDAY_POLICY } from '@treeseed/sdk/agent-capacity';
import { requireNativeAdmissionSamples, executionCliReadArguments, executionLibraryResult, verifyNativeWorkdayReadback } from '../../../../../acceptance/execution-inventory.ts';

it('native Workday readback retains exact production and simulation mode and original parameters without repairing authority', () => {
	for (const executionMode of ['simulation', 'production']) {
		const run = { id: 'original-workday', teamId: 'original-team', status: 'completed', executionMode, parameters: { durationSeconds: 600 } };
		const native = [{ id: run.id, team_id: run.teamId, status: run.status, execution_mode: executionMode, parameters_json: JSON.stringify(run.parameters) }];
		const before = structuredClone({ native, run }); verifyNativeWorkdayReadback(native, run); expect({ native, run }).toEqual(before);
	}
});

it('native Workday readback denies missing malformed or contradictory mode even when every other public and native field agrees', () => {
	for (const executionMode of [undefined, null, '', 'simulation ', 'production ', 'unknown', false, 0, {}, []]) {
		const run = { id: 'original-workday', teamId: 'original-team', status: 'completed', executionMode, parameters: {} };
		const native = [{ id: run.id, team_id: run.teamId, status: run.status, execution_mode: executionMode, parameters_json: '{}' }];
		const before = structuredClone({ native, run }); expect.soft(() => verifyNativeWorkdayReadback(native, run)).toThrow(); expect({ native, run }).toEqual(before);
	}
	for (const executionMode of ['simulation', 'production']) {
		const run = { id: 'original-workday', teamId: 'original-team', status: 'completed', executionMode, parameters: {} };
		const native = [{ id: run.id, team_id: run.teamId, status: run.status, execution_mode: executionMode === 'simulation' ? 'production' : 'simulation', parameters_json: '{}' }];
		const before = structuredClone({ native, run }); expect.soft(() => verifyNativeWorkdayReadback(native, run)).toThrow(); expect({ native, run }).toEqual(before);
	}
});

it('native Workday readback denies foreign identity duplicate parameter mode and differing original parameters without accepting matching duplicate authority', () => {
	for (const mode of ['foreign-id', 'duplicate-mode', 'parameters', 'malformed-parameters', 'array-parameters', 'invalid-json', 'missing-parameters', 'foreign-team', 'foreign-status', 'empty-native', 'duplicate-native']) {
		const run = { id: 'original-workday', teamId: 'original-team', status: 'completed', executionMode: 'simulation', parameters: { durationSeconds: 600 } as Record<string, unknown> };
		const native: Record<string, unknown>[] = [{ id: run.id, team_id: run.teamId, status: run.status, execution_mode: run.executionMode, parameters_json: JSON.stringify(run.parameters) }];
		if (mode === 'foreign-id') native[0]!.id = 'foreign-workday';
		if (mode === 'duplicate-mode') { run.parameters.executionMode = run.executionMode; native[0]!.parameters_json = JSON.stringify(run.parameters); }
		if (mode === 'parameters') native[0]!.parameters_json = '{"durationSeconds":601}';
		if (mode === 'malformed-parameters') native[0]!.parameters_json = 'null';
		if (mode === 'array-parameters') native[0]!.parameters_json = '[]';
		if (mode === 'invalid-json') native[0]!.parameters_json = '{';
		if (mode === 'missing-parameters') native[0]!.parameters_json = undefined;
		if (mode === 'foreign-team') native[0]!.team_id = 'foreign';
		if (mode === 'foreign-status') native[0]!.status = 'running';
		if (mode === 'empty-native') native.length = 0;
		if (mode === 'duplicate-native') native.push({ ...native[0]! });
		const before = structuredClone({ native, run }); expect.soft(() => verifyNativeWorkdayReadback(native, run)).toThrow(); expect({ native, run }).toEqual(before);
	}
});

it('schema priority source retains the single supported public library result and rejects raw compatibility fallback without repair', () => {
	const result = { ok: true, resolvedRef: 'a'.repeat(40), files: [{ path: 'proposals/current.mdx', content: 'original bytes' }] };
	const supplied = { result, receipt: { projectId: 'original-project' } }, held = structuredClone(supplied);
	expect(executionLibraryResult(supplied)).toBe(result); expect(supplied).toEqual(held);
	for (const value of [result, {}, { result: null }, { result: [] }, { result: '' }, { result: { ...result, ok: false } }]) {
		const before = structuredClone(value); expect.soft(() => executionLibraryResult(value)).toThrow('ACCEPTANCE_LIBRARY_RESULT'); expect(value).toEqual(before);
	}
});

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

it('native Workday readback reconciles original applied plan with independently measured reservation shares and rejects altered totals or source parameters', () => {
	const plan = compileWorkday({ id: 'original-workday', teamId: 'original-team', policyId: 'default', policyRevision: 1,
		executionMode: 'simulation', startsAt: '2026-09-16T12:00:00.000Z', agentIds: [], policy: { ...DEFAULT_WORKDAY_POLICY,
			durationSeconds: 600, maximumConcurrency: 1, communicationConcurrency: 1 } });
	const shares = [{ project_id: 'sdk', agent_class: 'engineer', admitted_seconds: '180' }, { project_id: 'sdk', agent_class: 'tester', admitted_seconds: '90' }];
	const run = { id: plan.id, teamId: plan.teamId, status: 'completed', executionMode: 'simulation', parameters: { durationSeconds: 600,
		appliedPlan: { ...plan, admittedSecondsByProject: { sdk: 270 }, admittedSecondsByAgentClass: { 'sdk:engineer': 180, 'sdk:tester': 90 } } } };
	const native = [{ id: run.id, team_id: run.teamId, status: run.status, execution_mode: run.executionMode, parameters_json: JSON.stringify({ durationSeconds: 600, appliedPlan: plan }) }];
	const before = structuredClone({ native, run, shares });
	for (const change of [{ id: 'foreign' }, { teamId: 'foreign' }, { executionMode: 'production' }]) {
		const changed = [{ ...native[0]!, parameters_json: JSON.stringify({ durationSeconds: 600, appliedPlan: { ...plan, ...change } }) }];
		const visible = { ...run, parameters: { ...run.parameters, appliedPlan: { ...run.parameters.appliedPlan, ...change } } };
		const failed = structuredClone({ changed, visible });
		expect(() => verifyNativeWorkdayReadback(changed, visible, shares)).toThrow(); expect({ changed, visible }).toEqual(failed);
	}
	expect(() => verifyNativeWorkdayReadback(native, run)).toThrow('Independent reservation shares required');
	expect(() => verifyNativeWorkdayReadback(native, run, [...shares, shares[0]!])).toThrow();
	verifyNativeWorkdayReadback(native, run, shares);
	for (const changed of [{ ...run, parameters: { ...run.parameters, appliedPlan: { ...run.parameters.appliedPlan, admittedSecondsByProject: { sdk: 269 } } } },
		{ ...run, parameters: { ...run.parameters, appliedPlan: { ...run.parameters.appliedPlan, policyRevision: 2 } } }]) {
		const failed = structuredClone(changed); expect.soft(() => verifyNativeWorkdayReadback(native, changed, shares)).toThrow(); expect(changed).toEqual(failed);
	}
	for (const invalid of ['', '0x10', '-1', 'Infinity', false, null, {}, []]) expect.soft(() => verifyNativeWorkdayReadback(native, run,
		[{ ...shares[0]!, admitted_seconds: invalid }])).toThrow();
	expect({ native, run, shares }).toEqual(before);
});

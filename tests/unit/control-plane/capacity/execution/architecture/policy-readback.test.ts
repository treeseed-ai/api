import { expect, it } from 'vitest';
import { compileWorkday, DEFAULT_WORKDAY_POLICY } from '@treeseed/sdk/agent-capacity';
import { canonicalJson, sha256 } from '../../../../../../src/api/capacity/security.ts';
import { verifyNativeWorkdayPolicy } from '../../../../../acceptance/execution-inventory.ts';

function fixture() {
	const intent = { profileId: 'default', teamId: 'team', projects: ['sdk'], executionMode: 'simulation',
		allocation: { planningPercent: 40, projectPercentages: { sdk: 1 }, agentClassPercentages: { sdk: { engineer: 1 } } } };
	const parameters = { ...DEFAULT_WORKDAY_POLICY, ...intent.allocation, policyId: 'default', profileId: 'default', policyRevision: 3 };
	const plan = compileWorkday({ id: 'workday', teamId: 'team', executionMode: 'simulation', policyId: 'default', policyRevision: 3,
		startsAt: '2026-10-11T12:00:00.000Z', agentIds: [], policy: { ...DEFAULT_WORKDAY_POLICY, ...intent.allocation,
			projectPercentages: { project: 1 }, agentClassPercentages: { project: { engineer: 1 } } } });
	const payload = { id: 'preflight', teamId: 'team', profileId: 'default', profileGeneration: 3, profileVersion: 'revision-3',
		intentDigest: `sha256:${sha256(canonicalJson(intent))}` };
	const preflight = { ...payload, preflightDigest: `sha256:${sha256(canonicalJson(payload))}` };
	const stored = { receipt: preflight, intent, runInput: { id: plan.id, executionMode: 'simulation', parameters } };
	const native = [{ id: 'native-preflight', team_id: 'team', operation: 'workday.preflight', resource_type: 'workday_preflight',
		resource_id: preflight.id, idempotency_key: preflight.id, request_digest: preflight.intentDigest, response_json: canonicalJson(stored) }];
	const run = { id: plan.id, teamId: 'team', executionMode: 'simulation', parameters: { ...parameters, appliedPlan: plan } };
	return { native, run, preflight, projects: [{ id: 'project', slug: 'sdk' }], stored };
}

it('original native preflight binds default revision and resolved overrides through canonical project aliases without input mutation', () => {
	const f = fixture(), held = structuredClone(f);
	verifyNativeWorkdayPolicy(f.native, f.run, f.preflight, f.projects);
	verifyNativeWorkdayPolicy(f.native, f.run, f.preflight, f.projects);
	expect(f).toEqual(held);
});

it('original native policy custody rejects missing duplicate foreign malformed or altered preflight observations and retains denied evidence', () => {
	const f = fixture();
	for (const rows of [[], [...f.native, ...f.native], ...[
		{ team_id: 'foreign' }, { operation: 'other' }, { resource_type: 'other' }, { resource_id: 'other' },
		{ idempotency_key: 'other' }, { request_digest: 'other' }, { response_json: '{' }, { response_json: 'null' },
		{ response_json: '[]' }, { response_json: '{}' },
	].map(change => [{ ...f.native[0]!, ...change }])]) {
		const held = structuredClone(rows); expect.soft(() => verifyNativeWorkdayPolicy(rows, f.run, f.preflight, f.projects)).toThrow();
		expect(rows).toEqual(held);
	}
	for (const change of [{ receipt: { ...f.preflight, profileGeneration: 4 } }, { intent: { ...f.stored.intent, profileId: 'other' } },
		{ runInput: { ...f.stored.runInput, id: 'other' } }, { runInput: { ...f.stored.runInput, executionMode: 'production' } },
		...['policyId', 'profileId', 'policyRevision', ...Object.keys(DEFAULT_WORKDAY_POLICY)].map(key => ({ runInput: {
			...f.stored.runInput, parameters: Object.fromEntries(Object.entries(f.stored.runInput.parameters).filter(([name]) => name !== key)),
		} }))]) {
		const rows = [{ ...f.native[0]!, response_json: canonicalJson({ ...f.stored, ...change }) }], held = structuredClone(rows);
		expect.soft(() => verifyNativeWorkdayPolicy(rows, f.run, f.preflight, f.projects)).toThrow(); expect(rows).toEqual(held);
	}
});

it('original native policy custody denies an altered issued revision or allocation even when native and public later records could agree', () => {
	const f = fixture();
	for (const change of [{ policyRevision: 4 }, { policyId: 'other' },
		...Object.keys(DEFAULT_WORKDAY_POLICY).map(key => ({ policySnapshot: { ...f.run.parameters.appliedPlan.policySnapshot, [key]:
			key === 'projectPercentages' ? { project: 2 } : key === 'agentClassPercentages' ? { project: { engineer: 2 } } : 999 } }))]) {
		const run = { ...f.run, parameters: { ...f.run.parameters, appliedPlan: { ...f.run.parameters.appliedPlan, ...change } } }, held = structuredClone(run);
		expect.soft(() => verifyNativeWorkdayPolicy(f.native, run, f.preflight, f.projects)).toThrow(); expect(run).toEqual(held);
	}
	for (const projects of [[], [{ id: 'foreign', slug: 'other' }], [{ id: 'project', slug: 'other' }]]) {
		const held = structuredClone(projects); expect(() => verifyNativeWorkdayPolicy(f.native, f.run, f.preflight, projects)).toThrow(); expect(projects).toEqual(held);
	}
});

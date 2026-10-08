import { describe, expect, it } from 'vitest';
import { appliedWorkdaySchema } from '@treeseed/sdk/agent-capacity';
import { schedulingInputs } from './relation-scheduling-fixture.ts';
import { buildAssignmentAttempt } from '../../../../../../src/api/capacity/services/capacity/assignments/planning/execution/assignment-attempt-builder.ts';
import { canonicalOfferBuildInput } from '../../../capacity/execution/fixtures/assignment-attempt-fixtures.ts';

describe('cross-project dependent assignment construction', () => {
	it('retains the original UTC day and phase bounds for positive whole-second supply and denies subsecond supply without changing governed inputs', () => {
		for (const [now, seconds, deadline] of [
			['2026-10-04T12:00:00.000Z', 3, '2026-10-04T12:00:40.000Z'],
			['2026-10-04T23:59:58.999Z', 1, '2026-10-05T00:00:00.000Z'],
			['2026-10-04T23:59:59.000Z', 1, '2026-10-05T00:00:00.000Z'],
			['2026-10-05T00:00:00.000Z', 3, '2026-10-05T00:00:40.000Z'],
		] as const) {
			const input = canonicalOfferBuildInput(now), before = structuredClone(input), result = buildAssignmentAttempt(input);
			expect(result.allocation.allocatedSeconds).toBe(seconds);
			expect(result.assignment.deadline).toBe(deadline);
			expect(result.assignment.limits.maximumSeconds).toBe(seconds);
			expect(input).toEqual(before);
		}
		for (const now of ['2026-10-04T23:59:59.001Z', '2026-10-04T23:59:59.999Z']) {
			const input = canonicalOfferBuildInput(now), before = structuredClone(input);
			expect(() => buildAssignmentAttempt(input)).toThrowError(expect.objectContaining({
				status: 409, code: 'capacity_assignment_allocation_deferred',
				details: { nodeId: input.candidate.node.id, providers: [{ providerId: 'codex', allocation: expect.objectContaining({
					admitted: false, allocatedSeconds: 0, limitingConstraint: 'utc-day-window',
					constraints: expect.arrayContaining([{ id: 'utc-day-window', remainingSeconds: (Date.parse('2026-10-05T00:00:00.000Z') - Date.parse(now)) / 1000 }]),
				}) }] },
			}));
			expect(input).toEqual(before);
		}
	});
	it('selects only the explicit primary repository for writes in either citation order and denies absent or ambiguous primary authority without rewriting inputs', () => {
		for (const reversed of [false, true]) {
			const input = schedulingInputs(); input.candidate.sourceRepositories = ['treeseed-ai/sdk'];
			if (reversed) input.candidate.contextRefs.reverse();
			const before = structuredClone(input), { assignment } = buildAssignmentAttempt(input);
			expect(assignment.workspace).toMatchObject({ mode: 'git', repository: 'treeseed-ai/sdk', baseCommit: 'c'.repeat(40) });
			expect(assignment.grant.sourceWrite).toEqual(['treeseed-ai/sdk']);
			expect(assignment.grant.sourceRead).toEqual(expect.arrayContaining(['treeseed-ai/sdk', 'treeseed-ai/precursor']));
			expect(assignment.contextRefs).toEqual(expect.arrayContaining(input.candidate.contextRefs)); expect(input).toEqual(before);
		}
		for (const sources of [[], ['missing-primary'], ['treeseed-ai/sdk', 'treeseed-ai/precursor'], ['treeseed-ai/sdk', 'treeseed-ai/sdk']]) {
			const input = schedulingInputs(); input.candidate.sourceRepositories = sources; const before = structuredClone(input);
			expect(() => buildAssignmentAttempt(input)).toThrowError(expect.objectContaining({ status: 409, code: 'assignment_source_repository_required' }));
			expect(input).toEqual(before);
		}
	});
	it('denies missing malformed and legacy partial provider offers before constructing an immutable governed assignment', () => {
		const partial = { offerId: 'legacy-partial-offer', capabilities: [{ id: 'code-change' }] };
		const invalid: unknown[] = [undefined, null, [], {}, 'legacy', [partial],
			[{ ...partial, offerId: '' }], [{ capabilities: partial.capabilities }],
			[{ ...partial, capabilities: null }], [null, partial], [partial, structuredClone(partial)]];
		for (const offers of invalid) {
			const input = schedulingInputs(); Object.assign(input.providers[0]!, { offers });
			const before = structuredClone(input);
			for (const supplied of [input, structuredClone(input)]) {
				expect(() => buildAssignmentAttempt(supplied)).toThrowError(expect.objectContaining({
					status: 409, code: 'capacity_execution_provider_unavailable',
				}));
				expect(supplied).toEqual(before);
			}
			expect(input).toEqual(before);
		}
	});
	it('retains both exact predecessor results as read context while granting writes only to the original sole primary Git workspace', () => {
		const input = schedulingInputs(), before = structuredClone(input), { assignment } = buildAssignmentAttempt(input);
		expect(assignment.predecessorResultIds).toEqual(input.candidate.predecessorResults.map(value => value.id));
		expect(assignment.contextRefs).toEqual(expect.arrayContaining(input.candidate.contextRefs));
		expect(assignment.grant.contentWrite).toEqual([]); expect(assignment.grant.sourceWrite).toEqual(['treeseed-ai/sdk']);
		expect(assignment.workspace).toMatchObject({ mode: 'git', repository: 'treeseed-ai/sdk', baseCommit: 'c'.repeat(40) });
		expect(assignment.grant.contentRead).toContainEqual(expect.objectContaining({ id: 'precursor-approval', repository: 'precursor-library', commit: 'd'.repeat(40) }));
		expect(input).toEqual(before);
	});
	it('denies secondary content writes and every permission outside the exact configured dependent profile before assignment construction', () => {
		const mutations: Array<(value: ReturnType<typeof schedulingInputs>) => void> = [
			value => { value.candidate.node.requestedPermissions!.content.write = ['decision']; },
			value => { Object.assign(value.candidate.node.requestedPermissions!, { tools: [...value.candidate.node.requestedPermissions!.tools, 'unapproved-tool'] }); },
			value => { value.candidate.effectiveProfile.permissionCeiling.content.read = ['proposal']; },
		];
		for (const mutate of mutations) { const input = schedulingInputs(); mutate(input); const before = structuredClone(input); expect(() => buildAssignmentAttempt(input)).toThrow(); expect(input).toEqual(before); }
	});
	it('denies malformed failed and duplicate predecessor records rather than freezing incomplete or contradictory dependency evidence', () => {
		const mutations: Array<(value: ReturnType<typeof schedulingInputs>) => void> = [
			value => { value.candidate.predecessorResults[0]!.status = 'failed'; },
			value => { value.candidate.predecessorResults[1]!.assignmentId = ''; },
			value => { value.candidate.predecessorResults.push(structuredClone(value.candidate.predecessorResults[0]!)); },
			value => { value.candidate.predecessorResults[0]!.id = value.candidate.predecessorResults[1]!.id; },
		];
		for (const mutate of mutations) { const input = schedulingInputs(); mutate(input); const before = structuredClone(input); expect(() => buildAssignmentAttempt(input)).toThrow(); expect(input).toEqual(before); }
	});
	it('denies elapsed original workday and stale provider observation without extending the dependent estimate window or changing predecessor custody', () => {
		const elapsed = schedulingInputs(); elapsed.now = appliedWorkdaySchema.parse(elapsed.run.parameters.appliedPlan).endsAt;
		const stale = schedulingInputs(); stale.providers[0]!.accountingObservation!.modelUsage.observedAt = '2026-09-12T12:00:00Z';
		for (const input of [elapsed, stale]) { const before = structuredClone(input); expect(() => buildAssignmentAttempt(input)).toThrow(); expect(input).toEqual(before); }
	});
});

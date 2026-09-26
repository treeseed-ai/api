import { describe, expect, it } from 'vitest';
import { integrateAssignmentEstimate, mergeAssignmentEstimate } from '../../../../../src/api/capacity/services/capacity/assignments/planning/estimates/integration.ts';

const estimate = { minimumSeconds: 100, expectedSeconds: 200, maximumSeconds: 300, rationale: 'Exact source inspection.' };
const frozen = { id: 'proposal-1', projectId: 'project-1', status: 'draft', executionPlan: { workItems: [
	{ id: 'research', agentClass: 'researcher', review: 'required', objective: 'Inspect the source.' },
	{ id: 'implementation', agentClass: 'engineer', review: 'required', objective: 'Implement the contract.' },
] } };
const candidate = { ...frozen, executionPlan: { workItems: [
	frozen.executionPlan.workItems[0], { ...frozen.executionPlan.workItems[1], estimate },
] } };

describe('exact estimator result integration', () => {
	it('preserves all six golden owner estimates and six reviews regardless of Reviewer publication order', () => {
		const classes = ['researcher', 'architect', 'tester', 'engineer', 'technical-writer', 'releaser'];
		const source = { id: 'golden', status: 'draft', executionPlan: { workItems: classes.map((agentClass, index) =>
			({ id: `work-${index}`, agentClass, review: 'required', objective: `Frozen objective ${index}` })) } };
		for (let reviewerPosition = 0; reviewerPosition <= classes.length; reviewerPosition += 1) {
			const order = [...classes];
			order.splice(reviewerPosition, 0, 'reviewer');
			let current: Record<string, unknown> = source;
			for (const agentClass of order) {
				const field = agentClass === 'reviewer' ? 'reviewEstimate' : 'estimate';
				// Every isolated workspace starts from the same frozen estimate-free proposal.
				const contribution = { ...source, executionPlan: { workItems: source.executionPlan.workItems.map((item) =>
					agentClass === 'reviewer' || item.agentClass === agentClass
						? { ...item, [field]: { ...estimate, rationale: `${agentClass}: ${item.id}` } } : item) } };
				current = mergeAssignmentEstimate({ frozen: source, candidate: contribution, current, agentClass });
				expect(mergeAssignmentEstimate({ frozen: source, candidate: contribution, current, agentClass })).toEqual(current);
			}
			const items = (current.executionPlan as { workItems: Array<Record<string, unknown>> }).workItems;
			expect(items).toHaveLength(6);
			for (const [index, item] of items.entries()) {
				expect(item.estimate).toEqual({ ...estimate, rationale: `${classes[index]}: work-${index}` });
				expect(item.reviewEstimate).toEqual({ ...estimate, rationale: `reviewer: work-${index}` });
				expect(item.objective).toBe(`Frozen objective ${index}`);
			}
		}
	});
	it('merges only the assigned estimate while preserving another completed estimate', () => {
		const prior = { minimumSeconds: 60, expectedSeconds: 120, maximumSeconds: 180, rationale: 'Research evidence.' };
		const current = { ...frozen, executionPlan: { workItems: [
			{ ...frozen.executionPlan.workItems[0], estimate: prior }, frozen.executionPlan.workItems[1],
		] } };
		const merged = mergeAssignmentEstimate({ frozen, candidate, current, agentClass: 'engineer' });
		expect(merged.executionPlan).toEqual({ workItems: [
			{ ...frozen.executionPlan.workItems[0], estimate: prior },
			{ ...frozen.executionPlan.workItems[1], estimate },
		] });
		expect(mergeAssignmentEstimate({ frozen, candidate, current: merged, agentClass: 'engineer' })).toEqual(merged);
	});
	it('rejects unrelated content and lets a later class-owned planning turn refine its estimate', () => {
		expect(() => mergeAssignmentEstimate({ frozen, candidate: { ...candidate, title: 'New authority' }, current: frozen,
			agentClass: 'engineer' })).toThrow('outside its assigned estimate');
		const current = { ...frozen, executionPlan: { workItems: [frozen.executionPlan.workItems[0],
			{ ...frozen.executionPlan.workItems[1], estimate: { ...estimate, expectedSeconds: 250 } }] } };
		expect((mergeAssignmentEstimate({ frozen, candidate, current, agentClass: 'engineer' }).executionPlan as {
			workItems: Array<{ estimate?: unknown }>;
		}).workItems[1]?.estimate).toEqual(estimate);
	});
	it('rejects missing, mistargeted, or changed work items', () => {
		expect(() => mergeAssignmentEstimate({ frozen, candidate: frozen, current: frozen,
			agentClass: 'engineer' })).toThrow('structured estimate');
		expect(() => mergeAssignmentEstimate({ frozen, candidate, current: frozen,
			agentClass: 'unknown' })).toThrow('class-owned frozen proposal work items');
		const changed = { ...frozen, executionPlan: { workItems: [frozen.executionPlan.workItems[0],
			{ ...frozen.executionPlan.workItems[1], objective: 'Changed objective.' }] } };
		expect(() => mergeAssignmentEstimate({ frozen, candidate, current: changed,
			agentClass: 'engineer' })).toThrow('no longer match');
	});
	it('merges Reviewer estimates for every work item without replacing actor estimates', () => {
		const current = { ...frozen, executionPlan: { workItems: [
			{ ...frozen.executionPlan.workItems[0], estimate }, frozen.executionPlan.workItems[1],
		] } };
		const reviewEstimate = { ...estimate, rationale: 'Independent review of the work.' };
		const reviewCandidate = { ...frozen, executionPlan: { workItems: frozen.executionPlan.workItems.map((item) =>
			({ ...item, reviewEstimate })) } };
		const merged = mergeAssignmentEstimate({ frozen, candidate: reviewCandidate, current, agentClass: 'reviewer' });
		expect((merged.executionPlan as { workItems: unknown[] }).workItems).toEqual([
			{ ...current.executionPlan.workItems[0], reviewEstimate },
			{ ...current.executionPlan.workItems[1], reviewEstimate },
		]);
		expect(() => mergeAssignmentEstimate({ frozen, candidate: { ...reviewCandidate,
			executionPlan: { workItems: [reviewCandidate.executionPlan.workItems[0], frozen.executionPlan.workItems[1]] } },
			current, agentClass: 'reviewer' })).toThrow('each assigned work item');
	});
	it('accepts one class contribution for multiple owned work items and rejects a partial contribution', () => {
		const extra = { id: 'integration', agentClass: 'engineer', review: 'required', objective: 'Integrate the contract.' };
		const source = { ...frozen, executionPlan: { workItems: [...frozen.executionPlan.workItems, extra] } };
		const two = { ...source, executionPlan: { workItems: [source.executionPlan.workItems[0],
			{ ...source.executionPlan.workItems[1], estimate }, { ...extra, estimate }] } };
		expect((mergeAssignmentEstimate({ frozen: source, candidate: two, current: source,
			agentClass: 'engineer' }).executionPlan as { workItems: Array<{ estimate?: unknown }> }).workItems.filter((item) => item.estimate)).toHaveLength(2);
		const partial = { ...source, executionPlan: { workItems: [source.executionPlan.workItems[0],
			{ ...source.executionPlan.workItems[1], estimate }, extra] } };
		expect(() => mergeAssignmentEstimate({ frozen: source, candidate: partial, current: source,
			agentClass: 'engineer' })).toThrow('each assigned work item');
	});
	it('rejects a racing estimator result before reading or writing a closed proposal', async () => {
		let reads = 0;
		const store = { getGovernanceProposal: async () => ({ id: 'proposal-1', projectId: 'project-1', teamId: 'team-1', status: 'accepted' }),
			getProjectTreeDxLibrary: async () => { reads += 1; return null; } };
		const assignment = { id: 'assignment-1', projectId: 'project-1', teamId: 'team-1', agentId: 'sdk/engineer',
			assignmentAttempt: { effectiveProfile: { activity: 'estimating' }, sourceRef: { model: 'proposal', id: 'proposal-1' } } };
		await expect(integrateAssignmentEstimate(store as never, assignment as never, { references: [] } as never))
			.rejects.toThrow('after voting or decision');
		expect(reads).toBe(0);
	});
});

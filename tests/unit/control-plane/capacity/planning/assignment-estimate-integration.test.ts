import { describe, expect, it } from 'vitest';
import { integrateAssignmentEstimate, mergeAssignmentEstimate } from '../../../../../src/api/capacity/services/capacity/assignments/planning/estimates/integration.ts';

const estimate = { minimumSeconds: 100, expectedSeconds: 200, maximumSeconds: 300, rationale: 'Exact source inspection.' };
const frozen = { id: 'proposal-1', projectId: 'project-1', status: 'draft', executionPlan: { workItems: [
	{ id: 'research', objective: 'Inspect the source.' },
	{ id: 'implementation', objective: 'Implement the contract.' },
] } };
const candidate = { ...frozen, executionPlan: { workItems: [
	frozen.executionPlan.workItems[0], { ...frozen.executionPlan.workItems[1], estimate },
] } };

describe('exact estimator result integration', () => {
	it('merges only the assigned estimate while preserving another completed estimate', () => {
		const prior = { minimumSeconds: 60, expectedSeconds: 120, maximumSeconds: 180, rationale: 'Research evidence.' };
		const current = { ...frozen, executionPlan: { workItems: [
			{ ...frozen.executionPlan.workItems[0], estimate: prior }, frozen.executionPlan.workItems[1],
		] } };
		const merged = mergeAssignmentEstimate({ frozen, candidate, current, workItemId: 'implementation' });
		expect(merged.executionPlan).toEqual({ workItems: [
			{ ...frozen.executionPlan.workItems[0], estimate: prior },
			{ ...frozen.executionPlan.workItems[1], estimate },
		] });
		expect(mergeAssignmentEstimate({ frozen, candidate, current: merged, workItemId: 'implementation' })).toEqual(merged);
	});
	it('rejects unrelated content and a competing estimate', () => {
		expect(() => mergeAssignmentEstimate({ frozen, candidate: { ...candidate, title: 'New authority' }, current: frozen,
			workItemId: 'implementation' })).toThrow('outside its assigned estimate');
		const current = { ...frozen, executionPlan: { workItems: [frozen.executionPlan.workItems[0],
			{ ...frozen.executionPlan.workItems[1], estimate: { ...estimate, expectedSeconds: 250 } }] } };
		expect(() => mergeAssignmentEstimate({ frozen, candidate, current, workItemId: 'implementation' })).toThrow('different estimate');
	});
	it('rejects missing, mistargeted, or changed work items', () => {
		expect(() => mergeAssignmentEstimate({ frozen, candidate: frozen, current: frozen,
			workItemId: 'implementation' })).toThrow('structured estimate');
		expect(() => mergeAssignmentEstimate({ frozen, candidate, current: frozen,
			workItemId: 'unknown' })).toThrow('frozen proposal work item');
		const changed = { ...frozen, executionPlan: { workItems: [frozen.executionPlan.workItems[0],
			{ ...frozen.executionPlan.workItems[1], objective: 'Changed objective.' }] } };
		expect(() => mergeAssignmentEstimate({ frozen, candidate, current: changed,
			workItemId: 'implementation' })).toThrow('no longer match');
	});
	it('merges Reviewer estimates for every work item without replacing actor estimates', () => {
		const current = { ...frozen, executionPlan: { workItems: [
			{ ...frozen.executionPlan.workItems[0], estimate }, frozen.executionPlan.workItems[1],
		] } };
		const reviewEstimate = { ...estimate, rationale: 'Independent review of the work.' };
		const reviewCandidate = { ...frozen, executionPlan: { workItems: frozen.executionPlan.workItems.map((item) =>
			({ ...item, reviewEstimate })) } };
		const merged = mergeAssignmentEstimate({ frozen, candidate: reviewCandidate, current, workItemId: null });
		expect((merged.executionPlan as { workItems: unknown[] }).workItems).toEqual([
			{ ...current.executionPlan.workItems[0], reviewEstimate },
			{ ...current.executionPlan.workItems[1], reviewEstimate },
		]);
		expect(() => mergeAssignmentEstimate({ frozen, candidate: { ...reviewCandidate,
			executionPlan: { workItems: [reviewCandidate.executionPlan.workItems[0], frozen.executionPlan.workItems[1]] } },
			current, workItemId: null })).toThrow('each assigned work item');
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

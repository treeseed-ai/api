import { describe, expect, it } from 'vitest';
import { hasCompleteExecutablePlan } from '../../../../../../src/api/governance/executable-proposal.ts';
import { readyProposal, readyWorkItem } from './ready-proposal-fixture.ts';

type Row = Record<string, unknown>;
describe('architecture proposal readiness (unit)', () => {
	it('admits complete arbitrary-class work without changing authored scope or estimates', () => {
		const proposal = readyProposal(), before = structuredClone(proposal);
		expect(hasCompleteExecutablePlan(proposal)).toBe(true);
		proposal.executionPlan.workItems[0]!.agentClass = 'renamed-boundary-author';
		expect(hasCompleteExecutablePlan(proposal)).toBe(true);
		proposal.executionPlan.workItems[0]!.agentClass = before.executionPlan.workItems[0]!.agentClass;
		expect(proposal).toEqual(before);
	});
	it('denies every missing work-item authority even when both estimates are present', () => {
		const admitted: string[] = [];
		for (const field of ['id', 'activity', 'agentClass', 'workspace', 'review', 'objective', 'dependsOn',
			'requestedPermissions', 'acceptanceCriteria', 'maximumReviewCycles']) {
			const proposal = readyProposal(); delete (proposal.executionPlan.workItems[0] as Row)[field];
			if (hasCompleteExecutablePlan(proposal)) admitted.push(field);
		}
		expect(admitted).toEqual([]);
	});
	it('denies malformed scope review bounds and retired work-item fields without rewriting input', () => {
		const changes: Row[] = [{ activity: 'chat' }, { workspace: 'unknown' }, { agentClass: '' }, { objective: ' ' },
			{ acceptanceCriteria: [] }, { acceptanceCriteria: [''] }, { review: 'unknown' },
			{ maximumReviewCycles: 0 }, { maximumReviewCycles: 1.5 }, { requestedPermissions: null },
			{ ownerEstimate: { expectedSeconds: 1, maximumSeconds: 2 } }, { minimumSeconds: 1 }];
		const admitted: number[] = [];
		for (const [index, change] of changes.entries()) {
			const proposal = readyProposal(); Object.assign(proposal.executionPlan.workItems[0]!, change);
			const before = structuredClone(proposal);
			if (hasCompleteExecutablePlan(proposal)) admitted.push(index);
			expect(proposal).toEqual(before);
		}
		expect(admitted).toEqual([]);
	});
	it('requires positive integer expected maximum and reviewer estimates with no coercion or minimum field', () => {
		const estimates = [null, {}, { expectedSeconds: '30', maximumSeconds: 60 },
			{ expectedSeconds: 1.5, maximumSeconds: 60 }, { expectedSeconds: 0, maximumSeconds: 60 },
			{ expectedSeconds: 30, maximumSeconds: 29 }, { expectedSeconds: 30, maximumSeconds: Infinity },
			{ expectedSeconds: 30, maximumSeconds: 60, minimumSeconds: 1 }];
		const admitted: string[] = [];
		for (const field of ['estimate', 'reviewEstimate']) for (const [index, estimate] of estimates.entries()) {
			const proposal = readyProposal(); (proposal.executionPlan.workItems[0] as Row)[field] = estimate;
			if (hasCompleteExecutablePlan(proposal)) admitted.push(`${field}:${index}`);
		}
		expect(admitted).toEqual([]);
	});
	it('requires unique local acyclic work dependencies rather than manufacturing a graph from estimates', () => {
		const other = { ...readyWorkItem(), id: 'independent-work' };
		const graphs = [
			[readyWorkItem(), readyWorkItem()],
			[{ ...readyWorkItem(), dependsOn: ['missing'] }],
			[{ ...readyWorkItem(), dependsOn: ['verify-boundary'] }],
			[{ ...readyWorkItem(), dependsOn: ['independent-work'] }, { ...other, dependsOn: ['verify-boundary'] }],
			[{ ...readyWorkItem(), dependsOn: ['independent-work', 'independent-work'] }, other],
		];
		expect(graphs.map(workItems => hasCompleteExecutablePlan({ ...readyProposal(), executionPlan: { workItems } })))
			.toEqual(graphs.map(() => false));
		const workItems = [readyWorkItem(), { ...other, dependsOn: ['verify-boundary'] }];
		expect(hasCompleteExecutablePlan({ ...readyProposal(), executionPlan: { workItems } })).toBe(true);
	});
	it('keeps structurally valid estimate-free drafts outside executable demand', () => {
		const proposal = readyProposal(); delete (proposal.executionPlan.workItems[0] as Row).estimate;
		expect(hasCompleteExecutablePlan(proposal)).toBe(false);
	});
});
